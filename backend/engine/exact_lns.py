from __future__ import annotations

import copy
import random
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from initialization import PopulationInitializer
from models import Baseline, Employee, ProblemInstance, Vehicle
from objective import ObjectiveEvaluator
from representation import Individual, Route
from route_pool import build_route_pool
from set_partition import solve_set_partition
from solution_objective import get_solution_base_objective
from solution_status import is_solution_feasible


@dataclass(frozen=True)
class ExactLnsConfig:
    enabled: bool = False
    attempts: int = 0
    # Fragment selection strategy:
    # - auto: choose best available signal (dual_hot -> unstable -> worst_cost)
    # - random_routes | worst_cost | worst_delay | worst_penalty (existing)
    # - dual_hot: routes covering high-dual employees (restricted-master signal)
    # - unstable: routes covering employees with unstable assignments (global-search signal)
    strategy: str = "worst_cost"
    fragment_routes: int = 2
    max_fragment_employees: int = 18
    include_unassigned: bool = True
    seed_population: int = 10
    pool_max_routes: int = 220
    pool_pruning_mode: str = "heuristic"
    time_limit_sec: float = 3.0


@dataclass
class ExactLnsAttempt:
    status: str
    accepted: bool
    improved_base_objective: float
    incumbent_base_objective: float
    fragment_vehicle_ids: List[str]
    fragment_employee_ids: List[str]
    solve_time_sec: float
    solver_backend: str
    pool_stats: Dict[str, object]
    set_partition_stats: Dict[str, object]
    candidate: Optional[Individual] = None


@dataclass(frozen=True)
class ExactLnsSignals:
    """Optional global-search/master signals to guide exact-LNS selection."""

    employee_scores: Dict[str, float]
    employee_instability: Dict[str, int]
    source: str = "none"


def _route_base_score(problem: ProblemInstance, route: Route) -> float:
    return float(problem.cost_weight) * float(getattr(route, "total_cost", 0.0)) + float(problem.time_weight) * float(
        getattr(route, "total_time", 0.0)
    )


def select_fragment_routes(
    problem: ProblemInstance,
    incumbent: Individual,
    strategy: str,
    fragment_routes: int,
    include_unassigned: bool,
    signals: Optional[ExactLnsSignals] = None,
    rng: Optional[random.Random] = None,
) -> Tuple[List[str], List[str], Dict[str, object]]:
    """Select a fragment as a subset of incumbent routes (vehicles).

    This fragment definition is *structurally safe* to reoptimize: we remove a
    small set of whole-vehicle routes, keeping all other vehicle routes fixed.
    The subproblem then reassigns only the employees from the destroyed routes
    across the same destroyed vehicle set (at most one route per vehicle).
    """
    fragment_routes = max(0, int(fragment_routes))
    strategy = str(strategy or "worst_cost").strip().lower()

    employee_scores = dict(getattr(signals, "employee_scores", {}) or {})
    employee_instability = dict(getattr(signals, "employee_instability", {}) or {})
    signals_source = str(getattr(signals, "source", "none") or "none")

    chosen_strategy = strategy
    if strategy == "auto":
        if employee_scores:
            chosen_strategy = "dual_hot"
        elif employee_instability:
            chosen_strategy = "unstable"
        else:
            chosen_strategy = "worst_cost"

    scored: List[Tuple[Tuple[float, float, str], str, List[str]]] = []
    for route in getattr(incumbent, "routes", []) or []:
        passenger_ids = sorted({str(emp.id) for emp in (route.employees or [])})
        if not passenger_ids:
            continue
        vehicle_id = str(route.vehicle.id)
        if chosen_strategy == "dual_hot":
            dual_sum = sum(float(employee_scores.get(eid, 0.0) or 0.0) for eid in passenger_ids)
            # Primary: maximize dual coverage; secondary: tie-break by base route score.
            key = (dual_sum, _route_base_score(problem, route), vehicle_id)
        elif chosen_strategy == "unstable":
            unstable_sum = sum(float(employee_instability.get(eid, 0) or 0) for eid in passenger_ids)
            key = (unstable_sum, _route_base_score(problem, route), vehicle_id)
        elif chosen_strategy == "worst_delay":
            key = (float(getattr(route, "total_delay", 0.0)), _route_base_score(problem, route), vehicle_id)
        elif chosen_strategy == "worst_penalty":
            penalty_total = 0.0
            pb = getattr(route, "penalty_breakdown", {}) or {}
            for v in pb.values():
                try:
                    penalty_total += float(v)
                except Exception:
                    continue
            key = (penalty_total, _route_base_score(problem, route), vehicle_id)
        else:
            # worst_cost (default): use base contribution (cost+time) only.
            key = (_route_base_score(problem, route), float(getattr(route, "total_delay", 0.0)), vehicle_id)
        scored.append((key, vehicle_id, passenger_ids))

    if not scored or fragment_routes <= 0:
        vehicle_ids: List[str] = []
        employee_ids: List[str] = []
        if include_unassigned:
            employee_ids = sorted({str(emp.id) for emp in (incumbent.unassigned or [])})
        return vehicle_ids, employee_ids, {"reason": "empty_or_disabled"}

    if chosen_strategy == "random_routes":
        if rng is None:
            ordered = scored[:]
        else:
            k = min(fragment_routes, len(scored))
            ordered = rng.sample(scored, k)
    else:
        ordered = sorted(scored, key=lambda x: x[0], reverse=True)

    chosen = ordered[: min(fragment_routes, len(ordered))]
    chosen_vehicle_ids = [vehicle_id for _, vehicle_id, _ in chosen]

    fragment_employee_ids = set()
    for _, _, passenger_ids in chosen:
        fragment_employee_ids.update(passenger_ids)
    if include_unassigned:
        fragment_employee_ids.update(str(emp.id) for emp in (incumbent.unassigned or []))

    meta = {
        "strategyRequested": str(strategy),
        "strategyUsed": str(chosen_strategy),
        "signalsSource": signals_source,
        "signalsAvailable": {
            "employeeScores": bool(employee_scores),
            "employeeInstability": bool(employee_instability),
        },
        "candidateRouteCount": int(len(scored)),
        "chosenRouteCount": int(len(chosen_vehicle_ids)),
        "fragmentEmployeeCount": int(len(fragment_employee_ids)),
    }
    return chosen_vehicle_ids, sorted(fragment_employee_ids), meta


def build_fragment_problem(
    problem: ProblemInstance,
    fragment_employee_ids: Sequence[str],
    fragment_vehicle_ids: Sequence[str],
) -> ProblemInstance:
    employee_id_set = {str(eid) for eid in (fragment_employee_ids or [])}
    vehicle_id_set = {str(vid) for vid in (fragment_vehicle_ids or [])}

    employees = [emp for emp in (problem.employees or []) if str(emp.id) in employee_id_set]
    vehicles = [veh for veh in (problem.vehicles or []) if str(veh.id) in vehicle_id_set]

    baseline: Dict[str, Baseline] = {}
    for emp_id, b in (getattr(problem, "baseline", {}) or {}).items():
        if str(emp_id) in employee_id_set:
            baseline[str(emp_id)] = b

    return ProblemInstance(
        employees=employees,
        vehicles=vehicles,
        metadata=dict(getattr(problem, "metadata", {}) or {}),
        baseline=baseline,
    )


def splice_fragment_solution(
    full_problem: ProblemInstance,
    incumbent: Individual,
    fragment_solution: Individual,
    fragment_vehicle_ids: Sequence[str],
    fragment_employee_ids: Sequence[str],
) -> Individual:
    vehicle_id_set = {str(v) for v in (fragment_vehicle_ids or [])}
    employee_id_set = {str(e) for e in (fragment_employee_ids or [])}

    fragment_routes_by_vehicle = {str(r.vehicle.id): r for r in (fragment_solution.routes or [])}

    new_routes: List[Route] = []
    for route in (incumbent.routes or []):
        vehicle_id = str(route.vehicle.id)
        if vehicle_id in vehicle_id_set:
            replacement = fragment_routes_by_vehicle.get(vehicle_id)
            if replacement is None:
                new_routes.append(Route(vehicle=route.vehicle, employees=[], stop_sequence=[]))
            else:
                # Keep original vehicle object from incumbent/full_problem for consistency.
                new_routes.append(
                    Route(
                        vehicle=route.vehicle,
                        employees=list(replacement.employees or []),
                        stop_sequence=list(replacement.stop_sequence or []),
                    )
                )
        else:
            new_routes.append(
                Route(
                    vehicle=route.vehicle,
                    employees=list(route.employees or []),
                    stop_sequence=list(route.stop_sequence or []),
                )
            )

    fixed_unassigned = [emp for emp in (incumbent.unassigned or []) if str(emp.id) not in employee_id_set]
    fragment_unassigned = [emp for emp in (fragment_solution.unassigned or []) if str(emp.id) in employee_id_set]
    merged = Individual(routes=new_routes, unassigned=fixed_unassigned + fragment_unassigned)

    # Ensure employee objects come from full_problem where possible.
    employee_by_id: Dict[str, Employee] = {str(emp.id): emp for emp in (full_problem.employees or [])}
    for route in merged.routes:
        normalized_sequence = []
        for stop in route.stop_sequence:
            emp = stop.get("emp") if isinstance(stop, dict) else None
            stop_type = stop.get("type") if isinstance(stop, dict) else None
            if emp is None or stop_type not in ("p", "d"):
                continue
            emp_id = str(getattr(emp, "id", ""))
            if emp_id in employee_by_id:
                normalized_sequence.append({"type": stop_type, "emp": employee_by_id[emp_id]})
        route.stop_sequence = normalized_sequence
        route.employees = [employee_by_id[str(emp.id)] for emp in (route.employees or []) if str(emp.id) in employee_by_id]

    merged.unassigned = [employee_by_id[str(emp.id)] for emp in merged.unassigned if str(emp.id) in employee_by_id]
    return merged


def should_accept_splice(
    evaluator: ObjectiveEvaluator,
    incumbent: Individual,
    candidate: Individual,
    eps: float = 1e-9,
) -> Tuple[bool, float, float]:
    evaluator.evaluate(incumbent, penalty_factor=15.0, phase_progress=1.0, enforce_hard=True)
    evaluator.evaluate(candidate, penalty_factor=15.0, phase_progress=1.0, enforce_hard=True)

    incumbent_base = float(get_solution_base_objective(incumbent))
    candidate_base = float(get_solution_base_objective(candidate))

    if not is_solution_feasible(candidate):
        return False, candidate_base, incumbent_base

    return (candidate_base + eps) < incumbent_base, candidate_base, incumbent_base


def run_exact_lns_attempt(
    problem: ProblemInstance,
    incumbent: Individual,
    config: ExactLnsConfig,
    rng: random.Random,
    time_budget_sec: Optional[float] = None,
    signals: Optional[ExactLnsSignals] = None,
) -> ExactLnsAttempt:
    if not config.enabled:
        return ExactLnsAttempt(
            status="disabled",
            accepted=False,
            improved_base_objective=float("inf"),
            incumbent_base_objective=float("inf"),
            fragment_vehicle_ids=[],
            fragment_employee_ids=[],
            solve_time_sec=0.0,
            solver_backend="none",
            pool_stats={},
            set_partition_stats={},
            candidate=None,
        )

    start = time.perf_counter()
    evaluator_full = ObjectiveEvaluator(problem)
    incumbent_copy = copy.deepcopy(incumbent)
    evaluator_full.evaluate(incumbent_copy, penalty_factor=15.0, phase_progress=1.0, enforce_hard=True)
    incumbent_base = float(get_solution_base_objective(incumbent_copy))

    fragment_vehicle_ids, fragment_employee_ids, frag_meta = select_fragment_routes(
        problem=problem,
        incumbent=incumbent_copy,
        strategy=config.strategy,
        fragment_routes=config.fragment_routes,
        include_unassigned=config.include_unassigned,
        signals=signals,
        rng=rng,
    )
    if not fragment_vehicle_ids or not fragment_employee_ids:
        return ExactLnsAttempt(
            status="no_fragment",
            accepted=False,
            improved_base_objective=incumbent_base,
            incumbent_base_objective=incumbent_base,
            fragment_vehicle_ids=list(fragment_vehicle_ids),
            fragment_employee_ids=list(fragment_employee_ids),
            solve_time_sec=float(time.perf_counter() - start),
            solver_backend="none",
            pool_stats={"fragment": frag_meta},
            set_partition_stats={},
            candidate=None,
        )

    if len(fragment_employee_ids) > int(config.max_fragment_employees):
        return ExactLnsAttempt(
            status="oversize_fragment",
            accepted=False,
            improved_base_objective=incumbent_base,
            incumbent_base_objective=incumbent_base,
            fragment_vehicle_ids=list(fragment_vehicle_ids),
            fragment_employee_ids=list(fragment_employee_ids),
            solve_time_sec=float(time.perf_counter() - start),
            solver_backend="none",
            pool_stats={"fragment": frag_meta},
            set_partition_stats={"reason": "max_fragment_employees_exceeded"},
            candidate=None,
        )

    fragment_problem = build_fragment_problem(
        problem=problem,
        fragment_employee_ids=fragment_employee_ids,
        fragment_vehicle_ids=fragment_vehicle_ids,
    )
    evaluator_fragment = ObjectiveEvaluator(fragment_problem)

    # Seed individual from incumbent fragment (destroyed vehicles only).
    fragment_routes: List[Route] = []
    incumbent_routes_by_vehicle = {str(r.vehicle.id): r for r in (incumbent_copy.routes or [])}
    vehicle_by_id: Dict[str, Vehicle] = {str(v.id): v for v in (fragment_problem.vehicles or [])}
    for vehicle in fragment_problem.vehicles:
        old = incumbent_routes_by_vehicle.get(str(vehicle.id))
        if old is None:
            fragment_routes.append(Route(vehicle=vehicle, employees=[], stop_sequence=[]))
        else:
            fragment_routes.append(
                Route(
                    vehicle=vehicle_by_id[str(vehicle.id)],
                    employees=list(old.employees or []),
                    stop_sequence=list(old.stop_sequence or []),
                )
            )
    seed_individual = Individual(routes=fragment_routes, unassigned=[])
    evaluator_fragment.evaluate(seed_individual, penalty_factor=12.0, phase_progress=0.8, enforce_hard=False)

    initializer = PopulationInitializer(fragment_problem, rng=rng, assignment_seed=None)
    seeds = [seed_individual]
    seed_count = max(0, int(config.seed_population) - 1)
    if seed_count > 0:
        seeds.extend(
            initializer.generate_population(
                seed_count,
                {"regret": 0.30, "grasp": 0.30, "random": 0.40},
            )
        )
        for ind in seeds[1:]:
            evaluator_fragment.evaluate(ind, penalty_factor=12.0, phase_progress=0.8, enforce_hard=False)

    # Build restricted route pool for fragment and solve set partition exactly over it.
    pool_routes, pool_stats = build_route_pool(
        problem=fragment_problem,
        individuals=seeds,
        archives=[],
        max_routes=int(config.pool_max_routes),
        evaluator=evaluator_fragment,
        pruning_mode=str(config.pool_pruning_mode or "heuristic"),
    )

    if not pool_routes:
        return ExactLnsAttempt(
            status="no_routes",
            accepted=False,
            improved_base_objective=incumbent_base,
            incumbent_base_objective=incumbent_base,
            fragment_vehicle_ids=list(fragment_vehicle_ids),
            fragment_employee_ids=list(fragment_employee_ids),
            solve_time_sec=float(time.perf_counter() - start),
            solver_backend="none",
            pool_stats={"fragment": frag_meta, **(pool_stats or {})},
            set_partition_stats={"reason": "empty_fragment_route_pool"},
            candidate=None,
        )

    budget = float(time_budget_sec if time_budget_sec is not None else config.time_limit_sec)
    remaining = max(0.2, budget)
    setp_result = solve_set_partition(
        fragment_problem,
        pool_routes,
        time_limit_sec=remaining,
        allow_relaxed_fallback=False,
        evaluator=evaluator_fragment,
    )

    if setp_result.individual is None:
        return ExactLnsAttempt(
            status=f"set_partition_{setp_result.status}",
            accepted=False,
            improved_base_objective=incumbent_base,
            incumbent_base_objective=incumbent_base,
            fragment_vehicle_ids=list(fragment_vehicle_ids),
            fragment_employee_ids=list(fragment_employee_ids),
            solve_time_sec=float(time.perf_counter() - start),
            solver_backend=str(setp_result.backend),
            pool_stats={"fragment": frag_meta, **(pool_stats or {})},
            set_partition_stats=dict(setp_result.metadata or {}),
            candidate=None,
        )

    spliced = splice_fragment_solution(
        full_problem=problem,
        incumbent=incumbent_copy,
        fragment_solution=setp_result.individual,
        fragment_vehicle_ids=fragment_vehicle_ids,
        fragment_employee_ids=fragment_employee_ids,
    )
    accepted, candidate_base, _ = should_accept_splice(evaluator_full, incumbent_copy, spliced)

    return ExactLnsAttempt(
        status="accepted" if accepted else "rejected",
        accepted=bool(accepted),
        improved_base_objective=float(candidate_base),
        incumbent_base_objective=float(incumbent_base),
        fragment_vehicle_ids=list(fragment_vehicle_ids),
        fragment_employee_ids=list(fragment_employee_ids),
        solve_time_sec=float(time.perf_counter() - start),
        solver_backend=str(setp_result.backend),
        pool_stats={"fragment": frag_meta, **(pool_stats or {})},
        set_partition_stats=dict(setp_result.metadata or {}),
        candidate=(spliced if accepted else None),
    )
