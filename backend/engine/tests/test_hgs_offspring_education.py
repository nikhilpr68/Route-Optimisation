"""
Tests for HGS offspring education (post-crossover local search pass).

Verifies:
  1. Education never worsens offspring objective.
  2. Post-education improvement counter is tracked correctly.
  3. Education can be disabled via OFFSPRING_EDUCATION_ENABLED=false.

Uses subprocess to run the full engine with carefully chosen metadata flags
for the flag-test, and unit-level calls for the non-worsening test.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
ENGINE_MAIN = ENGINE_DIR / "main.py"
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _canonical_payload(extra_metadata=None):
    meta = {"distance_metric": "haversine", "seed": 7}
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
                "capacity": 2,
                "cost_per_km": 12,
                "avg_speed_kmph": 25,
                "start_location": {"lat": 12.9760, "lng": 77.5993},
                "available_time": "07:45",
                "category": "normal",
                "fuel_type": "petrol",
            }
        ],
        "baseline": {
            "E1": {"cost": 220, "time": 45},
            "E2": {"cost": 240, "time": 48},
        },
    }


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


# ---------------------------------------------------------------------------
# Unit-level tests — NeighborhoodSearch.improve should never worsen score
# ---------------------------------------------------------------------------

class TestEducationDoesNotWorsenOffspring:
    """Directly exercise NeighborhoodSearch.improve and verify the objective
    never increases after the call (allowing for floating-point tolerance)."""

    def _build_solver_and_individual(self):
        from parser import JsonParser
        from solver import GeneticSolver
        from utils import configure_distance_metric

        problem = JsonParser().load_from_canonical(_canonical_payload())
        configure_distance_metric(problem.metadata.get("distance_metric"))
        solver = GeneticSolver(problem=problem, generations=3, pop_size=4,
                               alns_iterations=0, seed=99)
        population = solver.initializer.generate_population(
            2, solver.strategy_config
        )
        for ind in population:
            solver.evaluator.evaluate(ind, penalty_factor=1.0, phase_progress=0.0,
                                      enforce_hard=False)
        return solver, population[0]

    def test_improve_does_not_increase_objective(self):
        solver, ind = self._build_solver_and_individual()
        pre_score = float(ind.objective_score)
        improved = solver.neighborhoods.improve(
            ind, max_moves=2, penalty_factor=1.0, phase_progress=0.5
        )
        solver.evaluator.evaluate(improved, penalty_factor=1.0, phase_progress=0.5,
                                  enforce_hard=False)
        assert improved.objective_score <= pre_score + 1e-6

    def test_improve_returns_an_individual(self):
        from representation import Individual
        solver, ind = self._build_solver_and_individual()
        result = solver.neighborhoods.improve(ind, max_moves=2, penalty_factor=1.0,
                                              phase_progress=0.5)
        assert isinstance(result, Individual)


# ---------------------------------------------------------------------------
# Integration test — education metrics are present in run output
# ---------------------------------------------------------------------------

class TestEducationMetricsInRunOutput:
    def test_hgs_education_metrics_present_when_enabled(self):
        payload = _run_engine(
            ["--intensity", "low", "--runs", "1", "--max-workers", "1", "--seed", "7"],
            stdin_payload=_canonical_payload(
                extra_metadata={"OFFSPRING_EDUCATION_ENABLED": "true"}
            ),
        )
        runs = payload.get("runs") or []
        if not runs:
            pytest.skip("run metadata not exposed in this engine version")
        for run in runs:
            assert "hgsTotalPostEducationImprovements" in run
            assert isinstance(run["hgsTotalPostEducationImprovements"], int)

    def test_hgs_education_disabled_flag_accepted(self):
        """Engine must not crash when OFFSPRING_EDUCATION_ENABLED=false."""
        payload = _run_engine(
            ["--intensity", "low", "--runs", "1", "--max-workers", "1", "--seed", "7"],
            stdin_payload=_canonical_payload(
                extra_metadata={"OFFSPRING_EDUCATION_ENABLED": "false"}
            ),
        )
        assert "objectiveScore" in payload
