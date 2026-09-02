from __future__ import annotations

import statistics
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class BudgetComparison:
    baseline_variant: str
    candidate_variant: str
    baseline_median_of_case_medians: Optional[float]
    candidate_median_of_case_medians: Optional[float]
    baseline_mean_runtime_sec: Optional[float]
    candidate_mean_runtime_sec: Optional[float]
    accepted: bool
    reason: str


def _safe_float(x) -> Optional[float]:
    try:
        v = float(x)
    except Exception:
        return None
    if v != v:  # NaN
        return None
    return v


def compare_variants_from_summary_rows(
    summary_rows: Sequence[Dict],
    *,
    baseline_variant: str,
    candidate_variant: str,
    runtime_tolerance_ratio: float = 0.10,
) -> BudgetComparison:
    """
    Acceptance logic (conservative, per prompt):
    - Accept only if candidate beats baseline on median objective (median-of-case-medians)
      AND is not materially worse on mean runtime.

    Inputs are `benchmarks/ladder.py` summary rows:
      [{tier, case, variant, medianObjective, meanRuntimeSec, ...}, ...]
    """
    runtime_tolerance_ratio = max(0.0, float(runtime_tolerance_ratio))

    baseline = [r for r in summary_rows if str(r.get("variant")) == str(baseline_variant)]
    candidate = [r for r in summary_rows if str(r.get("variant")) == str(candidate_variant)]

    def med_of_case_meds(rows: List[Dict]) -> Optional[float]:
        meds = [_safe_float(r.get("medianObjective")) for r in rows]
        meds = [m for m in meds if m is not None]
        return float(statistics.median(meds)) if meds else None

    def mean_runtime(rows: List[Dict]) -> Optional[float]:
        vals = [_safe_float(r.get("meanRuntimeSec")) for r in rows]
        vals = [v for v in vals if v is not None]
        return float(sum(vals) / len(vals)) if vals else None

    b_med = med_of_case_meds(baseline)
    c_med = med_of_case_meds(candidate)
    b_rt = mean_runtime(baseline)
    c_rt = mean_runtime(candidate)

    if b_med is None or c_med is None:
        return BudgetComparison(
            baseline_variant=str(baseline_variant),
            candidate_variant=str(candidate_variant),
            baseline_median_of_case_medians=b_med,
            candidate_median_of_case_medians=c_med,
            baseline_mean_runtime_sec=b_rt,
            candidate_mean_runtime_sec=c_rt,
            accepted=False,
            reason="insufficient_summary_data",
        )

    # Lower objective is better.
    if c_med + 1e-9 >= b_med:
        return BudgetComparison(
            baseline_variant=str(baseline_variant),
            candidate_variant=str(candidate_variant),
            baseline_median_of_case_medians=b_med,
            candidate_median_of_case_medians=c_med,
            baseline_mean_runtime_sec=b_rt,
            candidate_mean_runtime_sec=c_rt,
            accepted=False,
            reason="candidate_not_better_on_median_objective",
        )

    if b_rt is not None and c_rt is not None:
        if c_rt > b_rt * (1.0 + runtime_tolerance_ratio) + 1e-9:
            return BudgetComparison(
                baseline_variant=str(baseline_variant),
                candidate_variant=str(candidate_variant),
                baseline_median_of_case_medians=b_med,
                candidate_median_of_case_medians=c_med,
                baseline_mean_runtime_sec=b_rt,
                candidate_mean_runtime_sec=c_rt,
                accepted=False,
                reason="candidate_materially_slower",
            )

    return BudgetComparison(
        baseline_variant=str(baseline_variant),
        candidate_variant=str(candidate_variant),
        baseline_median_of_case_medians=b_med,
        candidate_median_of_case_medians=c_med,
        baseline_mean_runtime_sec=b_rt,
        candidate_mean_runtime_sec=c_rt,
        accepted=True,
        reason="accepted",
    )

