import json
import subprocess
import sys
from pathlib import Path


ENGINE_DIR = Path(__file__).resolve().parents[1]
ENGINE_MAIN = ENGINE_DIR / "main.py"
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from lower_bound import compute_gap, derive_bound_computation


def _extract_last_json(text: str):
    decoder = json.JSONDecoder()
    idx = 0
    last_obj = None
    while idx < len(text):
        try:
            obj, end = decoder.raw_decode(text, idx)
            if isinstance(obj, dict):
                last_obj = obj
            idx = end
            continue
        except json.JSONDecodeError:
            idx += 1
    if last_obj is None:
        raise AssertionError("No JSON object found in engine output")
    return last_obj


def _sample_canonical():
    return {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "seed": 4242,
            "ROUTE_POOL_ENABLED": "true",
            "ROUTE_POOL_PRUNING_MODE": "safe",
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


def _run_engine(args, stdin_payload=None):
    cmd = [sys.executable, str(ENGINE_MAIN), *args]
    proc = subprocess.run(
        cmd,
        cwd=str(ENGINE_DIR),
        input=(json.dumps(stdin_payload) if stdin_payload is not None else None),
        text=True,
        capture_output=True,
        timeout=180,
        check=True,
    )
    stdout_only = (proc.stdout or "").strip()
    if stdout_only:
        try:
            return _extract_last_json(stdout_only)
        except AssertionError:
            pass
    combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
    return _extract_last_json(combined)


def test_gap_math_is_correct():
    gap_abs, gap_pct = compute_gap(120.0, 100.0)
    assert gap_abs == 20.0
    assert round(gap_pct, 6) == round((20.0 / 120.0) * 100.0, 6)


def test_derive_bound_computation_handles_restricted_pool_optimal():
    result = derive_bound_computation(
        incumbent_objective=50.0,
        solver_metadata={
            "lowerBound": 50.0,
            "boundScope": "restricted_route_pool",
        },
    )
    assert result.exactness_status == "exact_restricted_route_pool"
    assert result.lower_bound == 50.0
    assert result.optimality_gap_absolute == 0.0


def test_derive_bound_computation_is_conservative_about_global_claims():
    # Even if upstream metadata mistakenly claims global optimality, the bound
    # layer must not report "globally_optimal" unless global proof is present.
    result = derive_bound_computation(
        incumbent_objective=50.0,
        solver_metadata={
            "lowerBound": 50.0,
            "boundScope": "restricted_route_pool",
            "exactnessStatus": "globally_optimal",
            "globalOptimalityProven": False,
        },
    )
    assert result.exactness_status == "exact_restricted_route_pool"
    assert result.bound_scope == "restricted_route_pool"

def test_inconsistent_bound_is_discarded():
    # A lower bound that is greater than the incumbent objective is inconsistent
    # for a minimization problem; the engine should refuse to report a fake gap.
    result = derive_bound_computation(
        incumbent_objective=50.0,
        solver_metadata={
            "lowerBound": 55.0,
            "boundScope": "restricted_route_pool",
            "boundSource": "restricted_master_lp_relaxation",
        },
    )
    assert result.lower_bound is None
    assert result.exactness_status == "heuristic_incumbent_only"


def test_engine_result_exposes_new_status_and_gap_fields():
    payload = _run_engine(
        ["--intensity", "low", "--runs", "1", "--max-workers", "1", "--seed", "4242"],
        stdin_payload=_sample_canonical(),
    )
    for key in (
        "incumbent_objective",
        "lower_bound",
        "optimality_gap_absolute",
        "optimality_gap_percent",
        "exactness_status",
        "anytime_bounds_trace",
        "proof_mode_enabled",
        "route_pool_size_considered",
        "unsafe_pruning_enabled",
        "distance_backend_requested",
        "distance_backend_used",
        "fallback_occurred",
        "stop_reason",
    ):
        assert key in payload
    assert isinstance(payload.get("anytime_bounds_trace"), list)
    assert len(payload.get("anytime_bounds_trace") or []) >= 1


def test_pool_restricted_exactness_is_labeled_conservatively():
    payload = _run_engine(
        ["--intensity", "low", "--runs", "1", "--max-workers", "1", "--seed", "4242"],
        stdin_payload=_sample_canonical(),
    )
    assert payload["exactness_status"] in {
        "heuristic_incumbent_only",
        "bounded_restricted_route_pool",
        "exact_restricted_route_pool",
    }
    assert payload["exactness_status"] != "globally_optimal"


def test_distance_metadata_is_coherent():
    payload = _run_engine(
        ["--intensity", "low", "--runs", "1", "--max-workers", "1", "--seed", "4242"],
        stdin_payload=_sample_canonical(),
    )
    assert payload["distance_backend_requested"] == "haversine"
    assert payload["distance_backend_used"] == payload["distance"]["backend"]
    assert payload["fallback_occurred"] is False


def test_stop_reason_and_status_are_not_misleading():
    payload = _run_engine(
        ["--intensity", "low", "--runs", "1", "--max-workers", "1", "--seed", "4242"],
        stdin_payload=_sample_canonical(),
    )
    assert isinstance(payload["stop_reason"], str)
    assert payload["status"] in {"feasible", "partial", "infeasible"}
    assert payload["exactness_status"] != "globally_optimal"
