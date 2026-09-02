from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, Optional, Protocol, Sequence


@dataclass
class BoundComputation:
    incumbent_objective: Optional[float]
    lower_bound: Optional[float]
    optimality_gap_absolute: Optional[float]
    optimality_gap_percent: Optional[float]
    exactness_status: str
    bound_scope: str
    bound_source: str = "metadata"


KNOWN_BOUND_SCOPES = {"none", "restricted_route_pool", "global"}
KNOWN_EXACTNESS_STATUSES = {
    # No proven bound available (incumbent only).
    "heuristic_incumbent_only",
    # Exact/bounded only over a restricted candidate pool (route pool).
    "exact_restricted_route_pool",
    "bounded_restricted_route_pool",
    # Bound claims beyond restricted pools (reserved for future exact modes).
    "bounded_not_proven_globally_optimal",
    "globally_optimal",
}


def _normalize_bound_scope(raw: Any) -> str:
    text = str(raw or "").strip()
    if text in KNOWN_BOUND_SCOPES:
        return text
    return "none"


def _normalize_exactness_status(raw: Any) -> str:
    text = str(raw or "").strip()
    if text in KNOWN_EXACTNESS_STATUSES:
        return text
    return ""


def safe_float(value: Any) -> Optional[float]:
    try:
        out = float(value)
    except Exception:
        return None
    if not math.isfinite(out):
        return None
    return out


def compute_gap(incumbent_objective: Any, lower_bound: Any) -> tuple[Optional[float], Optional[float]]:
    incumbent = safe_float(incumbent_objective)
    bound = safe_float(lower_bound)
    if incumbent is None or bound is None:
        return None, None
    gap_abs = max(0.0, float(incumbent - bound))
    denom = max(1.0, abs(float(incumbent)))
    gap_pct = max(0.0, (gap_abs / denom) * 100.0)
    return float(gap_abs), float(gap_pct)


def derive_bound_computation(
    incumbent_objective: Any,
    solver_metadata: Optional[Dict[str, Any]],
) -> BoundComputation:
    solver_metadata = dict(solver_metadata or {})

    incumbent = safe_float(incumbent_objective)
    lower_bound = safe_float(solver_metadata.get("lowerBound"))
    bound_scope = _normalize_bound_scope(solver_metadata.get("boundScope") or "none")
    bound_source = str(solver_metadata.get("boundSource") or "metadata")

    global_proven = bool(solver_metadata.get("globalOptimalityProven"))
    if global_proven and incumbent is not None:
        lower_bound = incumbent
        bound_scope = "global"
        bound_source = "exact_small_global_proof"

    # Sanity: if a purported "lower bound" exceeds the incumbent in a
    # minimization setting, it's not a valid bound for that incumbent/scope.
    if incumbent is not None and lower_bound is not None:
        if lower_bound > incumbent + 1e-9:
            lower_bound = None
            bound_scope = "none"
            bound_source = "discarded_inconsistent_bound"

    gap_abs, gap_pct = compute_gap(incumbent, lower_bound)

    # Conservative semantics: accept explicit statuses only when consistent with
    # other metadata. This prevents accidental "globally_optimal" reporting
    # from a restricted-pool exact solve (or from any upstream bug).
    explicit_status = _normalize_exactness_status(solver_metadata.get("exactnessStatus"))
    if explicit_status:
        if explicit_status == "globally_optimal" and not global_proven:
            explicit_status = ""
        elif explicit_status in ("exact_restricted_route_pool", "bounded_restricted_route_pool") and bound_scope != "restricted_route_pool":
            explicit_status = ""
        elif explicit_status == "bounded_not_proven_globally_optimal" and bound_scope != "global":
            explicit_status = ""
        elif explicit_status == "heuristic_incumbent_only" and lower_bound is not None:
            # If a bound exists, prefer a bounded status rather than claiming
            # "incumbent only".
            explicit_status = ""

    exactness_status = explicit_status

    if not exactness_status:
        if global_proven:
            exactness_status = "globally_optimal"
        elif lower_bound is None:
            exactness_status = "heuristic_incumbent_only"
        elif bound_scope == "restricted_route_pool":
            if gap_abs is not None and gap_abs <= 1e-9:
                exactness_status = "exact_restricted_route_pool"
            else:
                exactness_status = "bounded_restricted_route_pool"
        elif bound_scope == "global":
            exactness_status = "bounded_not_proven_globally_optimal"
        else:
            exactness_status = "heuristic_incumbent_only"

    return BoundComputation(
        incumbent_objective=incumbent,
        lower_bound=lower_bound,
        optimality_gap_absolute=gap_abs,
        optimality_gap_percent=gap_pct,
        exactness_status=exactness_status,
        bound_scope=bound_scope,
        bound_source=bound_source,
    )


class LowerBoundProvider(Protocol):
    name: str

    def compute(self, incumbent_objective: Any, solver_metadata: Optional[Dict[str, Any]]) -> Optional[BoundComputation]:
        ...


@dataclass(frozen=True)
class MetadataLowerBoundProvider:
    name: str = "metadata"

    def compute(self, incumbent_objective: Any, solver_metadata: Optional[Dict[str, Any]]) -> Optional[BoundComputation]:
        return derive_bound_computation(incumbent_objective=incumbent_objective, solver_metadata=solver_metadata)


def compute_lower_bound(
    incumbent_objective: Any,
    solver_metadata: Optional[Dict[str, Any]],
    providers: Optional[Sequence[LowerBoundProvider]] = None,
) -> BoundComputation:
    """
    Modular lower-bound interface.

    Today, the strongest realistic bound comes from solver-produced metadata
    (exact-small global proof or restricted-route-pool master bounds). This
    function centralizes selection so additional bound sources can be added
    later without changing callers.
    """
    provider_list = list(providers) if providers is not None else [MetadataLowerBoundProvider()]
    for provider in provider_list:
        result = provider.compute(incumbent_objective=incumbent_objective, solver_metadata=solver_metadata)
        if result is None:
            continue
        if not result.bound_source:
            result.bound_source = str(getattr(provider, "name", "unknown") or "unknown")
        return result
    # Fallback: no bound.
    incumbent = safe_float(incumbent_objective)
    return BoundComputation(
        incumbent_objective=incumbent,
        lower_bound=None,
        optimality_gap_absolute=None,
        optimality_gap_percent=None,
        exactness_status="heuristic_incumbent_only",
        bound_scope="none",
        bound_source="none",
    )
