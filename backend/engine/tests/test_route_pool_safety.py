import sys
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from models import Employee, Location, ProblemInstance, Vehicle
from representation import Individual, Route
from route_pool import PooledRoute, RoutePoolManager
from set_partition import solve_set_partition
from utils import configure_distance_metric


def _problem_for_pool_tests():
    employee = Employee(
        id="E1",
        priority=2,
        pickup_loc=Location(12.9716, 77.5946),
        drop_loc=Location(12.9611, 77.6387),
        earliest_pickup=8 * 60,
        latest_drop=9 * 60,
        vehicle_pref="normal",
        sharing_pref="single",
    )
    vehicles = [
        Vehicle(
            id="V1",
            fuel_type="petrol",
            capacity=1,
            cost_per_km=10.0,
            speed_kmph=25.0,
            start_loc=Location(12.9700, 77.5900),
            avail_from=7 * 60 + 45,
            category="normal",
        ),
        Vehicle(
            id="V2",
            fuel_type="diesel",
            capacity=1,
            cost_per_km=12.0,
            speed_kmph=18.0,
            start_loc=Location(12.9300, 77.5600),
            avail_from=7 * 60 + 15,
            category="normal",
        ),
    ]
    return ProblemInstance(employees=[employee], vehicles=vehicles, metadata={"distance_metric": "haversine"}, baseline={})


def _single_employee_route(vehicle, employee):
    return Route(
        vehicle=vehicle,
        stop_sequence=[
            {"type": "p", "emp": employee},
            {"type": "d", "emp": employee},
        ],
    )


def _timing_variant(vehicle_id: str, total_time: float, total_delay: float, objective: float) -> PooledRoute:
    return PooledRoute(
        route_id=f"{vehicle_id}-{int(total_time)}-{int(total_delay)}",
        vehicle_id=vehicle_id,
        vehicle_category="normal",
        passenger_set=("E1",),
        sequence_signature=("p:E1", "d:E1"),
        stop_sequence=[],
        objective_score=objective,
        total_cost=objective,
        total_time=total_time,
        total_delay=total_delay,
        penalty_total=0.0,
        penalty_breakdown={},
        is_feasible=True,
        hard_violation_count=0,
    )


def test_same_passenger_set_different_vehicles_survive_in_safe_mode():
    configure_distance_metric("haversine")
    problem = _problem_for_pool_tests()
    employee = problem.employees[0]
    route_v1 = _single_employee_route(problem.vehicles[0], employee)
    route_v2 = _single_employee_route(problem.vehicles[1], employee)

    heuristic_pool = RoutePoolManager(problem, pruning_mode="heuristic", max_routes=20)
    heuristic_pool.add_route(route_v1, source="test", run_id=1)
    heuristic_pool.add_route(route_v2, source="test", run_id=1)

    safe_pool = RoutePoolManager(problem, pruning_mode="safe", max_routes=20)
    safe_pool.add_route(route_v1, source="test", run_id=1)
    safe_pool.add_route(route_v2, source="test", run_id=1)

    # Even in heuristic mode, route-pool identity must be vehicle-aware so we
    # do not accidentally drop candidates required by the master (<= 1 route
    # per vehicle).
    assert len(heuristic_pool.get_routes()) == 2
    assert len(safe_pool.get_routes()) == 2
    assert safe_pool.stats()["mode"] == "safe"


def test_same_passenger_set_different_timing_variants_survive_in_safe_mode():
    problem = _problem_for_pool_tests()

    heuristic_pool = RoutePoolManager(problem, pruning_mode="heuristic", max_routes=20)
    heuristic_pool.add_pooled_route(_timing_variant("V1", total_time=12.0, total_delay=0.0, objective=10.0))
    heuristic_pool.add_pooled_route(_timing_variant("V1", total_time=36.0, total_delay=18.0, objective=12.0))

    safe_pool = RoutePoolManager(problem, pruning_mode="safe", max_routes=20)
    safe_pool.add_pooled_route(_timing_variant("V1", total_time=12.0, total_delay=0.0, objective=10.0))
    safe_pool.add_pooled_route(_timing_variant("V1", total_time=36.0, total_delay=18.0, objective=12.0))

    assert len(heuristic_pool.get_routes()) == 1
    assert len(safe_pool.get_routes()) == 2


def test_heuristic_mode_retains_more_aggressive_pruning_behavior():
    problem = _problem_for_pool_tests()
    heuristic_pool = RoutePoolManager(problem, pruning_mode="heuristic", max_routes=20)
    safe_pool = RoutePoolManager(problem, pruning_mode="safe", max_routes=20)

    routes = [
        _timing_variant("V1", total_time=10.0, total_delay=0.0, objective=10.0),
        _timing_variant("V1", total_time=20.0, total_delay=5.0, objective=11.0),
        _timing_variant("V2", total_time=22.0, total_delay=6.0, objective=12.0),
    ]
    for r in routes:
        heuristic_pool.add_pooled_route(r)
        safe_pool.add_pooled_route(r)

    stats = heuristic_pool.stats()

    # Heuristic mode can still be aggressive (e.g., collapsing timing variants
    # for the same vehicle+passenger+sequence), but it should not collapse
    # across vehicles.
    assert len(heuristic_pool.get_routes()) == 2
    assert len(safe_pool.get_routes()) == 3
    assert stats["duplicatesRejected"] >= 1
    assert stats["mode"] == "heuristic"


def test_exact_master_receives_richer_pool_in_safe_mode():
    configure_distance_metric("haversine")
    problem = _problem_for_pool_tests()
    # Build two timing variants for the *same* vehicle and passenger/sequence.
    # Safe mode keeps both variants (timing footprint matters); heuristic mode
    # collapses them to one representative.
    heuristic_pool = RoutePoolManager(problem, pruning_mode="heuristic", max_routes=20)
    heuristic_pool.add_pooled_route(_timing_variant("V1", total_time=12.0, total_delay=0.0, objective=10.0))
    heuristic_pool.add_pooled_route(_timing_variant("V1", total_time=36.0, total_delay=18.0, objective=12.0))

    safe_pool = RoutePoolManager(problem, pruning_mode="safe", max_routes=20)
    safe_pool.add_pooled_route(_timing_variant("V1", total_time=12.0, total_delay=0.0, objective=10.0))
    safe_pool.add_pooled_route(_timing_variant("V1", total_time=36.0, total_delay=18.0, objective=12.0))

    heuristic_result = solve_set_partition(
        problem,
        heuristic_pool.get_routes(),
        time_limit_sec=1.0,
        allow_relaxed_fallback=False,
    )
    safe_result = solve_set_partition(
        problem,
        safe_pool.get_routes(),
        time_limit_sec=1.0,
        allow_relaxed_fallback=False,
    )

    assert heuristic_result.metadata["poolSize"] == 1
    assert safe_result.metadata["poolSize"] == 2
