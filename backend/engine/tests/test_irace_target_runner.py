from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
RUNNER = ENGINE_DIR / "benchmarks" / "irace_target_runner.py"


def _write_tiny_instance(tmp_path: Path) -> Path:
    payload = {
        "schema_version": "1.0",
        "problem_type": "employee_transport_many_to_one",
        "metadata": {
            "distance_metric": "haversine",
            "ROUTE_POOL_ENABLED": "false",
            "ORTOOLS_SEED_ASSIGNMENT_ENABLED": "false",
            "SET_PARTITION_TIME_LIMIT_SEC": 0.0,
            "TIME_LIMIT_SEC": 2.0,
            "MIN_RUNTIME_SEC": 0.2,
        },
        "employees": [
            {"id": "E1", "priority": "Low", "pickup": {"lat": 0.0, "lng": 0.01}, "dropoff": {"lat": 0.0, "lng": 0.02}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
            {"id": "E2", "priority": "Low", "pickup": {"lat": 0.0, "lng": 0.03}, "dropoff": {"lat": 0.0, "lng": 0.04}, "time_window": {"start": "08:00", "end": "23:59"}, "vehicle_preference": "normal", "sharing_preference": "double"},
        ],
        "vehicles": [
            {"id": "V1", "capacity": 2, "cost_per_km": 12, "avg_speed_kmph": 25, "start_location": {"lat": 0.0, "lng": 0.0}, "available_time": "07:45", "category": "normal", "fuel_type": "petrol"},
        ],
        "baseline": {"E1": {"cost": 10, "time": 10}, "E2": {"cost": 10, "time": 10}},
    }
    path = tmp_path / "tiny.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def _run(cmd: list[str]) -> str:
    env = dict(os.environ)
    env["DISTANCE_METRIC"] = "haversine"
    env["DISTANCE_CACHE_PERSIST"] = "0"
    env["PYTHONHASHSEED"] = "0"
    proc = subprocess.run(
        cmd,
        cwd=str(ENGINE_DIR),
        text=True,
        capture_output=True,
        env=env,
        timeout=120,
        check=True,
    )
    return (proc.stdout or "").strip()


class TestIraceTargetRunner:
    def test_argparse_style_invocation_outputs_numeric(self, tmp_path: Path):
        inst = _write_tiny_instance(tmp_path)
        out = _run(
            [
                sys.executable,
                str(RUNNER),
                "--instance",
                str(inst),
                "--seed",
                "11",
                "--intensity",
                "low",
                "--runs",
                "1",
                "--max-workers",
                "1",
                "--param",
                "OFFSPRING_EDUCATION_ENABLED=true",
            ]
        )
        float(out)  # must be parseable

    def test_positional_irace_invocation_outputs_numeric(self, tmp_path: Path):
        inst = _write_tiny_instance(tmp_path)
        out = _run(
            [
                sys.executable,
                str(RUNNER),
                "1",  # config id
                str(inst),
                "11",
                "--param",
                "OFFSPRING_EDUCATION_ENABLED=true",
            ]
        )
        float(out)

    def test_forbidden_param_is_rejected(self, tmp_path: Path):
        inst = _write_tiny_instance(tmp_path)
        env = dict(os.environ)
        env["DISTANCE_METRIC"] = "haversine"
        env["DISTANCE_CACHE_PERSIST"] = "0"
        env["PYTHONHASHSEED"] = "0"
        proc = subprocess.run(
            [
                sys.executable,
                str(RUNNER),
                "--instance",
                str(inst),
                "--seed",
                "11",
                "--param",
                "OBJECTIVE_COST_WEIGHT=0.9",
            ],
            cwd=str(ENGINE_DIR),
            text=True,
            capture_output=True,
            env=env,
            timeout=120,
        )
        assert proc.returncode != 0

    def test_deterministic_under_fixed_seed(self, tmp_path: Path):
        inst = _write_tiny_instance(tmp_path)
        cmd = [
            sys.executable,
            str(RUNNER),
            "--instance",
            str(inst),
            "--seed",
            "42",
            "--intensity",
            "low",
            "--runs",
            "1",
            "--max-workers",
            "1",
            "--param",
            "OFFSPRING_EDUCATION_ENABLED=true",
        ]
        out1 = _run(cmd)
        out2 = _run(cmd)
        assert out1 == out2

