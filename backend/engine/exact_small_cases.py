from __future__ import annotations

from typing import Dict, List


def get_exact_small_validation_cases() -> List[Dict]:
    return [
        {
            "name": "shared_pair_single_vehicle",
            "pattern": "simple_shared_pairing",
            "canonical": {
                "schema_version": "1.0",
                "problem_type": "employee_transport_many_to_one",
                "metadata": {
                    "distance_metric": "haversine",
                    "seed": 101,
                    "ROUTE_POOL_ENABLED": "true",
                },
                "employees": [
                    {
                        "id": "E1",
                        "priority": "High",
                        "pickup": {"lat": 12.9716, "lng": 77.5946},
                        "dropoff": {"lat": 12.9600, "lng": 77.6100},
                        "time_window": {"start": "08:00", "end": "09:10"},
                        "vehicle_preference": "normal",
                        "sharing_preference": "double",
                    },
                    {
                        "id": "E2",
                        "priority": "Medium",
                        "pickup": {"lat": 12.9690, "lng": 77.5980},
                        "dropoff": {"lat": 12.9580, "lng": 77.6120},
                        "time_window": {"start": "08:05", "end": "09:20"},
                        "vehicle_preference": "normal",
                        "sharing_preference": "double",
                    },
                ],
                "vehicles": [
                    {
                        "id": "V1",
                        "fuel_type": "petrol",
                        "capacity": 2,
                        "cost_per_km": 10,
                        "avg_speed_kmph": 25,
                        "start_location": {"lat": 12.9750, "lng": 77.6000},
                        "available_time": "07:45",
                        "category": "normal",
                    }
                ],
                "baseline": {
                    "E1": {"cost": 180, "time": 35},
                    "E2": {"cost": 175, "time": 34},
                },
            },
        },
        {
            "name": "premium_split_two_vehicles",
            "pattern": "vehicle_compatibility_split",
            "canonical": {
                "schema_version": "1.0",
                "problem_type": "employee_transport_many_to_one",
                "metadata": {
                    "distance_metric": "haversine",
                    "seed": 202,
                    "ROUTE_POOL_ENABLED": "true",
                },
                "employees": [
                    {
                        "id": "E1",
                        "priority": "High",
                        "pickup": {"lat": 12.9716, "lng": 77.5946},
                        "dropoff": {"lat": 12.9480, "lng": 77.6200},
                        "time_window": {"start": "08:00", "end": "09:05"},
                        "vehicle_preference": "premium",
                        "sharing_preference": "single",
                    },
                    {
                        "id": "E2",
                        "priority": "Medium",
                        "pickup": {"lat": 12.9620, "lng": 77.6080},
                        "dropoff": {"lat": 12.9500, "lng": 77.6180},
                        "time_window": {"start": "08:10", "end": "09:20"},
                        "vehicle_preference": "normal",
                        "sharing_preference": "double",
                    },
                ],
                "vehicles": [
                    {
                        "id": "V1",
                        "fuel_type": "electric",
                        "capacity": 1,
                        "cost_per_km": 12,
                        "avg_speed_kmph": 28,
                        "start_location": {"lat": 12.9750, "lng": 77.6000},
                        "available_time": "07:45",
                        "category": "premium",
                    },
                    {
                        "id": "V2",
                        "fuel_type": "petrol",
                        "capacity": 2,
                        "cost_per_km": 8,
                        "avg_speed_kmph": 24,
                        "start_location": {"lat": 12.9780, "lng": 77.6020},
                        "available_time": "07:45",
                        "category": "normal",
                    },
                ],
                "baseline": {
                    "E1": {"cost": 250, "time": 42},
                    "E2": {"cost": 180, "time": 36},
                },
            },
        },
        {
            "name": "tight_window_three_employee",
            "pattern": "tight_time_window_ordering",
            "canonical": {
                "schema_version": "1.0",
                "problem_type": "employee_transport_many_to_one",
                "metadata": {
                    "distance_metric": "haversine",
                    "seed": 303,
                    "ROUTE_POOL_ENABLED": "true",
                },
                "employees": [
                    {
                        "id": "E1",
                        "priority": "High",
                        "pickup": {"lat": 12.9700, "lng": 77.5950},
                        "dropoff": {"lat": 12.9510, "lng": 77.6210},
                        "time_window": {"start": "08:00", "end": "08:55"},
                        "vehicle_preference": "normal",
                        "sharing_preference": "double",
                    },
                    {
                        "id": "E2",
                        "priority": "High",
                        "pickup": {"lat": 12.9680, "lng": 77.6010},
                        "dropoff": {"lat": 12.9490, "lng": 77.6240},
                        "time_window": {"start": "08:02", "end": "08:58"},
                        "vehicle_preference": "normal",
                        "sharing_preference": "double",
                    },
                    {
                        "id": "E3",
                        "priority": "Medium",
                        "pickup": {"lat": 12.9640, "lng": 77.6060},
                        "dropoff": {"lat": 12.9470, "lng": 77.6270},
                        "time_window": {"start": "08:05", "end": "09:10"},
                        "vehicle_preference": "normal",
                        "sharing_preference": "double",
                    },
                ],
                "vehicles": [
                    {
                        "id": "V1",
                        "fuel_type": "petrol",
                        "capacity": 2,
                        "cost_per_km": 9,
                        "avg_speed_kmph": 22,
                        "start_location": {"lat": 12.9760, "lng": 77.6000},
                        "available_time": "07:45",
                        "category": "normal",
                    },
                    {
                        "id": "V2",
                        "fuel_type": "petrol",
                        "capacity": 2,
                        "cost_per_km": 9,
                        "avg_speed_kmph": 22,
                        "start_location": {"lat": 12.9790, "lng": 77.6030},
                        "available_time": "07:45",
                        "category": "normal",
                    },
                ],
                "baseline": {
                    "E1": {"cost": 180, "time": 34},
                    "E2": {"cost": 182, "time": 35},
                    "E3": {"cost": 185, "time": 36},
                },
            },
        },
    ]
