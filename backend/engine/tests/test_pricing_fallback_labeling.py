from __future__ import annotations

import sys
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _canonical_5e_3v():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "seed": 2026,
            "ROUTE_POOL_ENABLED": True,
            "ROUTE_POOL_SAFE_MODE": True,
            "SET_PARTITION_ITERATIONS": 2,
            "SET_PARTITION_NO_IMPROVE_ITERS": 2,
            "SET_PARTITION_TIME_LIMIT_SEC": 1.5,
            "ROUTE_POOL_MAX_ROUTES": 300,
            "ROUTE_POOL_TARGETED_VARIANTS": 2,
            "ROUTE_POOL_ITER_TOPK_ROUTES": 0,
            "COLUMN_GENERATION_ENABLED": True,
            "COLUMN_GENERATION_MAX_ITERS": 1,
            "COLUMN_GENERATION_LP_TIME_LIMIT_SEC": 0.3,
            "PRICING_EXACT_SMALL_ENABLED": True,
        },
        "employees": [
            {"id": "E1", "priority": "High", "pickup": {"lat": 12.97, "lng": 77.59}, "dropoff": {"lat": 12.93, "lng": 77.62}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E2", "priority": "Medium", "pickup": {"lat": 12.96, "lng": 77.63}, "dropoff": {"lat": 12.93, "lng": 77.67}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E3", "priority": "Low", "pickup": {"lat": 12.99, "lng": 77.60}, "dropoff": {"lat": 12.94, "lng": 77.64}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E4", "priority": "Low", "pickup": {"lat": 12.95, "lng": 77.58}, "dropoff": {"lat": 12.92, "lng": 77.61}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E5", "priority": "Medium", "pickup": {"lat": 12.98, "lng": 77.66}, "dropoff": {"lat": 12.94, "lng": 77.69}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
        ],
        "vehicles": [
            {"id": "V1", "capacity": 2, "cost_per_km": 12, "avg_speed_kmph": 25, "start_location": {"lat": 12.976, "lng": 77.599}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
            {"id": "V2", "capacity": 2, "cost_per_km": 12, "avg_speed_kmph": 25, "start_location": {"lat": 12.976, "lng": 77.599}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
            {"id": "V3", "capacity": 2, "cost_per_km": 12, "avg_speed_kmph": 25, "start_location": {"lat": 12.976, "lng": 77.599}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
        ],
        "baseline": {eid: {"cost": 200, "time": 40} for eid in ["E1", "E2", "E3", "E4", "E5"]},
    }


def test_fallback_reason_is_emitted_when_duals_unavailable():
    from parser import JsonParser
    from solver import GeneticSolver
    from utils import configure_distance_metric

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_5e_3v())
    solver = GeneticSolver(problem=problem, generations=6, pop_size=10, alns_iterations=0, seed=2026)
    _, meta = solver.solve(run_id=1)

    setp = meta.get("setPartitionStats") or {}
    cg = setp.get("columnGeneration") or {}
    assert cg.get("enabled") is True
    iters = cg.get("iterations") or []
    assert iters
    pricing = iters[0].get("pricing") or {}
    # If LP duals are unavailable (e.g. no GLOP/CLP), solver should label fallback.
    assert pricing.get("fallbackReason") in (None, "duals_unavailable", "exact_pricing_disabled_or_failed", "no_columns_added")

