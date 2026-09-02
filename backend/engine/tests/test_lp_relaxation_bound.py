from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _problem():
    from models import Baseline, Employee, Location, ProblemInstance, Vehicle

    employees = [
        Employee(id="E1", priority=2, pickup_loc=Location(0.0, 0.0), drop_loc=Location(0.0, 0.1), earliest_pickup=0, latest_drop=1000, vehicle_pref="normal", sharing_pref="double"),
        Employee(id="E2", priority=2, pickup_loc=Location(0.0, 0.0), drop_loc=Location(0.0, 0.1), earliest_pickup=0, latest_drop=1000, vehicle_pref="normal", sharing_pref="double"),
    ]
    vehicles = [
        Vehicle(id="V1", fuel_type="petrol", capacity=2, cost_per_km=12.0, speed_kmph=25.0, start_loc=Location(0.0, 0.0), avail_from=0, category="normal"),
        Vehicle(id="V2", fuel_type="petrol", capacity=2, cost_per_km=12.0, speed_kmph=25.0, start_loc=Location(0.0, 0.0), avail_from=0, category="normal"),
    ]
    baseline = {e.id: Baseline(emp_id=e.id, cost=10.0, time=10.0) for e in employees}
    return ProblemInstance(employees=employees, vehicles=vehicles, metadata={"distance_metric": "haversine"}, baseline=baseline)


def _route(problem, route_id, vehicle_id, passenger_ids, obj):
    from route_pool import PooledRoute

    employee_lookup = {e.id: e for e in problem.employees}
    passengers = tuple(sorted(passenger_ids))
    stop_sequence = []
    for emp_id in passengers:
        stop_sequence.append({"type": "p", "emp": employee_lookup[str(emp_id)]})
    for emp_id in passengers:
        stop_sequence.append({"type": "d", "emp": employee_lookup[str(emp_id)]})
    return PooledRoute(
        route_id=str(route_id),
        vehicle_id=str(vehicle_id),
        vehicle_category="normal",
        passenger_set=passengers,
        sequence_signature=tuple(f"p:{e}" for e in passengers) + tuple(f"d:{e}" for e in passengers),
        stop_sequence=stop_sequence,
        objective_score=float(obj),
        total_cost=float(obj),
        total_time=1.0,
        total_delay=0.0,
        penalty_total=0.0,
        penalty_breakdown={},
        is_feasible=True,
        hard_violation_count=0,
        violations=[],
        source="test",
        run_id=1,
        generation=0,
    )


def test_lp_relaxation_bound_is_available_when_ortools_present():
    from set_partition import pywraplp, restricted_master_lp_relaxation_bound

    if pywraplp is None:
        pytest.skip("OR-Tools not available in this environment")

    problem = _problem()
    routes = [
        _route(problem, "r1", "V1", ["E1"], obj=10.0),
        _route(problem, "r2", "V2", ["E2"], obj=11.0),
        _route(problem, "r3", "V1", ["E2"], obj=50.0),
        _route(problem, "r4", "V2", ["E1"], obj=55.0),
    ]
    bound, status, _ = restricted_master_lp_relaxation_bound(problem, routes, time_limit_sec=0.5)
    assert status in {"optimal", "feasible"}
    assert bound is not None
    # LP relaxation bound must be <= best integer feasible selection cost (here, 10+11).
    assert float(bound) <= 21.0 + 1e-6

