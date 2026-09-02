import math
import sys
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from objective import ObjectiveEvaluator
from parser import JsonParser
from solver import GeneticSolver
from utils import configure_distance_metric


def _canonical_feasible_case():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "ROUTE_POOL_ENABLED": "true",
            "ORTOOLS_SEED_ASSIGNMENT_ENABLED": "false",
            "TIME_LIMIT_SEC": 12,
            "MIN_RUNTIME_SEC": 1,
        },
        "employees": [
            {
                "id": "E1",
                "priority": "High",
                "pickup": {"lat": 12.9716, "lng": 77.5946},
                "dropoff": {"lat": 12.9352, "lng": 77.6245},
                "time_window": {"start": "08:00", "end": "09:30"},
                "vehicle_preference": "premium",
                "sharing_preference": "single",
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
                "pickup": {"lat": 12.9857, "lng": 77.6050},
                "dropoff": {"lat": 12.9225, "lng": 77.6402},
                "time_window": {"start": "08:05", "end": "09:55"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
            {
                "id": "E4",
                "priority": "Low",
                "pickup": {"lat": 12.9570, "lng": 77.6100},
                "dropoff": {"lat": 12.9190, "lng": 77.6440},
                "time_window": {"start": "08:15", "end": "10:00"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
        ],
        "vehicles": [
            {
                "id": "V1",
                "fuel_type": "petrol",
                "capacity": 2,
                "cost_per_km": 13,
                "avg_speed_kmph": 26,
                "start_location": {"lat": 12.9760, "lng": 77.5993},
                "available_time": "07:40",
                "category": "premium",
            },
            {
                "id": "V2",
                "fuel_type": "diesel",
                "capacity": 3,
                "cost_per_km": 10,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 12.9485, "lng": 77.5921},
                "available_time": "07:45",
                "category": "normal",
            },
        ],
        "baseline": {
            "E1": {"cost": 250, "time": 50},
            "E2": {"cost": 240, "time": 48},
            "E3": {"cost": 230, "time": 46},
            "E4": {"cost": 220, "time": 44},
        },
    }


def test_final_solution_is_hard_feasible():
    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_feasible_case())
    solver = GeneticSolver(problem, generations=80, pop_size=14, alns_iterations=5, seed=202)

    solution, _ = solver.solve(run_id=1)

    evaluator = ObjectiveEvaluator(problem)
    evaluator.evaluate(solution, penalty_factor=15.0, phase_progress=1.0, enforce_hard=True)

    assert not solution.unassigned
    assert not solution.consistency_errors
    for route in solution.routes:
        if not route.stop_sequence:
            continue
        assert route.is_feasible
        assert not route.consistency_errors

    assert math.isfinite(float(solution.objective_score))
    assert str(solution.structural_hash)
