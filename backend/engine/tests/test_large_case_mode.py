import sys
import types
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

if "hybrid_ortools" not in sys.modules:
    hybrid_ortools_stub = types.ModuleType("hybrid_ortools")
    hybrid_ortools_stub.build_assignment_seed = lambda *args, **kwargs: {}
    sys.modules["hybrid_ortools"] = hybrid_ortools_stub

if "set_partition" not in sys.modules:
    set_partition_stub = types.ModuleType("set_partition")
    set_partition_stub.solve_set_partition = lambda *args, **kwargs: {}
    sys.modules["set_partition"] = set_partition_stub

from main import (  # noqa: E402
    FREE_LARGE_CASE_MAX_RUNTIME_SEC,
    PREMIUM_LARGE_CASE_MAX_RUNTIME_SEC,
    _apply_large_case_profile,
    _validate_problem_for_solve,
)
from parser import JsonParser  # noqa: E402


def _canonical_case(employee_count=2, vehicle_count=2):
    employees = []
    for i in range(employee_count):
        employees.append(
            {
                "id": f"E{i + 1}",
                "priority": "Medium",
                "pickup": {"lat": 12.90 + i * 0.01, "lng": 77.50 + i * 0.01},
                "dropoff": {"lat": 12.97, "lng": 77.59},
                "time_window": {"start": "08:00", "end": "10:00"},
            }
        )

    vehicles = []
    for i in range(vehicle_count):
        vehicles.append(
            {
                "id": f"V{i + 1}",
                "fuel_type": "petrol",
                "capacity": 4,
                "cost_per_km": 10,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 12.95 + i * 0.0005, "lng": 77.55 + i * 0.0005},
                "available_time": "07:30",
                "category": "normal",
            }
        )

    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {"distance_metric": "osrm", "seed": 4242},
        "employees": employees,
        "vehicles": vehicles,
        "baseline": {emp["id"]: {"cost": 100, "time": 30} for emp in employees},
    }


def test_free_large_case_profile_applies_fast_budget():
    problem = JsonParser().load_from_canonical(_canonical_case(employee_count=75, vehicle_count=26))

    metadata, context, profile = _apply_large_case_profile(problem, dict(problem.metadata or {}), "free")

    assert context["is_large"] is True
    assert context["vehicle_count"] == 26
    assert context["vehiclePressureLarge"] is True
    assert metadata["COMPUTE_TIER"] == "free"
    assert metadata["LARGE_CASE_MODE"] == "free"
    assert metadata["TIME_LIMIT_SEC"] == FREE_LARGE_CASE_MAX_RUNTIME_SEC
    assert metadata["MAX_RUN_SECONDS"] == FREE_LARGE_CASE_MAX_RUNTIME_SEC
    assert metadata["SKIP_DISTANCE_PRECOMPUTE"] == "true"
    assert metadata["ROUTE_POOL_ENABLED"] == "false"
    assert metadata["ORTOOLS_SEED_ASSIGNMENT_ENABLED"] == "false"
    assert metadata["LARGE_CASE_FIXED_RUNS"] == 1
    assert metadata["LARGE_CASE_FIXED_GENERATIONS"] == 36
    assert profile["force_distance_metric"] == "haversine"


def test_premium_large_case_profile_applies_extended_budget():
    problem = JsonParser().load_from_canonical(_canonical_case(employee_count=75, vehicle_count=26))

    metadata, context, profile = _apply_large_case_profile(problem, dict(problem.metadata or {}), "premium")

    assert context["is_large"] is True
    assert context["vehiclePressureLarge"] is True
    assert metadata["COMPUTE_TIER"] == "premium"
    assert metadata["LARGE_CASE_MODE"] == "premium"
    assert metadata["TIME_LIMIT_SEC"] == PREMIUM_LARGE_CASE_MAX_RUNTIME_SEC
    assert metadata["MAX_RUN_SECONDS"] == PREMIUM_LARGE_CASE_MAX_RUNTIME_SEC
    assert metadata["SKIP_DISTANCE_PRECOMPUTE"] == "false"
    assert metadata["ROUTE_POOL_ENABLED"] == "true"
    assert metadata["ORTOOLS_SEED_ASSIGNMENT_ENABLED"] == "false"
    assert metadata["LARGE_CASE_FIXED_RUNS"] == 2
    assert metadata["LARGE_CASE_FIXED_GENERATIONS"] == 120
    assert profile["force_distance_metric"] is None


def test_standard_case_does_not_enable_large_case_mode():
    problem = JsonParser().load_from_canonical(_canonical_case(employee_count=3, vehicle_count=3))

    metadata, context, profile = _apply_large_case_profile(problem, dict(problem.metadata or {}), "free")

    assert context["is_large"] is False
    assert metadata["COMPUTE_TIER"] == "free"
    assert "LARGE_CASE_MODE" not in metadata
    assert metadata["large_case_mode"] == "false"
    assert profile is None


def test_vehicle_count_alone_does_not_trigger_large_case_mode():
    problem = JsonParser().load_from_canonical(_canonical_case(employee_count=2, vehicle_count=26))

    metadata, context, profile = _apply_large_case_profile(problem, dict(problem.metadata or {}), "free")

    assert context["vehicle_count"] == 26
    assert context["vehiclePressureLarge"] is False
    assert context["is_large"] is False
    assert metadata["COMPUTE_TIER"] == "free"
    assert metadata["large_case_mode"] == "false"
    assert profile is None


def test_absurd_vehicle_values_are_rejected_before_solve():
    problem = JsonParser().load_from_canonical(_canonical_case(employee_count=2, vehicle_count=2))
    problem.vehicles[0] = problem.vehicles[0].__class__(
        id=problem.vehicles[0].id,
        fuel_type=problem.vehicles[0].fuel_type,
        capacity=500,
        cost_per_km=999999.0,
        speed_kmph=999.0,
        start_loc=problem.vehicles[0].start_loc,
        avail_from=problem.vehicles[0].avail_from,
        category=problem.vehicles[0].category,
        original_id=problem.vehicles[0].original_id,
        display_id=problem.vehicles[0].display_id,
    )

    errors = _validate_problem_for_solve(problem)

    assert any("capacity" in err for err in errors)
    assert any("cost_per_km" in err for err in errors)
    assert any("speed_kmph" in err for err in errors)


def test_large_but_valid_case_is_not_rejected_before_solve():
    problem = JsonParser().load_from_canonical(_canonical_case(employee_count=320, vehicle_count=30))

    errors = _validate_problem_for_solve(problem)

    assert errors == []
