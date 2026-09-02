from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _payload_4e_2v():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {"distance_metric": "haversine", "seed": 999},
        "employees": [
            {"id": "E1", "priority": "High", "pickup": {"lat": 12.97, "lng": 77.59}, "dropoff": {"lat": 12.93, "lng": 77.62}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E2", "priority": "Medium", "pickup": {"lat": 12.96, "lng": 77.63}, "dropoff": {"lat": 12.93, "lng": 77.67}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E3", "priority": "Low", "pickup": {"lat": 12.99, "lng": 77.60}, "dropoff": {"lat": 12.94, "lng": 77.64}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E4", "priority": "Low", "pickup": {"lat": 12.95, "lng": 77.58}, "dropoff": {"lat": 12.92, "lng": 77.61}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
        ],
        "vehicles": [
            {"id": "V1", "capacity": 2, "cost_per_km": 12, "avg_speed_kmph": 25, "start_location": {"lat": 12.976, "lng": 77.599}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
            {"id": "V2", "capacity": 2, "cost_per_km": 12, "avg_speed_kmph": 25, "start_location": {"lat": 12.976, "lng": 77.599}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
        ],
        "baseline": {eid: {"cost": 200, "time": 40} for eid in ["E1", "E2", "E3", "E4"]},
    }


def _make_problem_and_individual():
    from parser import JsonParser
    from initialization import PopulationInitializer
    from utils import configure_distance_metric

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_payload_4e_2v())
    init = PopulationInitializer(problem)
    population = init.generate_population(4, {"regret": 0.6, "grasp": 0.2, "random": 0.2})
    population.sort(key=lambda x: x.objective_score)
    return problem, population[0]


def _assert_same_eval(a, b):
    assert pytest.approx(a.objective_score, rel=0, abs=1e-9) == b.objective_score
    assert pytest.approx(a.base_objective_score, rel=0, abs=1e-9) == b.base_objective_score
    assert dict(a.penalty_breakdown or {}) == dict(b.penalty_breakdown or {})
    assert dict(a.route_penalty_breakdown or {}) == dict(b.route_penalty_breakdown or {})
    assert list(a.violations or []) == list(b.violations or [])
    assert list(a.consistency_errors or []) == list(b.consistency_errors or [])
    for ra, rb in zip(a.routes, b.routes):
        assert bool(getattr(ra, "is_feasible", True)) == bool(getattr(rb, "is_feasible", True))
        assert dict(getattr(ra, "penalty_breakdown", {}) or {}) == dict(getattr(rb, "penalty_breakdown", {}) or {})


def test_incremental_eval_matches_full_for_relocate_like_change():
    from objective import ObjectiveEvaluator
    from operators import GeneticOperators

    problem, base = _make_problem_and_individual()
    evaluator = ObjectiveEvaluator(problem)
    ops = GeneticOperators(problem)

    evaluator.evaluate(base, penalty_factor=10.0, phase_progress=0.9, enforce_hard=True)
    state = evaluator.build_incremental_state(base, penalty_factor=10.0, phase_progress=0.9, enforce_hard=True)

    # Find a feasible relocate-like edit: remove one employee from a route and insert into another.
    route_indices = [idx for idx, r in enumerate(base.routes) if ops._pickup_employee_ids(r)]
    if len(route_indices) < 1:
        pytest.skip("No non-empty routes in base individual")

    src_idx = route_indices[0]
    src_route = base.routes[src_idx]
    src_ids = ops._pickup_employee_ids(src_route)
    if not src_ids:
        pytest.skip("No pickups to relocate")

    emp_id = src_ids[0]
    emp = ops._employee_by_id.get(str(emp_id))
    if emp is None:
        pytest.skip("Employee lookup failed")

    # Choose a destination route (different if possible).
    dst_idx = 1 if len(base.routes) > 1 and src_idx != 1 else (0 if src_idx != 0 else None)
    if dst_idx is None or dst_idx == src_idx:
        pytest.skip("No destination route for relocate-like test")

    src_without = [s for s in src_route.stop_sequence if str(s.get("emp").id) != str(emp_id)]
    if not ops._check_precedence(src_without):
        pytest.skip("Source removal breaks precedence unexpectedly")

    dst_route = base.routes[dst_idx]
    seq_dst, _ = ops._find_best_insertion_for_route(dst_route, emp, strictness=0.9, penalty_factor=10.0, allow_soft=False)
    if seq_dst is None:
        pytest.skip("No feasible insertion found for relocate-like test")

    candidate_inc = copy.deepcopy(base)
    candidate_inc.routes[src_idx].stop_sequence = src_without
    ops._sync_route_employees(candidate_inc.routes[src_idx])
    candidate_inc.routes[dst_idx].stop_sequence = seq_dst
    ops._sync_route_employees(candidate_inc.routes[dst_idx])
    ops._sync_unassigned(candidate_inc)

    used_inc = evaluator.evaluate_incremental(
        candidate_inc,
        state=state,
        changed_route_indices=[src_idx, dst_idx],
        penalty_factor=10.0,
        phase_progress=0.9,
        enforce_hard=True,
    )
    assert used_inc is True

    candidate_full = copy.deepcopy(candidate_inc)
    evaluator.evaluate(candidate_full, penalty_factor=10.0, phase_progress=0.9, enforce_hard=True)

    _assert_same_eval(candidate_inc, candidate_full)


def test_neighborhood_search_exposes_delta_eval_metrics():
    from objective import ObjectiveEvaluator
    from operators import GeneticOperators
    from neighborhoods import NeighborhoodSearch

    problem, base = _make_problem_and_individual()
    evaluator = ObjectiveEvaluator(problem)
    ops = GeneticOperators(problem)
    ns = NeighborhoodSearch(problem, operators=ops, evaluator=evaluator)
    improved = ns.improve(base, max_moves=2, penalty_factor=8.0, phase_progress=0.9)
    meta = dict(getattr(improved, "metadata", {}) or {})
    assert "deltaEvalMetrics" in meta
    assert int(meta["deltaEvalMetrics"].get("candidateEvaluations", 0)) >= 0
