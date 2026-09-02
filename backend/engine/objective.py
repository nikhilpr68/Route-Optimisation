from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Set, Tuple

from models import ProblemInstance, get_max_allowed_delay
from representation import Individual, Route
from utils import TURNAROUND_BUFFER_MINUTES, calculate_travel_time, get_distance

# Hard constraints: these should effectively dominate any soft objective terms.
# Use very large finite values instead of infinity so the search can still compare
# infeasible candidates and continue improving them.
PENALTY_UNASSIGNED = 5_000_000_000
PENALTY_INFEASIBLE_ROUTE = 2_500_000_000
PENALTY_PRECEDENCE = 4_000_000_000
PENALTY_CONSISTENCY = 3_000_000_000
PENALTY_CAPACITY_PER_UNIT = 2_000_000_000

# Soft constraints: these can still be traded off during constructive search.
PENALTY_PREMIUM_MISMATCH = 20_000
PENALTY_LATE_PER_MIN = 300
PENALTY_SHARING_PER_UNIT = 20_000


class ObjectiveEvaluator:
    def __init__(self, problem: ProblemInstance):
        self.problem = problem
        self.metadata = getattr(problem, "metadata", {}) or {}
        self.allow_sharing_violation = self._meta_bool("ALLOW_SHARING_VIOLATION", default=False)
        self.allow_premium_mismatch = self._meta_bool("ALLOW_PREMIUM_MISMATCH", default=False)

        # Expensive route simulation cache, intentionally independent of dynamic
        # penalty schedules (penalty_factor / strictness / enforce_hard).
        self._base_route_cache: Dict[Tuple, Dict] = {}
        self._max_base_cache_size = 80_000

    def evaluate(
        self,
        individual: Individual,
        penalty_factor: float = 1.0,
        phase_progress: float = None,
        enforce_hard: bool = False,
        use_cache: bool = True,
    ) -> float:
        strictness = self._strictness_from_phase(penalty_factor, phase_progress)

        base_objective_total = 0.0
        total_score = 0.0
        breakdown = {
            "lateness": 0.0,
            "capacity": 0.0,
            "sharing": 0.0,
            "premium": 0.0,
            "precedence": 0.0,
            "consistency": 0.0,
            "infeasible": 0.0,
            "unassigned": 0.0,
        }

        all_violations = []
        all_consistency_errors = []
        route_penalties: Dict[str, Dict[str, float]] = {}

        for route in individual.routes:
            route_penalty = self._evaluate_route_dynamic(
                route,
                penalty_factor=penalty_factor,
                strictness=strictness,
                enforce_hard=enforce_hard,
                use_cache=use_cache,
            )

            base_score = (
                self.problem.cost_weight * float(route.total_cost)
                + self.problem.time_weight * float(route.total_time)
            )
            base_objective_total += float(base_score)
            total_score += base_score + route_penalty

            route_key = str(getattr(route.vehicle, "id", "unknown"))
            route_penalties[route_key] = dict(route.penalty_breakdown)
            for key in breakdown:
                breakdown[key] += float(route.penalty_breakdown.get(key, 0.0))

            if route.violations:
                all_violations.extend([f"route:{route_key}:{v}" for v in route.violations])
            if route.consistency_errors:
                all_consistency_errors.extend([f"route:{route_key}:{e}" for e in route.consistency_errors])

        individual_consistency = self._validate_individual_consistency(individual)
        if individual_consistency:
            c_penalty = (
                len(individual_consistency)
                * PENALTY_CONSISTENCY
                * penalty_factor
                * (1.0 + strictness)
            )
            breakdown["consistency"] += c_penalty
            total_score += c_penalty
            all_consistency_errors.extend(individual_consistency)

        if individual.unassigned:
            unassigned_penalty = (
                len(individual.unassigned)
                * PENALTY_UNASSIGNED
                * penalty_factor
                * (0.5 + 1.5 * strictness)
            )
            breakdown["unassigned"] += unassigned_penalty
            total_score += unassigned_penalty
            all_violations.append(f"unassigned:{len(individual.unassigned)}")

        individual.objective_score = float(total_score)
        individual.base_objective_score = float(base_objective_total)
        individual.penalty_breakdown = breakdown
        individual.route_penalty_breakdown = route_penalties
        individual.violations = all_violations
        individual.consistency_errors = all_consistency_errors
        return individual.objective_score

    # ------------------------------------------------------------------
    # Incremental / delta evaluation (exact, route-local)
    # ------------------------------------------------------------------

    @dataclass
    class IncrementalEvalState:
        penalty_factor: float
        phase_progress: Optional[float]
        enforce_hard: bool
        strictness: float
        route_base_contrib: List[float]
        route_penalty_breakdown: List[Dict[str, float]]
        route_pickup_ids: List[Set[str]]

    def build_incremental_state(
        self,
        individual: Individual,
        penalty_factor: float,
        phase_progress: Optional[float],
        enforce_hard: bool,
    ) -> "ObjectiveEvaluator.IncrementalEvalState":
        """Create an incremental evaluation state for an already-evaluated individual."""
        strictness = self._strictness_from_phase(penalty_factor, phase_progress)
        route_base_contrib: List[float] = []
        route_penalty_breakdown: List[Dict[str, float]] = []
        route_pickup_ids: List[Set[str]] = []

        for route in getattr(individual, "routes", []) or []:
            base_c = (self.problem.cost_weight * float(getattr(route, "total_cost", 0.0))) + (
                self.problem.time_weight * float(getattr(route, "total_time", 0.0))
            )
            route_base_contrib.append(float(base_c))
            route_penalty_breakdown.append(dict(getattr(route, "penalty_breakdown", {}) or {}))
            route_pickup_ids.append(self._pickup_ids_for_consistency(route))

        return ObjectiveEvaluator.IncrementalEvalState(
            penalty_factor=float(penalty_factor),
            phase_progress=(None if phase_progress is None else float(phase_progress)),
            enforce_hard=bool(enforce_hard),
            strictness=float(strictness),
            route_base_contrib=route_base_contrib,
            route_penalty_breakdown=route_penalty_breakdown,
            route_pickup_ids=route_pickup_ids,
        )

    def evaluate_incremental(
        self,
        individual: Individual,
        state: "ObjectiveEvaluator.IncrementalEvalState",
        changed_route_indices: Sequence[int],
        penalty_factor: float,
        phase_progress: Optional[float],
        enforce_hard: bool,
        use_cache: bool = True,
    ) -> bool:
        """Exact delta evaluation for candidates where only a few routes changed.

        Returns True when incremental evaluation was applied. Falls back to full
        `evaluate()` (and returns False) if the provided state is incompatible.
        """
        strictness = self._strictness_from_phase(penalty_factor, phase_progress)
        if (
            abs(float(state.penalty_factor) - float(penalty_factor)) > 1e-12
            or bool(state.enforce_hard) != bool(enforce_hard)
            or (state.phase_progress is None) != (phase_progress is None)
            or (state.phase_progress is not None and abs(float(state.phase_progress) - float(phase_progress)) > 1e-12)
            or abs(float(state.strictness) - float(strictness)) > 1e-12
        ):
            self.evaluate(individual, penalty_factor=penalty_factor, phase_progress=phase_progress, enforce_hard=enforce_hard, use_cache=use_cache)
            return False

        routes = list(getattr(individual, "routes", []) or [])
        if len(routes) != len(state.route_base_contrib):
            self.evaluate(individual, penalty_factor=penalty_factor, phase_progress=phase_progress, enforce_hard=enforce_hard, use_cache=use_cache)
            return False

        changed = sorted({int(idx) for idx in changed_route_indices if 0 <= int(idx) < len(routes)})

        # Re-evaluate only the changed routes (route simulation + penalty application).
        for idx in changed:
            route = routes[idx]
            self._evaluate_route_dynamic(
                route,
                penalty_factor=float(penalty_factor),
                strictness=float(strictness),
                enforce_hard=bool(enforce_hard),
                use_cache=use_cache,
            )
            state.route_base_contrib[idx] = (
                self.problem.cost_weight * float(getattr(route, "total_cost", 0.0))
                + self.problem.time_weight * float(getattr(route, "total_time", 0.0))
            )
            state.route_penalty_breakdown[idx] = dict(getattr(route, "penalty_breakdown", {}) or {})
            state.route_pickup_ids[idx] = self._pickup_ids_for_consistency(route)

        # Rebuild route totals (still avoids re-simulating unchanged routes).
        base_objective_total = 0.0
        total_penalty_score = 0.0
        breakdown = {
            "lateness": 0.0,
            "capacity": 0.0,
            "sharing": 0.0,
            "premium": 0.0,
            "precedence": 0.0,
            "consistency": 0.0,
            "infeasible": 0.0,
            "unassigned": 0.0,
        }
        all_violations: List[str] = []
        all_consistency_errors: List[str] = []
        route_penalties: Dict[str, Dict[str, float]] = {}

        for idx, route in enumerate(routes):
            base_objective_total += float(state.route_base_contrib[idx])
            pb = dict(state.route_penalty_breakdown[idx] or {})
            route_key = str(getattr(route.vehicle, "id", "unknown"))
            route_penalties[route_key] = dict(pb)
            for key in breakdown.keys():
                if key == "unassigned":
                    continue
                breakdown[key] += float(pb.get(key, 0.0) or 0.0)

            total_penalty_score += sum(float(v) for v in pb.values() if isinstance(v, (int, float)))

            if getattr(route, "violations", None):
                all_violations.extend([f"route:{route_key}:{v}" for v in (route.violations or [])])
            if getattr(route, "consistency_errors", None):
                all_consistency_errors.extend([f"route:{route_key}:{e}" for e in (route.consistency_errors or [])])

        # Individual-level consistency (same semantics as _validate_individual_consistency).
        assignment_counts: Dict[str, int] = {}
        for pickup_ids in state.route_pickup_ids:
            for emp_id in pickup_ids:
                assignment_counts[emp_id] = assignment_counts.get(emp_id, 0) + 1

        consistency_errors = []
        for emp in getattr(individual, "unassigned", []) or []:
            emp_id = str(getattr(emp, "id", ""))
            if assignment_counts.get(emp_id, 0) > 0:
                consistency_errors.append(f"assigned_and_unassigned:{emp_id}")
        for emp_id, c in assignment_counts.items():
            if c > 1:
                consistency_errors.append(f"multi_route_assignment:{emp_id}:{c}")

        if consistency_errors:
            c_penalty = (
                len(consistency_errors)
                * PENALTY_CONSISTENCY
                * float(penalty_factor)
                * (1.0 + float(strictness))
            )
            breakdown["consistency"] += float(c_penalty)
            total_penalty_score += float(c_penalty)
            all_consistency_errors.extend(consistency_errors)

        if getattr(individual, "unassigned", None):
            unassigned_penalty = (
                len(individual.unassigned)
                * PENALTY_UNASSIGNED
                * float(penalty_factor)
                * (0.5 + 1.5 * float(strictness))
            )
            breakdown["unassigned"] += float(unassigned_penalty)
            total_penalty_score += float(unassigned_penalty)
            all_violations.append(f"unassigned:{len(individual.unassigned)}")

        individual.objective_score = float(base_objective_total + total_penalty_score)
        individual.base_objective_score = float(base_objective_total)
        individual.penalty_breakdown = breakdown
        individual.route_penalty_breakdown = route_penalties
        individual.violations = all_violations
        individual.consistency_errors = all_consistency_errors
        return True

    def _pickup_ids_for_consistency(self, route: Route) -> Set[str]:
        seen_in_route = set()
        out = set()
        for stop in getattr(route, "stop_sequence", []) or []:
            if stop.get("type") != "p":
                continue
            emp = stop.get("emp")
            if emp is None:
                continue
            emp_id = str(getattr(emp, "id", ""))
            if not emp_id or emp_id in seen_in_route:
                continue
            seen_in_route.add(emp_id)
            out.add(emp_id)
        return out

    def _strictness_from_phase(self, penalty_factor: float, phase_progress: float) -> float:
        if phase_progress is not None:
            return max(0.0, min(1.0, float(phase_progress)))
        normalized = (float(penalty_factor) - 0.2) / 14.8
        return max(0.0, min(1.0, normalized))

    def _base_route_cache_key(self, route: Route) -> Tuple:
        seq_key = tuple(
            (
                str(stop.get("type") or ""),
                str(getattr(stop.get("emp"), "id", "")),
            )
            for stop in route.stop_sequence
        )
        return str(route.vehicle.id), seq_key

    def _evaluate_route_dynamic(
        self,
        route: Route,
        penalty_factor: float,
        strictness: float,
        enforce_hard: bool,
        use_cache: bool,
    ) -> float:
        if not route.stop_sequence:
            has_orphan_employees = bool(route.employees)
            route.total_cost = 0.0
            route.total_time = 0.0
            route.total_delay = 0.0
            route.employee_delay_minutes = {}
            route.is_feasible = not has_orphan_employees
            route.violation_msg = "employees_without_stops" if has_orphan_employees else ""
            route.violations = ["employees_without_stops"] if has_orphan_employees else []
            penalties = {
                "lateness": 0.0,
                "capacity": 0.0,
                "sharing": 0.0,
                "premium": 0.0,
                "precedence": 0.0,
                "consistency": 0.0,
                "infeasible": 0.0,
            }
            if has_orphan_employees:
                penalties["consistency"] = PENALTY_CONSISTENCY * penalty_factor * (1.0 + strictness)
                penalties["infeasible"] = PENALTY_INFEASIBLE_ROUTE * penalty_factor * (1.0 + 2.5 * strictness)
            route.penalty_breakdown = penalties
            route.consistency_errors = ["employees_without_stops"] if has_orphan_employees else []
            return float(sum(float(v) for v in penalties.values()))

        key = self._base_route_cache_key(route)
        if use_cache and key in self._base_route_cache:
            base = copy.deepcopy(self._base_route_cache[key])
        else:
            base = self._simulate_route_base(route)
            if use_cache:
                self._store_base_route_cache(key, base)

        return self._apply_penalties(route, base, penalty_factor, strictness, enforce_hard)

    def _store_base_route_cache(self, key: Tuple, value: Dict) -> None:
        if len(self._base_route_cache) >= self._max_base_cache_size:
            self._base_route_cache.clear()
        self._base_route_cache[key] = copy.deepcopy(value)

    def _simulate_route_base(self, route: Route) -> Dict:
        penalties = {
            "lateness": 0.0,
            "capacity": 0.0,
            "sharing": 0.0,
            "premium": 0.0,
            "precedence": 0.0,
            "consistency": 0.0,
            "infeasible": 0.0,
        }
        if not route.stop_sequence:
            return {
                "total_cost": 0.0,
                "total_time": 0.0,
                "total_delay": 0.0,
                "employee_delay_minutes": {},
                "soft_lateness_minutes": 0.0,
                "capacity_excess": 0.0,
                "sharing_excess": 0.0,
                "premium_mismatch_count": 0.0,
                "precedence_count": 0,
                "consistency_errors": [],
                "violations": [],
                "hard_infeasible": False,
                "penalties_template": penalties,
            }

        vehicle = route.vehicle
        consistency_errors = self._validate_route_consistency(route)
        violations: List[str] = []
        hard_infeasible = bool(consistency_errors)

        curr_loc = vehicle.start_loc
        first_stop = route.stop_sequence[0]
        first_emp = first_stop.get("emp")
        if first_emp is None:
            consistency_errors.append("missing_first_employee")
            hard_infeasible = True
            return {
                "total_cost": 0.0,
                "total_time": 0.0,
                "total_delay": 0.0,
                "employee_delay_minutes": {},
                "soft_lateness_minutes": 0.0,
                "capacity_excess": 0.0,
                "sharing_excess": 0.0,
                "premium_mismatch_count": 0.0,
                "precedence_count": 0,
                "consistency_errors": consistency_errors,
                "violations": ["invalid_first_stop"],
                "hard_infeasible": True,
                "penalties_template": penalties,
            }

        first_loc = first_emp.pickup_loc if first_stop.get("type") == "p" else first_emp.drop_loc
        travel_to_first = calculate_travel_time(get_distance(curr_loc, first_loc), vehicle.speed_kmph)
        target_arrival = float(getattr(first_emp, "earliest_pickup", vehicle.avail_from))
        jit_start = float(target_arrival) - float(travel_to_first)
        effective_start = max(float(vehicle.avail_from), float(jit_start))

        curr_time = float(effective_start)
        curr_loc = vehicle.start_loc

        total_dist = 0.0
        total_delay = 0.0
        employee_delay_minutes: Dict[str, float] = {}

        current_load = 0
        active_passengers = set()
        picked_up_ids = set()

        soft_lateness_minutes = 0.0
        capacity_excess = 0.0
        sharing_excess = 0.0
        premium_mismatch_count = 0.0
        precedence_count = 0

        for idx, stop in enumerate(route.stop_sequence):
            emp = stop.get("emp")
            stop_type = stop.get("type")
            if emp is None or stop_type not in ("p", "d"):
                consistency_errors.append(f"invalid_stop:{idx}")
                violations.append(f"invalid_stop:{idx}")
                hard_infeasible = True
                continue

            target = emp.pickup_loc if stop_type == "p" else emp.drop_loc
            dist = get_distance(curr_loc, target)
            travel = calculate_travel_time(dist, vehicle.speed_kmph)
            curr_time += travel
            total_dist += dist

            if current_load == 0 and stop_type == "p" and idx > 0:
                curr_time += TURNAROUND_BUFFER_MINUTES

            if stop_type == "p":
                if curr_time < emp.earliest_pickup:
                    curr_time = float(emp.earliest_pickup)

                e_pref = str(emp.vehicle_pref or "").strip().lower()
                v_cat = str(vehicle.category or "").strip().lower()
                if (not self.allow_premium_mismatch) and e_pref == "premium" and v_cat != "premium":
                    premium_mismatch_count += 1.0
                    violations.append(f"premium_mismatch:{emp.id}")

                current_load += 1
                active_passengers.add(emp)
                picked_up_ids.add(emp.id)
            else:
                if emp.id not in picked_up_ids:
                    precedence_count += 1
                    violations.append(f"drop_before_pickup:{emp.id}")
                    hard_infeasible = True

                max_allowed_delay = float(
                    get_max_allowed_delay(emp.priority, self.problem.metadata)
                )
                delay_minutes = max(0.0, float(curr_time) - float(emp.latest_drop))
                if delay_minutes > 0.0:
                    violations.append(f"late_drop:{emp.id}:{delay_minutes:.2f}")

                # Delay is soft only up to max_allowed_delay for this priority.
                soft_lateness_minutes += min(delay_minutes, max_allowed_delay)

                if delay_minutes > max_allowed_delay + 1e-9:
                    hard_infeasible = True
                    violations.append(
                        f"delay_exceeds_max_allowed:{emp.id}:{delay_minutes - max_allowed_delay:.2f}"
                    )

                total_delay += delay_minutes
                employee_delay_minutes[str(emp.id)] = delay_minutes

                current_load = max(0, current_load - 1)
                if emp in active_passengers:
                    active_passengers.remove(emp)

            if current_load > vehicle.capacity:
                excess = float(current_load - vehicle.capacity)
                capacity_excess += excess
                violations.append(f"capacity_excess:{current_load}/{vehicle.capacity}")
                hard_infeasible = True

            if not self.allow_sharing_violation:
                for p in list(active_passengers):
                    max_share = self._sharing_limit(getattr(p, "sharing_pref", ""))
                    if current_load > max_share:
                        excess = float(current_load - max_share)
                        sharing_excess += excess
                        violations.append(f"sharing_excess:{p.id}:{current_load}>{max_share}")

            curr_loc = target

        return {
            "total_cost": float(total_dist) * float(vehicle.cost_per_km),
            "total_time": float(max(0.0, curr_time - effective_start)),
            "total_delay": float(total_delay),
            "employee_delay_minutes": employee_delay_minutes,
            "soft_lateness_minutes": float(soft_lateness_minutes),
            "capacity_excess": float(capacity_excess),
            "sharing_excess": float(sharing_excess),
            "premium_mismatch_count": float(premium_mismatch_count),
            "precedence_count": int(precedence_count),
            "consistency_errors": consistency_errors,
            "violations": violations,
            "hard_infeasible": bool(hard_infeasible),
            "penalties_template": penalties,
        }

    def _apply_penalties(
        self,
        route: Route,
        base: Dict,
        penalty_factor: float,
        strictness: float,
        enforce_hard: bool,
    ) -> float:
        penalties = dict(base.get("penalties_template") or {})
        for key in ("lateness", "capacity", "sharing", "premium", "precedence", "consistency", "infeasible"):
            penalties.setdefault(key, 0.0)

        violations = list(base.get("violations") or [])
        consistency_errors = list(base.get("consistency_errors") or [])

        if consistency_errors:
            penalties["consistency"] += (
                len(consistency_errors)
                * PENALTY_CONSISTENCY
                * penalty_factor
                * (1.0 + strictness)
            )

        precedence_count = int(base.get("precedence_count") or 0)
        if precedence_count > 0:
            penalties["precedence"] += (
                precedence_count * PENALTY_PRECEDENCE * penalty_factor * (1.0 + strictness)
            )

        soft_lateness_minutes = float(base.get("soft_lateness_minutes") or 0.0)
        capacity_excess = float(base.get("capacity_excess") or 0.0)
        sharing_excess = float(base.get("sharing_excess") or 0.0)
        premium_mismatch_count = float(base.get("premium_mismatch_count") or 0.0)

        penalties["lateness"] += (
            soft_lateness_minutes
            * PENALTY_LATE_PER_MIN
            * penalty_factor
            * (0.45 + 2.8 * strictness)
        )
        penalties["capacity"] += (
            capacity_excess
            * PENALTY_CAPACITY_PER_UNIT
            * penalty_factor
            * (0.35 + 2.4 * strictness)
        )
        penalties["sharing"] += (
            sharing_excess
            * PENALTY_SHARING_PER_UNIT
            * penalty_factor
            * (0.35 + 2.2 * strictness)
        )
        penalties["premium"] += (
            premium_mismatch_count
            * PENALTY_PREMIUM_MISMATCH
            * penalty_factor
            * (0.35 + 2.4 * strictness)
        )

        soft_violation_present = any(
            value > 0.0
            for value in (
                sharing_excess,
                premium_mismatch_count,
            )
        )

        hard_infeasible = bool(base.get("hard_infeasible"))
        if soft_violation_present and (enforce_hard or strictness >= 0.93):
            hard_infeasible = True
            violations.append("soft_violations_became_hard")

        if hard_infeasible:
            penalties["infeasible"] += (
                PENALTY_INFEASIBLE_ROUTE
                * penalty_factor
                * (1.0 + 2.5 * strictness)
            )

        route.total_cost = float(base.get("total_cost") or 0.0)
        route.total_time = float(base.get("total_time") or 0.0)
        route.total_delay = float(base.get("total_delay") or 0.0)
        route.employee_delay_minutes = dict(base.get("employee_delay_minutes") or {})

        route.is_feasible = not hard_infeasible
        route.violations = violations
        route.consistency_errors = consistency_errors
        route.penalty_breakdown = penalties
        route.violation_msg = violations[0] if violations else ""

        return float(sum(float(v) for v in penalties.values()))

    def _sharing_limit(self, sharing_pref: str) -> int:
        pref = str(sharing_pref or "").strip().lower()
        if pref in ("single", "1"):
            return 1
        if pref in ("double", "2"):
            return 2
        if pref in ("triple", "3"):
            return 3
        try:
            return max(1, int(pref))
        except Exception:
            return 2

    def _validate_route_consistency(self, route: Route) -> List[str]:
        errors = []

        if route.employees and not route.stop_sequence:
            errors.append("employees_without_stops")

        pickup_count: Dict[str, int] = {}
        drop_count: Dict[str, int] = {}
        seen_pickup = set()

        for idx, stop in enumerate(route.stop_sequence):
            stop_type = stop.get("type")
            emp = stop.get("emp")
            if stop_type not in ("p", "d") or emp is None:
                errors.append(f"invalid_stop_entry:{idx}")
                continue
            emp_id = str(emp.id)
            if stop_type == "p":
                pickup_count[emp_id] = pickup_count.get(emp_id, 0) + 1
                seen_pickup.add(emp_id)
            else:
                drop_count[emp_id] = drop_count.get(emp_id, 0) + 1
                if emp_id not in seen_pickup:
                    errors.append(f"drop_before_pickup:{emp_id}")

        for emp_id, count in pickup_count.items():
            if count != 1:
                errors.append(f"pickup_count:{emp_id}:{count}")
        for emp_id, count in drop_count.items():
            if count != 1:
                errors.append(f"drop_count:{emp_id}:{count}")
        for emp_id in set(pickup_count.keys()) ^ set(drop_count.keys()):
            errors.append(f"pickup_drop_mismatch:{emp_id}")

        employee_ids = {str(e.id) for e in route.employees}
        if employee_ids and employee_ids != set(pickup_count.keys()):
            errors.append("employee_list_sequence_mismatch")

        return errors

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
        meta = self.metadata or {}
        for candidate in self._meta_candidates(key):
            if candidate in meta:
                return meta.get(candidate)
        return None

    def _meta_bool(self, key: str, default: bool) -> bool:
        raw = self._meta_raw(key)
        if raw is None:
            return bool(default)
        if isinstance(raw, bool):
            return raw
        text = str(raw).strip().lower()
        if text in ("1", "true", "yes", "on"):
            return True
        if text in ("0", "false", "no", "off"):
            return False
        return bool(default)

    def _validate_individual_consistency(self, individual: Individual) -> List[str]:
        errors = []

        route_assignment_counts: Dict[str, int] = {}
        for route in individual.routes:
            seen_in_route = set()
            for stop in route.stop_sequence:
                if stop.get("type") != "p":
                    continue
                emp = stop.get("emp")
                if emp is None:
                    continue
                emp_id = str(emp.id)
                if emp_id in seen_in_route:
                    continue
                seen_in_route.add(emp_id)
                route_assignment_counts[emp_id] = route_assignment_counts.get(emp_id, 0) + 1

        for emp in individual.unassigned or []:
            emp_id = str(emp.id)
            if route_assignment_counts.get(emp_id, 0) > 0:
                errors.append(f"assigned_and_unassigned:{emp_id}")

        duplicates = [emp_id for emp_id, c in route_assignment_counts.items() if c > 1]
        for emp_id in duplicates:
            errors.append(f"multi_route_assignment:{emp_id}:{route_assignment_counts[emp_id]}")

        return errors
