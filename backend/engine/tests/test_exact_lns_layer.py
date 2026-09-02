from __future__ import annotations

import sys
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _payload_3e_2v(extra_metadata=None):
    meta = {"distance_metric": "haversine", "seed": 11}
    if extra_metadata:
        meta.update(extra_metadata)
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": meta,
        "employees": [
            {
                "id": "E1",
                "priority": "High",
                "pickup": {"lat": 0.0, "lng": 0.01},
                "dropoff": {"lat": 0.0, "lng": 0.02},
                "time_window": {"start": "08:00", "end": "23:59"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
            {
                "id": "E2",
                "priority": "Medium",
                "pickup": {"lat": 0.0, "lng": 0.10},
                "dropoff": {"lat": 0.0, "lng": 0.20},
                "time_window": {"start": "08:00", "end": "23:59"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
            {
                "id": "E3",
                "priority": "Low",
                "pickup": {"lat": 0.0, "lng": 1.00},
                "dropoff": {"lat": 0.0, "lng": 1.10},
                "time_window": {"start": "08:00", "end": "23:59"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
        ],
        "vehicles": [
            {
                "id": "V1",
                "capacity": 2,
                "cost_per_km": 12,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 0.0, "lng": 0.0},
                "available_time": "07:45",
                "category": "normal",
                "fuel_type": "petrol",
            },
            {
                "id": "V2",
                "capacity": 2,
                "cost_per_km": 12,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 0.0, "lng": 0.0},
                "available_time": "07:45",
                "category": "normal",
                "fuel_type": "petrol",
            },
        ],
        "baseline": {
            "E1": {"cost": 10, "time": 10},
            "E2": {"cost": 10, "time": 10},
            "E3": {"cost": 10, "time": 10},
        },
    }


def _make_problem():
    from parser import JsonParser
    from utils import configure_distance_metric

    problem = JsonParser().load_from_canonical(_payload_3e_2v())
    # Tests must not rely on network-backed OSRM.
    configure_distance_metric("haversine")
    return problem


def _make_incumbent(problem):
    from representation import Individual, Route

    employees = {str(e.id): e for e in problem.employees}
    vehicles = {str(v.id): v for v in problem.vehicles}

    r1 = Route(
        vehicle=vehicles["V1"],
        employees=[employees["E1"]],
        stop_sequence=[{"type": "p", "emp": employees["E1"]}, {"type": "d", "emp": employees["E1"]}],
    )
    # Intentionally long / expensive route: includes far employee E3.
    r2 = Route(
        vehicle=vehicles["V2"],
        employees=[employees["E2"], employees["E3"]],
        stop_sequence=[
            {"type": "p", "emp": employees["E3"]},
            {"type": "p", "emp": employees["E2"]},
            {"type": "d", "emp": employees["E3"]},
            {"type": "d", "emp": employees["E2"]},
        ],
    )
    return Individual(routes=[r1, r2], unassigned=[])


class TestExactLnsFragment:
    def test_select_fragment_routes_worst_cost_picks_expensive_route(self):
        from exact_lns import select_fragment_routes
        from objective import ObjectiveEvaluator

        problem = _make_problem()
        incumbent = _make_incumbent(problem)
        ObjectiveEvaluator(problem).evaluate(incumbent, penalty_factor=12.0, phase_progress=1.0, enforce_hard=True)

        vehicle_ids, employee_ids, meta = select_fragment_routes(
            problem=problem,
            incumbent=incumbent,
            strategy="worst_cost",
            fragment_routes=1,
            include_unassigned=False,
        )
        assert meta["chosenRouteCount"] == 1
        assert vehicle_ids == ["V2"]
        assert set(employee_ids) == {"E2", "E3"}

    def test_select_fragment_routes_dual_hot_uses_employee_scores(self):
        from exact_lns import ExactLnsSignals, select_fragment_routes
        from objective import ObjectiveEvaluator

        problem = _make_problem()
        incumbent = _make_incumbent(problem)
        ObjectiveEvaluator(problem).evaluate(incumbent, penalty_factor=12.0, phase_progress=1.0, enforce_hard=True)

        # Make the *cheaper* route (V1 covers E1) look more important to the master.
        signals = ExactLnsSignals(
            employee_scores={"E1": 1000.0, "E2": 0.0, "E3": 0.0},
            employee_instability={},
            source="test_duals",
        )

        vehicle_ids, employee_ids, meta = select_fragment_routes(
            problem=problem,
            incumbent=incumbent,
            strategy="dual_hot",
            fragment_routes=1,
            include_unassigned=False,
            signals=signals,
        )
        assert meta["strategyUsed"] == "dual_hot"
        assert meta["signalsAvailable"]["employeeScores"] is True
        assert vehicle_ids == ["V1"]
        assert set(employee_ids) == {"E1"}

    def test_select_fragment_routes_unstable_uses_instability_scores(self):
        from exact_lns import ExactLnsSignals, select_fragment_routes
        from objective import ObjectiveEvaluator

        problem = _make_problem()
        incumbent = _make_incumbent(problem)
        ObjectiveEvaluator(problem).evaluate(incumbent, penalty_factor=12.0, phase_progress=1.0, enforce_hard=True)

        signals = ExactLnsSignals(
            employee_scores={},
            employee_instability={"E1": 999, "E2": 0, "E3": 0},
            source="test_instability",
        )

        vehicle_ids, employee_ids, meta = select_fragment_routes(
            problem=problem,
            incumbent=incumbent,
            strategy="unstable",
            fragment_routes=1,
            include_unassigned=False,
            signals=signals,
        )
        assert meta["strategyUsed"] == "unstable"
        assert meta["signalsAvailable"]["employeeInstability"] is True
        assert vehicle_ids == ["V1"]
        assert set(employee_ids) == {"E1"}

    def test_select_fragment_routes_auto_prefers_dual_over_instability(self):
        from exact_lns import ExactLnsSignals, select_fragment_routes
        from objective import ObjectiveEvaluator

        problem = _make_problem()
        incumbent = _make_incumbent(problem)
        ObjectiveEvaluator(problem).evaluate(incumbent, penalty_factor=12.0, phase_progress=1.0, enforce_hard=True)

        signals = ExactLnsSignals(
            employee_scores={"E1": 1000.0},
            employee_instability={"E2": 999},
            source="test_auto",
        )

        vehicle_ids, employee_ids, meta = select_fragment_routes(
            problem=problem,
            incumbent=incumbent,
            strategy="auto",
            fragment_routes=1,
            include_unassigned=False,
            signals=signals,
        )
        assert meta["strategyUsed"] == "dual_hot"
        assert vehicle_ids == ["V1"]
        assert set(employee_ids) == {"E1"}

    def test_splice_preserves_fixed_routes(self):
        from exact_lns import splice_fragment_solution
        from representation import Individual, Route

        problem = _make_problem()
        incumbent = _make_incumbent(problem)

        # Fragment solution replaces only V2 (empty route).
        v2 = next(v for v in problem.vehicles if str(v.id) == "V2")
        fragment_solution = Individual(routes=[Route(vehicle=v2, employees=[], stop_sequence=[])], unassigned=[])

        spliced = splice_fragment_solution(
            full_problem=problem,
            incumbent=incumbent,
            fragment_solution=fragment_solution,
            fragment_vehicle_ids=["V2"],
            fragment_employee_ids=["E2", "E3"],
        )

        # V1 route sequence must be identical.
        assert spliced.routes[0].vehicle.id == "V1"
        assert spliced.routes[0].stop_sequence == incumbent.routes[0].stop_sequence

    def test_should_accept_splice_accepts_true_improvement(self):
        from exact_lns import should_accept_splice
        from objective import ObjectiveEvaluator
        from representation import Individual, Route

        problem = _make_problem()
        incumbent = _make_incumbent(problem)

        employees = {str(e.id): e for e in problem.employees}
        vehicles = {str(v.id): v for v in problem.vehicles}

        # Candidate changes V2 stop order to reduce travel (E2 is near start, E3 far).
        improved_v2 = Route(
            vehicle=vehicles["V2"],
            employees=[employees["E2"], employees["E3"]],
            stop_sequence=[
                {"type": "p", "emp": employees["E2"]},
                {"type": "p", "emp": employees["E3"]},
                {"type": "d", "emp": employees["E2"]},
                {"type": "d", "emp": employees["E3"]},
            ],
        )
        candidate = Individual(routes=[incumbent.routes[0], improved_v2], unassigned=[])

        evaluator = ObjectiveEvaluator(problem)
        accepted, cand_base, inc_base = should_accept_splice(evaluator, incumbent, candidate)
        assert cand_base < inc_base  # sanity check: test construction
        assert accepted is True

    def test_run_exact_lns_attempt_refuses_oversize_fragment(self):
        import random

        from exact_lns import ExactLnsConfig, run_exact_lns_attempt

        problem = _make_problem()
        incumbent = _make_incumbent(problem)

        cfg = ExactLnsConfig(
            enabled=True,
            strategy="worst_cost",
            fragment_routes=1,
            max_fragment_employees=1,  # force refusal
            include_unassigned=False,
            seed_population=4,
            pool_max_routes=40,
            pool_pruning_mode="safe",
            time_limit_sec=0.5,
        )
        attempt = run_exact_lns_attempt(problem, incumbent, cfg, rng=random.Random(123), time_budget_sec=0.5)
        assert attempt.status == "oversize_fragment"
        assert attempt.accepted is False
        assert attempt.candidate is None
