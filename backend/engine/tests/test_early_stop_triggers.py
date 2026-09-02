import sys
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from parser import JsonParser
from solver import GeneticSolver
from utils import configure_distance_metric


def _canonical_stagnant():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "ROUTE_POOL_ENABLED": "false",
            "ORTOOLS_SEED_ASSIGNMENT_ENABLED": "false",
            "EARLY_STOP_ENABLED": "true",
            "TIME_LIMIT_SEC": 15,
            "MIN_RUNTIME_SEC": 1,
            "CHECKPOINT_EVERY_SEC": 0.2,
            "EPS_REL": 0.5,
            "STALL_CHECKPOINTS": 2,
            "DIVERSITY_MIN": 1.0,
            "BURST_SEC": 0.2,
            "STAGNATION_LIMIT_GEN": 3,
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
                "time_window": {"start": "08:00", "end": "09:30"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
        ],
        "vehicles": [
            {
                "id": "V1",
                "fuel_type": "petrol",
                "capacity": 2,
                "cost_per_km": 11,
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


def test_stagnation_config_no_longer_stops_run_early():
    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_stagnant())
    solver = GeneticSolver(problem, generations=120, pop_size=10, alns_iterations=4, seed=101)

    _, run_meta = solver.solve(run_id=1)

    assert run_meta["terminatedEarly"] is False
    assert run_meta["stopReason"] == "manual_config"
    assert int(run_meta["generationsExecuted"]) == int(run_meta["generationsPlanned"])
    assert int(run_meta["escapeBurstCount"]) >= 1
