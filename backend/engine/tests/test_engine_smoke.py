import json
import subprocess
import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
ENGINE_MAIN = ENGINE_DIR / "main.py"
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from parser import FileParser


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


def test_engine_stdin_smoke():
    payload = _run_engine(
        ["--intensity", "low", "--runs", "1", "--max-workers", "1", "--seed", "4242"],
        stdin_payload=_sample_canonical(),
    )
    assert isinstance(payload, dict)
    assert "objectiveScore" in payload
    assert "structuralHash" in payload
    assert isinstance(payload.get("rides"), list)
    assert payload.get("solverConfig", {}).get("seed") == 4242
    assert payload.get("solverConfig", {}).get("generations") == 30
    assert payload.get("solverConfig", {}).get("timeLimitSec") == 40.0
    assert payload.get("solverConfig", {}).get("runs") == 1


def test_intensity_time_limits_from_stdin():
    expectations = {
        "low": (30, 40.0),
        "medium": (60, 120.0),
        "high": (135, 200.0),
    }

    for intensity, (expected_generations, expected_time_limit_sec) in expectations.items():
        payload = _run_engine(
            ["--intensity", intensity, "--runs", "1", "--max-workers", "1", "--seed", "4242"],
            stdin_payload=_sample_canonical(),
        )

        solver_cfg = payload.get("solverConfig", {})
        assert solver_cfg.get("intensity") == intensity
        assert solver_cfg.get("generations") == expected_generations
        assert solver_cfg.get("projectTimeLimitSec") == expected_time_limit_sec
        assert solver_cfg.get("timeLimitSec") == expected_time_limit_sec
        assert solver_cfg.get("maxRunSeconds") == expected_time_limit_sec
        assert solver_cfg.get("runs") == 1


def test_project_time_budget_is_split_across_run_batches():
    payload = _run_engine(
        ["--intensity", "high", "--runs", "4", "--max-workers", "2", "--seed", "4242"],
        stdin_payload=_sample_canonical(),
    )
    solver_cfg = payload.get("solverConfig", {})

    assert solver_cfg.get("projectTimeLimitSec") == 200.0
    assert solver_cfg.get("timeLimitSec") == 100.0
    assert solver_cfg.get("maxRunSeconds") == 100.0


def test_seed_reproducibility_from_stdin():
    args = ["--intensity", "low", "--runs", "1", "--max-workers", "1", "--seed", "4242"]
    payload_a = _run_engine(args, stdin_payload=_sample_canonical())
    payload_b = _run_engine(args, stdin_payload=_sample_canonical())
    assert payload_a.get("objectiveScore") == payload_b.get("objectiveScore")
    assert payload_a.get("structuralHash") == payload_b.get("structuralHash")


def test_custom_generation_override_from_stdin():
    payload = _run_engine(
        ["--intensity", "custom", "--runs", "1", "--max-workers", "1", "--seed", "4242", "--generations", "37", "--early-stop-enabled", "false"],
        stdin_payload=_sample_canonical(),
    )
    assert payload.get("solverConfig", {}).get("generations") == 37
    assert payload.get("solverConfig", {}).get("intensity") == "custom"


def test_cli_testcase1_smoke():
    emp = ENGINE_DIR / "testcase1" / "employees.csv"
    veh = ENGINE_DIR / "testcase1" / "vehicles.csv"
    meta = ENGINE_DIR / "testcase1" / "metadata.csv"
    base = ENGINE_DIR / "testcase1" / "baseline.csv"
    if not (emp.exists() and veh.exists() and meta.exists() and base.exists()):
        pytest.skip("testcase1 CSV fixtures are not present in this workspace")

    parser = FileParser(str(emp), str(veh), str(meta), str(base))
    problem = parser.load_data()
    assert len(problem.employees) >= 1
    assert len(problem.vehicles) >= 1
    assert len(problem.baseline) >= 1
