from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from route_pool import PooledRoute


def _stable_cut_id(prefix: str, payload: str) -> str:
    raw = f"{prefix}:{payload}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


@dataclass(frozen=True)
class SubsetRowCut:
    """
    Subset-row cut (SRC) for set-partitioning:
      sum_r floor(|r ∩ S| / 2) x_r <= floor(|S| / 2)

    This is a classic valid inequality used to tighten set-partition LP
    relaxations in VRP-style masters. It is valid for integer solutions where
    each customer/employee is served exactly once.
    """

    employee_set: Tuple[str, ...]
    cut_id: str
    rhs: int

    @staticmethod
    def from_employee_set(employee_ids: Iterable[str]) -> "SubsetRowCut":
        S = tuple(sorted({str(e).strip() for e in (employee_ids or []) if str(e).strip()}))
        rhs = int(math.floor(len(S) / 2))
        return SubsetRowCut(
            employee_set=S,
            cut_id=_stable_cut_id("src", ",".join(S)),
            rhs=rhs,
        )

    def coefficient(self, route: PooledRoute) -> int:
        if not self.employee_set:
            return 0
        inter = 0
        S = set(self.employee_set)
        for eid in (route.passenger_set or ()):
            if str(eid) in S:
                inter += 1
        return int(inter // 2)


class CutStore:
    def __init__(self, *, max_cuts: int):
        self.max_cuts = max(0, int(max_cuts))
        self._cuts_by_id: Dict[str, SubsetRowCut] = {}

    def add(self, cut: SubsetRowCut) -> bool:
        if self.max_cuts <= 0:
            return False
        if cut.cut_id in self._cuts_by_id:
            return False
        if len(self._cuts_by_id) >= self.max_cuts:
            return False
        self._cuts_by_id[cut.cut_id] = cut
        return True

    def cuts(self) -> List[SubsetRowCut]:
        return list(self._cuts_by_id.values())

    def __len__(self) -> int:
        return int(len(self._cuts_by_id))


def _median(values: Sequence[float]) -> float:
    values = sorted(float(v) for v in values)
    if not values:
        return 0.0
    n = len(values)
    mid = n // 2
    if n % 2 == 1:
        return float(values[mid])
    return 0.5 * (float(values[mid - 1]) + float(values[mid]))


def separate_subset_row_cuts(
    routes: Sequence[PooledRoute],
    *,
    primal_values_by_route_id: Dict[str, float],
    max_tries: int,
    min_frac_x: float,
    max_set_size: int,
    eps: float = 1e-6,
) -> List[SubsetRowCut]:
    """
    Heuristic separation for subset-row cuts from an LP fractional solution.

    We select S as small odd-sized sets of employees that appear heavily in
    fractional columns.
    """
    routes = list(routes or [])
    if not routes:
        return []
    max_tries = max(0, int(max_tries))
    if max_tries <= 0:
        return []
    min_frac_x = max(0.0, min(0.49, float(min_frac_x)))
    max_set_size = max(3, int(max_set_size))

    # Fractional routes: 0 < x < 1 and above min threshold.
    frac_routes: List[Tuple[float, PooledRoute]] = []
    for r in routes:
        x = float(primal_values_by_route_id.get(str(r.route_id), 0.0) or 0.0)
        if x > min_frac_x and x < 1.0 - min_frac_x and r.passenger_set:
            frac_routes.append((x, r))
    if not frac_routes:
        return []

    # Employee scores: sum of x over fractional routes that contain employee.
    score: Dict[str, float] = {}
    for x, r in frac_routes:
        for eid in r.passenger_set:
            key = str(eid)
            score[key] = score.get(key, 0.0) + float(x)
    ranked = sorted(score.items(), key=lambda kv: (-kv[1], kv[0]))
    if not ranked:
        return []

    # Candidate S sizes (odd sizes are usually stronger).
    sizes = [3, 5, 7, 9, 11]
    sizes = [s for s in sizes if s <= max_set_size]
    if not sizes:
        sizes = [max_set_size]

    cuts: List[SubsetRowCut] = []
    used = set()

    # Build a few S candidates from top-ranked employees and from unions of
    # passengers of fractional routes.
    top_ids = [eid for eid, _ in ranked]
    for attempt in range(max_tries):
        size = sizes[attempt % len(sizes)]
        if len(top_ids) < size:
            break
        if attempt < len(frac_routes):
            # Seed from a fractional route, then fill from top list.
            _, seed_route = frac_routes[attempt]
            seed = list(seed_route.passenger_set)[:size]
            for eid in top_ids:
                if len(seed) >= size:
                    break
                if eid not in seed:
                    seed.append(eid)
            S = seed[:size]
        else:
            S = top_ids[:size]

        key = tuple(sorted(S))
        if key in used:
            continue
        used.add(key)

        rhs = int(math.floor(len(key) / 2))
        lhs = 0.0
        set_key = set(key)
        for r in routes:
            x = float(primal_values_by_route_id.get(str(r.route_id), 0.0) or 0.0)
            if x <= 0.0:
                continue
            inter = 0
            for eid in r.passenger_set:
                if str(eid) in set_key:
                    inter += 1
            coeff = int(inter // 2)
            if coeff <= 0:
                continue
            lhs += float(coeff) * float(x)

        if lhs > float(rhs) + float(eps):
            cut = SubsetRowCut.from_employee_set(key)
            cuts.append(cut)

    return cuts

