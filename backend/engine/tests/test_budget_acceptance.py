import json
from pathlib import Path

from benchmarks.budget_acceptance import aggregate_variant, should_accept_budget_change, VariantAggregate


def test_acceptance_rejects_without_objective_improvement():
    baseline = VariantAggregate(variant="default", cases=("a",), median_objective=100.0, median_runtime_sec=10.0)
    challenger = VariantAggregate(variant="new", cases=("a",), median_objective=100.0, median_runtime_sec=9.0)
    decision = should_accept_budget_change(baseline=baseline, challenger=challenger)
    assert decision.accept is False
    assert decision.reason == "no_median_objective_improvement"


def test_acceptance_rejects_runtime_regression():
    baseline = VariantAggregate(variant="default", cases=("a",), median_objective=100.0, median_runtime_sec=10.0)
    challenger = VariantAggregate(variant="new", cases=("a",), median_objective=90.0, median_runtime_sec=12.0)
    decision = should_accept_budget_change(
        baseline=baseline,
        challenger=challenger,
        max_runtime_ratio=1.05,
        max_runtime_abs_delta_sec=0.5,
    )
    assert decision.accept is False
    assert decision.reason == "runtime_regression"


def test_acceptance_accepts_improvement_within_runtime_limits():
    baseline = VariantAggregate(variant="default", cases=("a",), median_objective=100.0, median_runtime_sec=10.0)
    challenger = VariantAggregate(variant="new", cases=("a",), median_objective=95.0, median_runtime_sec=10.4)
    decision = should_accept_budget_change(
        baseline=baseline,
        challenger=challenger,
        max_runtime_ratio=1.05,
        max_runtime_abs_delta_sec=0.5,
    )
    assert decision.accept is True


def test_aggregate_variant_from_ladder_summary(tmp_path: Path):
    rows = [
        {"tier": "tier2", "case": "c1", "variant": "default", "medianObjective": 10.0, "meanRuntimeSec": 1.0},
        {"tier": "tier2", "case": "c2", "variant": "default", "medianObjective": 30.0, "meanRuntimeSec": 3.0},
        {"tier": "tier2", "case": "c1", "variant": "new", "medianObjective": 9.0, "meanRuntimeSec": 1.2},
        {"tier": "tier2", "case": "c2", "variant": "new", "medianObjective": 29.0, "meanRuntimeSec": 3.1},
    ]
    p = tmp_path / "summary.json"
    p.write_text(json.dumps(rows))
    loaded = json.loads(p.read_text())
    agg = aggregate_variant(loaded, variant="default")
    assert agg.cases == ("c1", "c2")
    # Median of [10, 30] = 20
    assert agg.median_objective == 20.0
    # Median of [1, 3] = 2
    assert agg.median_runtime_sec == 2.0

