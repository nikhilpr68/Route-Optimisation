from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Optional, Sequence, Set, Tuple

from route_pool import PooledRoute


def _parse_id_list(raw: Any) -> Set[str]:
    if raw is None:
        return set()
    if isinstance(raw, (list, tuple, set)):
        values = [str(v).strip() for v in raw]
    else:
        text = str(raw).strip()
        if not text:
            return set()
        values = [chunk.strip() for chunk in text.split(",")]
    return {v for v in values if v}


@dataclass(frozen=True)
class BranchingState:
    """
    Minimal branching-state plumbing for a future branch-and-price tree.

    This is intentionally small: it supports only fixing columns in/out by
    route_id. Full BCP would branch on fractional variables and maintain a
    node tree; this repository does not implement that yet.
    """

    fixed_in_route_ids: Set[str] = field(default_factory=set)
    fixed_out_route_ids: Set[str] = field(default_factory=set)

    @staticmethod
    def from_metadata(metadata: Dict[str, Any]) -> "BranchingState":
        meta = dict(metadata or {})
        fixed_in = _parse_id_list(meta.get("BRANCH_FIXED_IN_ROUTE_IDS"))
        fixed_out = _parse_id_list(meta.get("BRANCH_FIXED_OUT_ROUTE_IDS"))
        # If a route is both fixed in and fixed out, fixed in wins (user error).
        fixed_out = set(fixed_out) - set(fixed_in)
        return BranchingState(fixed_in_route_ids=set(fixed_in), fixed_out_route_ids=set(fixed_out))


@dataclass(frozen=True)
class CutOptions:
    """
    Cut-management hook (limited).

    Today we support only one universally valid "cut": forbidding route columns
    that are already known infeasible (hard-constraint violations).

    This is off by default to preserve historical behaviour where the master
    may select penalized routes as a fallback if the pool lacks a feasible
    cover. In proof-sensitive contexts, enabling it is safer.
    """

    disallow_infeasible_routes: bool = False
    # Subset-row cuts (SRC) for set-partitioning masters.
    # These tighten the restricted master LP relaxation; they are still
    # restricted-route-pool constructs and do not imply global bounds.
    subset_row_cuts_enabled: bool = False
    subset_row_cuts_max: int = 30
    subset_row_cuts_sep_tries: int = 12
    subset_row_cuts_min_frac_x: float = 0.15
    subset_row_cuts_max_set_size: int = 7

    @staticmethod
    def from_metadata(metadata: Dict[str, Any]) -> "CutOptions":
        meta = dict(metadata or {})
        raw = meta.get("MASTER_DISALLOW_INFEASIBLE_ROUTES", False)
        if isinstance(raw, bool):
            enabled = raw
        else:
            enabled = str(raw).strip().lower() in ("1", "true", "yes", "on")
        def _int(key: str, default: int, lo: int, hi: int) -> int:
            try:
                v = int(float(meta.get(key, default)))
            except Exception:
                v = int(default)
            return max(int(lo), min(int(hi), int(v)))

        def _float(key: str, default: float, lo: float, hi: float) -> float:
            try:
                v = float(meta.get(key, default))
            except Exception:
                v = float(default)
            return max(float(lo), min(float(hi), float(v)))

        src_enabled = meta.get("MASTER_SUBSET_ROW_CUTS_ENABLED", False)
        if isinstance(src_enabled, bool):
            src_enabled_b = bool(src_enabled)
        else:
            src_enabled_b = str(src_enabled).strip().lower() in ("1", "true", "yes", "on")

        return CutOptions(
            disallow_infeasible_routes=bool(enabled),
            subset_row_cuts_enabled=bool(src_enabled_b),
            subset_row_cuts_max=_int("MASTER_SUBSET_ROW_CUTS_MAX", 30, 0, 500),
            subset_row_cuts_sep_tries=_int("MASTER_SUBSET_ROW_CUTS_SEP_TRIES", 12, 0, 200),
            subset_row_cuts_min_frac_x=_float("MASTER_SUBSET_ROW_CUTS_MIN_FRAC_X", 0.15, 0.0, 0.49),
            subset_row_cuts_max_set_size=_int("MASTER_SUBSET_ROW_CUTS_MAX_SET_SIZE", 7, 3, 25),
        )


@dataclass(frozen=True)
class MasterSolveOptions:
    branching: BranchingState = field(default_factory=BranchingState)
    cuts: CutOptions = field(default_factory=CutOptions)

    @staticmethod
    def from_metadata(metadata: Dict[str, Any]) -> "MasterSolveOptions":
        return MasterSolveOptions(
            branching=BranchingState.from_metadata(metadata),
            cuts=CutOptions.from_metadata(metadata),
        )


def reduced_cost(
    route: PooledRoute,
    *,
    employee_duals: Dict[str, float],
    vehicle_duals: Dict[str, float],
    cut_duals: Optional[Dict[str, float]] = None,
    cuts: Optional[Sequence[Any]] = None,
) -> float:
    """
    Reduced cost for the restricted master:
      min sum_r c_r x_r
      s.t. cover(emp) == 1, per vehicle sum x_r <= 1

    rc(r) = c_r - sum_{e in r} pi_e - sigma_v

    Note: dual signs depend on solver conventions; this function assumes
    OR-Tools / CLP/GLOP conventions for a minimization LP.
    """
    c = float(getattr(route, "objective_score", 0.0) or 0.0)
    pi_sum = 0.0
    for emp_id in (route.passenger_set or ()):
        pi_sum += float(employee_duals.get(str(emp_id), 0.0) or 0.0)
    sigma = float(vehicle_duals.get(str(route.vehicle_id), 0.0) or 0.0)
    rc = float(c - pi_sum - sigma)
    if cut_duals and cuts:
        for cut in cuts:
            try:
                cid = str(getattr(cut, "cut_id"))
                mu = float(cut_duals.get(cid, 0.0) or 0.0)
                if abs(mu) <= 0.0:
                    continue
                a = float(getattr(cut, "coefficient")(route))
                if a:
                    rc -= float(mu) * float(a)
            except Exception:
                continue
    return float(rc)


def pricing_employee_scores_from_duals(employee_duals: Dict[str, float]) -> Dict[str, float]:
    """
    Convert employee duals into a deterministic, monotone "difficulty" score
    used to focus heuristic route generation.

    This is *hybrid pricing*: it uses exact duals from the restricted LP master
    but the route generation itself remains heuristic.
    """
    scores: Dict[str, float] = {}
    for emp_id, val in (employee_duals or {}).items():
        try:
            dual = float(val)
        except Exception:
            continue
        # Positive duals typically indicate employees that are expensive to
        # cover in the current restricted master; clamp at 0 for stability.
        scores[str(emp_id)] = max(0.0, dual)
    return scores
