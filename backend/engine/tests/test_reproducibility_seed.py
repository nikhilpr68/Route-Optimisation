import sys
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from parser import JsonParser
from solver import GeneticSolver
from utils import configure_distance_metric


def _canonical():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "ROUTE_POOL_ENABLED": "false",
            "ORTOOLS_SEED_ASSIGNMENT_ENABLED": "false",
            "EARLY_STOP_ENABLED": "false",
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
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
            {
                "id": "E2",
                "priority": "Medium",
                "pickup": {"lat": 12.9611, "lng": 77.6387},
                "dropoff": {"lat": 12.9304, "lng": 77.6784},
                "time_window": {"start": "08:10", "end": "09:40"},
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
        ],
        "vehicles": [
            {
                "id": "V1",
                "fuel_type": "petrol",
                "capacity": 2,
                "cost_per_km": 12,
                "avg_speed_kmph": 24,
                "start_location": {"lat": 12.9760, "lng": 77.5993},
                "available_time": "07:40",
                "category": "normal",
            },
            {
                "id": "V2",
                "fuel_type": "diesel",
                "capacity": 2,
                "cost_per_km": 10,
                "avg_speed_kmph": 26,
                "start_location": {"lat": 12.9485, "lng": 77.5921},
                "available_time": "07:45",
                "category": "normal",
            },
        ],
        "baseline": {
            "E1": {"cost": 220, "time": 45},
            "E2": {"cost": 240, "time": 48},
            "E3": {"cost": 250, "time": 50},
        },
    }


def test_same_seed_same_objective_hash_and_stop_reason():
    configure_distance_metric("haversine")
    canonical = _canonical()

    p1 = JsonParser().load_from_canonical(canonical)
    p2 = JsonParser().load_from_canonical(canonical)

    s1 = GeneticSolver(p1, generations=50, pop_size=12, alns_iterations=4, seed=4242)
    s2 = GeneticSolver(p2, generations=50, pop_size=12, alns_iterations=4, seed=4242)

    sol1, meta1 = s1.solve(run_id=1)
    sol2, meta2 = s2.solve(run_id=1)

    assert float(sol1.objective_score) == float(sol2.objective_score)
    assert str(sol1.structural_hash) == str(sol2.structural_hash)
    assert str(meta1.get("stopReason")) == str(meta2.get("stopReason"))
