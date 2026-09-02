from __future__ import annotations

import sys
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _canonical_3e_2v():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "seed": 7,
            "ALLOW_SHARING_VIOLATION": False,
            "ALLOW_PREMIUM_MISMATCH": False,
        },
        "employees": [
            {"id": "E1", "priority": "High", "pickup": {"lat": 0.0, "lng": 0.0}, "dropoff": {"lat": 0.0, "lng": 0.1}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E2", "priority": "High", "pickup": {"lat": 0.0, "lng": 0.02}, "dropoff": {"lat": 0.0, "lng": 0.1}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E3", "priority": "High", "pickup": {"lat": 0.0, "lng": 0.04}, "dropoff": {"lat": 0.0, "lng": 0.1}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
        ],
        "vehicles": [
            {"id": "V1", "capacity": 2, "cost_per_km": 1, "avg_speed_kmph": 30, "start_location": {"lat": 0.0, "lng": 0.0}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
            {"id": "V2", "capacity": 2, "cost_per_km": 1, "avg_speed_kmph": 30, "start_location": {"lat": 0.0, "lng": 0.0}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
        ],
        "baseline": {eid: {"cost": 200, "time": 40} for eid in ["E1", "E2", "E3"]},
    }


def test_reduced_cost_formula_matches_expected():
    from bcp_foundation import reduced_cost
    from route_pool import PooledRoute

    pr = PooledRoute(
        route_id="r",
        vehicle_id="V1",
        vehicle_category="normal",
        passenger_set=("E1", "E2"),
        sequence_signature=("p:E1", "p:E2", "d:E1", "d:E2"),
        stop_sequence=[],
        objective_score=100.0,
        total_cost=0.0,
        total_time=0.0,
        total_delay=0.0,
        penalty_total=0.0,
        penalty_breakdown={},
        is_feasible=True,
        hard_violation_count=0,
    )
    rc = reduced_cost(pr, employee_duals={"E1": 30.0, "E2": 40.0}, vehicle_duals={"V1": 5.0})
    assert abs(rc - (100.0 - 30.0 - 40.0 - 5.0)) <= 1e-9


def test_exact_small_pricing_finds_negative_reduced_cost_columns():
    from parser import JsonParser
    from pricing import price_vehicle_exact_small
    from route_pool import RoutePoolManager
    from utils import configure_distance_metric

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_3e_2v())
    manager = RoutePoolManager(problem=problem, max_routes=500, pruning_mode="safe")
    v1 = next(v for v in problem.vehicles if str(v.id) == "V1")

    # Artificial duals: make covering E1/E2/E3 very valuable.
    employee_duals = {"E1": 500.0, "E2": 500.0, "E3": 500.0}
    vehicle_duals = {"V1": 0.0}
    res = price_vehicle_exact_small(
        problem,
        vehicle=v1,
        candidate_employee_ids=["E1", "E2", "E3"],
        employee_duals=employee_duals,
        vehicle_duals=vehicle_duals,
        pool_manager=manager,
        run_id=1,
        iteration=0,
        max_candidates=8,
        max_columns=5,
        min_reduced_cost=-1e-6,
        time_limit_sec=1.2,
    )
    assert res.stats.mode == "exact_enumeration_pricing_small"
    assert res.stats.evaluated_routes >= 1
    assert res.stats.negative_reduced_cost_found >= 1
    assert all(r.is_feasible for r in res.routes)


def test_pricing_emits_dominance_stats():
    from parser import JsonParser
    from pricing import price_vehicle_exact_small
    from route_pool import RoutePoolManager
    from utils import configure_distance_metric

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_3e_2v())
    manager = RoutePoolManager(problem=problem, max_routes=500, pruning_mode="safe")
    v1 = next(v for v in problem.vehicles if str(v.id) == "V1")
    res = price_vehicle_exact_small(
        problem,
        vehicle=v1,
        candidate_employee_ids=["E1", "E2", "E3"],
        employee_duals={"E1": 1.0, "E2": 1.0, "E3": 1.0},
        vehicle_duals={"V1": 0.0},
        pool_manager=manager,
        run_id=1,
        iteration=0,
        time_limit_sec=0.4,
    )
    assert res.stats.expanded_labels >= 1
    assert res.stats.dominance_pruned >= 0


def test_dominance_pruning_does_not_change_best_reduced_cost_on_tiny_case():
    from parser import JsonParser
    from pricing import price_vehicle_exact_small
    from route_pool import RoutePoolManager
    from utils import configure_distance_metric
    from bcp_foundation import reduced_cost

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_3e_2v())
    v1 = next(v for v in problem.vehicles if str(v.id) == "V1")
    manager_a = RoutePoolManager(problem=problem, max_routes=500, pruning_mode="safe")
    manager_b = RoutePoolManager(problem=problem, max_routes=500, pruning_mode="safe")
    duals = {"E1": 500.0, "E2": 500.0, "E3": 500.0}

    r_on = price_vehicle_exact_small(
        problem,
        vehicle=v1,
        candidate_employee_ids=["E1", "E2", "E3"],
        employee_duals=duals,
        vehicle_duals={"V1": 0.0},
        pool_manager=manager_a,
        run_id=1,
        iteration=0,
        time_limit_sec=1.2,
        dominance_enabled=True,
    )
    r_off = price_vehicle_exact_small(
        problem,
        vehicle=v1,
        candidate_employee_ids=["E1", "E2", "E3"],
        employee_duals=duals,
        vehicle_duals={"V1": 0.0},
        pool_manager=manager_b,
        run_id=1,
        iteration=0,
        time_limit_sec=1.2,
        dominance_enabled=False,
    )

    assert r_on.routes and r_off.routes
    best_on = min(reduced_cost(r, employee_duals=duals, vehicle_duals={"V1": 0.0}) for r in r_on.routes)
    best_off = min(reduced_cost(r, employee_duals=duals, vehicle_duals={"V1": 0.0}) for r in r_off.routes)
    assert abs(best_on - best_off) <= 1e-6
