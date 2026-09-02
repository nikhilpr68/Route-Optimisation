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
            # Make the restricted-master iteration short but active.
            "ROUTE_POOL_ENABLED": True,
            "ROUTE_POOL_SAFE_MODE": True,
            "SET_PARTITION_ITERATIONS": 3,
            "SET_PARTITION_NO_IMPROVE_ITERS": 3,
            "SET_PARTITION_TIME_LIMIT_SEC": 2.0,
            "ROUTE_POOL_MAX_ROUTES": 400,
            "ROUTE_POOL_TARGETED_VARIANTS": 3,
            "ROUTE_POOL_ITER_TOPK_ROUTES": 0,  # do not slice within iter loop (safe mode ignores anyway)
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


def test_restricted_master_iteration_adds_routes_and_tracks_pricing():
    from parser import JsonParser
    from solver import GeneticSolver
    from utils import configure_distance_metric

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_5e_3v())
    solver = GeneticSolver(problem=problem, generations=6, pop_size=10, alns_iterations=0, seed=2026)
    _, meta = solver.solve(run_id=1)

    pool_stats = meta.get("routePoolStats") or {}
    setp_stats = meta.get("setPartitionStats") or {}
    iters = setp_stats.get("iterations") or []
    assert len(iters) >= 1

    # Ensure iteration layer actually tried to augment the pool at least once.
    assert any(int(row.get("addedRoutes") or 0) > 0 for row in iters)

    # Pricing observability present.
    assert "pricing" in iters[0]
    assert iters[0]["pricing"]["type"] == "surrogate_min_route_cost"

    # Pool size should remain within cap.
    for row in iters:
        assert int(row.get("poolSize") or 0) <= int(problem.metadata["ROUTE_POOL_MAX_ROUTES"])

    # Best objective-so-far should be monotone non-increasing.
    best_so_far = float("inf")
    for row in iters:
        obj = row.get("bestObjectiveSoFar")
        if obj is None:
            continue
        obj = float(obj)
        assert obj <= best_so_far + 1e-9
        best_so_far = obj
