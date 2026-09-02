"""
Regression tests for HGS competitive upgrades:
  - Optional two-subpopulation survivor selection wiring
  - Neighborhood hit-rate metrics emitted by offspring education / local search
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _canonical_payload(extra_metadata=None):
    meta = {"distance_metric": "haversine", "seed": 13}
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
            {
                "id": "E3",
                "priority": "Low",
                "pickup": {"lat": 12.9871, "lng": 77.5663},
                "dropoff": {"lat": 12.9312, "lng": 77.6017},
                "time_window": {"start": "08:05", "end": "09:40"},
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
            },
            {
                "id": "V2",
                "capacity": 2,
                "cost_per_km": 12,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 12.9760, "lng": 77.5993},
                "available_time": "07:45",
                "category": "normal",
                "fuel_type": "petrol",
            },
        ],
        "baseline": {
            "E1": {"cost": 220, "time": 45},
            "E2": {"cost": 240, "time": 48},
            "E3": {"cost": 210, "time": 44},
        },
    }


class TestNeighborhoodMetrics:
    def test_improve_emits_neighborhood_metrics(self):
        from parser import JsonParser
        from solver import GeneticSolver
        from utils import configure_distance_metric

        problem = JsonParser().load_from_canonical(_canonical_payload())
        configure_distance_metric(problem.metadata.get("distance_metric"))
        solver = GeneticSolver(problem=problem, generations=2, pop_size=4, alns_iterations=0, seed=99)
        population = solver.initializer.generate_population(2, solver.strategy_config)
        ind = population[0]
        solver.evaluator.evaluate(ind, penalty_factor=1.0, phase_progress=0.2, enforce_hard=False)

        improved = solver.neighborhoods.improve(ind, max_moves=2, penalty_factor=1.0, phase_progress=0.5)
        meta = getattr(improved, "metadata", {}) or {}
        assert "neighborhoodMetrics" in meta
        nm = meta["neighborhoodMetrics"]
        assert isinstance(nm, dict)
        # At minimum, the configured neighborhoods should appear.
        assert "inter_route_relocate" in nm
        assert "inter_route_swap" in nm


class TestHGSTwoSubpopulationWiring:
    def test_subpopulation_enabled_emits_population_counts(self):
        from parser import JsonParser
        from solver import GeneticSolver
        from utils import configure_distance_metric

        problem = JsonParser().load_from_canonical(
            _canonical_payload(
                extra_metadata={
                    "HGS_SUBPOPULATION_ENABLED": "true",
                    "HGS_SUBPOPULATION_INFEASIBLE_FRACTION": 0.50,
                    "OFFSPRING_EDUCATION_ENABLED": "true",
                    "OFFSPRING_EDUCATION_MAX_MOVES": 1,
                }
            )
        )
        configure_distance_metric(problem.metadata.get("distance_metric"))
        solver = GeneticSolver(problem=problem, generations=4, pop_size=6, alns_iterations=0, seed=7)
        _, run_meta = solver.solve(run_id=1)

        assert run_meta.get("hgsSubpopulationEnabled") is True
        assert "hgsEducationNeighborhoodStats" in run_meta
        assert isinstance(run_meta["hgsEducationNeighborhoodStats"], dict)

        history = run_meta.get("generationObjectiveHistory", [])
        assert history, "expected generation history"
        for entry in history:
            pop_size = int(entry.get("populationSize") or 0)
            assert pop_size == int(solver.initial_pop_size)
            feasible = entry.get("populationFeasibleCount")
            infeasible = entry.get("populationInfeasibleCount")
            assert isinstance(feasible, int)
            assert isinstance(infeasible, int)
            assert feasible + infeasible == pop_size
