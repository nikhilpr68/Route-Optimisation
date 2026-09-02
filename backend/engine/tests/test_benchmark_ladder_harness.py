from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def test_extract_last_json_works_with_noise():
    from benchmarks.ladder import _extract_last_json

    text = "hello\n{\"a\":1}\nnoise\n{\"b\":2,\"c\":3}\n"
    obj = _extract_last_json(text)
    assert obj == {"b": 2, "c": 3}


def test_extract_run_metrics_schema_smoke():
    from benchmarks.ladder import extract_run_metrics

    payload = {
        "objectiveScore": 123.4,
        "status": "feasible",
        "lower_bound": 120.0,
        "optimality_gap_percent": 0.028,
        "solverMetadata": {"runtimeSec": 3.21},
        "distance": {"backend": "haversine"},
    }
    row = extract_run_metrics(payload)
    assert row["objectiveScore"] == 123.4
    assert row["lower_bound"] == 120.0
    assert row["runtimeSec"] == 3.21


def test_write_artifacts_creates_expected_files(tmp_path: Path):
    from benchmarks.ladder import write_artifacts

    rows = [
        {"tier": "tier1", "case": "c1", "variant": "default", "seed": 1, "objectiveScore": 10.0, "runtimeSec": 1.0, "feasible": True},
        {"tier": "tier1", "case": "c1", "variant": "default", "seed": 2, "objectiveScore": 11.0, "runtimeSec": 1.1, "feasible": True},
    ]
    write_artifacts(tmp_path, rows)
    assert (tmp_path / "runs.jsonl").exists()
    assert (tmp_path / "runs.csv").exists()
    assert (tmp_path / "summary.json").exists()
    assert (tmp_path / "summary.csv").exists()
    assert (tmp_path / "leaderboard.md").exists()

    summary = json.loads((tmp_path / "summary.json").read_text(encoding="utf-8"))
    assert isinstance(summary, list)
    assert summary[0]["tier"] == "tier1"


def test_variant_list_contains_ablation_names():
    from benchmarks.ladder import default_variants

    names = {v.name for v in default_variants()}
    assert "default" in names
    assert "budget_recalibrated" in names
    assert "budget_recalibrated_runs_minus1" in names
    assert "budget_recalibrated_runs1" in names
    assert "budget_recalibrated_tweak_auto" in names
    assert "no_delta_eval" in names
    assert "no_exact_lns" in names
    assert "one_shot_master" in names
    assert "no_complementarity_pool" in names
