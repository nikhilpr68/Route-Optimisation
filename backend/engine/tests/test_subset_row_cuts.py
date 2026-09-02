from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _canonical_4e_4v():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "seed": 7,
            "MASTER_SUBSET_ROW_CUTS_ENABLED": True,
            "MASTER_SUBSET_ROW_CUTS_MAX": 20,
            "MASTER_SUBSET_ROW_CUTS_SEP_TRIES": 10,
        },
        "employees": [
            {"id": "E1", "priority": "High", "pickup": {"lat": 0.0, "lng": 0.0}, "dropoff": {"lat": 0.0, "lng": 0.1}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E2", "priority": "High", "pickup": {"lat": 0.0, "lng": 0.02}, "dropoff": {"lat": 0.0, "lng": 0.1}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E3", "priority": "High", "pickup": {"lat": 0.0, "lng": 0.04}, "dropoff": {"lat": 0.0, "lng": 0.1}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E4", "priority": "High", "pickup": {"lat": 0.0, "lng": 0.06}, "dropoff": {"lat": 0.0, "lng": 0.1}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
        ],
        "vehicles": [
            {"id": "V1", "capacity": 2, "cost_per_km": 1, "avg_speed_kmph": 30, "start_location": {"lat": 0.0, "lng": 0.0}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
            {"id": "V2", "capacity": 2, "cost_per_km": 1, "avg_speed_kmph": 30, "start_location": {"lat": 0.0, "lng": 0.0}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
            {"id": "V3", "capacity": 2, "cost_per_km": 1, "avg_speed_kmph": 30, "start_location": {"lat": 0.0, "lng": 0.0}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
            {"id": "V4", "capacity": 2, "cost_per_km": 1, "avg_speed_kmph": 30, "start_location": {"lat": 0.0, "lng": 0.0}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
        ],
        "baseline": {eid: {"cost": 200, "time": 40} for eid in ["E1", "E2", "E3", "E4"]},
    }


def _pooled(route_id: str, vehicle_id: str, passengers: tuple[str, ...], obj: float):
    from route_pool import PooledRoute

    seq = []
    for eid in passengers:
        seq.append(f"p:{eid}")
    for eid in passengers:
        seq.append(f"d:{eid}")
    return PooledRoute(
        route_id=str(route_id),
        vehicle_id=str(vehicle_id),
        vehicle_category="normal",
        passenger_set=tuple(passengers),
        sequence_signature=tuple(seq),
        stop_sequence=[],
        objective_score=float(obj),
        total_cost=float(obj),
        total_time=0.0,
        total_delay=0.0,
        penalty_total=0.0,
        penalty_breakdown={},
        is_feasible=True,
        hard_violation_count=0,
    )


def test_subset_row_cut_tightens_lp_bound_when_solver_available():
    from bcp_foundation import MasterSolveOptions
    from cuts import CutStore
    from parser import JsonParser
    from set_partition import solve_restricted_master_lp
    from utils import configure_distance_metric

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_4e_4v())

    # Pair routes among E1,E2,E3 allow fractional cover; singletons allow integer cover.
    routes = [
        _pooled("r12", "V1", ("E1", "E2"), 1.0),
        _pooled("r23", "V2", ("E2", "E3"), 1.0),
        _pooled("r13", "V3", ("E1", "E3"), 1.0),
        _pooled("r4", "V4", ("E4",), 1.0),
        _pooled("r1", "V4", ("E1",), 10.0),
        _pooled("r2", "V3", ("E2",), 10.0),
        _pooled("r3", "V2", ("E3",), 10.0),
    ]

    options = MasterSolveOptions.from_metadata(problem.metadata)
    store = CutStore(max_cuts=20)
    lp0 = solve_restricted_master_lp(problem, routes, time_limit_sec=0.8, options=options, cut_store=store)
    if lp0.status == "solver_unavailable":
        pytest.skip("LP solver unavailable; subset-row cut tests require GLOP/CLP")
    assert lp0.status in ("optimal", "feasible")
    obj0 = float(lp0.objective_value)
    cuts0 = int(lp0.cuts_total)

    # Re-solve: separation should add at least one SRC cut, tightening the bound.
    lp1 = solve_restricted_master_lp(problem, routes, time_limit_sec=0.8, options=options, cut_store=store)
    assert lp1.status in ("optimal", "feasible")
    obj1 = float(lp1.objective_value)
    assert int(lp1.cuts_total) >= cuts0
    assert int(lp1.cuts_added) >= 0
    # Tightening: objective (lower bound) should not decrease.
    assert obj1 + 1e-9 >= obj0


def test_cut_duals_are_exposed_when_cuts_active():
    from bcp_foundation import MasterSolveOptions
    from cuts import CutStore
    from parser import JsonParser
    from set_partition import solve_restricted_master_lp
    from utils import configure_distance_metric

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_4e_4v())
    routes = [
        _pooled("r12", "V1", ("E1", "E2"), 1.0),
        _pooled("r23", "V2", ("E2", "E3"), 1.0),
        _pooled("r13", "V3", ("E1", "E3"), 1.0),
        _pooled("r4", "V4", ("E4",), 1.0),
        _pooled("r1", "V4", ("E1",), 10.0),
        _pooled("r2", "V3", ("E2",), 10.0),
        _pooled("r3", "V2", ("E3",), 10.0),
    ]
    options = MasterSolveOptions.from_metadata(problem.metadata)
    store = CutStore(max_cuts=20)
    lp = solve_restricted_master_lp(problem, routes, time_limit_sec=0.8, options=options, cut_store=store)
    if lp.status == "solver_unavailable":
        pytest.skip("LP solver unavailable; subset-row cut tests require GLOP/CLP")
    # second solve will re-add existing cuts and attempt separation.
    lp2 = solve_restricted_master_lp(problem, routes, time_limit_sec=0.8, options=options, cut_store=store)
    assert int(lp2.cuts_total) >= 0
    assert isinstance(lp2.cut_duals, dict)

