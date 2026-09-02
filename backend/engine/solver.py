from __future__ import annotations

import copy
import json
import logging
import math
import random
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

from alns import ALNSEngine
from diversity import assignment_vector, biased_fitness_scores, normalized_hamming_distance, population_diversity, structural_hash
from finetuner import FineTuner
from hybrid_ortools import build_assignment_seed
from initialization import PopulationInitializer
from models import ProblemInstance, get_max_allowed_delay
from neighborhoods import NeighborhoodSearch
from objective import ObjectiveEvaluator
from exact_lns import ExactLnsConfig, ExactLnsSignals, run_exact_lns_attempt
from operators import GeneticOperators, SelectionEngine
from representation import Individual
from route_pool import RoutePoolManager, build_route_pool
from set_partition import solve_restricted_master_lp, solve_set_partition
from solution_objective import get_solution_base_objective, get_solution_search_objective
from solution_status import classify_solution_status, is_solution_feasible, is_solution_fully_assigned
from stop_controller import StopController
from bcp_foundation import MasterSolveOptions, pricing_employee_scores_from_duals, reduced_cost
from cuts import CutStore
from pricing import price_vehicle_exact_small


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


DEFAULT_MIN_GENERATION_FLOOR = 20


def _employee_scaled_runtime_floor_sec(employee_count: int) -> float:
    return max(4.0, float(employee_count) * 1.5)


class GeneticSolver:
    def __init__(
        self,
        problem: ProblemInstance,
        generations: int = None,
        pop_size: int = 50,
        alns_iterations: int = 10,
        strategy_config: Dict = None,
        seed: Optional[int] = None,
    ):
        self.problem = problem
        self.metadata = getattr(problem, "metadata", {}) or {}
        self.large_case_mode = str(self._meta_raw("LARGE_CASE_MODE") or "").strip().lower()
        self.bypass_size_floors = self._meta_bool("BYPASS_SOLVER_SIZE_FLOORS", default=False)
        self.initial_pop_size = max(4, int(pop_size))
        self.alns_iterations = max(0, int(alns_iterations))
        self.strategy_config = strategy_config or {"name": "Default"}

        if generations is None:
            self.generations = 50 if len(problem.employees) <= 50 else 80
        else:
            self.generations = max(5, int(generations))

        self.employee_count = len(getattr(problem, "employees", []) or [])
        default_min_runtime_floor_sec = _employee_scaled_runtime_floor_sec(self.employee_count)
        default_min_generation_floor = DEFAULT_MIN_GENERATION_FLOOR
        if self._meta_bool("MIN_GENERATION_FLOOR_BELOW_20", default=False):
            default_min_generation_floor = 8
        configured_min_generation_floor = self._meta_int(
            "MIN_GENERATION_FLOOR",
            default=default_min_generation_floor,
            lo=5,
            hi=5000,
        )
        if self.bypass_size_floors:
            self.min_runtime_floor_sec = 0.0
            self.min_generation_floor = self._meta_int(
                "MIN_EARLY_STOP_GENERATIONS",
                default=max(10, min(self.generations, 20)),
                lo=5,
                hi=5000,
            )
        else:
            self.min_runtime_floor_sec = default_min_runtime_floor_sec
            self.min_generation_floor = max(default_min_generation_floor, configured_min_generation_floor)
        self.generations = max(self.generations, self.min_generation_floor)

        self.seed = int(seed if seed is not None else 123456)
        self._seed_everything(self.seed)
        self.rng = random.Random(self.seed)

        # Hybrid controls
        self.route_pool_enabled = self._meta_bool("ROUTE_POOL_ENABLED", default=True)
        self.route_pool_pruning_mode = self._resolve_route_pool_pruning_mode()
        self.route_pool_max_routes = self._meta_int("ROUTE_POOL_MAX_ROUTES", default=700, lo=80, hi=5000)
        self.route_pool_archive_limit = self._meta_int("ROUTE_POOL_ARCHIVE_LIMIT", default=96, lo=20, hi=800)
        self.route_pool_targeted_variants = self._meta_int(
            "ROUTE_POOL_TARGETED_VARIANTS",
            default=5,
            lo=1,
            hi=40,
        )
        self.route_pool_iter_topk_routes = self._meta_int(
            "ROUTE_POOL_ITER_TOPK_ROUTES",
            default=3,
            lo=0,
            hi=50,
        )
        self.set_partition_time_limit_sec = self._meta_float(
            "SET_PARTITION_TIME_LIMIT_SEC",
            default=14.0,
            # Allow explicit disable via 0.0 (used by budget-recalibration formulas for short budgets).
            lo=0.0,
            hi=180.0,
        )
        self.set_partition_iter_limit = self._meta_int(
            "SET_PARTITION_ITERATIONS",
            default=4,
            lo=1,
            hi=20,
        )
        self.set_partition_no_improve_limit = self._meta_int(
            "SET_PARTITION_NO_IMPROVE_ITERS",
            default=2,
            lo=1,
            hi=10,
        )
        # Branch-cut-and-price foundation flags (restricted-master oriented).
        # These are intentionally conservative: they improve the route pool and
        # expose LP-dual signals, but do not provide global optimality proofs.
        self.column_generation_enabled = self._meta_bool("COLUMN_GENERATION_ENABLED", default=False)
        self.column_generation_max_iters = self._meta_int(
            "COLUMN_GENERATION_MAX_ITERS",
            default=int(self.set_partition_iter_limit),
            lo=1,
            hi=50,
        )
        self.column_generation_lp_time_limit_sec = self._meta_float(
            "COLUMN_GENERATION_LP_TIME_LIMIT_SEC",
            default=1.0,
            lo=0.05,
            hi=30.0,
        )
        self.column_generation_min_reduced_cost = self._meta_float(
            "COLUMN_GENERATION_MIN_REDUCED_COST",
            default=-1e-6,
            lo=-1e6,
            hi=0.0,
        )
        self.master_solve_options = MasterSolveOptions.from_metadata(self.metadata)
        self.master_cut_store = CutStore(max_cuts=int(self.master_solve_options.cuts.subset_row_cuts_max))

        self.ortools_seed_assignment_enabled = self._meta_bool(
            "ORTOOLS_SEED_ASSIGNMENT_ENABLED",
            default=True,
        )
        self.ortools_assign_time_limit_sec = self._meta_float(
            "ORTOOLS_ASSIGN_TIME_LIMIT_SEC",
            default=8.0,
            lo=0.2,
            hi=60.0,
        )

        # Global stop-control configuration.
        self.time_limit_sec = self._resolve_time_limit(default=25.0)
        self.min_runtime_sec = self._meta_float("MIN_RUNTIME_SEC", default=4.0, lo=0.0, hi=1800.0)
        self.min_runtime_sec = min(float(self.min_runtime_sec), float(self.time_limit_sec))
        self.checkpoint_every_sec = self._meta_float("CHECKPOINT_EVERY_SEC", default=3.0, lo=0.1, hi=60.0)
        self.eps_rel = self._meta_float("EPS_REL", default=0.0002, lo=0.0, hi=1.0)
        self.stall_checkpoints = self._meta_int("STALL_CHECKPOINTS", default=6, lo=1, hi=50)
        self.diversity_min = self._meta_float("DIVERSITY_MIN", default=0.06, lo=0.0, hi=1.0)
        self.burst_sec = self._meta_float("BURST_SEC", default=6.0, lo=0.1, hi=60.0)
        self.mip_probe_time_sec = self._meta_float("MIP_PROBE_TIME_SEC", default=5.0, lo=0.1, hi=60.0)
        self.mip_gap_tol = self._meta_float("MIP_GAP_TOL", default=0.005, lo=0.0, hi=1.0)

        # Exact-LNS: matheuristic intensification via exact fragment reoptimization.
        self.exact_lns_enabled = self._meta_bool("EXACT_LNS_ENABLED", default=False)
        self.exact_lns_attempts = self._meta_int("EXACT_LNS_ATTEMPTS", default=2, lo=0, hi=50)
        self.exact_lns_time_limit_sec = self._meta_float("EXACT_LNS_TIME_LIMIT_SEC", default=3.0, lo=0.2, hi=120.0)
        self.exact_lns_repeat_generations = self._meta_int(
            "EXACT_LNS_REPEAT_GENERATIONS",
            default=max(4, int(round(self.generations * 0.08))),
            lo=1,
            hi=5000,
        )
        self.exact_lns_strategy = str(self._meta_raw("EXACT_LNS_STRATEGY") or "worst_cost").strip().lower()
        self.exact_lns_fragment_routes = self._meta_int("EXACT_LNS_FRAGMENT_ROUTES", default=2, lo=1, hi=20)
        self.exact_lns_max_fragment_employees = self._meta_int("EXACT_LNS_MAX_FRAGMENT_EMPLOYEES", default=18, lo=2, hi=200)
        self.exact_lns_include_unassigned = self._meta_bool("EXACT_LNS_INCLUDE_UNASSIGNED", default=True)
        self.exact_lns_seed_population = self._meta_int("EXACT_LNS_SEED_POPULATION", default=10, lo=2, hi=120)
        self.exact_lns_pool_max_routes = self._meta_int("EXACT_LNS_POOL_MAX_ROUTES", default=220, lo=30, hi=2000)

        # Convergence-based termination is disabled. Runs stop only when they
        # finish their planned generations or hit the hard runtime limit.
        self.early_stop_enabled = False
        self.min_early_stop_generations = self._meta_int("MIN_EARLY_STOP_GENERATIONS", default=20, lo=0, hi=5000)
        self.min_early_stop_generations = max(int(self.min_early_stop_generations), int(self.min_generation_floor))
        self.stagnation_grace_generations = self._meta_int("STAGNATION_GRACE_GENERATIONS", default=10, lo=0, hi=5000)
        self.best_run_grace_generations = self._meta_int("BEST_RUN_GRACE_GENERATIONS", default=24, lo=0, hi=5000)
        self.lagging_run_grace_generations = self._meta_int(
            "LAGGING_RUN_GRACE_GENERATIONS",
            default=max(8, int(round(self.stagnation_grace_generations * 0.75))),
            lo=0,
            hi=5000,
        )
        self.cross_run_target_rel_gap = self._meta_float("CROSS_RUN_TARGET_REL_GAP", default=0.015, lo=0.0, hi=1.0)
        self.cross_run_target_abs_gap = self._meta_float("CROSS_RUN_TARGET_ABS_GAP", default=0.5, lo=0.0, hi=1_000_000_000.0)

        # Quality/stability controls.
        self.elite_size = self._meta_int(
            "ELITE_SIZE",
            default=max(2, self.initial_pop_size // 20),
            lo=1,
            hi=max(1, self.initial_pop_size // 2),
        )
        self.restart_fraction = self._meta_float("RESTART_FRACTION", default=0.30, lo=0.05, hi=0.9)
        self.stagnation_limit = self._meta_int(
            "STAGNATION_LIMIT_GEN",
            default=max(6, int(round(self.generations * 0.12))),
            lo=3,
            hi=200,
        )
        self.max_restarts = self._meta_int("MAX_RESTARTS", default=10_000, lo=0, hi=10_000)
        self.min_diversity_target = self._meta_float("MIN_DIVERSITY_TARGET", default=0.30, lo=0.0, hi=1.0)
        self.plateau_patience_generations = self._meta_int(
            "PLATEAU_PATIENCE_GENERATIONS",
            default=max(12, int(round(self.generations * 0.14))),
            lo=4,
            hi=5000,
        )
        self.infeasible_plateau_patience_generations = self._meta_int(
            "INFEASIBLE_PLATEAU_PATIENCE_GENERATIONS",
            default=max(6, int(round(self.plateau_patience_generations * 0.65))),
            lo=3,
            hi=5000,
        )
        self.plateau_diversity_max = self._meta_float(
            "PLATEAU_DIVERSITY_MAX",
            default=max(self.diversity_min, 0.12),
            lo=0.0,
            hi=1.0,
        )
        self.restarts_before_convergence_stop = self._meta_int(
            "RESTARTS_BEFORE_CONVERGENCE_STOP",
            default=1,
            lo=0,
            hi=20,
        )
        self.mip_probe_repeat_generations = self._meta_int(
            "MIP_PROBE_REPEAT_GENERATIONS",
            default=max(4, int(round(self.plateau_patience_generations * 0.5))),
            lo=1,
            hi=5000,
        )
        self.mip_early_stop_min_plateau_generations = self._meta_int(
            "MIP_EARLY_STOP_MIN_PLATEAU_GENERATIONS",
            default=max(6, int(round(self.plateau_patience_generations * 0.75))),
            lo=0,
            hi=5000,
        )

        self.significant_improvement_abs = self._meta_float(
            "SIGNIFICANT_IMPROVEMENT_ABS",
            default=5e-5,
            lo=0.0,
            hi=100.0,
        )
        self.significant_improvement_rel = self._meta_float(
            "SIGNIFICANT_IMPROVEMENT_REL",
            default=5e-6,
            lo=0.0,
            hi=0.5,
        )

        self.lambda_diversity = self._meta_float("LAMBDA_DIVERSITY", default=0.30, lo=0.0, hi=4.0)
        self.lambda_diversity_min = self._meta_float("LAMBDA_DIVERSITY_MIN", default=0.05, lo=0.0, hi=4.0)
        self.lambda_diversity_max = self._meta_float("LAMBDA_DIVERSITY_MAX", default=2.0, lo=0.1, hi=8.0)

        # ------------------------------------------------------------------
        # HGS-aligned additions
        # ------------------------------------------------------------------
        # Offspring education: apply lightweight local search to each child
        # after crossover/mutation before it enters the candidate pool.
        self.offspring_education_enabled = self._meta_bool(
            "OFFSPRING_EDUCATION_ENABLED", default=True
        )
        self.offspring_education_max_moves = self._meta_int(
            "OFFSPRING_EDUCATION_MAX_MOVES", default=2, lo=1, hi=12
        )

        # Biased parent selection: use HGS biased fitness (obj rank +
        # lambda * diversity rank) instead of raw objective for tournament.
        self.biased_parent_selection = self._meta_bool(
            "BIASED_PARENT_SELECTION", default=True
        )

        # Adaptive penalty scale based on feasible/infeasible offspring ratio.
        self._adaptive_penalty_scale: float = 1.0
        self._target_feasible_ratio: float = self._meta_float(
            "TARGET_FEASIBLE_RATIO", default=0.25, lo=0.0, hi=1.0
        )
        self._adaptive_penalty_scale_min: float = 0.5
        self._adaptive_penalty_scale_max: float = 4.0

        # Global elite pool: persists across restarts.
        self._global_elite_pool: List[Individual] = []
        self._global_elite_pool_max: int = max(2, int(self.elite_size) * 2)

        # Observability: incumbent improvement timeline.
        self._incumbent_improvement_timeline: List[Dict[str, float]] = []
        # Cumulative counters for run_meta.
        self._total_post_education_improvements: int = 0
        self._cumulative_feasible_count: int = 0
        self._cumulative_offspring_count: int = 0
        self._peak_lambda_div: float = self.lambda_diversity

        # ------------------------------------------------------------------
        # HGS population-management upgrade (optional):
        # Maintain two subpopulations with separate survivor selection:
        #   - "feasible" bucket: fully-assigned + route-feasible (status == "feasible")
        #   - "infeasible" bucket: everything else (partial assignment or infeasible)
        #
        # This mirrors the spirit of HGS feasible/infeasible subpopulations while
        # staying consistent with this repo's feasibility semantics.
        # ------------------------------------------------------------------
        self.hgs_subpopulation_enabled = self._meta_bool("HGS_SUBPOPULATION_ENABLED", default=False)
        self.hgs_subpopulation_infeasible_fraction = self._meta_float(
            "HGS_SUBPOPULATION_INFEASIBLE_FRACTION",
            default=0.30,
            lo=0.0,
            hi=0.80,
        )

        # Education observability (across the run).
        self._education_total_gain: float = 0.0
        self._education_gain_count: int = 0
        self._education_neighborhood_stats: Dict[str, Dict[str, int]] = {}

        # Exact-LNS coupling signals (best-effort; used only for fragment selection).
        self._employee_instability: Dict[str, int] = {}
        self._last_assignment_map: Dict[str, Optional[str]] = {}
        self._last_master_employee_scores: Dict[str, float] = {}
        self._last_master_signals_source: str = "none"

        self.assignment_seed_info = {"backend": "disabled", "status": "disabled", "assignment": {}}

        self.initializer = PopulationInitializer(problem, rng=self.rng, assignment_seed=None)
        self.operators = GeneticOperators(problem, rng=self.rng)
        self.evaluator = ObjectiveEvaluator(problem)
        self.selector = SelectionEngine(problem=problem, tournament_size=3, rng=self.rng)
        self.neighborhoods = NeighborhoodSearch(
            problem,
            operators=self.operators,
            evaluator=self.evaluator,
            rng=self.rng,
        )
        self.alns_engine = ALNSEngine(
            problem,
            operators=self.operators,
            evaluator=self.evaluator,
            neighborhoods=self.neighborhoods,
            rng=self.rng,
        )
        self.finetuner = FineTuner(problem, rng=self.rng)
        self.route_pool_archives: List[Dict[str, object]] = []
        self._anytime_bounds_trace: List[Dict[str, object]] = []
        # Dynamic generation calibration (optional, budget mode).
        self.dynamic_generation_calibration_enabled = self._meta_bool(
            "DYNAMIC_GENERATION_CALIBRATION_ENABLED",
            default=False,
        )
        self.gen_calibration_warmup_generations = self._meta_int(
            "GEN_CALIBRATION_WARMUP_GENERATIONS",
            default=3,
            lo=1,
            hi=20,
        )
        self.gen_calibration_reserve_ratio = self._meta_float(
            "GEN_CALIBRATION_RESERVE_RATIO",
            default=0.18,
            lo=0.0,
            hi=0.8,
        )
        self._gen_calibration_sec_per_generation: Optional[float] = None
        self._gen_calibration_reachable_generations: Optional[int] = None
        self._gen_calibration_planned_generations: Optional[int] = None

        self.logger = logging.getLogger(f"engine.solver.{self.seed}.{self.strategy_config.get('name','default')}")
        if not self.logger.handlers:
            handler = logging.StreamHandler()
            handler.setFormatter(logging.Formatter("%(message)s"))
            self.logger.addHandler(handler)
        self.logger.setLevel(logging.INFO)
        self.logger.propagate = False

    def solve(self, run_id: int = 1, progress_tracker: Optional[Any] = None):
        stop_controller = StopController(
            time_limit_sec=self.time_limit_sec,
            min_runtime_sec=self.min_runtime_sec,
            checkpoint_every_sec=self.checkpoint_every_sec,
            eps_rel=self.eps_rel,
            stall_checkpoints=self.stall_checkpoints,
            diversity_min=self.diversity_min,
            burst_sec=self.burst_sec,
            mip_probe_time_sec=self.mip_probe_time_sec,
            mip_gap_tol=self.mip_gap_tol,
        )

        strategy_name = str(self.strategy_config.get("name") or "Default")
        self._log_event(
            "run_start",
            runId=run_id,
            seed=self.seed,
            strategy=strategy_name,
            popSize=self.initial_pop_size,
            generations=self.generations,
            alnsIterations=self.alns_iterations,
            routePoolEnabled=self.route_pool_enabled,
            setPartitionTimeLimitSec=self.set_partition_time_limit_sec,
            stopConfig=stop_controller.config_snapshot(),
        )

        generations_executed = 0
        self._prepare_assignment_seed(stop_controller)
        population = self.initializer.generate_population(
            self.initial_pop_size,
            self.strategy_config,
            should_stop=lambda: self._should_stop_for_time_limit(stop_controller, generations_executed),
        )

        for ind in population:
            self.evaluator.evaluate(ind, penalty_factor=0.6, phase_progress=0.0, enforce_hard=False)

        population.sort(key=lambda x: x.objective_score)
        best_sol = copy.deepcopy(population[0])
        best_score = float(best_sol.objective_score)
        last_improvement_gen = 0
        stagnation_counter = 0
        restart_count = 0

        # Reset HGS run-level state.
        self._incumbent_improvement_timeline = [{
            "generation": 0,
            "score": float(get_solution_base_objective(best_sol)),
            "searchScore": float(get_solution_search_objective(best_sol)),
        }]
        self._total_post_education_improvements = 0
        self._education_total_gain = 0.0
        self._education_gain_count = 0
        self._education_neighborhood_stats = {}
        self._cumulative_feasible_count = 0
        self._cumulative_offspring_count = 0
        self._peak_lambda_div = self.lambda_diversity
        self._employee_instability = {}
        self._last_assignment_map = {}
        self._last_master_employee_scores = {}
        self._last_master_signals_source = "none"
        # Seed global elite pool with initial best.
        self._update_global_elite_pool(best_sol)

        diversity = population_diversity(population, self.problem)
        stop_controller.note_progress(
            best_score=best_score,
            diversity=float(diversity.get("unique_ratio", 0.0)),
            structural_hash=structural_hash(best_sol),
            force=True,
        )

        stop_reason = "manual_config"
        terminated_early = False
        exploration_next_generation = 1
        mip_probe_next_generation = 1
        exact_lns_next_generation = 1
        mip_probe_result = {"status": "not_run", "gap": None, "durationSec": 0.0}
        escape_burst_count = 0
        mip_probe_count = 0
        exact_lns_attempts_used = 0
        exact_lns_accepted = 0
        exact_lns_history: List[Dict[str, object]] = []
        generation_objective_history: List[Dict[str, float]] = []
        stagnation_detected_gen: Optional[int] = None
        dynamic_gen_cap = int(self.generations)
        warmup_start_elapsed: Optional[float] = None
        calibration_done = False

        self._report_shared_progress(progress_tracker, run_id=run_id, generation=0, best_score=best_score)

        for gen in range(self.generations):
            if gen >= int(dynamic_gen_cap):
                break
            if self._should_stop_for_time_limit(stop_controller, generations_executed):
                terminated_early = True
                stop_reason = "time_limit"
                break

            generations_executed = gen + 1
            if warmup_start_elapsed is None:
                # This timestamp is taken after initialization and right before
                # generation-level loops begin, matching the requested
                # "after initialization" calibration point.
                warmup_start_elapsed = float(stop_controller.elapsed_sec())
            progress = gen / max(1, self.generations - 1)
            controls = self._adaptive_controls(
                progress=progress,
                stagnation_counter=stagnation_counter,
                burst=False,
            )

            # ------------------------------------------------------------
            # Dynamic generation calibration (throughput-based)
            # ------------------------------------------------------------
            if self.dynamic_generation_calibration_enabled and (not calibration_done):
                if int(gen + 1) >= int(self.gen_calibration_warmup_generations):
                    elapsed_now = float(stop_controller.elapsed_sec())
                    start_elapsed = float(warmup_start_elapsed or 0.0)
                    denom = max(1.0, float(self.gen_calibration_warmup_generations))
                    sec_per_gen = max(1e-6, float(elapsed_now - start_elapsed) / denom)

                    from budget_recalibration import planned_generations_from_throughput

                    planned, dbg = planned_generations_from_throughput(
                        T=float(self.time_limit_sec),
                        sec_per_generation=sec_per_gen,
                        reserve_ratio=float(self.gen_calibration_reserve_ratio),
                    )
                    planned = max(int(gen + 1), int(planned))
                    dynamic_gen_cap = int(min(max(dynamic_gen_cap, planned), 5000))

                    self._gen_calibration_sec_per_generation = float(dbg.get("secPerGeneration") or sec_per_gen)
                    try:
                        self._gen_calibration_reachable_generations = int(dbg.get("reachableGenerations") or 0)
                    except Exception:
                        self._gen_calibration_reachable_generations = None
                    self._gen_calibration_planned_generations = int(planned)
                    calibration_done = True

            for ind in population:
                self.evaluator.evaluate(
                    ind,
                    penalty_factor=controls["penalty_factor"],
                    phase_progress=controls["strictness"],
                    enforce_hard=False,
                )

            population.sort(key=lambda x: x.objective_score)
            elites = self._select_elites(population, prefer_fully_assigned_feasible=self.hgs_subpopulation_enabled)
            self._archive_candidates(
                source="elite",
                generation=gen,
                run_id=run_id,
                candidates=elites[: min(2, len(elites))],
            )

            # Biased parent selection (HGS).
            parents = self.selector.select_parents(
                population,
                k=max(2, len(population) // 2),
                use_biased_fitness=self.biased_parent_selection,
                lambda_div=self.lambda_diversity,
            )
            offspring: List[Individual] = []

            for i in range(0, len(parents) - 1, 2):
                if self._should_stop_for_time_limit(stop_controller, generations_executed):
                    break

                child = self.operators.crossover(parents[i], parents[i + 1])
                self.evaluator.evaluate(
                    child,
                    penalty_factor=controls["penalty_factor"],
                    phase_progress=controls["strictness"],
                    enforce_hard=False,
                )

                # -----------------------------------------------------------
                # HGS: offspring education — lightweight local-search pass
                # Applied BEFORE mutation acceptance so mutation builds on an
                # educated child.  Gated by OFFSPRING_EDUCATION_ENABLED.
                # -----------------------------------------------------------
                if (
                    self.offspring_education_enabled
                    and not self._should_stop_for_time_limit(stop_controller, generations_executed)
                ):
                    pre_edu_score = float(child.objective_score)
                    child = self.neighborhoods.improve(
                        child,
                        max_moves=self.offspring_education_max_moves,
                        penalty_factor=controls["penalty_factor"],
                        phase_progress=controls["strictness"],
                    )
                    self.evaluator.evaluate(
                        child,
                        penalty_factor=controls["penalty_factor"],
                        phase_progress=controls["strictness"],
                        enforce_hard=False,
                    )
                    if child.objective_score + 1e-9 < pre_edu_score:
                        self._total_post_education_improvements += 1
                        gain = max(0.0, pre_edu_score - float(child.objective_score))
                        self._education_total_gain += float(gain)
                        self._education_gain_count += 1
                    self._accumulate_education_neighborhood_metrics(child)

                # Track offspring feasibility for adaptive penalty.
                child_feasible = self._is_individual_feasible(child)
                self._cumulative_offspring_count += 1
                if child_feasible:
                    self._cumulative_feasible_count += 1

                if self.rng.random() < controls["mutation_rate"]:
                    destroy_mode = self._pick_destroy_mode(progress, stagnation_counter)
                    repair_mode = self._pick_repair_mode(progress, stagnation_counter)
                    mutated = self.operators.ruin_and_recreate(
                        child,
                        ruin_fraction=controls["ruin_fraction"],
                        max_victims=controls["max_victims"],
                        penalty_factor=controls["penalty_factor"],
                        strictness=controls["strictness"],
                        destroy_mode=destroy_mode,
                        repair_mode=repair_mode,
                    )
                    self.evaluator.evaluate(
                        mutated,
                        penalty_factor=controls["penalty_factor"],
                        phase_progress=controls["strictness"],
                        enforce_hard=False,
                    )

                    delta = mutated.objective_score - child.objective_score
                    temp = max(0.5, 80.0 * (1.0 - progress))
                    if delta < 0 or self.rng.random() < math.exp(-max(0.0, delta) / temp):
                        child = mutated

                offspring.append(child)

            candidate_pool = population + offspring

            if self.alns_iterations > 0 and candidate_pool and not self._should_stop_for_time_limit(stop_controller, generations_executed):
                candidate_pool.sort(key=lambda x: x.objective_score)
                top_k = max(1, int(round(len(candidate_pool) * controls["alns_topk_ratio"])))
                top_k = min(top_k, len(candidate_pool))

                for idx in range(top_k):
                    if self._should_stop_for_time_limit(stop_controller, generations_executed):
                        break
                    before = candidate_pool[idx]
                    improved, _ = self.alns_engine.improve(
                        before,
                        iterations=controls["alns_iterations"],
                        penalty_factor=controls["penalty_factor"],
                        phase_progress=controls["strictness"],
                        ruin_fraction=controls["ruin_fraction"],
                        max_victims=controls["max_victims"],
                        stop_controller=stop_controller,
                    )
                    candidate_pool[idx] = improved
                    if improved.objective_score + 1e-9 < before.objective_score:
                        self._archive_candidates(
                            source="alns_improved",
                            generation=gen,
                            run_id=run_id,
                            candidates=[improved],
                        )

                self._archive_candidates(
                    source="alns",
                    generation=gen,
                    run_id=run_id,
                    candidates=candidate_pool[: min(3, top_k)],
                )

            survivors_needed = max(0, self.initial_pop_size - len(elites))
            # HGS: elites are already deterministically preserved. Exclude them from the
            # survivor selection pool to avoid cloning the same structure twice, which
            # reduces diversity and survivor pressure.
            survivor_pool, elite_duplicate_drops = self._exclude_elites_from_candidate_pool(
                candidate_pool,
                elites,
            )
            if self.hgs_subpopulation_enabled:
                survivors, subpop_metrics = self._survivors_via_hgs_subpopulations(
                    elites=elites,
                    candidate_pool=survivor_pool,
                    survivors_needed=survivors_needed,
                    lambda_div=float(self.lambda_diversity),
                )
            else:
                survivors = self.selector.survival_elimination(
                    survivor_pool,
                    survivors_needed,
                    lambda_div=self.lambda_diversity,
                )
                subpop_metrics = {
                    "popFeasibleCount": None,
                    "popInfeasibleCount": None,
                    "eliteFeasibleCount": None,
                    "eliteInfeasibleCount": None,
                    "survivorFeasibleCount": None,
                    "survivorInfeasibleCount": None,
                }
            population = elites + survivors

            if len(population) < self.initial_pop_size and not self._should_stop_for_time_limit(stop_controller, generations_executed):
                new_needed = self.initial_pop_size - len(population)
                fresh = self.initializer.generate_population(
                    new_needed,
                    {
                        "regret": 0.15,
                        "grasp": 0.25,
                        "random": 0.60,
                    },
                    should_stop=lambda: self._should_stop_for_time_limit(stop_controller, generations_executed),
                )
                for ind in fresh:
                    self.evaluator.evaluate(
                        ind,
                        penalty_factor=controls["penalty_factor"],
                        phase_progress=controls["strictness"],
                        enforce_hard=False,
                    )
                population.extend(fresh)

            population = population[: self.initial_pop_size]
            for ind in population:
                self.evaluator.evaluate(
                    ind,
                    penalty_factor=controls["penalty_factor"],
                    phase_progress=controls["strictness"],
                    enforce_hard=False,
                )
            population.sort(key=lambda x: x.objective_score)

            # If we topped up the population with fresh individuals, ensure the
            # subpopulation counters reflect the *final* population that will be
            # used for the next generation.
            if self.hgs_subpopulation_enabled and isinstance(subpop_metrics, dict):
                pop_feasible = sum(1 for ind in population if classify_solution_status(ind) == "feasible")
                subpop_metrics["popFeasibleCount"] = int(pop_feasible)
                subpop_metrics["popInfeasibleCount"] = int(max(0, len(population) - pop_feasible))

            gen_best = population[0]
            current_best_score = float(best_sol.objective_score)
            improved = (current_best_score - gen_best.objective_score) > self._improvement_threshold(current_best_score)
            if improved:
                best_sol = copy.deepcopy(gen_best)
                best_score = float(best_sol.objective_score)
                last_improvement_gen = gen + 1
                stagnation_counter = 0
                # HGS: record incumbent improvement timeline entry.
                self._incumbent_improvement_timeline.append({
                    "generation": int(gen + 1),
                    "score": float(get_solution_base_objective(best_sol)),
                    "searchScore": float(get_solution_search_objective(best_sol)),
                })
                self._update_global_elite_pool(best_sol)
            else:
                stagnation_counter += 1

            # Exact-LNS fragment selection can use this as a global-search signal.
            self._update_employee_instability(best_sol)

            if stagnation_counter >= self.stagnation_limit and not self._should_stop_for_time_limit(stop_controller, generations_executed):
                if restart_count < int(self.max_restarts):
                    population = self._restart_population(population, controls)
                    restart_count += 1
                    stagnation_counter = 0

            diversity = population_diversity(population, self.problem)
            diversity_ratio = float(diversity.get("unique_ratio", 0.0))
            if diversity_ratio < self.min_diversity_target and progress < 0.92:
                population = self._inject_diversity(population, controls)
                diversity = population_diversity(population, self.problem)
                diversity_ratio = float(diversity.get("unique_ratio", 0.0))

            self._update_lambda_diversity(diversity_ratio=diversity_ratio, improved=improved)

            # -------------------------------------------------------------------
            # HGS: adaptive penalty based on feasible/infeasible offspring ratio
            # -------------------------------------------------------------------
            gen_feasible = sum(1 for ind in offspring if self._is_individual_feasible(ind))
            gen_infeasible = max(0, len(offspring) - gen_feasible)
            gen_feasible_ratio = float(gen_feasible) / float(max(1, len(offspring)))
            self._update_adaptive_penalty_scale(gen_feasible_ratio)
            # Computed adaptive penalty applied in next generation via controls.

            # Track peak lambda_div for run_meta.
            if self.lambda_diversity > self._peak_lambda_div:
                self._peak_lambda_div = self.lambda_diversity

            gen_best_hash = structural_hash(gen_best)
            committed = stop_controller.note_progress(
                best_score=float(best_sol.objective_score),
                diversity=diversity_ratio,
                structural_hash=gen_best_hash,
            )
            if committed:
                snap = stop_controller.last_checkpoint()
                self._anytime_bounds_trace.append(
                    {
                        "t": (float(snap.t) if snap is not None else float(stop_controller.elapsed_sec())),
                        "generation": int(gen + 1),
                        "phase": "heuristic_search",
                        "incumbent_objective": float(get_solution_base_objective(best_sol)),
                        "lower_bound": None,
                        "optimality_gap_absolute": None,
                        "optimality_gap_percent": None,
                        "bound_scope": "none",
                        "bound_source": "none",
                        "stop_reason": None,
                    }
                )
            generation_objective_history.append({
                "generation": int(gen + 1),
                "bestObjective": float(get_solution_base_objective(gen_best)),
                "globalBestObjective": float(get_solution_base_objective(best_sol)),
                "bestSearchObjective": float(get_solution_search_objective(gen_best)),
                "globalBestSearchObjective": float(get_solution_search_objective(best_sol)),
                # HGS observability metrics
                "feasibleOffspringCount": int(gen_feasible),
                "infeasibleOffspringCount": int(gen_infeasible),
                "feasibleRatio": float(gen_feasible_ratio),
                "adaptivePenaltyScale": float(self._adaptive_penalty_scale),
                "diversityScore": float(diversity_ratio),
                # Education metrics (cumulative over run).
                "educationGainTotal": float(self._education_total_gain),
                "educationGainCount": int(self._education_gain_count),
                "educationNeighborhoodStats": dict(self._education_neighborhood_stats),
                # Optional HGS subpopulation accounting (None when disabled).
                "populationFeasibleCount": subpop_metrics.get("popFeasibleCount"),
                "populationInfeasibleCount": subpop_metrics.get("popInfeasibleCount"),
                "eliteFeasibleCount": subpop_metrics.get("eliteFeasibleCount"),
                "eliteInfeasibleCount": subpop_metrics.get("eliteInfeasibleCount"),
                "survivorFeasibleCount": subpop_metrics.get("survivorFeasibleCount"),
                "survivorInfeasibleCount": subpop_metrics.get("survivorInfeasibleCount"),
                "diversityAvgAssignmentDistance": float(diversity.get("avg_assignment_distance", 0.0)),
                "diversityAvgRouteJaccardDistance": float(diversity.get("avg_route_jaccard_distance", 0.0)),
                "populationSize": int(len(population)),
                "lambdaDiv": float(self.lambda_diversity),
                "survivorPoolSize": int(len(survivor_pool)),
                "eliteDuplicateDrops": int(elite_duplicate_drops),
                "survivorAvgSimilarity": float(self.selector.last_survival_metrics.get("avg_similarity", 0.0)),
            })
            self._report_shared_progress(
                progress_tracker,
                run_id=run_id,
                generation=gen + 1,
                best_score=float(best_sol.objective_score),
            )

            self._log_event(
                "generation",
                runId=run_id,
                gen=gen,
                best=float(get_solution_base_objective(gen_best)),
                globalBest=float(get_solution_base_objective(best_sol)),
                bestSearch=float(get_solution_search_objective(gen_best)),
                globalBestSearch=float(get_solution_search_objective(best_sol)),
                diversity=diversity,
                stagnation=stagnation_counter,
                restartCount=restart_count,
                mutation=controls["mutation_rate"],
                ruinFraction=controls["ruin_fraction"],
                alnsIterations=controls["alns_iterations"],
                lambdaDiv=float(self.lambda_diversity),
                avgSimilarity=float(self.selector.last_survival_metrics.get("avg_similarity", 0.0)),
                alnsStats=self.alns_engine.last_stats,
                checkpointCount=len(stop_controller.snapshots),
            )

            # Human-readable progress line for terminal monitoring
            div_pct = diversity_ratio * 100.0
            elapsed = stop_controller.elapsed_sec()
            print(
                f"[Run {run_id}|{strategy_name}] Gen {gen + 1}/{self.generations}  "
                f"best={get_solution_base_objective(gen_best):.4f}  globalBest={get_solution_base_objective(best_sol):.4f}  "
                f"diversity={div_pct:.1f}%  stagnation={stagnation_counter}  "
                f"restarts={restart_count}  elapsed={elapsed:.1f}s",
                file=sys.stderr, flush=True,
            )

            if stop_controller.stagnation_detected:
                if stagnation_detected_gen is None:
                    stagnation_detected_gen = gen + 1
            else:
                stagnation_detected_gen = None

            best_solution_feasible = bool(self._is_individual_feasible(best_sol))
            best_solution_fully_assigned = bool(is_solution_fully_assigned(best_sol))
            stagnation_gate = int(
                self._stagnation_generation_gate(
                    best_solution_feasible=best_solution_feasible,
                    best_solution_fully_assigned=best_solution_fully_assigned,
                )
            )
            plateau_exploration_ready = False
            if int(gen + 1) >= stagnation_gate:
                plateau_exploration_ready = self._should_stop_for_generation_plateau(
                    stop_controller=stop_controller,
                    generation=gen + 1,
                    last_improvement_gen=last_improvement_gen,
                    diversity_ratio=diversity_ratio,
                    restart_count=restart_count,
                    best_solution_feasible=best_solution_feasible,
                    best_solution_fully_assigned=best_solution_fully_assigned,
                )

            if (
                (stop_controller.stagnation_detected or plateau_exploration_ready)
                and int(gen + 1) >= int(exploration_next_generation)
                and stop_controller.can_run_for(0.2)
            ):
                best_sol, population, burst_improved = self._run_escape_burst(
                    best_sol=best_sol,
                    population=population,
                    stop_controller=stop_controller,
                    run_id=run_id,
                    generation=gen + 1,
                )
                escape_burst_count += 1
                exploration_next_generation = int(gen + 1) + max(1, int(self.mip_probe_repeat_generations))
                stop_controller.mark_escape_burst_completed(burst_improved)
                population.sort(key=lambda x: x.objective_score)
                if float(best_sol.objective_score) + 1e-9 < best_score:
                    best_score = float(best_sol.objective_score)
                    last_improvement_gen = gen + 1
                    stagnation_counter = 0

                if (
                    self.route_pool_enabled
                    and int(gen + 1) >= int(mip_probe_next_generation)
                    and stop_controller.can_run_for(0.2)
                ):
                    probe_payload = self._run_mip_probe(
                        run_id=run_id,
                        best_sol=best_sol,
                        population=population,
                        stop_controller=stop_controller,
                    )
                    probe_solution = probe_payload.pop("solution", None)
                    mip_probe_result = probe_payload
                    mip_probe_count += 1
                    mip_probe_next_generation = int(gen + 1) + max(1, int(self.mip_probe_repeat_generations))

                    if probe_solution is not None:
                        self.evaluator.evaluate(
                            probe_solution,
                            penalty_factor=15.0,
                            phase_progress=1.0,
                            enforce_hard=True,
                        )
                        probe_solution.structural_hash = structural_hash(probe_solution)
                        population.append(probe_solution)
                        population.sort(key=lambda x: x.objective_score)
                        population = population[: self.initial_pop_size]
                        if probe_solution.objective_score + 1e-9 < best_sol.objective_score:
                            best_sol = copy.deepcopy(probe_solution)
                            best_score = float(best_sol.objective_score)
                            last_improvement_gen = gen + 1
                            stagnation_counter = 0

                # Exact-LNS: exact/near-exact fragment reoptimization around incumbent.
                if (
                    self.exact_lns_enabled
                    and exact_lns_attempts_used < int(self.exact_lns_attempts)
                    and int(gen + 1) >= int(exact_lns_next_generation)
                    and stop_controller.can_run_for(0.2)
                ):
                    budget = min(
                        float(self.exact_lns_time_limit_sec),
                        max(0.2, float(stop_controller.remaining_sec()) - 0.05),
                    )
                    cfg = ExactLnsConfig(
                        enabled=True,
                        attempts=int(self.exact_lns_attempts),
                        strategy=str(self.exact_lns_strategy),
                        fragment_routes=int(self.exact_lns_fragment_routes),
                        max_fragment_employees=int(self.exact_lns_max_fragment_employees),
                        include_unassigned=bool(self.exact_lns_include_unassigned),
                        seed_population=int(self.exact_lns_seed_population),
                        pool_max_routes=int(self.exact_lns_pool_max_routes),
                        pool_pruning_mode=str(self.route_pool_pruning_mode),
                        time_limit_sec=float(self.exact_lns_time_limit_sec),
                    )
                    signals = ExactLnsSignals(
                        employee_scores=dict(self._last_master_employee_scores or {}),
                        employee_instability=dict(self._employee_instability or {}),
                        source=str(self._last_master_signals_source or "none"),
                    )
                    attempt = run_exact_lns_attempt(
                        problem=self.problem,
                        incumbent=best_sol,
                        config=cfg,
                        rng=self.rng,
                        time_budget_sec=budget,
                        signals=signals,
                    )
                    exact_lns_attempts_used += 1
                    exact_lns_next_generation = int(gen + 1) + max(1, int(self.exact_lns_repeat_generations))

                    exact_lns_history.append(
                        {
                            "status": str(attempt.status),
                            "accepted": bool(attempt.accepted),
                            "incumbentObjective": float(attempt.incumbent_base_objective),
                            "candidateObjective": float(attempt.improved_base_objective),
                            "gain": float(attempt.incumbent_base_objective - attempt.improved_base_objective),
                            "solveTimeSec": float(attempt.solve_time_sec),
                            "backend": str(attempt.solver_backend),
                            "fragmentVehicleCount": int(len(attempt.fragment_vehicle_ids)),
                            "fragmentEmployeeCount": int(len(attempt.fragment_employee_ids)),
                            "fragmentVehicleIds": list(attempt.fragment_vehicle_ids),
                            "fragmentEmployeeIds": list(attempt.fragment_employee_ids),
                            "pool": dict(attempt.pool_stats or {}),
                            "setPartition": dict(attempt.set_partition_stats or {}),
                        }
                    )

                    self._log_event(
                        "exact_lns",
                        runId=run_id,
                        generation=gen + 1,
                        status=str(attempt.status),
                        accepted=bool(attempt.accepted),
                        gain=float(attempt.incumbent_base_objective - attempt.improved_base_objective),
                        fragmentVehicles=int(len(attempt.fragment_vehicle_ids)),
                        fragmentEmployees=int(len(attempt.fragment_employee_ids)),
                        backend=str(attempt.solver_backend),
                        solveTimeSec=float(attempt.solve_time_sec),
                    )

                    if attempt.accepted and attempt.candidate is not None:
                        exact_lns_accepted += 1
                        best_sol = copy.deepcopy(attempt.candidate)
                        self.evaluator.evaluate(best_sol, penalty_factor=15.0, phase_progress=1.0, enforce_hard=True)
                        best_score = float(best_sol.objective_score)
                        last_improvement_gen = gen + 1
                        stagnation_counter = 0
                        population.append(best_sol)
                        population.sort(key=lambda x: x.objective_score)
                        population = population[: self.initial_pop_size]
                        self._archive_candidates(
                            source="exact_lns",
                            generation=gen + 1,
                            run_id=run_id,
                            candidates=[best_sol],
                        )

        if self._should_stop_for_time_limit(stop_controller, generations_executed) and stop_reason != "time_limit":
            terminated_early = True
            stop_reason = "time_limit"

        if not terminated_early:
            stop_reason = "manual_config"

        # Deterministic intensification and hard-feasibility repair.
        if not self._should_stop_for_time_limit(stop_controller, generations_executed) and stop_controller.can_run_for(0.2):
            max_tune = min(4.0, max(0.2, stop_controller.remaining_sec() * 0.25))
            best_sol = self.finetuner.tune(best_sol, stop_controller=stop_controller, max_runtime_sec=max_tune)

        if not self._should_stop_for_time_limit(stop_controller, generations_executed) and stop_controller.can_run_for(0.1):
            best_sol = self.neighborhoods.improve(
                best_sol,
                max_moves=6,
                penalty_factor=10.0,
                phase_progress=0.98,
            )

        for _ in range(3):
            self.evaluator.evaluate(best_sol, penalty_factor=12.0, phase_progress=1.0, enforce_hard=True)
            if self._is_individual_feasible(best_sol):
                break
            if self._should_stop_for_time_limit(stop_controller, generations_executed):
                break
            best_sol = self.operators.repair_to_feasible(best_sol, max_passes=3)
            best_sol = self.operators.force_reassign_unassigned(best_sol, max_passes=5, strictness=1.0)
            best_sol = self._enforce_max_delay_policy(best_sol, max_passes=2)

        best_sol = self._enforce_max_delay_policy(best_sol, max_passes=3)
        self.evaluator.evaluate(best_sol, penalty_factor=15.0, phase_progress=1.0, enforce_hard=True)
        best_sol.structural_hash = structural_hash(best_sol)

        # Fallback to best feasible individual from current population if needed.
        if not self._is_individual_feasible(best_sol):
            feasible_candidates = []
            for ind in population:
                self.evaluator.evaluate(ind, penalty_factor=15.0, phase_progress=1.0, enforce_hard=True)
                if self._is_individual_feasible(ind):
                    feasible_candidates.append(ind)
            if feasible_candidates:
                feasible_candidates.sort(key=lambda x: x.objective_score)
                best_sol = copy.deepcopy(feasible_candidates[0])
                best_sol = self._enforce_max_delay_policy(best_sol, max_passes=2)
                best_sol.structural_hash = structural_hash(best_sol)

        heuristic_best = copy.deepcopy(best_sol)
        heuristic_objective = float(get_solution_base_objective(heuristic_best))
        heuristic_search_objective = float(get_solution_search_objective(heuristic_best))

        exact_solution = None
        exact_objective = None
        exact_search_objective = None
        route_pool_stats: Dict[str, object] = {"enabled": False}
        set_partition_stats: Dict[str, object] = {"enabled": False}

        if (
            self.route_pool_enabled
            and self.set_partition_time_limit_sec > 0.0
            and (not self._should_stop_for_time_limit(stop_controller, generations_executed))
            and stop_controller.can_run_for(0.2)
        ):
            exact_solution, route_pool_stats, set_partition_stats = self._run_route_pool_selection(
                run_id=run_id,
                best_sol=heuristic_best,
                population=population,
                stop_controller=stop_controller,
            )
            if exact_solution is not None:
                self.evaluator.evaluate(
                    exact_solution,
                    penalty_factor=15.0,
                    phase_progress=1.0,
                    enforce_hard=True,
                )
                exact_solution.structural_hash = structural_hash(exact_solution)
                exact_objective = float(get_solution_base_objective(exact_solution))
                exact_search_objective = float(get_solution_search_objective(exact_solution))
                if (
                    self._is_individual_feasible(exact_solution)
                    and exact_solution.objective_score + 1e-9 < best_sol.objective_score
                ):
                    best_sol = copy.deepcopy(exact_solution)

        final_source = "set_partition" if (exact_solution is not None and best_sol.structural_hash == exact_solution.structural_hash) else "heuristic"
        self.evaluator.evaluate(best_sol, penalty_factor=15.0, phase_progress=1.0, enforce_hard=True)
        best_sol.structural_hash = structural_hash(best_sol)

        proof_mode_enabled = bool(self._meta_bool("PROOF_MODE_ENABLED", default=False))
        lower_bound = None
        bound_scope = "none"
        exactness_status = "heuristic_incumbent_only"
        route_pool_size_considered = None
        if bool(set_partition_stats.get("enabled")):
            lower_bound = set_partition_stats.get("lowerBound")
            bound_scope = str(set_partition_stats.get("boundScope") or "none")
            exactness_status = str(set_partition_stats.get("exactnessStatus") or "heuristic_incumbent_only")
            route_pool_size_considered = int(set_partition_stats.get("routePoolSizeConsidered") or 0)
        global_optimality_proven = bool(
            self._meta_bool("GLOBAL_EXACT_MODE", default=False)
            and exactness_status == "globally_optimal"
        )
        unsafe_pruning_enabled = bool(self.route_pool_enabled and self.route_pool_pruning_mode != "safe")
        # Conservative status semantics (v2): make pool-vs-master-vs-global distinctions explicit.
        # This is intentionally descriptive rather than claiming global exactness.
        exactness_status_v2 = "heuristic_only"
        if global_optimality_proven:
            exactness_status_v2 = "globally_optimal"
        else:
            if lower_bound is None:
                exactness_status_v2 = "heuristic_only"
            elif str(bound_scope) == "restricted_route_pool":
                cg_enabled = bool((set_partition_stats.get("columnGeneration") or {}).get("enabled")) if isinstance(set_partition_stats, dict) else False
                iter_rows = (set_partition_stats.get("iterations") or []) if isinstance(set_partition_stats, dict) else []
                ran_integer_master = bool(iter_rows)
                if cg_enabled and (not ran_integer_master):
                    exactness_status_v2 = "column_generation_converged_not_integer"
                elif str(exactness_status) == "exact_restricted_route_pool":
                    exactness_status_v2 = "restricted_master_optimal" if cg_enabled else "pool_optimal"
                else:
                    exactness_status_v2 = "bounded_not_proven"
            else:
                exactness_status_v2 = "bounded_not_proven"

        stop_controller.note_progress(
            best_score=float(best_sol.objective_score),
            diversity=float(diversity.get("unique_ratio", 0.0)),
            structural_hash=str(best_sol.structural_hash),
            force=True,
        )

        runtime_sec = float(stop_controller.elapsed_sec())
        run_meta = {
            "runId": int(run_id),
            "strategy": strategy_name,
            "durationSeconds": runtime_sec,
            "runtimeSec": runtime_sec,
            "seed": int(self.seed),
            "alnsIterations": int(self.alns_iterations),
            "timeLimitSec": float(self.time_limit_sec),
            "maxRunSeconds": float(self.time_limit_sec),
            "minRuntimeSec": float(self.min_runtime_sec),
            "generationsPlanned": int(self.generations),
            "generationsExecuted": int(generations_executed),
            "dynamicGenerationCap": int(dynamic_gen_cap),
            "genCalibrationEnabled": bool(self.dynamic_generation_calibration_enabled),
            "genCalibrationWarmupGenerations": int(self.gen_calibration_warmup_generations),
            "genCalibrationReserveRatio": float(self.gen_calibration_reserve_ratio),
            "genCalibrationSecPerGeneration": self._gen_calibration_sec_per_generation,
            "genCalibrationReachableGenerations": self._gen_calibration_reachable_generations,
            "genCalibrationPlannedGenerations": self._gen_calibration_planned_generations,
            "terminatedEarly": bool(terminated_early),
            "terminationReason": str(stop_reason),
            "stopReason": str(stop_reason),
            "lastImprovementGeneration": int(last_improvement_gen),
            "stagnationLimit": int(self.stagnation_limit),
            "restartCount": int(restart_count),
            "maxRestarts": int(self.max_restarts),
            "eliteSize": int(self.elite_size),
            "bestStructuralHash": str(best_sol.structural_hash),
            "bestPenaltyBreakdown": dict(best_sol.penalty_breakdown),
            "avgDiversityRatio": float(sum(v for _, v in stop_controller.compressed_diversity_history()) / max(1, len(stop_controller.compressed_diversity_history()))),
            "minDiversityRatio": float(min((v for _, v in stop_controller.compressed_diversity_history()), default=0.0)),
            "assignmentSeed": {
                "backend": str(self.assignment_seed_info.get("backend") or ""),
                "status": str(self.assignment_seed_info.get("status") or ""),
                "unassigned": int(len(self.assignment_seed_info.get("unassigned") or [])),
                "solveTimeSec": float(self.assignment_seed_info.get("solveTimeSec") or 0.0),
            },
            "routePoolStats": route_pool_stats,
            "setPartitionStats": set_partition_stats,
            "heuristicBestObjective": float(heuristic_objective),
            "heuristicBestSearchObjective": float(heuristic_search_objective),
            "exactSelectedObjective": (float(exact_objective) if exact_objective is not None else None),
            "exactSelectedSearchObjective": (float(exact_search_objective) if exact_search_objective is not None else None),
            "finalBestSource": final_source,
            "proofModeEnabled": bool(proof_mode_enabled),
            "lowerBound": lower_bound,
            "boundScope": str(bound_scope),
            "exactnessStatus": str(exactness_status),
            "exactnessStatusV2": str(exactness_status_v2),
            "routePoolSizeConsidered": route_pool_size_considered,
            "unsafePruningEnabled": bool(unsafe_pruning_enabled),
            "globalOptimalityProven": bool(global_optimality_proven),
            "lambdaDivFinal": float(self.lambda_diversity),
            "escapeBurstCount": int(escape_burst_count),
            "mipProbeCount": int(mip_probe_count),
            "mipProbe": mip_probe_result,
            "exactLnsEnabled": bool(self.exact_lns_enabled),
            "exactLnsAttemptsUsed": int(exact_lns_attempts_used),
            "exactLnsAccepted": int(exact_lns_accepted),
            "exactLnsHistory": list(exact_lns_history),
            "generationObjectiveHistory": generation_objective_history,
            "bestHistory": stop_controller.compressed_best_history(),
            "diversityHistory": stop_controller.compressed_diversity_history(),
            "stopController": stop_controller.config_snapshot(),
            "alnsOperatorStats": self.alns_engine.last_stats,
            "configSnapshot": self._runtime_config_snapshot(stop_controller),
            # HGS metrics
            "hgsOffspringEducationEnabled": bool(self.offspring_education_enabled),
            "hgsBiasedParentSelection": bool(self.biased_parent_selection),
            "hgsTotalPostEducationImprovements": int(self._total_post_education_improvements),
            "hgsEducationTotalGain": float(self._education_total_gain),
            "hgsEducationGainCount": int(self._education_gain_count),
            "hgsEducationNeighborhoodStats": dict(self._education_neighborhood_stats),
            "hgsSubpopulationEnabled": bool(self.hgs_subpopulation_enabled),
            "hgsSubpopulationInfeasibleFraction": float(self.hgs_subpopulation_infeasible_fraction),
            "hgsAvgFeasibleRatio": float(
                self._cumulative_feasible_count / max(1, self._cumulative_offspring_count)
            ),
            "hgsTotalOffspring": int(self._cumulative_offspring_count),
            "hgsTotalFeasibleOffspring": int(self._cumulative_feasible_count),
            "hgsPeakLambdaDiv": float(self._peak_lambda_div),
            "hgsAdaptivePenaltyScaleFinal": float(self._adaptive_penalty_scale),
            "hgsGlobalElitePoolSize": int(len(self._global_elite_pool)),
            "hgsIncumbentImprovementTimeline": list(self._incumbent_improvement_timeline),
            "hgsSurvivorAvgSimilarityFinal": float(self.selector.last_survival_metrics.get("avg_similarity", 0.0)),
            # Move-evaluation throughput observability (repair/insertions).
            "insertionPrefixEvalEnabled": bool(getattr(self.operators, "insertion_prefix_eval_enabled", False)),
            "insertionEvalStats": dict(getattr(self.operators, "insertion_eval_stats", {}) or {}),
            # Anytime incumbent-vs-bound trace (bounds are restricted-pool when present).
            "anytimeBoundsTrace": list(self._anytime_bounds_trace),
        }

        best_sol.metadata.update(run_meta)

        best_sol_base_objective = float(get_solution_base_objective(best_sol))
        best_sol_search_objective = float(get_solution_search_objective(best_sol))
        best_sol_feasible = bool(self._is_individual_feasible(best_sol))
        best_sol_fully_assigned = bool(is_solution_fully_assigned(best_sol))
        best_sol_status = classify_solution_status(best_sol)

        self._log_event(
            "run_complete",
            runId=run_id,
            score=best_sol_base_objective,
            searchScore=best_sol_search_objective,
            feasible=best_sol_feasible,
            fullyAssigned=best_sol_fully_assigned,
            status=best_sol_status,
            structuralHash=str(best_sol.structural_hash),
            stopReason=str(stop_reason),
            runtimeSec=runtime_sec,
            finalSource=final_source,
        )

        # Human-readable run completion summary for terminal
        feasible_str = best_sol_status.upper()
        print(
            f"\n{'='*60}\n"
            f"[Run {run_id}|{strategy_name}] COMPLETED  "
            f"objective={best_sol_base_objective:.4f}  {feasible_str}\n"
            f"  generations={generations_executed}/{self.generations}  "
            f"stop={stop_reason}  source={final_source}\n"
            f"  runtime={runtime_sec:.2f}s  restarts={restart_count}  "
            f"lastImproveGen={last_improvement_gen}\n"
            f"{'='*60}",
            file=sys.stderr, flush=True,
        )
        return best_sol, run_meta

    # ------------------------------------------------------------------
    # Adaptive controls / restart / diversity
    # ------------------------------------------------------------------

    def _exclude_elites_from_candidate_pool(
        self,
        candidate_pool: Sequence[Individual],
        elites: Sequence[Individual],
    ) -> Tuple[List[Individual], int]:
        """Exclude elite structures from survivor candidate pool.

        This is a search-quality safeguard: the solver already preserves elites
        explicitly, so allowing them to re-enter survivor selection can duplicate
        identical structures and reduce diversity.
        """
        if not candidate_pool or not elites:
            return list(candidate_pool or []), 0

        elite_hashes = set()
        for elite in elites:
            sig = getattr(elite, "structural_hash", None) or structural_hash(elite)
            elite_hashes.add(sig)

        filtered: List[Individual] = []
        dropped = 0
        for ind in candidate_pool:
            sig = getattr(ind, "structural_hash", None) or structural_hash(ind)
            if sig in elite_hashes:
                dropped += 1
                continue
            filtered.append(ind)
        return filtered, dropped

    def _adaptive_controls(self, progress: float, stagnation_counter: int, burst: bool = False) -> Dict[str, float]:
        stagnation_ratio = min(1.0, stagnation_counter / max(1, self.stagnation_limit))
        exploration = (1.0 - progress) * 0.75 + stagnation_ratio * 0.85
        if burst:
            exploration = max(exploration, 0.95)

        mutation_rate = _clamp(0.18 + 0.52 * exploration, 0.10, 0.95)
        ruin_fraction = _clamp(0.09 + 0.34 * exploration, 0.06, 0.75)
        max_victims = int(round(_clamp(1.0 + 6.0 * exploration, 1.0, 10.0)))

        strictness = _clamp(progress + 0.18 * (progress ** 2), 0.0, 1.0)
        if stagnation_ratio > 0.65 and progress < 0.85:
            strictness = _clamp(strictness * 0.90, 0.0, 1.0)
        if burst:
            strictness = min(strictness, 0.75)

        penalty_factor = 0.35 + (14.5 * (progress ** 1.35))
        if stagnation_ratio > 0.70 and progress < 0.80:
            penalty_factor *= 0.90
        if burst:
            penalty_factor *= 0.85
        # HGS: apply adaptive penalty scale (driven by feasible/infeasible ratio)
        penalty_factor = _clamp(
            penalty_factor * self._adaptive_penalty_scale,
            0.10,
            50.0,
        )

        alns_iters = 0
        if self.alns_iterations > 0:
            alns_iters = max(1, int(round(self.alns_iterations * (0.7 + 0.8 * stagnation_ratio))))
            if burst:
                alns_iters = max(alns_iters, int(round(self.alns_iterations * 1.5)))

        return {
            "mutation_rate": mutation_rate,
            "ruin_fraction": ruin_fraction,
            "max_victims": max_victims,
            "penalty_factor": penalty_factor,
            "strictness": strictness,
            "alns_iterations": alns_iters,
            "alns_topk_ratio": _clamp(0.16 + 0.20 * stagnation_ratio, 0.12, 0.45),
        }

    def _select_elites(
        self,
        population: Sequence[Individual],
        prefer_fully_assigned_feasible: bool = False,
    ) -> List[Individual]:
        ordered = sorted(population, key=lambda x: x.objective_score)
        elites: List[Individual] = []
        seen_hash = set()

        if prefer_fully_assigned_feasible:
            feasible_first = [ind for ind in ordered if classify_solution_status(ind) == "feasible"]
            remainder = [ind for ind in ordered if classify_solution_status(ind) != "feasible"]
            ordered = feasible_first + remainder

        for ind in ordered:
            if len(elites) >= self.elite_size:
                break
            sig = structural_hash(ind)
            if sig in seen_hash:
                continue
            clone = copy.deepcopy(ind)
            clone.structural_hash = sig
            elites.append(clone)
            seen_hash.add(sig)

        return elites

    def _accumulate_education_neighborhood_metrics(self, individual: Individual) -> None:
        meta = getattr(individual, "metadata", {}) or {}
        per = meta.get("neighborhoodMetrics") or {}
        if not isinstance(per, dict):
            return
        for name, stats in per.items():
            if not isinstance(stats, dict):
                continue
            attempts = int(stats.get("attempts", 0) or 0)
            hits = int(stats.get("hits", 0) or 0)
            bucket = self._education_neighborhood_stats.setdefault(str(name), {"attempts": 0, "hits": 0})
            bucket["attempts"] += attempts
            bucket["hits"] += hits

    def _survivors_via_hgs_subpopulations(
        self,
        elites: List[Individual],
        candidate_pool: List[Individual],
        survivors_needed: int,
        lambda_div: float,
    ) -> Tuple[List[Individual], Dict[str, Optional[int]]]:
        """Two-subpopulation survivor selection (HGS-inspired).

        "Feasible" here means `classify_solution_status(ind) == "feasible"` i.e.
        route-feasible and fully assigned. Everything else is treated as the
        complementary bucket.
        """
        survivors_needed = max(0, int(survivors_needed))
        if survivors_needed <= 0:
            pop = list(elites)
            pop_feasible = sum(1 for ind in pop if classify_solution_status(ind) == "feasible")
            return [], {
                "popFeasibleCount": int(pop_feasible),
                "popInfeasibleCount": int(max(0, len(pop) - pop_feasible)),
                "eliteFeasibleCount": int(sum(1 for ind in elites if classify_solution_status(ind) == "feasible")),
                "eliteInfeasibleCount": int(sum(1 for ind in elites if classify_solution_status(ind) != "feasible")),
                "survivorFeasibleCount": 0,
                "survivorInfeasibleCount": 0,
            }

        total_target = int(self.initial_pop_size)
        infeasible_target = int(round(total_target * float(self.hgs_subpopulation_infeasible_fraction)))
        infeasible_target = max(0, min(total_target - 1, infeasible_target))
        feasible_target = int(total_target - infeasible_target)

        elite_feasible = [e for e in elites if classify_solution_status(e) == "feasible"]
        elite_infeasible = [e for e in elites if classify_solution_status(e) != "feasible"]

        need_feasible = max(0, feasible_target - len(elite_feasible))
        need_infeasible = max(0, infeasible_target - len(elite_infeasible))

        cand_feasible = [c for c in candidate_pool if classify_solution_status(c) == "feasible"]
        cand_infeasible = [c for c in candidate_pool if classify_solution_status(c) != "feasible"]

        survivors: List[Individual] = []
        if need_feasible > 0:
            survivors.extend(self.selector.survival_elimination(cand_feasible, need_feasible, lambda_div=lambda_div))
        if need_infeasible > 0:
            survivors.extend(self.selector.survival_elimination(cand_infeasible, need_infeasible, lambda_div=lambda_div))

        # Spill-over: if either bucket couldn't be filled, pull remaining from the combined pool.
        survivors = survivors[:survivors_needed]
        if len(survivors) < survivors_needed:
            remaining = survivors_needed - len(survivors)
            chosen_hashes = {structural_hash(s) for s in survivors}
            combined_remaining = [c for c in candidate_pool if structural_hash(c) not in chosen_hashes]
            survivors.extend(self.selector.survival_elimination(combined_remaining, remaining, lambda_div=lambda_div))

        survivors = survivors[:survivors_needed]
        pop = elites + survivors
        pop_feasible = sum(1 for ind in pop if classify_solution_status(ind) == "feasible")
        metrics = {
            "popFeasibleCount": int(pop_feasible),
            "popInfeasibleCount": int(max(0, len(pop) - pop_feasible)),
            "eliteFeasibleCount": int(len(elite_feasible)),
            "eliteInfeasibleCount": int(len(elite_infeasible)),
            "survivorFeasibleCount": int(sum(1 for ind in survivors if classify_solution_status(ind) == "feasible")),
            "survivorInfeasibleCount": int(sum(1 for ind in survivors if classify_solution_status(ind) != "feasible")),
        }
        return survivors, metrics

    def _restart_population(self, population: List[Individual], controls: Dict[str, float]) -> List[Individual]:
        population = sorted(population, key=lambda x: x.objective_score)
        elites = self._select_elites(population)

        # HGS: inject global elite pool members that aren't already covered.
        seen_hashes = {structural_hash(e) for e in elites}
        for gep_ind in sorted(self._global_elite_pool, key=lambda x: x.objective_score):
            if len(elites) >= self._global_elite_pool_max:
                break
            sig = structural_hash(gep_ind)
            if sig not in seen_hashes:
                clone = copy.deepcopy(gep_ind)
                clone.structural_hash = sig
                elites.append(clone)
                seen_hashes.add(sig)

        replace_count = max(1, int(round(self.initial_pop_size * self.restart_fraction)))
        survivors = population[len(elites) :]
        keep_non_elite = survivors[: max(0, self.initial_pop_size - len(elites) - replace_count)]

        fresh = self.initializer.generate_population(
            replace_count,
            {
                "regret": 0.15,
                "grasp": 0.25,
                "random": 0.60,
            },
        )
        for ind in fresh:
            self.evaluator.evaluate(
                ind,
                penalty_factor=controls["penalty_factor"],
                phase_progress=controls["strictness"],
                enforce_hard=False,
            )

        merged = elites + keep_non_elite + fresh
        merged.sort(key=lambda x: x.objective_score)
        self._log_event(
            "restart",
            preservedElites=len(elites),
            replaced=len(fresh),
            retained=len(keep_non_elite),
            globalElitePoolSize=len(self._global_elite_pool),
        )
        return merged[: self.initial_pop_size]

    def _inject_diversity(self, population: List[Individual], controls: Dict[str, float]) -> List[Individual]:
        ordered = sorted(population, key=lambda x: x.objective_score)
        elites = self._select_elites(ordered)
        replace_count = max(1, int(round(self.initial_pop_size * 0.22)))
        survivors = ordered[len(elites) :]
        keep_count = max(0, self.initial_pop_size - len(elites) - replace_count)
        keepers = survivors[:keep_count]

        fresh = self.initializer.generate_population(
            replace_count,
            {
                "regret": 0.15,
                "grasp": 0.20,
                "random": 0.65,
            },
        )
        for ind in fresh:
            self.evaluator.evaluate(
                ind,
                penalty_factor=controls["penalty_factor"],
                phase_progress=controls["strictness"],
                enforce_hard=False,
            )

        merged = elites + keepers + fresh
        merged.sort(key=lambda x: x.objective_score)
        return merged[: self.initial_pop_size]

    def _update_lambda_diversity(self, diversity_ratio: float, improved: bool) -> None:
        if improved:
            self.lambda_diversity *= 0.90
        elif diversity_ratio < self.min_diversity_target:
            self.lambda_diversity *= 1.18
        else:
            self.lambda_diversity *= 0.98

        self.lambda_diversity = _clamp(
            self.lambda_diversity,
            self.lambda_diversity_min,
            self.lambda_diversity_max,
        )

    def _update_adaptive_penalty_scale(self, feasible_ratio: float) -> None:
        """HGS-style adaptive penalty: adjust penalty scale based on the
        observed ratio of feasible offspring.

        - If too few offspring are feasible (below target), increase penalty to
          steer the search toward feasibility.
        - If nearly all offspring are feasible (above 0.80), relax slightly to
          allow exploration of the infeasible region.
        """
        if feasible_ratio < self._target_feasible_ratio:
            self._adaptive_penalty_scale *= 1.07
        elif feasible_ratio > 0.80:
            self._adaptive_penalty_scale *= 0.96
        # else: keep scale
        self._adaptive_penalty_scale = _clamp(
            self._adaptive_penalty_scale,
            self._adaptive_penalty_scale_min,
            self._adaptive_penalty_scale_max,
        )

    def _update_global_elite_pool(self, individual: Individual) -> None:
        """Maintain the global elite pool (persists across restarts).

        Adds a deep copy of *individual* if its structural hash is not already
        in the pool.  When the pool exceeds its capacity, the worst-scoring
        member is evicted.
        """
        sig = structural_hash(individual)
        existing_hashes = {structural_hash(e) for e in self._global_elite_pool}
        if sig in existing_hashes:
            return
        clone = copy.deepcopy(individual)
        clone.structural_hash = sig
        self._global_elite_pool.append(clone)
        # Evict worst if over capacity.
        if len(self._global_elite_pool) > self._global_elite_pool_max:
            self._global_elite_pool.sort(key=lambda x: x.objective_score)
            self._global_elite_pool = self._global_elite_pool[: self._global_elite_pool_max]

    # ------------------------------------------------------------------
    # Escape burst + mip probe
    # ------------------------------------------------------------------

    def _run_escape_burst(
        self,
        best_sol: Individual,
        population: List[Individual],
        stop_controller: StopController,
        run_id: int,
        generation: int,
    ) -> Tuple[Individual, List[Individual], bool]:
        stop_controller.mark_escape_burst_started()

        if stop_controller.remaining_sec() <= 0.2:
            return best_sol, population, False

        burst_budget = min(stop_controller.burst_sec, max(0.2, stop_controller.remaining_sec() - 0.05))
        local_deadline = time.perf_counter() + burst_budget
        controls = self._adaptive_controls(progress=0.30, stagnation_counter=self.stagnation_limit, burst=True)

        improved = False
        working = sorted(population, key=lambda x: x.objective_score)[: max(2, self.initial_pop_size // 3)]

        while time.perf_counter() < local_deadline and (not stop_controller.time_limit_reached()):
            base = working[self.rng.randrange(len(working))]
            mutate = self.operators.ruin_and_recreate(
                base,
                ruin_fraction=controls["ruin_fraction"],
                max_victims=controls["max_victims"],
                penalty_factor=controls["penalty_factor"],
                strictness=controls["strictness"],
                destroy_mode=self._weighted_pick(
                    [
                        ("route", 0.35),
                        ("related", 0.35),
                        ("worst", 0.20),
                        ("random", 0.10),
                    ]
                ),
                repair_mode=self._weighted_pick(
                    [
                        ("regret3", 0.55),
                        ("regret2", 0.35),
                        ("greedy", 0.10),
                    ]
                ),
            )
            self.evaluator.evaluate(
                mutate,
                penalty_factor=controls["penalty_factor"],
                phase_progress=controls["strictness"],
                enforce_hard=False,
            )

            if mutate.objective_score + 1e-9 < base.objective_score:
                working.append(mutate)
                working.sort(key=lambda x: x.objective_score)
                working = working[: max(2, self.initial_pop_size // 3)]

            if mutate.objective_score + 1e-9 < best_sol.objective_score:
                best_sol = copy.deepcopy(mutate)
                improved = True
                self._archive_candidates(
                    source="escape_burst",
                    generation=generation,
                    run_id=run_id,
                    candidates=[mutate],
                )

        merged = population + working
        merged.sort(key=lambda x: x.objective_score)
        unique = []
        seen = set()
        for ind in merged:
            sig = structural_hash(ind)
            if sig in seen:
                continue
            seen.add(sig)
            ind.structural_hash = sig
            unique.append(ind)
            if len(unique) >= self.initial_pop_size:
                break

        self._log_event(
            "escape_burst",
            runId=run_id,
            generation=generation,
            improved=bool(improved),
            burstSec=float(burst_budget),
            best=float(best_sol.objective_score),
        )
        return best_sol, unique, improved

    def _run_mip_probe(
        self,
        run_id: int,
        best_sol: Individual,
        population: Sequence[Individual],
        stop_controller: StopController,
    ) -> Dict[str, object]:
        probe_start = time.perf_counter()
        remaining = stop_controller.remaining_sec()
        if remaining <= 0.2:
            return {"status": "skipped_no_time", "gap": None, "durationSec": 0.0, "solution": None}

        probe_tl = min(stop_controller.mip_probe_time_sec, max(0.2, remaining - 0.05))

        top_individuals = self._collect_diverse_candidates(population, top_k=5)
        top_individuals = [copy.deepcopy(best_sol)] + top_individuals
        pool_routes, pool_stats = build_route_pool(
            problem=self.problem,
            individuals=top_individuals,
            archives=self.route_pool_archives,
            max_routes=min(240, self.route_pool_max_routes),
            evaluator=self.evaluator,
            pruning_mode=self.route_pool_pruning_mode,
        )

        if not pool_routes:
            return {
                "status": "no_routes",
                "gap": None,
                "durationSec": float(max(0.0, time.perf_counter() - probe_start)),
                "solution": None,
                "pool": pool_stats,
            }

        result = solve_set_partition(
            self.problem,
            pool_routes,
            time_limit_sec=probe_tl,
            allow_relaxed_fallback=False,
            evaluator=self.evaluator,
        )

        gap = result.mip_gap
        if gap is None:
            gap = result.metadata.get("relativeGap") if isinstance(result.metadata, dict) else None

        payload = {
            "status": str(result.status),
            "gap": (float(gap) if gap is not None else None),
            "durationSec": float(max(0.0, time.perf_counter() - probe_start)),
            "backend": str(result.backend),
            "selectedRoutes": int(len(result.selected_route_ids)),
            "poolSize": int(len(pool_routes)),
            "pool": pool_stats,
            "solution": result.individual,
        }

        self._log_event(
            "mip_probe",
            runId=run_id,
            status=payload["status"],
            gap=payload["gap"],
            durationSec=payload["durationSec"],
            poolSize=payload["poolSize"],
        )
        return payload

    # ------------------------------------------------------------------
    # Route-pool + iterated set partition
    # ------------------------------------------------------------------

    def _run_route_pool_selection(
        self,
        run_id: int,
        best_sol: Individual,
        population: List[Individual],
        stop_controller: StopController,
    ):
        if float(self.set_partition_time_limit_sec) <= 0.0:
            return (
                None,
                {"enabled": bool(self.route_pool_enabled), "skipped": True, "skippedReason": "set_partition_budget_zero"},
                {"enabled": False, "skipped": True, "skippedReason": "set_partition_budget_zero"},
            )

        manager = RoutePoolManager(
            problem=self.problem,
            evaluator=self.evaluator,
            max_routes=self.route_pool_max_routes,
            penalty_factor=15.0,
            phase_progress=1.0,
            enforce_hard=True,
            pruning_mode=self.route_pool_pruning_mode,
        )

        anchors = [copy.deepcopy(best_sol)] + self._collect_diverse_candidates(population, top_k=7)
        for idx, ind in enumerate(anchors):
            manager.collect_from_individual(
                ind,
                source="iter_seed",
                run_id=run_id,
                generation=-1,
                top_k_routes=(None if self.route_pool_iter_topk_routes <= 0 else int(self.route_pool_iter_topk_routes)),
            )

        manager.collect_from_archives(self.route_pool_archives)

        cg_rows = []
        pricing_type = "surrogate_min_route_cost"
        lp_last = None
        if self.column_generation_enabled:
            # Restricted master LP column-generation foundation.
            # Pricing is hybrid: exact duals (when available) guide *heuristic*
            # route generation via destroy/repair operators.
            no_negative_iters = 0
            prev_employee_duals: Dict[str, float] = {}
            dual_stabilization_alpha = self._meta_float(
                "PRICING_DUAL_STABILIZATION_ALPHA",
                default=0.75,
                lo=0.0,
                hi=1.0,
            )
            exact_pricing_enabled = self._meta_bool("PRICING_EXACT_SMALL_ENABLED", default=True)
            exact_pricing_max_candidates = self._meta_int("PRICING_EXACT_SMALL_MAX_EMPLOYEES", default=8, lo=2, hi=12)
            exact_pricing_max_columns_per_vehicle = self._meta_int("PRICING_EXACT_SMALL_MAX_COLUMNS_PER_VEHICLE", default=5, lo=1, hi=30)
            exact_pricing_time_limit_sec = self._meta_float("PRICING_EXACT_SMALL_TIME_LIMIT_SEC", default=0.7, lo=0.05, hi=20.0)
            for cg_idx in range(int(self.column_generation_max_iters)):
                if stop_controller.time_limit_reached():
                    break
                remaining = stop_controller.remaining_sec()
                if remaining <= 0.25:
                    break

                routes = manager.get_routes()
                if not routes:
                    break

                lp_tl = min(float(self.column_generation_lp_time_limit_sec), max(0.05, remaining * 0.15))
                lp = solve_restricted_master_lp(
                    self.problem,
                    routes,
                    time_limit_sec=lp_tl,
                    options=self.master_solve_options,
                    cut_store=self.master_cut_store,
                )
                lp_last = lp
                employee_duals_raw = dict(lp.employee_duals or {})
                vehicle_duals = dict(lp.vehicle_duals or {})
                cut_duals = dict(getattr(lp, "cut_duals", {}) or {})
                duals_available = bool(employee_duals_raw)

                # Stabilize employee duals (simple exponential smoothing).
                employee_duals = {}
                dual_l1 = 0.0
                for k, v in employee_duals_raw.items():
                    prev = float(prev_employee_duals.get(k, 0.0) or 0.0)
                    cur = float(v or 0.0)
                    stabilized = (dual_stabilization_alpha * cur) + ((1.0 - dual_stabilization_alpha) * prev)
                    employee_duals[str(k)] = float(stabilized)
                    dual_l1 += abs(cur - prev)
                prev_employee_duals = dict(employee_duals)

                pricing_type = "dual_reduced_cost_hybrid" if duals_available else "surrogate_min_route_cost"

                employee_prices = (
                    pricing_employee_scores_from_duals(employee_duals)
                    if duals_available
                    else self._approx_employee_prices(routes)
                )
                # Expose best-effort pricing/master signal to hybrid intensification layers.
                self._last_master_employee_scores = dict(employee_prices or {})
                self._last_master_signals_source = "restricted_master_duals" if duals_available else "surrogate_prices"

                before_ids = {str(r.route_id) for r in routes}
                dummy_partition = type("LpPartition", (), {"uncovered_employee_ids": [], "individual": None})()
                target_employee_ids = self._target_employees_from_partition(
                    dummy_partition,
                    fallback_solution=best_sol,
                    employee_prices=employee_prices,
                )
                pricing_stats = None
                pricing_fallback_reason = None

                added = 0
                # Stronger pricing attempt: exact enumeration for a restricted scope (small candidate set).
                if duals_available and exact_pricing_enabled:
                    # Candidate employees: deterministic top-by-dual plus targets.
                    ranked = sorted(
                        ((float(employee_duals.get(str(e.id), 0.0) or 0.0), str(e.id)) for e in self.problem.employees),
                        key=lambda x: (-x[0], x[1]),
                    )
                    cand = [eid for _, eid in ranked if eid]
                    cand = [*list(dict.fromkeys([*list(target_employee_ids or []), *cand]))]
                    cand = cand[: int(max(2, exact_pricing_max_candidates))]

                    remaining_for_pricing = max(0.05, min(float(exact_pricing_time_limit_sec), stop_controller.remaining_sec() * 0.25))
                    vehicle_ids = sorted({str(v.id) for v in self.problem.vehicles})
                    negative_total = 0
                    generated_total = 0
                    dominance_pruned = 0
                    expanded_labels = 0
                    priced_vehicles = 0
                    best_rc = None
                    for vid in vehicle_ids[: min(len(vehicle_ids), 4)]:
                        if stop_controller.time_limit_reached() or stop_controller.remaining_sec() <= 0.2:
                            break
                        vehicle = next((v for v in self.problem.vehicles if str(v.id) == vid), None)
                        if vehicle is None:
                            continue
                        priced_vehicles += 1
                        res = price_vehicle_exact_small(
                            self.problem,
                            vehicle=vehicle,
                            candidate_employee_ids=cand,
                            employee_duals=employee_duals,
                            vehicle_duals=vehicle_duals,
                            cut_duals=cut_duals,
                            cuts=self.master_cut_store.cuts(),
                            pool_manager=manager,
                            run_id=run_id,
                            iteration=int(cg_idx),
                            max_candidates=int(exact_pricing_max_candidates),
                            max_columns=int(exact_pricing_max_columns_per_vehicle),
                            min_reduced_cost=float(self.column_generation_min_reduced_cost),
                            time_limit_sec=float(remaining_for_pricing / max(1, min(4, len(vehicle_ids)))),
                            dominance_enabled=bool(self._meta_bool("PRICING_EXACT_SMALL_DOMINANCE_ENABLED", default=True)),
                        )
                        pricing_stats = res.stats
                        expanded_labels += int(res.stats.expanded_labels)
                        dominance_pruned += int(res.stats.dominance_pruned)
                        generated_total += int(len(res.routes))
                        negative_total += int(res.stats.negative_reduced_cost_found)
                        if res.stats.best_reduced_cost is not None:
                            best_rc = res.stats.best_reduced_cost if best_rc is None else float(min(best_rc, res.stats.best_reduced_cost))
                        for pr in res.routes:
                            manager.add_pooled_route(pr)
                    after_tmp = manager.get_routes()
                    after_ids_tmp = {str(r.route_id) for r in after_tmp}
                    added = max(0, len(after_ids_tmp - before_ids))
                    pricing_stats = {
                        "mode": "exact_enumeration_pricing_small",
                        "vehiclesPriced": int(priced_vehicles),
                        "candidateEmployees": int(len(cand)),
                        "generatedColumns": int(generated_total),
                        "negativeReducedCostColumns": int(negative_total),
                        "expandedLabels": int(expanded_labels),
                        "dominancePruned": int(dominance_pruned),
                        "bestReducedCost": best_rc,
                    }
                    if added <= 0:
                        pricing_fallback_reason = "no_columns_added"
                if added <= 0:
                    # Fallback: heuristic pool augmentation (existing behavior).
                    pricing_fallback_reason = pricing_fallback_reason or ("duals_unavailable" if not duals_available else "exact_pricing_disabled_or_failed")
                    added = self._augment_route_pool(
                        manager=manager,
                        anchors=anchors,
                        partition=dummy_partition,
                        target_employee_ids=target_employee_ids,
                        iteration=int(cg_idx),
                        run_id=run_id,
                        stop_controller=stop_controller,
                        employee_prices=employee_prices,
                    )
                after_routes = manager.get_routes()
                new_routes = [r for r in after_routes if str(r.route_id) not in before_ids]

                added_negative = None
                min_new_rc = None
                if duals_available and new_routes:
                    rcs = [
                        reduced_cost(
                            r,
                            employee_duals=employee_duals,
                            vehicle_duals=vehicle_duals,
                            cut_duals=cut_duals,
                            cuts=self.master_cut_store.cuts(),
                        )
                        for r in new_routes
                    ]
                    if rcs:
                        min_new_rc = float(min(rcs))
                    added_negative = int(sum(1 for v in rcs if float(v) < float(self.column_generation_min_reduced_cost)))
                    if added_negative <= 0:
                        no_negative_iters += 1
                    else:
                        no_negative_iters = 0

                cg_rows.append(
                    {
                        "iteration": int(cg_idx + 1),
                        "lpStatus": str(lp.status),
                        "lpObjective": lp.objective_value,
                        "lpSolveTimeSec": float(lp.solve_time_sec),
                        "poolSize": int(len(after_routes)),
                        "addedRoutes": int(added),
                        "pricing": {
                            "type": str(pricing_type),
                            "dualsAvailable": bool(duals_available),
                            "employeeDualCount": int(len(employee_duals)),
                            "vehicleDualCount": int(len(vehicle_duals)),
                            "cutDualCount": int(len(cut_duals)),
                            "minReducedCostInPool": lp.reduced_cost_min,
                            "minReducedCostAmongNew": min_new_rc,
                            "newNegativeReducedCostRoutes": added_negative,
                            "dualStabilizationAlpha": float(dual_stabilization_alpha),
                            "dualDeltaL1": float(dual_l1),
                            "pricingSubproblem": (pricing_stats if isinstance(pricing_stats, dict) else None),
                            "fallbackReason": (str(pricing_fallback_reason) if pricing_fallback_reason else None),
                        },
                        "cuts": {
                            "enabled": bool(self.master_solve_options.cuts.subset_row_cuts_enabled),
                            "family": ("subset_row" if self.master_solve_options.cuts.subset_row_cuts_enabled else "none"),
                            "total": int(getattr(lp, "cuts_total", 0) or 0),
                            "added": int(getattr(lp, "cuts_added", 0) or 0),
                        },
                    }
                )

                if added <= 0:
                    break
                if duals_available and no_negative_iters >= 2:
                    break

        iter_rows = []
        best_exact = None
        best_exact_score = float("inf")
        best_gap = None
        best_status = "not_run"
        no_improve_iters = 0

        for iter_idx in range(self.set_partition_iter_limit):
            if stop_controller.time_limit_reached():
                break

            remaining = stop_controller.remaining_sec()
            if remaining <= 0.2:
                break

            tl = min(self.set_partition_time_limit_sec, max(0.2, remaining - 0.05))
            routes = manager.get_routes()
            if not routes:
                best_status = "route_pool_empty"
                break

            partition = solve_set_partition(
                self.problem,
                routes,
                time_limit_sec=tl,
                allow_relaxed_fallback=True,
                evaluator=self.evaluator,
                master_options=self.master_solve_options,
            )

            employee_prices = self._approx_employee_prices(routes)
            lp_bound = None
            try:
                lp_bound = (partition.metadata or {}).get("lpRelaxationLowerBound") if isinstance(partition.metadata, dict) else None
            except Exception:
                lp_bound = None
            row = {
                "iteration": int(iter_idx + 1),
                "status": str(partition.status),
                "backend": str(partition.backend),
                "mipGap": partition.mip_gap,
                "selectedRoutes": int(len(partition.selected_route_ids)),
                "uncoveredEmployees": list(partition.uncovered_employee_ids),
                "poolSize": int(len(routes)),
                "pricing": {
                    "type": str(pricing_type),
                    "employeeCount": int(len(employee_prices)),
                    "maxEmployeePrice": float(max(employee_prices.values(), default=0.0)),
                    "avgEmployeePrice": float(sum(employee_prices.values()) / max(1, len(employee_prices))),
                },
                "lowerBound": partition.metadata.get("lowerBound") if isinstance(partition.metadata, dict) else None,
                "boundScope": str(partition.metadata.get("boundScope") or "none") if isinstance(partition.metadata, dict) else "none",
                "exactnessStatus": str(partition.metadata.get("exactnessStatus") or "heuristic_incumbent_only") if isinstance(partition.metadata, dict) else "heuristic_incumbent_only",
                "boundSource": str(partition.metadata.get("boundSource") or "none") if isinstance(partition.metadata, dict) else "none",
                "lpRelaxationLowerBound": lp_bound,
                "lpRelaxationStatus": str(partition.metadata.get("lpRelaxationStatus") or "unknown") if isinstance(partition.metadata, dict) else "unknown",
            }
            if row.get("lowerBound") is None and lp_bound is not None:
                row["lowerBound"] = lp_bound
                row["boundScope"] = "restricted_route_pool"
                row["exactnessStatus"] = "bounded_restricted_route_pool"
                row["boundSource"] = "restricted_master_lp_relaxation"

            best_status = str(partition.status)
            if partition.mip_gap is not None:
                best_gap = float(partition.mip_gap)

            improved_this_iter = False
            if partition.individual is not None:
                self.evaluator.evaluate(
                    partition.individual,
                    penalty_factor=15.0,
                    phase_progress=1.0,
                    enforce_hard=True,
                )
                partition.individual.structural_hash = structural_hash(partition.individual)
                row["objective"] = float(partition.individual.objective_score)
                row["feasible"] = bool(self._is_individual_feasible(partition.individual))

                if (
                    self._is_individual_feasible(partition.individual)
                    and partition.individual.objective_score + 1e-9 < best_exact_score
                ):
                    best_exact = copy.deepcopy(partition.individual)
                    best_exact_score = float(partition.individual.objective_score)
                    improved_this_iter = True

            if improved_this_iter:
                no_improve_iters = 0
            else:
                no_improve_iters += 1

            if best_exact is not None and math.isfinite(best_exact_score):
                row["bestObjectiveSoFar"] = float(best_exact_score)

            target_employee_ids = self._target_employees_from_partition(partition, best_sol, employee_prices=employee_prices)
            added_routes = self._augment_route_pool(
                manager=manager,
                anchors=anchors,
                partition=partition,
                target_employee_ids=target_employee_ids,
                iteration=iter_idx,
                run_id=run_id,
                stop_controller=stop_controller,
                employee_prices=employee_prices,
            )
            row["addedRoutes"] = int(added_routes)
            iter_rows.append(row)
            # Anytime trace: tie bound information to restricted-master iterations.
            incumbent_obj = None
            if best_exact is not None and math.isfinite(best_exact_score):
                incumbent_obj = float(get_solution_base_objective(best_exact))
            lower_bound = row.get("lowerBound")
            gap_abs = None
            gap_pct = None
            try:
                from lower_bound import compute_gap
                gap_abs, gap_pct = compute_gap(incumbent_obj, lower_bound)
            except Exception:
                gap_abs, gap_pct = None, None
            self._anytime_bounds_trace.append(
                {
                    "t": float(stop_controller.elapsed_sec()),
                    "iteration": int(iter_idx + 1),
                    "phase": "restricted_master",
                    "incumbent_objective": incumbent_obj,
                    "lower_bound": lower_bound,
                    "optimality_gap_absolute": gap_abs,
                    "optimality_gap_percent": gap_pct,
                    "bound_scope": str(row.get("boundScope") or "none"),
                    "bound_source": str(row.get("boundSource") or "none"),
                    "stop_reason": None,
                }
            )

            if no_improve_iters >= self.set_partition_no_improve_limit:
                break
            if added_routes <= 0:
                break

        pool_stats = manager.stats()
        pool_stats.update(
            {
                "enabled": True,
                "poolSize": int(len(manager.get_routes())),
                "archiveSize": int(len(self.route_pool_archives)),
                "runId": int(run_id),
                "iterations": iter_rows,
                "columnGeneration": {
                    "enabled": bool(self.column_generation_enabled),
                    "iterations": cg_rows,
                    "lastLpObjective": (lp_last.objective_value if lp_last is not None else None),
                    "lastLpStatus": (lp_last.status if lp_last is not None else None),
                },
            }
        )

        partition_stats = {
            "enabled": True,
            "status": best_status,
            "backend": "iterated_set_partition",
            "mipGap": best_gap,
            "iterations": iter_rows,
            "columnGeneration": {
                "enabled": bool(self.column_generation_enabled),
                "iterations": cg_rows,
                "lastLpObjective": (lp_last.objective_value if lp_last is not None else None),
                "lastLpStatus": (lp_last.status if lp_last is not None else None),
            },
            "bestObjective": (float(best_exact_score) if best_exact is not None else None),
            "lowerBound": None,
            "boundScope": "none",
            "exactnessStatus": "heuristic_incumbent_only",
            "boundSource": "none",
            "routePoolSizeConsidered": int(len(manager.get_routes())),
        }

        if iter_rows:
            strongest_bound = None
            strongest_status = "heuristic_incumbent_only"
            strongest_scope = "none"
            strongest_source = "none"
            for row in iter_rows:
                row_bound = row.get("lowerBound")
                if row_bound is None:
                    continue
                strongest_bound = float(row_bound)
                strongest_scope = str(row.get("boundScope") or "restricted_route_pool")
                strongest_status = str(row.get("exactnessStatus") or "bounded_restricted_route_pool")
                strongest_source = str(row.get("boundSource") or "none")
                if strongest_status == "exact_restricted_route_pool":
                    break
            partition_stats["lowerBound"] = strongest_bound
            partition_stats["boundScope"] = strongest_scope
            partition_stats["exactnessStatus"] = strongest_status
            partition_stats["boundSource"] = strongest_source
        elif lp_last is not None and lp_last.objective_value is not None:
            # If integer master didn't run, surface the restricted LP objective
            # as a valid restricted-route-pool lower bound.
            partition_stats["lowerBound"] = float(lp_last.objective_value)
            partition_stats["boundScope"] = "restricted_route_pool"
            partition_stats["exactnessStatus"] = "bounded_restricted_route_pool"
            partition_stats["boundSource"] = "restricted_master_lp_relaxation"

        return best_exact, pool_stats, partition_stats

    def _target_employees_from_partition(
        self,
        partition_result,
        fallback_solution: Individual,
        employee_prices: Optional[Dict[str, float]] = None,
    ) -> List[str]:
        target = []
        target.extend([str(eid) for eid in (partition_result.uncovered_employee_ids or [])])

        candidate = partition_result.individual or fallback_solution
        if candidate is not None:
            delay_rows: List[Tuple[float, str]] = []
            for route in candidate.routes:
                for emp_id, delay in (getattr(route, "employee_delay_minutes", {}) or {}).items():
                    delay_rows.append((float(delay), str(emp_id)))
            delay_rows.sort(key=lambda x: (-x[0], x[1]))
            for _, emp_id in delay_rows[:8]:
                if emp_id not in target:
                    target.append(emp_id)

        if employee_prices:
            priced = sorted(
                ((float(v), str(k)) for k, v in employee_prices.items()),
                key=lambda x: (-x[0], x[1]),
            )
            for _, emp_id in priced[:8]:
                if emp_id not in target:
                    target.append(emp_id)

        if not target:
            # deterministic fallback: earliest employee IDs
            all_ids = sorted(str(emp.id) for emp in self.problem.employees)
            target = all_ids[: min(6, len(all_ids))]

        return target[:10]

    def _approx_employee_prices(self, routes) -> Dict[str, float]:
        """Surrogate 'dual' prices for employees based on current pool.

        Pricing is approximate: we use the minimum route objective among pool
        routes that cover an employee. This is not a true reduced-cost pricing
        signal (no LP duals), but it provides a grounded way to focus route
        generation on 'expensive to cover' employees.
        """
        best: Dict[str, float] = {}
        for route in routes or []:
            try:
                cost = float(getattr(route, "objective_score", float("inf")))
            except Exception:
                continue
            if not (route.passenger_set or []):
                continue
            for emp_id in route.passenger_set:
                key = str(emp_id)
                cur = best.get(key)
                if cur is None or cost < cur:
                    best[key] = cost
        return best

    def _augment_route_pool(
        self,
        manager: RoutePoolManager,
        anchors: Sequence[Individual],
        partition,
        target_employee_ids: Sequence[str],
        iteration: int,
        run_id: int,
        stop_controller: StopController,
        employee_prices: Optional[Dict[str, float]] = None,
    ) -> int:
        before = len(manager.get_routes())
        if not anchors:
            return 0

        variants_budget = max(1, self.route_pool_targeted_variants)
        targets = list(dict.fromkeys(str(v) for v in target_employee_ids if str(v).strip()))
        if employee_prices:
            priced = sorted(
                ((float(v), str(k)) for k, v in employee_prices.items()),
                key=lambda x: (-x[0], x[1]),
            )
            for _, emp_id in priced[:10]:
                if emp_id not in targets:
                    targets.append(emp_id)
        targets = targets[:12]

        built = 0
        base_rows = list(anchors)
        if getattr(partition, "individual", None) is not None:
            base_rows.append(copy.deepcopy(partition.individual))
        base_rows.sort(key=lambda x: x.objective_score)

        destroy_modes = ["related", "worst", "route"]
        for idx in range(min(len(base_rows), 4)):
            if built >= variants_budget:
                break
            if stop_controller.time_limit_reached():
                break

            base = base_rows[idx]
            variant = copy.deepcopy(base)

            if targets:
                slice_size = min(4, len(targets))
                picked = targets[(idx * slice_size) % len(targets): ((idx * slice_size) % len(targets)) + slice_size]
                if not picked:
                    picked = targets[:slice_size]
                removed = self.operators.remove_employees(variant, picked)
                if removed:
                    self.operators.repair_employees(
                        variant,
                        removed,
                        repair_mode="regret3",
                        strictness=0.92,
                        penalty_factor=10.0,
                    )

            variant = self.operators.ruin_and_recreate(
                variant,
                ruin_fraction=0.22,
                max_victims=5,
                penalty_factor=9.0,
                strictness=0.90,
                destroy_mode=destroy_modes[(iteration + idx) % len(destroy_modes)],
                repair_mode="regret3",
            )
            self.evaluator.evaluate(variant, penalty_factor=12.0, phase_progress=0.98, enforce_hard=False)

            manager.collect_from_individual(
                variant,
                source=f"targeted_iter_{iteration + 1}",
                run_id=run_id,
                generation=iteration,
                top_k_routes=(None if self.route_pool_iter_topk_routes <= 0 else int(self.route_pool_iter_topk_routes)),
            )
            built += 1

        after = len(manager.get_routes())
        return max(0, after - before)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _collect_diverse_candidates(self, population: Sequence[Individual], top_k: int) -> List[Individual]:
        if not population:
            return []

        ordered = sorted(population, key=lambda x: x.objective_score)
        selected: List[Individual] = []
        seen_hash = set()

        first = ordered[0]
        first_hash = structural_hash(first)
        first.structural_hash = first_hash
        selected.append(copy.deepcopy(first))
        seen_hash.add(first_hash)

        vectors = {structural_hash(ind): assignment_vector(self.problem, ind) for ind in ordered}

        while len(selected) < top_k:
            best_candidate = None
            best_score = float("inf")
            for ind in ordered:
                sig = structural_hash(ind)
                if sig in seen_hash:
                    continue

                vec = vectors[sig]
                distances = []
                for s in selected:
                    s_sig = structural_hash(s)
                    s_vec = vectors.get(s_sig)
                    if s_vec is None:
                        s_vec = assignment_vector(self.problem, s)
                    distances.append(normalized_hamming_distance(vec, s_vec))
                avg_dist = sum(distances) / max(1, len(distances))

                # low score preferred: objective rank minus diversity bonus.
                score = float(ind.objective_score) - (avg_dist * max(1.0, abs(ind.objective_score) * 0.02))
                tie = (score, float(ind.objective_score), sig)
                best_tie = (
                    best_score,
                    float(best_candidate.objective_score) if best_candidate is not None else float("inf"),
                    best_candidate.structural_hash if best_candidate is not None else "",
                )
                if best_candidate is None or tie < best_tie:
                    best_candidate = ind
                    best_score = score

            if best_candidate is None:
                break

            sig = structural_hash(best_candidate)
            best_candidate.structural_hash = sig
            selected.append(copy.deepcopy(best_candidate))
            seen_hash.add(sig)

            if len(selected) >= len(ordered):
                break

        return selected[:top_k]

    def _archive_candidates(
        self,
        source: str,
        generation: int,
        run_id: int,
        candidates: List[Individual],
    ) -> None:
        for individual in candidates:
            self.route_pool_archives.append(
                {
                    "source": str(source),
                    "generation": int(generation),
                    "runId": int(run_id),
                    "individual": copy.deepcopy(individual),
                    "topKRoutes": 3,
                }
            )

        if len(self.route_pool_archives) > self.route_pool_archive_limit:
            trim = len(self.route_pool_archives) - self.route_pool_archive_limit
            self.route_pool_archives = self.route_pool_archives[trim:]

    def _pick_destroy_mode(self, progress: float, stagnation_counter: int) -> str:
        stagnation_ratio = min(1.0, stagnation_counter / max(1, self.stagnation_limit))
        modes = [
            ("random", 0.40 + 0.05 * (1.0 - progress)),
            ("worst", 0.25 + 0.25 * stagnation_ratio),
            ("related", 0.20 + 0.20 * stagnation_ratio),
            ("route", 0.15 + 0.25 * stagnation_ratio),
        ]
        return self._weighted_pick(modes)

    def _pick_repair_mode(self, progress: float, stagnation_counter: int) -> str:
        stagnation_ratio = min(1.0, stagnation_counter / max(1, self.stagnation_limit))
        modes = [
            ("greedy", 0.50 - 0.20 * progress),
            ("regret2", 0.30 + 0.15 * stagnation_ratio),
            ("regret3", 0.20 + 0.20 * progress + 0.10 * stagnation_ratio),
        ]
        return self._weighted_pick(modes)

    def _weighted_pick(self, rows: List[tuple]) -> str:
        total = sum(max(1e-8, float(w)) for _, w in rows)
        cut = self.rng.random() * total
        acc = 0.0
        for name, weight in rows:
            acc += max(1e-8, float(weight))
            if acc >= cut:
                return name
        return rows[-1][0]

    def _assignment_map(self, individual: Individual) -> Dict[str, Optional[str]]:
        """Map each employee id to assigned vehicle id (or None).

        Used only for Exact-LNS fragment selection signals.
        """
        mapping: Dict[str, Optional[str]] = {str(e.id): None for e in (self.problem.employees or [])}
        for route in getattr(individual, "routes", []) or []:
            vid = str(getattr(getattr(route, "vehicle", None), "id", "")) or None
            for emp in getattr(route, "employees", []) or []:
                mapping[str(emp.id)] = vid
        for emp in getattr(individual, "unassigned", []) or []:
            mapping[str(emp.id)] = None
        return mapping

    def _update_employee_instability(self, incumbent: Individual) -> None:
        """Update per-employee assignment-change counters (best-effort).

        This is a low-cost global-search signal for guiding Exact-LNS fragment
        selection. It does not affect objective/feasibility semantics.
        """
        current = self._assignment_map(incumbent)
        if not self._last_assignment_map:
            self._last_assignment_map = dict(current)
            self._employee_instability = {str(k): 0 for k in current.keys()}
            return

        for emp_id, now in current.items():
            prev = self._last_assignment_map.get(emp_id)
            if prev != now:
                self._employee_instability[emp_id] = int(self._employee_instability.get(emp_id, 0)) + 1
        self._last_assignment_map = dict(current)

    def _is_individual_feasible(self, individual: Individual) -> bool:
        return bool(is_solution_feasible(individual))

    def _enforce_max_delay_policy(self, individual: Individual, max_passes: int = 2) -> Individual:
        """
        Employees delayed beyond their max allowed delay are forcibly removed.
        They can only be reinserted if a valid (within-threshold) placement exists.
        """
        candidate = copy.deepcopy(individual)
        self.evaluator.evaluate(candidate, penalty_factor=12.0, phase_progress=1.0, enforce_hard=True)
        overdelayed_ids = self._collect_overdelayed_employee_ids(candidate)
        if not overdelayed_ids:
            return candidate

        self.operators.remove_employees(candidate, overdelayed_ids)
        candidate = self.operators.force_reassign_unassigned(
            candidate,
            max_passes=max(1, int(max_passes)),
            strictness=1.0,
        )
        self.evaluator.evaluate(candidate, penalty_factor=12.0, phase_progress=1.0, enforce_hard=True)
        return candidate

    def _collect_overdelayed_employee_ids(self, individual: Individual) -> List[str]:
        employee_by_id = {str(emp.id): emp for emp in self.problem.employees}
        exceeded = set()

        for route in individual.routes:
            per_employee_delay = getattr(route, "employee_delay_minutes", {}) or {}
            for emp_id_raw, delay_raw in per_employee_delay.items():
                emp_id = str(emp_id_raw)
                emp = employee_by_id.get(emp_id)
                if emp is None:
                    continue
                delay_minutes = float(delay_raw or 0.0)
                max_allowed = float(get_max_allowed_delay(emp.priority, self.problem.metadata))
                if delay_minutes > max_allowed + 1e-9:
                    exceeded.add(emp_id)

        return sorted(exceeded)

    def _improvement_threshold(self, current_best_score: float) -> float:
        return max(
            float(self.significant_improvement_abs),
            abs(float(current_best_score)) * float(self.significant_improvement_rel),
        )

    def _prepare_assignment_seed(self, stop_controller: StopController) -> None:
        assignment_seed = None
        self.assignment_seed_info = {"backend": "disabled", "status": "disabled", "assignment": {}}

        if self.ortools_seed_assignment_enabled and stop_controller.can_run_for(0.2):
            assign_tl = min(
                self.ortools_assign_time_limit_sec,
                max(0.2, stop_controller.remaining_sec() * 0.25),
            )
            self.assignment_seed_info = build_assignment_seed(
                self.problem,
                time_limit_sec=assign_tl,
                seed=self.seed,
            )
            assignment_seed = self.assignment_seed_info.get("assignment") or None

        self.initializer = PopulationInitializer(self.problem, rng=self.rng, assignment_seed=assignment_seed)

    def _runtime_config_snapshot(self, stop_controller: StopController) -> Dict[str, object]:
        return {
            "seed": int(self.seed),
            "generations": int(self.generations),
            "employee_count": int(self.employee_count),
            "population": int(self.initial_pop_size),
            "alns_iterations": int(self.alns_iterations),
            "large_case_mode": str(self.large_case_mode or ""),
            "bypass_size_floors": bool(self.bypass_size_floors),
            "elite_size": int(self.elite_size),
            "stagnation_limit": int(self.stagnation_limit),
            "route_pool_enabled": bool(self.route_pool_enabled),
            "route_pool_pruning_mode": str(self.route_pool_pruning_mode),
            "route_pool_max_routes": int(self.route_pool_max_routes),
            "set_partition_time_limit_sec": float(self.set_partition_time_limit_sec),
            "set_partition_iter_limit": int(self.set_partition_iter_limit),
            "stop_controller": stop_controller.config_snapshot(),
            "early_stop_enabled": bool(self.early_stop_enabled),
            "min_early_stop_generations": int(self.min_early_stop_generations),
            "min_generation_floor": int(self.min_generation_floor),
            "min_runtime_floor_sec": float(self.min_runtime_floor_sec),
            "stagnation_grace_generations": int(self.stagnation_grace_generations),
            "best_run_grace_generations": int(self.best_run_grace_generations),
            "cross_run_target_rel_gap": float(self.cross_run_target_rel_gap),
            "cross_run_target_abs_gap": float(self.cross_run_target_abs_gap),
            "lagging_run_grace_generations": int(self.lagging_run_grace_generations),
            "lambda_diversity": float(self.lambda_diversity),
            "plateau_patience_generations": int(self.plateau_patience_generations),
            "infeasible_plateau_patience_generations": int(self.infeasible_plateau_patience_generations),
            "plateau_diversity_max": float(self.plateau_diversity_max),
            "restarts_before_convergence_stop": int(self.restarts_before_convergence_stop),
            "mip_probe_repeat_generations": int(self.mip_probe_repeat_generations),
            "mip_early_stop_min_plateau_generations": int(self.mip_early_stop_min_plateau_generations),
        }

    def _report_shared_progress(
        self,
        progress_tracker: Optional[Any],
        run_id: int,
        generation: int,
        best_score: float,
    ) -> None:
        if progress_tracker is None or not hasattr(progress_tracker, "update"):
            return
        try:
            progress_tracker.update(run_id=run_id, generation=generation, best_score=best_score)
        except TypeError:
            progress_tracker.update(run_id, generation, best_score)
        except Exception:
            return

    def _shared_progress_snapshot(self, progress_tracker: Optional[Any], run_id: int) -> Optional[Dict[str, Any]]:
        if progress_tracker is None or not hasattr(progress_tracker, "snapshot"):
            return None
        try:
            snapshot = progress_tracker.snapshot(run_id=run_id)
        except TypeError:
            snapshot = progress_tracker.snapshot(run_id)
        except Exception:
            return None
        return snapshot if isinstance(snapshot, dict) else None

    def _is_within_cross_run_target(self, score: float, target: float) -> bool:
        if not math.isfinite(float(score)) or not math.isfinite(float(target)):
            return False
        allowance = max(
            float(self.cross_run_target_abs_gap),
            abs(float(target)) * float(self.cross_run_target_rel_gap),
        )
        return float(score) <= float(target) + allowance

    def _should_stop_for_stagnation(
        self,
        stop_controller: StopController,
        run_id: int,
        generation: int,
        diversity_ratio: float,
        best_score: float,
        progress_tracker: Optional[Any],
        stagnation_detected_gen: Optional[int],
        last_improvement_gen: int,
        restart_count: int,
        best_solution_feasible: bool,
        best_solution_fully_assigned: bool,
    ) -> bool:
        if int(generation) < int(self._stagnation_generation_gate(best_solution_feasible, best_solution_fully_assigned)):
            return False
        checkpoint_stagnation_ready = stop_controller.should_stop_for_stagnation(diversity_ratio)
        plateau_stagnation_ready = self._should_stop_for_generation_plateau(
            stop_controller=stop_controller,
            generation=generation,
            last_improvement_gen=last_improvement_gen,
            diversity_ratio=diversity_ratio,
            restart_count=restart_count,
            best_solution_feasible=best_solution_feasible,
            best_solution_fully_assigned=best_solution_fully_assigned,
        )
        if not checkpoint_stagnation_ready and not plateau_stagnation_ready:
            return False

        plateau_age = max(0, int(generation) - int(last_improvement_gen))
        stagnation_start = int(stagnation_detected_gen or generation)
        checkpoint_age = max(0, int(generation) - stagnation_start)
        stagnation_age = max(plateau_age, checkpoint_age)

        snapshot = self._shared_progress_snapshot(progress_tracker, run_id=run_id)
        if snapshot:
            global_best_score = float(snapshot.get("globalBestScore", float("inf")))
            global_best_run_id = snapshot.get("globalBestRunId")
            if math.isfinite(global_best_score):
                if not self._is_within_cross_run_target(best_score, global_best_score):
                    lagging_grace = int(self.lagging_run_grace_generations)
                    if (not best_solution_feasible) or (not best_solution_fully_assigned):
                        lagging_grace = min(lagging_grace, int(self.infeasible_plateau_patience_generations))
                    return stagnation_age >= lagging_grace
                required_grace = int(self.best_run_grace_generations)
                if global_best_run_id is None or int(global_best_run_id) != int(run_id):
                    required_grace = int(self.stagnation_grace_generations)
                if not best_solution_fully_assigned:
                    required_grace = min(required_grace, int(self._partial_plateau_patience_generations() + 2))
                return stagnation_age >= required_grace

        required_grace = int(self.stagnation_grace_generations)
        if not best_solution_fully_assigned:
            required_grace = min(required_grace, int(self._partial_plateau_patience_generations() + 2))
        elif not best_solution_feasible:
            required_grace = min(required_grace, int(self.infeasible_plateau_patience_generations))
        return stagnation_age >= required_grace

    def _partial_plateau_patience_generations(self) -> int:
        return max(
            int(self.infeasible_plateau_patience_generations) + 1,
            int(math.ceil(self.plateau_patience_generations * 0.65)),
        )

    def _stagnation_generation_gate(self, best_solution_feasible: bool, best_solution_fully_assigned: bool) -> int:
        gate = int(self.min_early_stop_generations)
        if best_solution_feasible and best_solution_fully_assigned:
            return gate
        if not best_solution_fully_assigned:
            partial_gate = int(
                self._partial_plateau_patience_generations()
                + max(3, int(math.ceil(self.stagnation_grace_generations * 0.4)))
            )
            return max(0, min(gate, partial_gate))
        infeasible_gate = int(
            self.infeasible_plateau_patience_generations
            + max(3, int(math.ceil(self.stagnation_grace_generations * 0.35)))
        )
        return max(0, min(gate, infeasible_gate))

    def _should_stop_for_generation_plateau(
        self,
        stop_controller: StopController,
        generation: int,
        last_improvement_gen: int,
        diversity_ratio: float,
        restart_count: int,
        best_solution_feasible: bool,
        best_solution_fully_assigned: bool,
    ) -> bool:
        plateau_age = max(0, int(generation) - int(last_improvement_gen))
        if not best_solution_fully_assigned:
            patience = int(self._partial_plateau_patience_generations())
        else:
            patience = int(self.plateau_patience_generations)
            if not best_solution_feasible:
                patience = int(self.infeasible_plateau_patience_generations)
        if plateau_age < patience:
            return False
        if int(restart_count) >= int(self.restarts_before_convergence_stop):
            return True
        if not best_solution_fully_assigned:
            return plateau_age >= max(patience + 3, 1)
        if not best_solution_feasible:
            return plateau_age >= max(patience + 2, 1)
        if float(diversity_ratio) > float(self.plateau_diversity_max):
            return False
        return plateau_age >= max(patience + max(4, patience // 2), 1)

    def _should_accept_mip_early_stop(
        self,
        run_id: int,
        generation: int,
        best_score: float,
        last_improvement_gen: int,
        best_solution_feasible: bool,
        progress_tracker: Optional[Any],
    ) -> bool:
        if not best_solution_feasible:
            return False
        if int(generation) < int(self.min_early_stop_generations):
            return False
        plateau_age = max(0, int(generation) - int(last_improvement_gen))
        if plateau_age < int(self.mip_early_stop_min_plateau_generations):
            return False
        snapshot = self._shared_progress_snapshot(progress_tracker, run_id=run_id)
        if snapshot:
            global_best_score = float(snapshot.get("globalBestScore", float("inf")))
            if math.isfinite(global_best_score) and not self._is_within_cross_run_target(best_score, global_best_score):
                return False
        return True

    def _should_stop_for_time_limit(self, stop_controller: StopController, generations_executed: int) -> bool:
        if not stop_controller.time_limit_reached():
            return False
        return True

    def _log_event(self, event: str, **fields) -> None:
        payload = {"event": str(event), "ts": round(time.time(), 3)}
        payload.update(fields)
        self.logger.info(json.dumps(payload, separators=(",", ":"), sort_keys=True, default=str))

    def _resolve_time_limit(self, default: float) -> float:
        raw = self._meta_raw("TIME_LIMIT_SEC")
        if raw is None:
            raw = self._meta_raw("MAX_RUN_SECONDS")
        if raw is None:
            return float(default)
        try:
            value = float(raw)
        except Exception:
            return float(default)
        if value <= 0:
            return float(default)
        return float(_clamp(value, 1.0, 3600.0))

    def _resolve_route_pool_pruning_mode(self) -> str:
        raw = self._meta_raw("ROUTE_POOL_PRUNING_MODE")
        if raw is not None:
            text = str(raw).strip().lower()
            if text in ("safe", "proof", "conservative"):
                return "safe"
            return "heuristic"
        if self._meta_bool("ROUTE_POOL_SAFE_MODE", default=False):
            return "safe"
        return "heuristic"

    def _meta_candidates(self, key: str) -> List[str]:
        text = str(key or "").strip()
        variants = {text, text.lower(), text.upper()}
        snake = text.replace("-", "_")
        variants.update({snake, snake.lower(), snake.upper()})
        return [item for item in variants if item]

    def _meta_raw(self, key: str):
        meta = self.metadata or {}
        for candidate in self._meta_candidates(key):
            if candidate in meta:
                return meta.get(candidate)
        return None

    def _meta_bool(self, key: str, default: bool) -> bool:
        raw = self._meta_raw(key)
        if raw is None:
            return bool(default)
        text = str(raw).strip().lower()
        if text in ("1", "true", "yes", "on"):
            return True
        if text in ("0", "false", "no", "off"):
            return False
        return bool(default)

    def _meta_float(self, key: str, default: float, lo: float, hi: float) -> float:
        raw = self._meta_raw(key)
        if raw is None:
            return float(default)
        try:
            value = float(raw)
        except Exception:
            return float(default)
        return float(_clamp(value, lo, hi))

    def _meta_int(self, key: str, default: int, lo: int, hi: int) -> int:
        raw = self._meta_raw(key)
        if raw is None:
            return int(default)
        try:
            value = int(float(raw))
        except Exception:
            return int(default)
        return int(max(lo, min(hi, value)))

    def _seed_everything(self, seed: int) -> None:
        random.seed(seed)
        try:
            import numpy as np  # type: ignore

            np.random.seed(seed % (2**32 - 1))
        except Exception:
            pass
