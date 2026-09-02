from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from models import ProblemInstance
from objective import ObjectiveEvaluator
from representation import Individual, Route


@dataclass
class PooledRoute:
    route_id: str
    vehicle_id: str
    vehicle_category: str
    passenger_set: Tuple[str, ...]
    sequence_signature: Tuple[str, ...]
    stop_sequence: List[Dict]
    objective_score: float
    total_cost: float
    total_time: float
    total_delay: float
    penalty_total: float
    penalty_breakdown: Dict[str, float]
    is_feasible: bool
    hard_violation_count: int
    violations: List[str] = field(default_factory=list)
    source: str = "unknown"
    run_id: int = 0
    generation: int = -1

    @property
    def dedup_key(self) -> Tuple[Tuple[str, ...], Tuple[str, ...]]:
        # WARNING: This key is intentionally weaker than what the exact master
        # needs. It is used only as a building block for heuristic-only
        # pruning paths; proof-sensitive paths must use `equivalence_key("safe")`.
        return self.passenger_set, self.sequence_signature

    @property
    def timing_signature(self) -> Tuple[int, int, int, int]:
        # Timing footprint matters to master-selection quality because two
        # routes with the same passengers/order can still differ materially in
        # route duration, delay exposure, and hard-feasibility footprint.
        return (
            _timing_bucket(self.total_time, 5.0),
            _timing_bucket(self.total_delay, 5.0),
            1 if self.is_feasible else 0,
            int(self.hard_violation_count),
        )

    @property
    def hard_constraint_signature(self) -> Tuple[int, int, int, int]:
        penalties = self.penalty_breakdown or {}
        return (
            1 if float(penalties.get("precedence", 0.0)) > 0.0 else 0,
            1 if float(penalties.get("consistency", 0.0)) > 0.0 else 0,
            1 if float(penalties.get("infeasible", 0.0)) > 0.0 else 0,
            int(self.hard_violation_count),
        )

    def equivalence_key(self, pruning_mode: str) -> Tuple[object, ...]:
        mode = normalize_pruning_mode(pruning_mode)
        if mode == "safe":
            # Safe mode keeps vehicle identity and timing/hard-constraint
            # footprint in the key so routes are not treated as interchangeable
            # unless they are close to identical in proof-sensitive terms.
            return (
                str(self.vehicle_id),
                self.passenger_set,
                self.sequence_signature,
                self.timing_signature,
                self.hard_constraint_signature,
            )
        # Heuristic mode intentionally uses a weaker key for a smaller pool,
        # but it must still be vehicle-aware. Collapsing across vehicles is
        # unsafe for master-selection because the set-partition master has a
        # per-vehicle constraint (<= 1 route per vehicle). If routes for V1 and
        # V2 are treated as equivalent, the pool may drop routes required for a
        # globally optimal (or even feasible) master solution.
        #
        # Timing/hard-constraint footprint is still ignored in heuristic mode
        # as an explicit quality-vs-runtime trade-off.
        return (
            str(self.vehicle_id),
            self.passenger_set,
            self.sequence_signature,
        )


def canonical_route_signature(route: Route) -> Tuple[Tuple[str, ...], Tuple[str, ...]]:
    sequence: List[str] = []
    passengers = set()

    for stop in route.stop_sequence:
        stop_type = stop.get("type")
        emp = stop.get("emp")
        if emp is None or stop_type not in ("p", "d"):
            continue
        emp_id = str(emp.id)
        sequence.append(f"{stop_type}:{emp_id}")
        if stop_type == "p":
            passengers.add(emp_id)

    return tuple(sorted(passengers)), tuple(sequence)


def normalize_pruning_mode(raw_mode: Optional[str]) -> str:
    text = str(raw_mode or "heuristic").strip().lower()
    if text in ("safe", "proof", "conservative"):
        return "safe"
    return "heuristic"


def _timing_bucket(value: float, width: float) -> int:
    if width <= 0:
        width = 1.0
    return int(round(float(value) / float(width)))


class RoutePoolManager:
    """Deduplicated route pool with dominance pruning for exact selection."""

    def __init__(
        self,
        problem: ProblemInstance,
        evaluator: Optional[ObjectiveEvaluator] = None,
        max_routes: int = 700,
        penalty_factor: float = 15.0,
        phase_progress: float = 1.0,
        enforce_hard: bool = True,
        pruning_mode: str = "heuristic",
    ):
        self.problem = problem
        self.evaluator = evaluator or ObjectiveEvaluator(problem)
        self.max_routes = max(1, int(max_routes))
        self.penalty_factor = float(penalty_factor)
        self.phase_progress = max(0.0, min(1.0, float(phase_progress)))
        self.enforce_hard = bool(enforce_hard)
        self.pruning_mode = normalize_pruning_mode(pruning_mode)
        self.metadata = getattr(self.problem, "metadata", {}) or {}

        # Complementarity-aware retention (heuristic mode only).
        # This layer is explicitly heuristic: it influences which routes survive
        # the pool cap, not the objective semantics.
        self.complementarity_enabled = bool(
            (self.pruning_mode == "heuristic")
            and self._meta_bool("ROUTE_POOL_COMPLEMENTARITY_ENABLED", default=True)
        )
        self.complementarity_quality_fraction = self._meta_float(
            "ROUTE_POOL_COMPLEMENTARITY_QUALITY_FRACTION",
            default=0.55,
            lo=0.0,
            hi=1.0,
        )
        self.complementarity_rarity_fraction = self._meta_float(
            "ROUTE_POOL_COMPLEMENTARITY_RARITY_FRACTION",
            default=0.30,
            lo=0.0,
            hi=1.0,
        )
        self.complementarity_timing_fraction = self._meta_float(
            "ROUTE_POOL_COMPLEMENTARITY_TIMING_FRACTION",
            default=0.15,
            lo=0.0,
            hi=1.0,
        )

        self._routes_by_key: Dict[Tuple[object, ...], PooledRoute] = {}
        self._vehicle_category = {
            str(v.id): str(getattr(v, "category", "normal") or "normal").strip().lower()
            for v in self.problem.vehicles
        }

        self.considered_count = 0
        self.replaced_count = 0
        self.duplicate_rejected_count = 0
        self.prune_count = 0
        self.dominated_dropped_count = 0
        self.source_counts: Dict[str, int] = {}
        self.top_k_dropped_count = 0
        self.cap_dropped_count = 0
        self.unsafe_heuristic_drop_count = 0
        self.last_retention_breakdown: Dict[str, int] = {}
        self.last_composition_stats: Dict[str, object] = {}

    def collect_from_individual(
        self,
        individual: Individual,
        source: str,
        run_id: int = 0,
        generation: int = -1,
        top_k_routes: Optional[int] = None,
    ) -> None:
        routes = [route for route in individual.routes if route.stop_sequence]
        if not routes:
            return

        routes = sorted(
            routes,
            key=lambda r: (
                float(getattr(r, "total_cost", 0.0)) + float(getattr(r, "total_time", 0.0)),
                str(getattr(r.vehicle, "id", "")),
            ),
        )

        if top_k_routes is not None and self.pruning_mode == "heuristic":
            top_k = max(1, int(top_k_routes))
            if len(routes) > top_k:
                self.top_k_dropped_count += len(routes) - top_k
            routes = routes[:top_k]
        elif top_k_routes is not None and self.pruning_mode == "safe":
            # Safe mode ignores caller-supplied top-k route slicing because that
            # truncation is heuristic only and can remove globally relevant
            # candidates before the exact master sees them.
            pass

        for route in routes:
            self.add_route(route, source=source, run_id=run_id, generation=generation)

    def collect_from_archives(self, archives: Iterable[Dict]) -> None:
        for record in archives:
            individual = record.get("individual")
            if individual is None:
                continue
            self.collect_from_individual(
                individual,
                source=str(record.get("source") or "archive"),
                run_id=int(record.get("runId") or 0),
                generation=int(record.get("generation") or -1),
                top_k_routes=record.get("topKRoutes"),
            )

    def add_route(self, route: Route, source: str, run_id: int = 0, generation: int = -1) -> None:
        if route is None or not route.stop_sequence:
            return

        self.considered_count += 1
        source_key = str(source or "unknown")
        self.source_counts[source_key] = self.source_counts.get(source_key, 0) + 1

        pooled = self._canonicalize_route(route, source_key, run_id=run_id, generation=generation)
        if pooled is None:
            return

        self.add_pooled_route(pooled)

    def canonicalize_route(
        self,
        route: Route,
        *,
        source: str,
        run_id: int = 0,
        generation: int = -1,
    ) -> Optional[PooledRoute]:
        """
        Public wrapper for route canonicalization used by pricing / master-driven
        route generation.

        This preserves objective semantics by using the same evaluator pathway
        as the pool itself.
        """
        return self._canonicalize_route(route, str(source or "unknown"), run_id=int(run_id), generation=int(generation))

    def add_pooled_route(self, pooled: Optional[PooledRoute]) -> None:
        if pooled is None:
            return

        equiv_key = pooled.equivalence_key(self.pruning_mode)
        existing = self._routes_by_key.get(equiv_key)
        if existing is None:
            self._routes_by_key[equiv_key] = pooled
        elif pooled.objective_score + 1e-9 < existing.objective_score:
            self._routes_by_key[equiv_key] = pooled
            self.replaced_count += 1
        else:
            self.duplicate_rejected_count += 1
            return

        self._apply_dominance_prune_for_set(pooled.passenger_set, pooled.vehicle_id)

        if len(self._routes_by_key) > self.max_routes:
            self._prune_to_limit()

    def get_routes(self) -> List[PooledRoute]:
        return sorted(
            self._routes_by_key.values(),
            key=lambda r: (
                r.objective_score,
                len(r.passenger_set),
                r.vehicle_id,
                r.sequence_signature,
            ),
        )

    def stats(self) -> Dict[str, object]:
        routes = self.get_routes()
        feasible = sum(1 for route in routes if route.is_feasible)
        unique_passenger_sets = len({route.passenger_set for route in routes})
        unique_vehicle_passenger_sets = len({(route.vehicle_id, route.passenger_set) for route in routes})

        vehicle_counts: Dict[str, int] = {}
        timing_bucket_counts: Dict[str, int] = {}
        for route in routes:
            vehicle_counts[str(route.vehicle_id)] = vehicle_counts.get(str(route.vehicle_id), 0) + 1
            tb = route.timing_signature
            timing_key = f"timeB{tb[0]}_delayB{tb[1]}_feas{tb[2]}_hard{tb[3]}"
            timing_bucket_counts[timing_key] = timing_bucket_counts.get(timing_key, 0) + 1

        # Overlap statistics (heuristic observability): average passenger-set
        # Jaccard overlap among routes of the same vehicle.
        overlap_values: List[float] = []
        by_vehicle: Dict[str, List[Tuple[str, ...]]] = {}
        for route in routes:
            by_vehicle.setdefault(str(route.vehicle_id), []).append(route.passenger_set)
        for vid, sets in by_vehicle.items():
            if len(sets) <= 1:
                continue
            for i in range(len(sets)):
                for j in range(i + 1, len(sets)):
                    a = set(sets[i])
                    b = set(sets[j])
                    if not a and not b:
                        continue
                    inter = len(a & b)
                    uni = len(a | b)
                    overlap_values.append(float(inter) / float(max(1, uni)))
        avg_overlap = float(sum(overlap_values) / max(1, len(overlap_values))) if overlap_values else 0.0
        max_overlap = float(max(overlap_values)) if overlap_values else 0.0
        return {
            "mode": self.pruning_mode,
            "complementarityEnabled": bool(self.complementarity_enabled),
            "considered": int(self.considered_count),
            "kept": int(len(routes)),
            "feasible": int(feasible),
            "infeasible": int(len(routes) - feasible),
            "duplicatesRejected": int(self.duplicate_rejected_count),
            "replaced": int(self.replaced_count),
            "dominanceDropped": int(self.dominated_dropped_count),
            "pruneCount": int(self.prune_count),
            "maxRoutes": int(self.max_routes),
            "uniquePassengerSets": int(unique_passenger_sets),
            "uniqueVehiclePassengerSets": int(unique_vehicle_passenger_sets),
            "topKDropped": int(self.top_k_dropped_count),
            "capDropped": int(self.cap_dropped_count),
            "unsafeHeuristicDrops": int(self.unsafe_heuristic_drop_count),
            "sourceCounts": dict(sorted(self.source_counts.items())),
            "vehicleCounts": dict(sorted(vehicle_counts.items())),
            "timingBucketCounts": dict(sorted(timing_bucket_counts.items(), key=lambda x: (-x[1], x[0]))[:24]),
            "avgOverlapSameVehicle": float(avg_overlap),
            "maxOverlapSameVehicle": float(max_overlap),
            "retentionBreakdown": dict(self.last_retention_breakdown or {}),
        }

    def _meta_candidates(self, key: str) -> List[str]:
        text = str(key or "").strip()
        if not text:
            return []
        snake = text.replace("-", "_")
        ordered = [text, text.lower(), text.upper(), snake, snake.lower(), snake.upper()]
        out: List[str] = []
        for item in ordered:
            if item and item not in out:
                out.append(item)
        return out

    def _meta_raw(self, key: str):
        for cand in self._meta_candidates(key):
            if cand in self.metadata:
                return self.metadata.get(cand)
        return None

    def _meta_bool(self, key: str, default: bool) -> bool:
        raw = self._meta_raw(key)
        if raw is None:
            return bool(default)
        if isinstance(raw, bool):
            return bool(raw)
        text = str(raw).strip().lower()
        if text in ("1", "true", "yes", "on"):
            return True
        if text in ("0", "false", "no", "off"):
            return False
        return bool(default)

    def _meta_float(self, key: str, default: float, lo: float, hi: float) -> float:
        raw = self._meta_raw(key)
        if raw is None:
            return float(default)
        try:
            val = float(raw)
        except Exception:
            return float(default)
        return float(max(lo, min(hi, val)))

    def _canonicalize_route(
        self,
        route: Route,
        source: str,
        run_id: int,
        generation: int,
    ) -> Optional[PooledRoute]:
        passenger_set, sequence_signature = canonical_route_signature(route)
        if not passenger_set or not sequence_signature:
            return None

        route_copy = copy.deepcopy(route)
        penalty_total = self.evaluator._evaluate_route_dynamic(
            route_copy,
            penalty_factor=self.penalty_factor,
            strictness=self.phase_progress,
            enforce_hard=self.enforce_hard,
            use_cache=False,
        )

        base_score = (
            self.problem.cost_weight * float(route_copy.total_cost)
            + self.problem.time_weight * float(route_copy.total_time)
        )
        objective_score = float(base_score + penalty_total)

        route_id = self._build_route_id(
            route_copy,
            passenger_set=passenger_set,
            sequence_signature=sequence_signature,
            source=source,
            run_id=run_id,
            generation=generation,
        )

        penalties = dict(route_copy.penalty_breakdown or {})
        hard_violation_count = 0
        for key in ("precedence", "consistency", "infeasible"):
            if float(penalties.get(key, 0.0)) > 0.0:
                hard_violation_count += 1

        return PooledRoute(
            route_id=route_id,
            vehicle_id=str(route_copy.vehicle.id),
            vehicle_category=str(self._vehicle_category.get(str(route_copy.vehicle.id), "normal")),
            passenger_set=passenger_set,
            sequence_signature=sequence_signature,
            stop_sequence=copy.deepcopy(route_copy.stop_sequence),
            objective_score=objective_score,
            total_cost=float(route_copy.total_cost),
            total_time=float(route_copy.total_time),
            total_delay=float(getattr(route_copy, "total_delay", 0.0)),
            penalty_total=float(penalty_total),
            penalty_breakdown=penalties,
            is_feasible=bool(route_copy.is_feasible),
            hard_violation_count=int(hard_violation_count),
            violations=list(route_copy.violations),
            source=source,
            run_id=int(run_id),
            generation=int(generation),
        )

    def _build_route_id(
        self,
        route: Route,
        passenger_set: Sequence[str],
        sequence_signature: Sequence[str],
        source: str,
        run_id: int,
        generation: int,
    ) -> str:
        payload = {
            "vehicle": str(route.vehicle.id),
            "passengerSet": list(passenger_set),
            "sequence": list(sequence_signature),
            "source": str(source),
            "runId": int(run_id),
            "generation": int(generation),
        }
        raw = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _route_dominates(self, left: PooledRoute, right: PooledRoute) -> bool:
        if left.passenger_set != right.passenger_set:
            return False
        if str(left.vehicle_id) != str(right.vehicle_id):
            return False

        # Prefer feasible and lower hard-violation footprints.
        if left.is_feasible and (not right.is_feasible):
            if left.objective_score <= right.objective_score + 1e-9:
                return True

        better_or_equal = (
            left.objective_score <= right.objective_score + 1e-9
            and left.penalty_total <= right.penalty_total + 1e-9
            and left.total_cost <= right.total_cost + 1e-9
            and left.total_time <= right.total_time + 1e-9
            and left.total_delay <= right.total_delay + 1e-9
            and left.hard_violation_count <= right.hard_violation_count
        )
        strictly_better = (
            left.objective_score < right.objective_score - 1e-9
            or left.penalty_total < right.penalty_total - 1e-9
            or left.total_cost < right.total_cost - 1e-9
            or left.total_time < right.total_time - 1e-9
            or left.total_delay < right.total_delay - 1e-9
            or left.hard_violation_count < right.hard_violation_count
            or (left.is_feasible and not right.is_feasible)
        )
        return better_or_equal and strictly_better

    def _apply_dominance_prune_for_set(self, passenger_set: Tuple[str, ...], vehicle_id: str) -> None:
        if self.pruning_mode != "heuristic":
            # Safe mode disables dominance pruning entirely. Even same-passenger
            # routes can differ in timing/slack footprint and become globally
            # relevant once the master model couples routes across vehicles.
            return

        candidates = [
            (key, route)
            for key, route in self._routes_by_key.items()
            if route.passenger_set == passenger_set and str(route.vehicle_id) == str(vehicle_id)
        ]
        if len(candidates) <= 1:
            return

        to_remove = set()
        for i in range(len(candidates)):
            key_i, route_i = candidates[i]
            if key_i in to_remove:
                continue
            for j in range(i + 1, len(candidates)):
                key_j, route_j = candidates[j]
                if key_j in to_remove:
                    continue
                if self._route_dominates(route_i, route_j):
                    to_remove.add(key_j)
                elif self._route_dominates(route_j, route_i):
                    to_remove.add(key_i)
                    break

        for key in to_remove:
            self._routes_by_key.pop(key, None)
        self.dominated_dropped_count += len(to_remove)
        self.unsafe_heuristic_drop_count += len(to_remove)

    def _prune_to_limit(self) -> None:
        if self.pruning_mode == "safe":
            self._prune_to_limit_safe()
            return

        routes = self.get_routes()
        if len(routes) <= self.max_routes:
            return

        # Keep at least the best representative of every (passenger-set, vehicle)
        # pair first. Even in heuristic mode, collapsing across vehicles is
        # unsafe for the master (<= 1 route per vehicle).
        best_per_set: Dict[Tuple[Tuple[str, ...], str], PooledRoute] = {}
        for route in routes:
            key = (route.passenger_set, str(route.vehicle_id))
            existing = best_per_set.get(key)
            if existing is None or route.objective_score + 1e-9 < existing.objective_score:
                best_per_set[key] = route

        selected: List[PooledRoute] = sorted(
            best_per_set.values(),
            key=lambda r: (r.objective_score, len(r.passenger_set), r.vehicle_id, r.sequence_signature),
        )

        if len(selected) > self.max_routes:
            if self.complementarity_enabled:
                # When the mandatory representatives already exceed the cap,
                # apply the same complementarity-aware selection rather than
                # trimming purely by objective score.
                selected, breakdown = self._fill_with_complementarity([], selected)
                breakdown = dict(breakdown or {})
                breakdown["seedStageOverflow"] = int(max(0, len(best_per_set) - self.max_routes))
                self.last_retention_breakdown = breakdown
            else:
                selected = selected[: self.max_routes]
                self.last_retention_breakdown = {
                    "seedBestPerVehiclePassenger": int(len(selected)),
                    "trimmedAtSeedStage": int(max(0, len(best_per_set) - len(selected))),
                    "selectedByQuality": 0,
                    "selectedByRarity": 0,
                    "selectedByTiming": 0,
                    "selectedByBucketFill": 0,
                }
        else:
            selected, breakdown = self._fill_with_complementarity(selected, routes)
            self.last_retention_breakdown = dict(breakdown or {})

        self.cap_dropped_count += max(0, len(routes) - min(len(selected), self.max_routes))
        self.unsafe_heuristic_drop_count += max(0, len(routes) - min(len(selected), self.max_routes))
        self._routes_by_key = {
            route.equivalence_key(self.pruning_mode): route
            for route in selected[: self.max_routes]
        }
        self.prune_count += 1

    def _fill_with_complementarity(
        self,
        seed_selected: List[PooledRoute],
        routes: List[PooledRoute],
    ) -> Tuple[List[PooledRoute], Dict[str, int]]:
        """Fill remaining pool capacity using explicit complementarity signals.

        Signals (heuristic, observable):
        - Quality: low objective score.
        - Rarity: routes that cover employees with few alternatives in the pool.
        - Timing diversity: preserve multiple timing footprints per vehicle.
        """
        selected = list(seed_selected)
        selected_keys = {route.equivalence_key(self.pruning_mode) for route in selected}
        remaining = [r for r in routes if r.equivalence_key(self.pruning_mode) not in selected_keys]

        breakdown = {
            "seedBestPerVehiclePassenger": int(len(seed_selected)),
            "selectedByQuality": 0,
            "selectedByRarity": 0,
            "selectedByTiming": 0,
            "selectedByBucketFill": 0,
        }

        if not remaining or len(selected) >= self.max_routes:
            return selected[: self.max_routes], breakdown

        if not self.complementarity_enabled:
            # Backward-compatible fallback: simple bucket fill by passenger count and category.
            buckets: Dict[Tuple[int, str], List[PooledRoute]] = {}
            for route in remaining:
                key = (len(route.passenger_set), str(route.vehicle_category or "normal"))
                buckets.setdefault(key, []).append(route)
            for key in buckets:
                buckets[key].sort(key=lambda r: (r.objective_score, r.vehicle_id, r.sequence_signature))

            active_keys = sorted(buckets.keys())
            cursor = {key: 0 for key in active_keys}
            while len(selected) < self.max_routes and active_keys:
                progressed = False
                for key in list(active_keys):
                    idx = cursor[key]
                    bucket = buckets[key]
                    if idx >= len(bucket):
                        active_keys.remove(key)
                        continue
                    selected.append(bucket[idx])
                    cursor[key] += 1
                    breakdown["selectedByBucketFill"] += 1
                    progressed = True
                    if len(selected) >= self.max_routes:
                        break
                if not progressed:
                    break
            return selected[: self.max_routes], breakdown

        slots = max(0, int(self.max_routes) - int(len(selected)))
        if slots <= 0:
            return selected[: self.max_routes], breakdown

        # Coverage counts across all candidates (selected + remaining).
        coverage_count: Dict[str, int] = {}
        for route in (selected + remaining):
            for emp_id in route.passenger_set:
                coverage_count[emp_id] = coverage_count.get(emp_id, 0) + 1

        def rarity_score(route: PooledRoute) -> float:
            score = 0.0
            for emp_id in route.passenger_set:
                c = coverage_count.get(emp_id, 0)
                if c <= 0:
                    continue
                score += 1.0 / float(c)
            # Prefer feasible routes and routes with lower penalty totals in tie.
            if route.is_feasible:
                score += 0.15
            score -= 1e-10 * float(route.penalty_total)
            return float(score)

        # Stage quotas.
        q_frac = float(self.complementarity_quality_fraction)
        r_frac = float(self.complementarity_rarity_fraction)
        t_frac = float(self.complementarity_timing_fraction)
        total = max(1e-9, q_frac + r_frac + t_frac)
        q_frac /= total
        r_frac /= total
        t_frac /= total

        q_slots = int(round(slots * q_frac))
        r_slots = int(round(slots * r_frac))
        t_slots = max(0, int(slots - q_slots - r_slots))

        remaining.sort(key=lambda r: (r.objective_score, len(r.passenger_set), r.vehicle_id, r.sequence_signature))

        # Quality picks.
        if q_slots > 0:
            take = remaining[: min(q_slots, len(remaining))]
            selected.extend(take)
            breakdown["selectedByQuality"] += len(take)
            selected_keys.update(r.equivalence_key(self.pruning_mode) for r in take)
            remaining = [r for r in remaining if r.equivalence_key(self.pruning_mode) not in selected_keys]

        # Rarity picks (highest rarity score).
        if r_slots > 0 and remaining and len(selected) < self.max_routes:
            ranked = sorted(
                remaining,
                key=lambda r: (
                    -rarity_score(r),
                    r.objective_score,
                    len(r.passenger_set),
                    r.vehicle_id,
                    r.sequence_signature,
                ),
            )
            take = ranked[: min(r_slots, len(ranked), self.max_routes - len(selected))]
            selected.extend(take)
            breakdown["selectedByRarity"] += len(take)
            selected_keys.update(r.equivalence_key(self.pruning_mode) for r in take)
            remaining = [r for r in remaining if r.equivalence_key(self.pruning_mode) not in selected_keys]

        # Timing diversity: round-robin by (vehicle_id, timing_signature).
        if t_slots > 0 and remaining and len(selected) < self.max_routes:
            buckets: Dict[Tuple[str, Tuple[int, int, int, int]], List[PooledRoute]] = {}
            for route in remaining:
                key = (str(route.vehicle_id), route.timing_signature)
                buckets.setdefault(key, []).append(route)
            for key in buckets:
                buckets[key].sort(key=lambda r: (r.objective_score, len(r.passenger_set), r.sequence_signature))

            bucket_keys = sorted(buckets.keys(), key=lambda k: (k[0], k[1]))
            cursors = {k: 0 for k in bucket_keys}
            while len(selected) < self.max_routes and bucket_keys and breakdown["selectedByTiming"] < t_slots:
                progressed = False
                for k in list(bucket_keys):
                    idx = cursors[k]
                    bucket = buckets[k]
                    if idx >= len(bucket):
                        bucket_keys.remove(k)
                        continue
                    selected.append(bucket[idx])
                    cursors[k] += 1
                    breakdown["selectedByTiming"] += 1
                    progressed = True
                    if len(selected) >= self.max_routes or breakdown["selectedByTiming"] >= t_slots:
                        break
                if not progressed:
                    break
            selected_keys = {r.equivalence_key(self.pruning_mode) for r in selected}
            remaining = [r for r in remaining if r.equivalence_key(self.pruning_mode) not in selected_keys]

        # Fill remaining capacity with deterministic bucket fill.
        if remaining and len(selected) < self.max_routes:
            buckets: Dict[Tuple[int, str], List[PooledRoute]] = {}
            for route in remaining:
                key = (len(route.passenger_set), str(route.vehicle_category or "normal"))
                buckets.setdefault(key, []).append(route)
            for key in buckets:
                buckets[key].sort(key=lambda r: (r.objective_score, r.vehicle_id, r.sequence_signature))

            active_keys = sorted(buckets.keys())
            cursor = {key: 0 for key in active_keys}
            while len(selected) < self.max_routes and active_keys:
                progressed = False
                for key in list(active_keys):
                    idx = cursor[key]
                    bucket = buckets[key]
                    if idx >= len(bucket):
                        active_keys.remove(key)
                        continue
                    selected.append(bucket[idx])
                    cursor[key] += 1
                    breakdown["selectedByBucketFill"] += 1
                    progressed = True
                    if len(selected) >= self.max_routes:
                        break
                if not progressed:
                    break

        return selected[: self.max_routes], breakdown

    def _prune_to_limit_safe(self) -> None:
        routes = self.get_routes()
        if len(routes) <= self.max_routes:
            return

        # Safe mode still needs a hard cap for runtime/memory, but any drop here
        # is heuristic-only. Preserve multiple representatives per passenger set
        # by vehicle and timing footprint before filling remaining slots by cost.
        group_key = lambda r: (
            r.passenger_set,
            str(r.vehicle_id),
            r.timing_signature,
            r.sequence_signature,
            r.hard_constraint_signature,
        )

        buckets: Dict[Tuple[object, ...], List[PooledRoute]] = {}
        for route in routes:
            buckets.setdefault(group_key(route), []).append(route)

        for key in buckets:
            buckets[key].sort(
                key=lambda r: (
                    r.objective_score,
                    len(r.passenger_set),
                    r.total_delay,
                    r.total_time,
                    r.sequence_signature,
                )
            )

        selected: List[PooledRoute] = []
        bucket_keys = sorted(
            buckets.keys(),
            key=lambda key: (
                len(key[0]),
                str(key[1]),
                tuple(key[2]),
                tuple(key[3]),
            ),
        )
        cursors = {key: 0 for key in bucket_keys}

        while len(selected) < self.max_routes and bucket_keys:
            progressed = False
            for key in list(bucket_keys):
                idx = cursors[key]
                bucket = buckets[key]
                if idx >= len(bucket):
                    bucket_keys.remove(key)
                    continue
                selected.append(bucket[idx])
                cursors[key] += 1
                progressed = True
                if len(selected) >= self.max_routes:
                    break
            if not progressed:
                break

        self.cap_dropped_count += max(0, len(routes) - len(selected))
        self._routes_by_key = {
            route.equivalence_key(self.pruning_mode): route
            for route in selected[: self.max_routes]
        }
        self.prune_count += 1


def build_route_pool(
    problem: ProblemInstance,
    individuals: Sequence[Individual],
    archives: Sequence[Dict],
    max_routes: int,
    evaluator: Optional[ObjectiveEvaluator] = None,
    pruning_mode: str = "heuristic",
) -> Tuple[List[PooledRoute], Dict[str, object]]:
    pool = RoutePoolManager(
        problem=problem,
        evaluator=evaluator,
        max_routes=max_routes,
        penalty_factor=15.0,
        phase_progress=1.0,
        enforce_hard=True,
        pruning_mode=pruning_mode,
    )

    for idx, individual in enumerate(individuals):
        pool.collect_from_individual(individual, source="final_topk", run_id=idx + 1, generation=-1)

    pool.collect_from_archives(archives)
    routes = pool.get_routes()
    return routes, pool.stats()
