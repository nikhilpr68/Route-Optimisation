from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _problem(meta_extra=None):
    from models import Baseline, Employee, Location, ProblemInstance, Vehicle

    meta = {"distance_metric": "haversine"}
    if meta_extra:
        meta.update(meta_extra)

    employees = [
        Employee(id="E1", priority=2, pickup_loc=Location(0.0, 0.0), drop_loc=Location(0.0, 0.1), earliest_pickup=0, latest_drop=1000, vehicle_pref="normal", sharing_pref="double"),
        Employee(id="E2", priority=2, pickup_loc=Location(0.0, 0.0), drop_loc=Location(0.0, 0.1), earliest_pickup=0, latest_drop=1000, vehicle_pref="normal", sharing_pref="double"),
        Employee(id="E3", priority=2, pickup_loc=Location(0.0, 0.0), drop_loc=Location(0.0, 0.1), earliest_pickup=0, latest_drop=1000, vehicle_pref="normal", sharing_pref="double"),
        Employee(id="ERARE", priority=2, pickup_loc=Location(0.0, 0.0), drop_loc=Location(0.0, 0.1), earliest_pickup=0, latest_drop=1000, vehicle_pref="normal", sharing_pref="double"),
    ]
    vehicles = [
        Vehicle(id="V1", fuel_type="petrol", capacity=2, cost_per_km=12.0, speed_kmph=25.0, start_loc=Location(0.0, 0.0), avail_from=0, category="normal"),
        Vehicle(id="V2", fuel_type="petrol", capacity=2, cost_per_km=12.0, speed_kmph=25.0, start_loc=Location(0.0, 0.0), avail_from=0, category="normal"),
    ]
    baseline = {e.id: Baseline(emp_id=e.id, cost=10.0, time=10.0) for e in employees}
    return ProblemInstance(employees=employees, vehicles=vehicles, metadata=meta, baseline=baseline)


def _pooled(
    route_id,
    vehicle_id,
    passenger_ids,
    seq_sig,
    obj,
    feasible=True,
    delay=0.0,
    penalty_total=0.0,
    employee_lookup=None,
):
    from route_pool import PooledRoute

    passengers = tuple(sorted(passenger_ids))
    seq = tuple(seq_sig)
    # Provide a minimal stop sequence so the set-partition master can build an
    # Individual without immediately discarding the route as empty.
    stop_sequence = []
    if employee_lookup is None:
        employee_lookup = {e.id: e for e in _problem().employees}
    for emp_id in passengers:
        stop_sequence.append({"type": "p", "emp": employee_lookup[str(emp_id)]})
    for emp_id in passengers:
        stop_sequence.append({"type": "d", "emp": employee_lookup[str(emp_id)]})
    return PooledRoute(
        route_id=str(route_id),
        vehicle_id=str(vehicle_id),
        vehicle_category="normal",
        passenger_set=passengers,
        sequence_signature=seq,
        stop_sequence=stop_sequence,
        objective_score=float(obj),
        total_cost=float(obj),
        total_time=1.0,
        total_delay=float(delay),
        penalty_total=float(penalty_total),
        penalty_breakdown={"lateness": 0.0, "capacity": 0.0, "sharing": 0.0, "premium": 0.0, "precedence": 0.0, "consistency": 0.0, "infeasible": 0.0},
        is_feasible=bool(feasible),
        hard_violation_count=0,
        violations=[],
        source="test",
        run_id=1,
        generation=0,
    )


def test_complementarity_keeps_rare_coverage_route_under_cap():
    from route_pool import RoutePoolManager

    problem = _problem(
        meta_extra={
            "ROUTE_POOL_COMPLEMENTARITY_ENABLED": "true",
            # Force the fill stage to prefer rarity over pure objective.
            "ROUTE_POOL_COMPLEMENTARITY_QUALITY_FRACTION": 0.0,
            "ROUTE_POOL_COMPLEMENTARITY_RARITY_FRACTION": 1.0,
            "ROUTE_POOL_COMPLEMENTARITY_TIMING_FRACTION": 0.0,
        }
    )
    pool = RoutePoolManager(problem=problem, max_routes=4, pruning_mode="heuristic")

    # Create >cap distinct (passenger_set, vehicle) representatives so the seed
    # stage overflows the cap. Pure objective trimming would drop the rare route.
    pool.add_pooled_route(_pooled("v1_e1", "V1", ["E1"], ["p:E1", "d:E1", "a"], obj=5.0))
    pool.add_pooled_route(_pooled("v1_e2", "V1", ["E2"], ["p:E2", "d:E2", "b"], obj=6.0))
    pool.add_pooled_route(_pooled("v1_e12", "V1", ["E1", "E2"], ["p:E1", "p:E2", "d:E1", "d:E2", "c"], obj=7.0))
    pool.add_pooled_route(_pooled("v2_e2", "V2", ["E2"], ["p:E2", "d:E2", "d"], obj=5.5))
    pool.add_pooled_route(_pooled("v2_e3", "V2", ["E3"], ["p:E3", "d:E3", "e"], obj=6.5))
    pool.add_pooled_route(_pooled("v2_e23", "V2", ["E2", "E3"], ["p:E2", "p:E3", "d:E2", "d:E3", "f"], obj=7.5))

    # Rare route: individually bad but covers ERARE (rare coverage should retain it).
    pool.add_pooled_route(_pooled("rare", "V1", ["ERARE"], ["p:ERARE", "d:ERARE", "z"], obj=999.0))

    routes = pool.get_routes()
    assert len(routes) <= 4
    assert any("ERARE" in r.passenger_set for r in routes), "Rare-coverage route was dropped under complementarity retention"

    stats = pool.stats()
    rb = stats.get("retentionBreakdown") or {}
    assert int(rb.get("selectedByRarity", 0)) >= 1


def test_safe_mode_unchanged_by_complementarity_flags():
    from route_pool import RoutePoolManager

    problem = _problem(meta_extra={"ROUTE_POOL_COMPLEMENTARITY_ENABLED": "true"})
    pool = RoutePoolManager(problem=problem, max_routes=3, pruning_mode="safe")
    assert pool.complementarity_enabled is False


def test_complementarity_changes_master_coverage_under_cap():
    """Proves complementarity retention can preserve globally useful routes.

    Scenario: the only route that covers a rare employee (ERARE) is individually
    very expensive. Without complementarity retention, a cap trim can drop it,
    forcing the restricted master to fall back to a relaxed cover with ERARE
    uncovered. With complementarity retention (rarity quota), ERARE stays in
    the pool and the master can cover everyone.
    """
    from route_pool import RoutePoolManager
    from set_partition import solve_set_partition
    from utils import configure_distance_metric

    configure_distance_metric("haversine")

    base_meta = {
        # Keep some pure-quality routes so we don't accidentally drop the
        # low-cost building blocks needed for full coverage.
        "ROUTE_POOL_COMPLEMENTARITY_QUALITY_FRACTION": 0.5,
        "ROUTE_POOL_COMPLEMENTARITY_RARITY_FRACTION": 0.5,
        "ROUTE_POOL_COMPLEMENTARITY_TIMING_FRACTION": 0.0,
    }

    def build_pool(complementarity_enabled: bool):
        meta = dict(base_meta)
        meta["ROUTE_POOL_COMPLEMENTARITY_ENABLED"] = "true" if complementarity_enabled else "false"
        problem = _problem(meta_extra=meta)
        pool = RoutePoolManager(problem=problem, max_routes=4, pruning_mode="heuristic")
        employee_lookup = {e.id: e for e in problem.employees}

        # Many unique (passenger_set, vehicle) reps so seed stage overflows cap.
        pool.add_pooled_route(_pooled("v1_e12", "V1", ["E1", "E2"], ["p:E1", "p:E2", "d:E1", "d:E2"], obj=1.0, employee_lookup=employee_lookup))
        pool.add_pooled_route(_pooled("v2_e23", "V2", ["E2", "E3"], ["p:E2", "p:E3", "d:E2", "d:E3"], obj=1.1, employee_lookup=employee_lookup))
        pool.add_pooled_route(_pooled("v1_e1", "V1", ["E1"], ["p:E1", "d:E1"], obj=1.2, employee_lookup=employee_lookup))
        pool.add_pooled_route(_pooled("v1_e2", "V1", ["E2"], ["p:E2", "d:E2"], obj=1.3, employee_lookup=employee_lookup))
        pool.add_pooled_route(_pooled("v2_e3", "V2", ["E3"], ["p:E3", "d:E3"], obj=1.4, employee_lookup=employee_lookup))

        # Rare coverage route: only route that covers ERARE, but it's individually expensive.
        pool.add_pooled_route(_pooled("rare", "V2", ["E3", "ERARE"], ["p:E3", "p:ERARE", "d:E3", "d:ERARE"], obj=999.0, employee_lookup=employee_lookup))
        return problem, pool

    problem_no, pool_no_comp = build_pool(complementarity_enabled=False)
    problem_yes, pool_comp = build_pool(complementarity_enabled=True)

    # Under complementarity, ensure the rare route survives the cap.
    assert any(r.route_id == "rare" for r in pool_comp.get_routes())
    # Under pure objective trim, it's expected to be dropped.
    assert not any(r.route_id == "rare" for r in pool_no_comp.get_routes())

    res_no = solve_set_partition(problem_no, pool_no_comp.get_routes(), time_limit_sec=0.5, allow_relaxed_fallback=True)
    assert "ERARE" in set(res_no.uncovered_employee_ids)

    res_yes = solve_set_partition(problem_yes, pool_comp.get_routes(), time_limit_sec=0.5, allow_relaxed_fallback=True)
    assert "ERARE" not in set(res_yes.uncovered_employee_ids)
