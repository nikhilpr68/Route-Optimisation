import sys
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from parser import JsonParser  # noqa: E402


def test_duplicate_employee_and_vehicle_ids_are_normalized():
    canonical = {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {"distance_metric": "haversine"},
        "employees": [
            {
                "id": "E1",
                "priority": "Medium",
                "pickup": {"lat": 12.90, "lng": 77.50},
                "dropoff": {"lat": 12.97, "lng": 77.59},
                "time_window": {"start": "08:00", "end": "10:00"},
            },
            {
                "id": "E1",
                "priority": "Medium",
                "pickup": {"lat": 12.91, "lng": 77.51},
                "dropoff": {"lat": 12.97, "lng": 77.59},
                "time_window": {"start": "08:05", "end": "10:05"},
            },
        ],
        "vehicles": [
            {
                "id": "V1",
                "fuel_type": "petrol",
                "capacity": 2,
                "cost_per_km": 10,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 12.95, "lng": 77.55},
                "available_time": "07:30",
                "category": "normal",
            },
            {
                "id": "V1",
                "fuel_type": "petrol",
                "capacity": 2,
                "cost_per_km": 10,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 12.96, "lng": 77.56},
                "available_time": "07:35",
                "category": "normal",
            },
        ],
        "baseline": {
            "E1": {"cost": 100, "time": 30},
        },
    }

    problem = JsonParser().load_from_canonical(canonical)

    employee_ids = [emp.id for emp in problem.employees]
    employee_display_ids = [emp.display_id for emp in problem.employees]
    vehicle_ids = [veh.id for veh in problem.vehicles]
    vehicle_display_ids = [veh.display_id for veh in problem.vehicles]

    assert employee_ids == ["E1__dup1", "E1__dup2"]
    assert employee_display_ids == ["E1 #1", "E1 #2"]
    assert vehicle_ids == ["V1__dup1", "V1__dup2"]
    assert vehicle_display_ids == ["V1 #1", "V1 #2"]

    assert set(problem.baseline.keys()) == {"E1__dup1", "E1__dup2"}
    assert problem.baseline["E1__dup1"].cost == 100
    assert problem.baseline["E1__dup2"].time == 30

    assert problem.metadata["normalized_employee_id_map"]["E1__dup1"] == "E1"
    assert problem.metadata["normalized_vehicle_display_map"]["V1__dup2"] == "V1 #2"
