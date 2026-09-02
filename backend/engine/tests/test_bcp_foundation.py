from __future__ import annotations

import sys
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _canonical_2e_1v():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {"distance_metric": "haversine", "seed": 7},
        "employees": [
            {"id": "E1", "priority": "High", "pickup": {"lat": 12.97, "lng": 77.59}, "dropoff": {"lat": 12.93, "lng": 77.62}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E2", "priority": "Medium", "pickup": {"lat": 12.96, "lng": 77.63}, "dropoff": {"lat": 12.93, "lng": 77.67}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
        ],
        "vehicles": [
            {"id": "V1", "capacity": 2, "cost_per_km": 12, "avg_speed_kmph": 25, "start_location": {"lat": 12.976, "lng": 77.599}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
        ],
        "baseline": {eid: {"cost": 200, "time": 40} for eid in ["E1", "E2"]},
    }


def _pooled_route(*, route_id: str, objective: float, feasible: bool):
    from route_pool import PooledRoute

    return PooledRoute(
        route_id=str(route_id),
        vehicle_id="V1",
        vehicle_category="normal",
        passenger_set=("E1", "E2"),
        sequence_signature=("p:E1", "p:E2", "d:E1", "d:E2"),
        stop_sequence=[],
        objective_score=float(objective),
        total_cost=float(objective),
        total_time=0.0,
        total_delay=0.0,
        penalty_total=0.0,
        penalty_breakdown={},
        is_feasible=bool(feasible),
        hard_violation_count=(0 if feasible else 1),
        violations=[],
        source="test",
        run_id=0,
        generation=-1,
    )


def test_restricted_master_lp_respects_infeasible_cut_and_branching_fix_out():
    import pytest

    from bcp_foundation import BranchingState, CutOptions, MasterSolveOptions
    from parser import JsonParser
    from set_partition import solve_restricted_master_lp
    from utils import configure_distance_metric

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_2e_1v())
    cheap_infeasible = _pooled_route(route_id="R_bad", objective=1.0, feasible=False)
    expensive_feasible = _pooled_route(route_id="R_good", objective=10.0, feasible=True)
    routes = [cheap_infeasible, expensive_feasible]

    # Baseline: infeasible route can be chosen (no cut, no branching).
    lp0 = solve_restricted_master_lp(problem, routes, time_limit_sec=0.5, options=MasterSolveOptions())
    if lp0.status == "solver_unavailable":
        pytest.skip("LP solver unavailable (ortools GLOP/CLP not present); dual-based master tests skipped")
    assert lp0.status in ("optimal", "feasible")
    assert float(lp0.primal_values.get("R_bad", 0.0)) > 0.9

    # Cut hook: disallow infeasible routes forces selection of feasible route.
    lp_cut = solve_restricted_master_lp(
        problem,
        routes,
        time_limit_sec=0.5,
        options=MasterSolveOptions(branching=BranchingState(), cuts=CutOptions(disallow_infeasible_routes=True)),
    )
    assert lp_cut.status in ("optimal", "feasible")
    assert float(lp_cut.primal_values.get("R_bad", 0.0)) < 1e-6
    assert float(lp_cut.primal_values.get("R_good", 0.0)) > 0.9

    # Branching-state plumbing: fix out a route_id.
    lp_branch = solve_restricted_master_lp(
        problem,
        routes,
        time_limit_sec=0.5,
        options=MasterSolveOptions(branching=BranchingState(fixed_out_route_ids={"R_bad"}), cuts=CutOptions()),
    )
    assert lp_branch.status in ("optimal", "feasible")
    assert float(lp_branch.primal_values.get("R_bad", 0.0)) < 1e-6
    assert float(lp_branch.primal_values.get("R_good", 0.0)) > 0.9


def test_column_generation_foundation_wires_into_route_pool_layer():
    from parser import JsonParser
    from solver import GeneticSolver
    from utils import configure_distance_metric

    canonical = {
        **_canonical_2e_1v(),
        "metadata": {
            "distance_metric": "haversine",
            "seed": 2026,
            "ROUTE_POOL_ENABLED": True,
            "ROUTE_POOL_SAFE_MODE": True,
            "SET_PARTITION_ITERATIONS": 2,
            "SET_PARTITION_NO_IMPROVE_ITERS": 2,
            "SET_PARTITION_TIME_LIMIT_SEC": 1.5,
            "ROUTE_POOL_MAX_ROUTES": 250,
            "ROUTE_POOL_TARGETED_VARIANTS": 2,
            "ROUTE_POOL_ITER_TOPK_ROUTES": 0,
            "COLUMN_GENERATION_ENABLED": True,
            "COLUMN_GENERATION_MAX_ITERS": 2,
            "COLUMN_GENERATION_LP_TIME_LIMIT_SEC": 0.4,
        },
    }

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(canonical)
    solver = GeneticSolver(problem=problem, generations=5, pop_size=8, alns_iterations=0, seed=2026)
    _, meta = solver.solve(run_id=1)

    setp = meta.get("setPartitionStats") or {}
    cg = (setp.get("columnGeneration") or {}) if isinstance(setp, dict) else {}
    assert cg.get("enabled") is True
    cg_iters = cg.get("iterations") or []
    assert len(cg_iters) >= 1
    assert "pricing" in cg_iters[0]
    assert "type" in cg_iters[0]["pricing"]
