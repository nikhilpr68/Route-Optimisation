import sys
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from parser import JsonParser
from main import _apply_intensity_stop_profile, _derive_solver_config
from solver import GeneticSolver
from stop_controller import StopController
from utils import configure_distance_metric


def _canonical_base():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "ROUTE_POOL_ENABLED": "false",
            "ORTOOLS_SEED_ASSIGNMENT_ENABLED": "false",
            "EARLY_STOP_ENABLED": "true",
            "MIN_RUNTIME_SEC": 0.0,
        },
        "employees": [
            {
                "id": "E1",
                "priority": "High",
                "pickup": {"lat": 12.9716, "lng": 77.5946},
                "dropoff": {"lat": 12.9352, "lng": 77.6245},
                "time_window": {"start": "08:00", "end": "09:30"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
            {
                "id": "E2",
                "priority": "Medium",
                "pickup": {"lat": 12.9611, "lng": 77.6387},
                "dropoff": {"lat": 12.9304, "lng": 77.6784},
                "time_window": {"start": "08:10", "end": "09:45"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
        ],
        "vehicles": [
            {
                "id": "V1",
                "fuel_type": "petrol",
                "capacity": 2,
                "cost_per_km": 12,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 12.9760, "lng": 77.5993},
                "available_time": "07:45",
                "category": "normal",
            }
        ],
        "baseline": {
            "E1": {"cost": 220, "time": 45},
            "E2": {"cost": 240, "time": 48},
        },
    }


def _build_solver():
    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(_canonical_base())
    return GeneticSolver(problem, generations=80, pop_size=10, alns_iterations=0, seed=77)


def test_generation_budget_uses_fixed_counts_by_intensity():
    configure_distance_metric("haversine")
    canonical = _canonical_base()
    canonical["employees"].extend(
        [
            {
                "id": "E3",
                "priority": "Medium",
                "pickup": {"lat": 12.9521, "lng": 77.6175},
                "dropoff": {"lat": 12.9304, "lng": 77.6784},
                "time_window": {"start": "08:05", "end": "09:40"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
            {
                "id": "E4",
                "priority": "Low",
                "pickup": {"lat": 12.9415, "lng": 77.6291},
                "dropoff": {"lat": 12.9352, "lng": 77.6245},
                "time_window": {"start": "08:15", "end": "09:50"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            },
        ]
    )
    canonical["vehicles"].append(
        {
            "id": "V2",
            "fuel_type": "petrol",
            "capacity": 2,
            "cost_per_km": 12,
            "avg_speed_kmph": 25,
            "start_location": {"lat": 12.9650, "lng": 77.6100},
            "available_time": "07:45",
            "category": "normal",
        }
    )

    configs = {}
    for intensity in ("low", "medium", "high", "custom"):
        problem = JsonParser().load_from_canonical(
            _canonical_base() | {"employees": canonical["employees"], "vehicles": canonical["vehicles"]}
        )
        metadata = dict(problem.metadata or {})
        _apply_intensity_stop_profile(metadata, intensity)
        problem.metadata = metadata
        configs[intensity] = _derive_solver_config(problem, intensity, runs_override=None)

    assert configs["low"]["generations"] == configs["low"]["min_generation_floor"] == 30
    assert configs["medium"]["generations"] == configs["medium"]["min_generation_floor"] == 60
    assert configs["high"]["generations"] == configs["high"]["min_generation_floor"] == 135
    assert configs["custom"]["generations"] == configs["custom"]["min_generation_floor"] == 60
    assert configs["low"]["runs"] == 7
    assert configs["medium"]["runs"] == 7
    assert configs["high"]["runs"] == 7
    assert configs["custom"]["runs"] == 7
    assert configs["low"]["time_limit_sec"] == 40.0
    assert configs["medium"]["time_limit_sec"] == 120.0
    assert configs["high"]["time_limit_sec"] == 200.0
    assert configs["custom"]["time_limit_sec"] == 120.0


def test_runtime_floor_and_default_generation_floor_apply():
    solver = _build_solver()

    assert solver.employee_count == 2
    assert solver.min_runtime_floor_sec == 4.0
    assert solver.min_generation_floor == 20
    assert solver.generations >= solver.min_generation_floor


def test_explicit_time_limit_is_not_raised_by_runtime_floor():
    configure_distance_metric("haversine")
    canonical = _canonical_base()
    canonical["metadata"]["TIME_LIMIT_SEC"] = 1

    problem = JsonParser().load_from_canonical(canonical)
    solver = GeneticSolver(problem, generations=80, pop_size=10, alns_iterations=0, seed=77)

    assert solver.min_runtime_floor_sec == 4.0
    assert solver.time_limit_sec == 1.0
    assert solver.min_runtime_sec == 0.0


def test_low_fixed_generation_budget_is_not_scaled_by_employee_count():
    configure_distance_metric("haversine")
    canonical = _canonical_base()

    for idx in range(3, 16):
        canonical["employees"].append(
            {
                "id": f"E{idx}",
                "priority": "Medium",
                "pickup": {"lat": 12.95 + (idx * 0.001), "lng": 77.61 + (idx * 0.001)},
                "dropoff": {"lat": 12.93, "lng": 77.67},
                "time_window": {"start": "08:00", "end": "09:45"},
                "vehicle_preference": "normal",
                "sharing_preference": "double",
            }
        )

    problem = JsonParser().load_from_canonical(canonical)
    metadata = dict(problem.metadata or {})
    _apply_intensity_stop_profile(metadata, "low")
    problem.metadata = metadata
    solver_cfg = _derive_solver_config(problem, "low", runs_override=None)
    solver = GeneticSolver(
        problem,
        generations=solver_cfg["generations"],
        pop_size=10,
        alns_iterations=0,
        seed=77,
    )

    assert solver_cfg["generations"] == 30
    assert solver.min_generation_floor == 30
    assert solver.generations == 30


def test_time_limit_still_stops_run():
    solver = _build_solver()
    stop_controller = StopController(time_limit_sec=0.001, min_runtime_sec=0.0)
    stop_controller.start_time -= 1.0

    assert solver._should_stop_for_time_limit(stop_controller, generations_executed=0) is True
    assert solver._should_stop_for_time_limit(stop_controller, generations_executed=solver.min_generation_floor) is True


def test_convergence_stop_flag_is_disabled():
    solver = _build_solver()

    assert solver.early_stop_enabled is False
