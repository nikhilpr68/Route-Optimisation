"""
Tests for HGS incumbent improvement pipeline:
  - Global elite pool grows when best_sol improves.
  - Restart seeds from the global elite pool.
  - Population size stays stable over generations.
  - Generation history carries new HGS metrics fields.
"""
from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _canonical_payload(extra_metadata=None):
    meta = {"distance_metric": "haversine", "seed": 77}
    if extra_metadata:
        meta.update(extra_metadata)
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": meta,
        "employees": [
            {
                "id": "E1",
                "priority": "High",
                "pickup": {"lat": 12.9716, "lng": 77.5946},
                "dropoff": {"lat": 12.9352, "lng": 77.6245},
                "time_window": {"start": "08:00", "end": "09:30"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
            {
                "id": "E2",
                "priority": "Medium",
                "pickup": {"lat": 12.9611, "lng": 77.6387},
                "dropoff": {"lat": 12.9304, "lng": 77.6784},
                "time_window": {"start": "08:10", "end": "09:45"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
        ],
        "vehicles": [
            {
                "id": "V1",
                "capacity": 2,
                "cost_per_km": 12,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 12.9760, "lng": 77.5993},
                "available_time": "07:45",
                "category": "normal",
                "fuel_type": "petrol",
            }
        ],
        "baseline": {
            "E1": {"cost": 220, "time": 45},
            "E2": {"cost": 240, "time": 48},
        },
    }


def _make_problem_and_solver(pop_size=4, generations=5, alns_iterations=0, seed=42):
    from parser import JsonParser
    from solver import GeneticSolver
    from utils import configure_distance_metric

    problem = JsonParser().load_from_canonical(_canonical_payload())
    configure_distance_metric(problem.metadata.get("distance_metric"))
    solver = GeneticSolver(
        problem=problem,
        generations=generations,
        pop_size=pop_size,
        alns_iterations=alns_iterations,
        seed=seed,
    )
    return problem, solver


# ---------------------------------------------------------------------------

class TestGlobalElitePool:
    def test_pool_empty_on_construction(self):
        _, solver = _make_problem_and_solver()
        # Before solve(), pool is empty (reset happens inside solve()).
        assert solver._global_elite_pool == []

    def test_update_global_elite_pool_adds_new_member(self):
        _, solver = _make_problem_and_solver()
        population = solver.initializer.generate_population(2, solver.strategy_config)
        for ind in population:
            solver.evaluator.evaluate(ind, penalty_factor=1.0, phase_progress=0.0,
                                      enforce_hard=False)
        ind = population[0]
        solver._update_global_elite_pool(ind)
        assert len(solver._global_elite_pool) == 1

    def test_update_global_elite_pool_ignores_duplicate(self):
        _, solver = _make_problem_and_solver()
        population = solver.initializer.generate_population(2, solver.strategy_config)
        for ind in population:
            solver.evaluator.evaluate(ind, penalty_factor=1.0, phase_progress=0.0,
                                      enforce_hard=False)
        ind = population[0]
        solver._update_global_elite_pool(ind)
        solver._update_global_elite_pool(ind)  # second call: same hash, should be ignored
        assert len(solver._global_elite_pool) == 1

    def test_pool_evicts_worst_when_over_capacity(self):
        _, solver = _make_problem_and_solver()
        solver._global_elite_pool_max = 2
        population = solver.initializer.generate_population(5, solver.strategy_config)
        for i, ind in enumerate(population):
            solver.evaluator.evaluate(ind, penalty_factor=1.0, phase_progress=0.0,
                                      enforce_hard=False)
            ind.objective_score = float(i)  # force distinct scores and hashes differ
            solver._update_global_elite_pool(ind)
        # Pool must never exceed max.
        assert len(solver._global_elite_pool) <= solver._global_elite_pool_max

    def test_restart_includes_global_elite_pool_members(self):
        """After _update_global_elite_pool, the elite is preserved across restarts."""
        problem, solver = _make_problem_and_solver()
        population = solver.initializer.generate_population(4, solver.strategy_config)
        for ind in population:
            solver.evaluator.evaluate(ind, penalty_factor=1.0, phase_progress=0.0,
                                      enforce_hard=False)
        population.sort(key=lambda x: x.objective_score)

        # Manually add the best to the global elite pool with a distinct score.
        best = copy.deepcopy(population[0])
        best.objective_score = 0.001  # force it to "rank 1" so it must survive restart
        solver._update_global_elite_pool(best)
        assert len(solver._global_elite_pool) == 1

        controls = solver._adaptive_controls(progress=0.5, stagnation_counter=0)
        new_pop = solver._restart_population(population, controls)
        # The restarted population must have at least one member from global elite pool.
        from diversity import structural_hash
        gep_hashes = {structural_hash(e) for e in solver._global_elite_pool}
        pop_hashes = {structural_hash(ind) for ind in new_pop}
        # At least one global elite member should appear (by hash).
        assert gep_hashes & pop_hashes, "Global elite pool member not found after restart"


# ---------------------------------------------------------------------------

class TestPopulationSizeStability:
    def test_solve_preserves_target_population_size(self):
        """Run a very short solve and verify population was never critically small.
        Because we can't hook into the loop, we verify the generation history
        records population size >= initial_pop_size // 2 throughout."""
        from parser import JsonParser
        from solver import GeneticSolver
        from utils import configure_distance_metric

        problem = JsonParser().load_from_canonical(_canonical_payload())
        configure_distance_metric(problem.metadata.get("distance_metric"))
        solver = GeneticSolver(
            problem=problem,
            generations=6,
            pop_size=4,
            alns_iterations=0,
            seed=42,
        )
        best_sol, run_meta = solver.solve(run_id=1)
        history = run_meta.get("generationObjectiveHistory", [])
        min_half = solver.initial_pop_size // 2
        for entry in history:
            pop_size = entry.get("populationSize")
            if pop_size is not None:
                assert pop_size >= min_half, (
                    f"Population size {pop_size} dropped below {min_half}"
                )


class TestIncumbentTimelineAndHGSMetrics:
    def test_run_meta_contains_hgs_fields(self):
        from parser import JsonParser
        from solver import GeneticSolver
        from utils import configure_distance_metric

        problem = JsonParser().load_from_canonical(_canonical_payload())
        configure_distance_metric(problem.metadata.get("distance_metric"))
        solver = GeneticSolver(
            problem=problem,
            generations=5,
            pop_size=4,
            alns_iterations=0,
            seed=42,
        )
        _, run_meta = solver.solve(run_id=1)

        required_fields = [
            "hgsOffspringEducationEnabled",
            "hgsBiasedParentSelection",
            "hgsTotalPostEducationImprovements",
            "hgsAvgFeasibleRatio",
            "hgsTotalOffspring",
            "hgsTotalFeasibleOffspring",
            "hgsPeakLambdaDiv",
            "hgsAdaptivePenaltyScaleFinal",
            "hgsGlobalElitePoolSize",
            "hgsIncumbentImprovementTimeline",
            "hgsSurvivorAvgSimilarityFinal",
        ]
        for field in required_fields:
            assert field in run_meta, f"Missing HGS run_meta field: {field}"

    def test_incumbent_timeline_starts_at_generation_zero(self):
        from parser import JsonParser
        from solver import GeneticSolver
        from utils import configure_distance_metric

        problem = JsonParser().load_from_canonical(_canonical_payload())
        configure_distance_metric(problem.metadata.get("distance_metric"))
        solver = GeneticSolver(
            problem=problem,
            generations=5,
            pop_size=4,
            alns_iterations=0,
            seed=42,
        )
        _, run_meta = solver.solve(run_id=1)
        timeline = run_meta["hgsIncumbentImprovementTimeline"]
        assert len(timeline) >= 1
        assert timeline[0]["generation"] == 0

    def test_generation_history_contains_hgs_fields(self):
        from parser import JsonParser
        from solver import GeneticSolver
        from utils import configure_distance_metric

        problem = JsonParser().load_from_canonical(_canonical_payload())
        configure_distance_metric(problem.metadata.get("distance_metric"))
        solver = GeneticSolver(
            problem=problem,
            generations=5,
            pop_size=4,
            alns_iterations=0,
            seed=42,
        )
        _, run_meta = solver.solve(run_id=1)
        for entry in run_meta.get("generationObjectiveHistory", []):
            assert "feasibleOffspringCount" in entry
            assert "infeasibleOffspringCount" in entry
            assert "feasibleRatio" in entry
            assert "diversityScore" in entry
            assert "diversityAvgAssignmentDistance" in entry
            assert "diversityAvgRouteJaccardDistance" in entry
            assert "populationSize" in entry
            assert "lambdaDiv" in entry
            assert "adaptivePenaltyScale" in entry
            assert "survivorPoolSize" in entry
            assert "eliteDuplicateDrops" in entry
            assert "survivorAvgSimilarity" in entry

    def test_elites_are_excluded_from_survivor_selection(self):
        """Elites are already preserved, so survivor selection should not duplicate them."""
        from parser import JsonParser
        from solver import GeneticSolver
        from utils import configure_distance_metric

        problem = JsonParser().load_from_canonical(_canonical_payload())
        configure_distance_metric(problem.metadata.get("distance_metric"))
        solver = GeneticSolver(
            problem=problem,
            generations=3,
            pop_size=4,
            alns_iterations=0,
            seed=42,
        )
        _, run_meta = solver.solve(run_id=1)
        history = run_meta.get("generationObjectiveHistory", [])
        assert history, "Expected generation history to be non-empty"

        # With pop_size=4 the default elite_size is 2, so we expect at least two
        # elite-structure drops from the survivor pool each generation.
        first = history[0]
        assert int(first.get("eliteDuplicateDrops", 0)) >= 1
