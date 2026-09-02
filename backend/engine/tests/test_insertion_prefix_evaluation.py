from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _payload(prefix_enabled: bool):
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "seed": 999,
            "DELTA_EVAL_ENABLED": True,
            "INSERTION_PREFIX_EVAL_ENABLED": bool(prefix_enabled),
        },
        "employees": [
            {"id": "E1", "priority": "High", "pickup": {"lat": 12.97, "lng": 77.59}, "dropoff": {"lat": 12.93, "lng": 77.62}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E2", "priority": "Medium", "pickup": {"lat": 12.96, "lng": 77.63}, "dropoff": {"lat": 12.93, "lng": 77.67}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E3", "priority": "Low", "pickup": {"lat": 12.99, "lng": 77.60}, "dropoff": {"lat": 12.94, "lng": 77.64}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
        ],
        "vehicles": [
            {"id": "V1", "capacity": 3, "cost_per_km": 12, "avg_speed_kmph": 25, "start_location": {"lat": 12.976, "lng": 77.599}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
        ],
        "baseline": {eid: {"cost": 200, "time": 40} for eid in ["E1", "E2", "E3"]},
    }


def _make_ops_and_route(prefix_enabled: bool):
    from parser import JsonParser
    from operators import GeneticOperators
    from representation import Route
    from utils import configure_distance_metric

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_payload(prefix_enabled))
    ops = GeneticOperators(problem)

    e1 = next(e for e in problem.employees if str(e.id) == "E1")
    e2 = next(e for e in problem.employees if str(e.id) == "E2")
    vehicle = problem.vehicles[0]

    route = Route(vehicle=vehicle, employees=[], stop_sequence=[{"type": "p", "emp": e1}, {"type": "d", "emp": e1}])
    ops._sync_route_employees(route)
    return problem, ops, route, e2


def _seq_sig(seq):
    return tuple((s.get("type"), str(getattr(s.get("emp"), "id", ""))) for s in (seq or []))


def test_insertion_prefix_eval_matches_full_path_result():
    _, ops_full, route_full, emp_full = _make_ops_and_route(prefix_enabled=False)
    _, ops_prefix, route_prefix, emp_prefix = _make_ops_and_route(prefix_enabled=True)

    seq_full, diff_full = ops_full._find_best_insertion_for_route(
        route_full, emp_full, strictness=0.9, penalty_factor=8.0, allow_soft=False
    )
    seq_prefix, diff_prefix = ops_prefix._find_best_insertion_for_route(
        route_prefix, emp_prefix, strictness=0.9, penalty_factor=8.0, allow_soft=False
    )

    assert seq_full is not None
    assert seq_prefix is not None
    assert pytest.approx(diff_full, rel=0, abs=1e-9) == diff_prefix
    assert _seq_sig(seq_full) == _seq_sig(seq_prefix)

    # Ensure the prefix path actually ran for at least some candidates.
    assert int(ops_prefix.insertion_eval_stats.get("prefixUsed", 0)) > 0


def test_insertion_prefix_eval_falls_back_when_base_invalid():
    _, ops_prefix, route, emp = _make_ops_and_route(prefix_enabled=True)
    # Break precedence: drop before pickup.
    route.stop_sequence = [route.stop_sequence[1], route.stop_sequence[0]]
    ops_prefix._sync_route_employees(route)

    seq, _ = ops_prefix._find_best_insertion_for_route(
        route, emp, strictness=0.8, penalty_factor=6.0, allow_soft=True
    )
    # Whether insertion succeeds isn't the point; ensure we didn't use prefix cache on an invalid base.
    assert int(ops_prefix.insertion_eval_stats.get("prefixUsed", 0)) == 0
    assert int(ops_prefix.insertion_eval_stats.get("fullUsed", 0)) > 0
    assert seq is None or isinstance(seq, list)

