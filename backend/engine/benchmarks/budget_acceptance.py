from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


def _median(values: Sequence[float]) -> Optional[float]:
    values = [float(v) for v in values if v is not None]
    if not values:
        return None
    values = sorted(values)
    n = len(values)
    mid = n // 2
    if n % 2 == 1:
        return float(values[mid])
    return 0.5 * (float(values[mid - 1]) + float(values[mid]))


@dataclass(frozen=True)
class VariantAggregate:
    variant: str
    cases: Tuple[str, ...]
    median_objective: Optional[float]
    median_runtime_sec: Optional[float]


def aggregate_variant(
    summary_rows: Iterable[Dict[str, Any]],
    *,
    variant: str,
    tiers: Optional[Iterable[str]] = None,
    cases: Optional[Iterable[str]] = None,
) -> VariantAggregate:
    tiers_set = set(str(t) for t in tiers) if tiers is not None else None
    cases_set = set(str(c) for c in cases) if cases is not None else None

    selected: List[Dict[str, Any]] = []
    for row in summary_rows:
        if str(row.get("variant")) != str(variant):
            continue
        if tiers_set is not None and str(row.get("tier")) not in tiers_set:
            continue
        if cases_set is not None and str(row.get("case")) not in cases_set:
            continue
        selected.append(row)

    case_names = tuple(sorted({str(r.get("case")) for r in selected if r.get("case") is not None}))
    objectives = [r.get("medianObjective") for r in selected if r.get("medianObjective") is not None]
    runtimes = [r.get("meanRuntimeSec") for r in selected if r.get("meanRuntimeSec") is not None]
    return VariantAggregate(
        variant=str(variant),
        cases=case_names,
        median_objective=_median([float(x) for x in objectives]) if objectives else None,
        median_runtime_sec=_median([float(x) for x in runtimes]) if runtimes else None,
    )


@dataclass(frozen=True)
class AcceptanceDecision:
    accept: bool
    reason: str
    baseline: VariantAggregate
    challenger: VariantAggregate


def should_accept_budget_change(
    *,
    baseline: VariantAggregate,
    challenger: VariantAggregate,
    max_runtime_ratio: float = 1.05,
    max_runtime_abs_delta_sec: float = 0.5,
    min_objective_improvement: float = 0.0,
) -> AcceptanceDecision:
    """Implements the prompt's accept/reject rule.

    - Accept iff challenger has strictly better median objective (by at least
      `min_objective_improvement`) and is not materially worse on runtime.
    - "Materially worse" is parameterized by a ratio and an absolute delta.
    """
    if baseline.median_objective is None or challenger.median_objective is None:
        return AcceptanceDecision(
            accept=False,
            reason="missing_objective_metrics",
            baseline=baseline,
            challenger=challenger,
        )
    # Minimization objective: accept only if challenger is strictly lower by at
    # least `min_objective_improvement` (up to numerical tolerance).
    if challenger.median_objective >= (baseline.median_objective - float(min_objective_improvement) - 1e-9):
        return AcceptanceDecision(
            accept=False,
            reason="no_median_objective_improvement",
            baseline=baseline,
            challenger=challenger,
        )

    # If runtime metrics are missing, be conservative and reject (do not claim
    # non-regression).
    if baseline.median_runtime_sec is None or challenger.median_runtime_sec is None:
        return AcceptanceDecision(
            accept=False,
            reason="missing_runtime_metrics",
            baseline=baseline,
            challenger=challenger,
        )

    allowed = min(
        float(baseline.median_runtime_sec) * float(max_runtime_ratio),
        float(baseline.median_runtime_sec) + float(max_runtime_abs_delta_sec),
    )
    if float(challenger.median_runtime_sec) > allowed + 1e-9:
        return AcceptanceDecision(
            accept=False,
            reason="runtime_regression",
            baseline=baseline,
            challenger=challenger,
        )

    return AcceptanceDecision(
        accept=True,
        reason="median_objective_improved_and_runtime_ok",
        baseline=baseline,
        challenger=challenger,
    )
