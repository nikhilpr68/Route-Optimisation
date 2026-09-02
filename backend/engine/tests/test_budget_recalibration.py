from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def test_runs_schedule_matches_prompt_bands():
    from budget_recalibration import runs_for_time_budget_sec

    assert runs_for_time_budget_sec(44) == 2  # prompt doesn't specify; conservative default
    assert runs_for_time_budget_sec(45) == 3
    assert runs_for_time_budget_sec(89.9) == 3
    assert runs_for_time_budget_sec(90) == 4
    assert runs_for_time_budget_sec(149.9) == 4
    assert runs_for_time_budget_sec(150) == 5
    assert runs_for_time_budget_sec(239.9) == 5
    assert runs_for_time_budget_sec(240) == 6
    assert runs_for_time_budget_sec(359.9) == 6
    assert runs_for_time_budget_sec(360) == 7


def test_pop_size_caps_apply_by_time_band():
    from budget_recalibration import pop_size

    # Very large E shouldn't exceed caps for small T.
    assert pop_size(1000, 60) <= 32
    assert pop_size(1000, 120) <= 40
    assert pop_size(1000, 240) <= 48
    assert pop_size(1000, 360) <= 56


def test_planned_generations_from_throughput_is_clamped():
    from budget_recalibration import planned_generations_from_throughput

    planned, dbg = planned_generations_from_throughput(T=100.0, sec_per_generation=0.1, reserve_ratio=0.18)
    assert planned <= 80
    assert dbg["secPerGeneration"] > 0

    planned2, _ = planned_generations_from_throughput(T=10.0, sec_per_generation=999.0, reserve_ratio=0.18)
    assert planned2 >= 8


def test_set_partition_time_budget_piecewise():
    from budget_recalibration import set_partition_time_limit_sec

    assert set_partition_time_limit_sec(59) == 0.0
    assert 0.0 < set_partition_time_limit_sec(60) <= 4.0
    assert set_partition_time_limit_sec(120) <= 8.0
    assert set_partition_time_limit_sec(240) <= 12.0

