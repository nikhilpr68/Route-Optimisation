import sys
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from parser import JsonParser
from solver import GeneticSolver
from utils import configure_distance_metric


def _canonical_with_aggressive_early_stop():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "ROUTE_POOL_ENABLED": "false",
            "ORTOOLS_SEED_ASSIGNMENT_ENABLED": "false",
            "EARLY_STOP_ENABLED": "true",
            "TIME_LIMIT_SEC": 12,
            "MIN_RUNTIME_SEC": 0.0,
            "CHECKPOINT_EVERY_SEC": 0.01,
            "EPS_REL": 0.9,
            "STALL_CHECKPOINTS": 1,
            "DIVERSITY_MIN": 1.0,
            "BURST_SEC": 0.05,
            "STAGNATION_LIMIT_GEN": 4,
            "SIGNIFICANT_IMPROVEMENT_ABS": 1000000.0,
            "SIGNIFICANT_IMPROVEMENT_REL": 0.0,
        },
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
                "fuel_type": "petrol",
                "capacity": 2,
                "cost_per_km": 12,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 12.9760, "lng": 77.5993},
                "available_time": "07:45",
                "category": "normal",
            }
        ],
        "baseline": {
            "E1": {"cost": 220, "time": 45},
            "E2": {"cost": 240, "time": 48},
        },
    }


def test_solver_ignores_convergence_stop_settings_and_runs_full_budget():
    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_with_aggressive_early_stop())
    solver = GeneticSolver(problem, generations=200, pop_size=10, alns_iterations=4, seed=77)

    _, run_meta = solver.solve(run_id=1)

    assert run_meta["generationsPlanned"] == 200
    assert run_meta["terminatedEarly"] is False
    assert run_meta["generationsExecuted"] == run_meta["generationsPlanned"]
    assert str(run_meta["stopReason"]) == "manual_config"


def test_solver_time_limit_stops_run():
    configure_distance_metric("haversine")
    canonical = _canonical_with_aggressive_early_stop()
    canonical["metadata"]["EARLY_STOP_ENABLED"] = "false"
    canonical["metadata"]["BYPASS_SOLVER_SIZE_FLOORS"] = "true"
    canonical["metadata"]["TIME_LIMIT_SEC"] = 0.001

    problem = JsonParser().load_from_canonical(canonical)
    solver = GeneticSolver(problem, generations=2000, pop_size=14, alns_iterations=5, seed=91)

    _, run_meta = solver.solve(run_id=1)

    assert run_meta["terminatedEarly"] is True
    assert str(run_meta["stopReason"]) == "time_limit"
    assert run_meta["generationsExecuted"] < run_meta["generationsPlanned"]
    assert float(run_meta["maxRunSeconds"]) == 1.0
    assert run_meta["heuristicBestObjective"] is not None
