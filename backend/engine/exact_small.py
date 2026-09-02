from __future__ import annotations

import copy
import time
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Dict, List, Optional, Tuple

from diversity import structural_hash
from models import Employee, ProblemInstance, get_max_allowed_delay
from objective import (
    ObjectiveEvaluator,
    PENALTY_CAPACITY_PER_UNIT,
    PENALTY_INFEASIBLE_ROUTE,
    PENALTY_LATE_PER_MIN,
    PENALTY_PREMIUM_MISMATCH,
    PENALTY_SHARING_PER_UNIT,
    PENALTY_UNASSIGNED,
)
from operators import GeneticOperators
from representation import Individual, Route
from utils import TURNAROUND_BUFFER_MINUTES, calculate_travel_time, configure_distance_metric, get_distance


EXACT_SMALL_FINAL_PENALTY_FACTOR = 15.0
EXACT_SMALL_FINAL_STRICTNESS = 1.0


@dataclass(frozen=True)
class ExactSmallLimits:
    max_employees: int = 5
    max_vehicles: int = 3


@dataclass
class ExactSmallResult:
    status: str
    individual: Optional[Individual] = None
    message: str = ""
    stats: Dict[str, object] = field(default_factory=dict)
    limits: ExactSmallLimits = field(default_factory=ExactSmallLimits)


@dataclass
class _RouteSolveResult:
    score: float
    route: Route
    stats: Dict[str, int]


def _is_truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _forced_unassigned_ids(problem: ProblemInstance) -> set[str]:
    raw = (getattr(problem, "metadata", {}) or {}).get("FORCED_UNASSIGNED_IDS")
    if raw is None:
        return set()
    if isinstance(raw, (list, tuple, set)):
        items = [str(value).strip() for value in raw]
    else:
        items = [chunk.strip() for chunk in str(raw).split(",")]
    return {item for item in items if item}


def _configure_metric_from_problem(problem: ProblemInstance) -> None:
    metadata = getattr(problem, "metadata", {}) or {}
    metric = metadata.get("distance_metric") or metadata.get("distance_method") or "haversine"
    configure_distance_metric(metric)


def evaluate_individual_final(problem: ProblemInstance, individual: Individual) -> float:
    _configure_metric_from_problem(problem)
    evaluator = ObjectiveEvaluator(problem)
    return float(
        evaluator.evaluate(
            individual,
            penalty_factor=EXACT_SMALL_FINAL_PENALTY_FACTOR,
            phase_progress=EXACT_SMALL_FINAL_STRICTNESS,
            enforce_hard=True,
        )
    )


def check_exact_small_limits(
    problem: ProblemInstance,
    limits: ExactSmallLimits,
) -> Optional[str]:
    employee_count = len(getattr(problem, "employees", []) or [])
    vehicle_count = len(getattr(problem, "vehicles", []) or [])
    if employee_count > int(limits.max_employees):
        return (
            f"exact-small mode supports at most {int(limits.max_employees)} employees; "
            f"received {int(employee_count)}"
        )
    if vehicle_count > int(limits.max_vehicles):
        return (
            f"exact-small mode supports at most {int(limits.max_vehicles)} vehicles; "
            f"received {int(vehicle_count)}"
        )
    return None


def solve_exact_small(
    problem: ProblemInstance,
    limits: ExactSmallLimits | None = None,
) -> ExactSmallResult:
    _configure_metric_from_problem(problem)
    limits = limits or ExactSmallLimits()
    rejection = check_exact_small_limits(problem, limits)
    if rejection:
        return ExactSmallResult(
            status="rejected",
            message=rejection,
            stats={
                "employeeCount": int(len(getattr(problem, "employees", []) or [])),
                "vehicleCount": int(len(getattr(problem, "vehicles", []) or [])),
            },
            limits=limits,
        )

    started_at = time.time()
    employees = list(getattr(problem, "employees", []) or [])
    vehicles = list(getattr(problem, "vehicles", []) or [])
    forced_unassigned = _forced_unassigned_ids(problem)
    assignable_employees = [emp for emp in employees if str(emp.id) not in forced_unassigned]
    forced_unassigned_employees = [emp for emp in employees if str(emp.id) in forced_unassigned]
    full_mask = (1 << len(assignable_employees)) - 1

    route_cache: Dict[Tuple[int, int], _RouteSolveResult] = {}
    route_calls = 0
    route_nodes = 0

    def route_for_subset(vehicle_idx: int, subset_mask: int) -> _RouteSolveResult:
        nonlocal route_calls, route_nodes
        key = (int(vehicle_idx), int(subset_mask))
        cached = route_cache.get(key)
        if cached is not None:
            return cached

        route_calls += 1
        vehicle = vehicles[vehicle_idx]
        subset_employees = [
            assignable_employees[idx]
            for idx in range(len(assignable_employees))
            if subset_mask & (1 << idx)
        ]

        if not subset_employees:
            empty_route = Route(vehicle=vehicle, employees=[], stop_sequence=[])
            result = _RouteSolveResult(score=0.0, route=empty_route, stats={"nodesExplored": 1})
            route_cache[key] = result
            return result

        local_index = {str(emp.id): idx for idx, emp in enumerate(subset_employees)}
        allow_sharing_violation = _is_truthy(
            (getattr(problem, "metadata", {}) or {}).get("ALLOW_SHARING_VIOLATION")
        )
        allow_premium_mismatch = _is_truthy(
            (getattr(problem, "metadata", {}) or {}).get("ALLOW_PREMIUM_MISMATCH")
        )
        late_multiplier = PENALTY_LATE_PER_MIN * EXACT_SMALL_FINAL_PENALTY_FACTOR * (0.45 + 2.8 * EXACT_SMALL_FINAL_STRICTNESS)
        capacity_multiplier = (
            PENALTY_CAPACITY_PER_UNIT
            * EXACT_SMALL_FINAL_PENALTY_FACTOR
            * (0.35 + 2.4 * EXACT_SMALL_FINAL_STRICTNESS)
        )
        sharing_multiplier = (
            PENALTY_SHARING_PER_UNIT
            * EXACT_SMALL_FINAL_PENALTY_FACTOR
            * (0.35 + 2.2 * EXACT_SMALL_FINAL_STRICTNESS)
        )
        premium_multiplier = (
            PENALTY_PREMIUM_MISMATCH
            * EXACT_SMALL_FINAL_PENALTY_FACTOR
            * (0.35 + 2.4 * EXACT_SMALL_FINAL_STRICTNESS)
        )
        infeasible_penalty = (
            PENALTY_INFEASIBLE_ROUTE
            * EXACT_SMALL_FINAL_PENALTY_FACTOR
            * (1.0 + 2.5 * EXACT_SMALL_FINAL_STRICTNESS)
        )

        best_score = float("inf")
        best_sequence: List[Dict[str, object]] = []
        nodes_explored = 0

        def current_lower_bound(
            total_dist: float,
            effective_start: Optional[float],
            curr_time: float,
            soft_lateness: float,
            capacity_excess: float,
            sharing_excess: float,
            premium_mismatch_count: float,
            hard_infeasible: bool,
        ) -> float:
            base_time = 0.0 if effective_start is None else max(0.0, float(curr_time) - float(effective_start))
            score = (
                problem.cost_weight * (float(total_dist) * float(vehicle.cost_per_km))
                + problem.time_weight * float(base_time)
                + float(soft_lateness) * float(late_multiplier)
                + float(capacity_excess) * float(capacity_multiplier)
                + float(sharing_excess) * float(sharing_multiplier)
                + float(premium_mismatch_count) * float(premium_multiplier)
            )
            if hard_infeasible:
                score += float(infeasible_penalty)
            return float(score)

        def finalize_score(
            total_dist: float,
            effective_start: float,
            curr_time: float,
            soft_lateness: float,
            capacity_excess: float,
            sharing_excess: float,
            premium_mismatch_count: float,
            hard_infeasible: bool,
        ) -> float:
            total_time = max(0.0, float(curr_time) - float(effective_start))
            total = (
                problem.cost_weight * (float(total_dist) * float(vehicle.cost_per_km))
                + problem.time_weight * float(total_time)
                + float(soft_lateness) * float(late_multiplier)
                + float(capacity_excess) * float(capacity_multiplier)
                + float(sharing_excess) * float(sharing_multiplier)
                + float(premium_mismatch_count) * float(premium_multiplier)
            )
            if hard_infeasible:
                total += float(infeasible_penalty)
            return float(total)

        def sharing_limit(emp: Employee) -> int:
            pref = str(getattr(emp, "sharing_pref", "") or "").strip().lower()
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

        def ordered_candidates(
            current_loc: object,
            picked_mask: int,
            dropped_mask: int,
        ) -> List[Tuple[str, Employee]]:
            options: List[Tuple[float, int, str, Employee]] = []
            for emp in subset_employees:
                bit = 1 << local_index[str(emp.id)]
                if not (picked_mask & bit):
                    dist = get_distance(current_loc, emp.pickup_loc)
                    options.append((float(dist), int(emp.earliest_pickup), "p", emp))
                elif not (dropped_mask & bit):
                    dist = get_distance(current_loc, emp.drop_loc)
                    options.append((float(dist), int(emp.latest_drop), "d", emp))
            options.sort(key=lambda row: (row[0], row[1], row[2], str(row[3].id)))
            return [(kind, emp) for _, _, kind, emp in options]

        def dfs(
            sequence: List[Dict[str, object]],
            picked_mask: int,
            dropped_mask: int,
            current_loc: object,
            curr_time: float,
            effective_start: Optional[float],
            total_dist: float,
            load: int,
            active_mask: int,
            soft_lateness: float,
            capacity_excess: float,
            sharing_excess: float,
            premium_mismatch_count: float,
            hard_infeasible: bool,
        ) -> None:
            nonlocal best_score, best_sequence, nodes_explored, route_nodes
            nodes_explored += 1
            route_nodes += 1

            lower_bound = current_lower_bound(
                total_dist=total_dist,
                effective_start=effective_start,
                curr_time=curr_time,
                soft_lateness=soft_lateness,
                capacity_excess=capacity_excess,
                sharing_excess=sharing_excess,
                premium_mismatch_count=premium_mismatch_count,
                hard_infeasible=hard_infeasible,
            )
            if lower_bound >= best_score - 1e-9:
                return

            if dropped_mask == (1 << len(subset_employees)) - 1:
                if effective_start is None:
                    return
                score = finalize_score(
                    total_dist=total_dist,
                    effective_start=float(effective_start),
                    curr_time=curr_time,
                    soft_lateness=soft_lateness,
                    capacity_excess=capacity_excess,
                    sharing_excess=sharing_excess,
                    premium_mismatch_count=premium_mismatch_count,
                    hard_infeasible=hard_infeasible,
                )
                if score + 1e-9 < best_score:
                    best_score = float(score)
                    best_sequence = copy.deepcopy(sequence)
                return

            for stop_type, emp in ordered_candidates(current_loc, picked_mask, dropped_mask):
                local_bit = 1 << local_index[str(emp.id)]
                target = emp.pickup_loc if stop_type == "p" else emp.drop_loc
                travel_dist = get_distance(current_loc, target)
                arrival = float(curr_time) + float(calculate_travel_time(travel_dist, vehicle.speed_kmph))
                if stop_type == "p" and sequence and load == 0:
                    arrival += TURNAROUND_BUFFER_MINUTES

                next_effective_start = effective_start
                next_picked_mask = picked_mask
                next_dropped_mask = dropped_mask
                next_load = load
                next_active_mask = active_mask
                next_soft_lateness = soft_lateness
                next_capacity_excess = capacity_excess
                next_sharing_excess = sharing_excess
                next_premium_mismatch_count = premium_mismatch_count
                next_hard_infeasible = hard_infeasible

                if stop_type == "p":
                    if next_effective_start is None:
                        target_arrival = float(emp.earliest_pickup)
                        travel_to_first = float(calculate_travel_time(travel_dist, vehicle.speed_kmph))
                        jit_start = float(target_arrival) - float(travel_to_first)
                        next_effective_start = max(float(vehicle.avail_from), float(jit_start))
                        arrival = float(next_effective_start) + float(travel_to_first)
                    if arrival < float(emp.earliest_pickup):
                        arrival = float(emp.earliest_pickup)
                    next_picked_mask |= local_bit
                    next_active_mask |= local_bit
                    next_load += 1

                    emp_pref = str(getattr(emp, "vehicle_pref", "") or "").strip().lower()
                    vehicle_cat = str(getattr(vehicle, "category", "") or "").strip().lower()
                    if (not allow_premium_mismatch) and emp_pref == "premium" and vehicle_cat != "premium":
                        next_premium_mismatch_count += 1.0
                        next_hard_infeasible = True
                else:
                    next_dropped_mask |= local_bit
                    next_active_mask &= ~local_bit
                    next_load = max(0, next_load - 1)

                    max_allowed_delay = float(get_max_allowed_delay(emp.priority, problem.metadata))
                    delay_minutes = max(0.0, float(arrival) - float(emp.latest_drop))
                    if delay_minutes > 0.0:
                        next_soft_lateness += min(delay_minutes, max_allowed_delay)
                    if delay_minutes > max_allowed_delay + 1e-9:
                        next_hard_infeasible = True

                if next_load > int(vehicle.capacity):
                    next_capacity_excess += float(next_load - int(vehicle.capacity))
                    next_hard_infeasible = True

                if not allow_sharing_violation and next_active_mask:
                    for other in subset_employees:
                        other_bit = 1 << local_index[str(other.id)]
                        if not (next_active_mask & other_bit):
                            continue
                        if next_load > sharing_limit(other):
                            next_sharing_excess += float(next_load - sharing_limit(other))
                            next_hard_infeasible = True

                sequence.append({"type": stop_type, "emp": emp})
                dfs(
                    sequence=sequence,
                    picked_mask=next_picked_mask,
                    dropped_mask=next_dropped_mask,
                    current_loc=target,
                    curr_time=float(arrival),
                    effective_start=next_effective_start,
                    total_dist=float(total_dist) + float(travel_dist),
                    load=next_load,
                    active_mask=next_active_mask,
                    soft_lateness=next_soft_lateness,
                    capacity_excess=next_capacity_excess,
                    sharing_excess=next_sharing_excess,
                    premium_mismatch_count=next_premium_mismatch_count,
                    hard_infeasible=next_hard_infeasible,
                )
                sequence.pop()

        dfs(
            sequence=[],
            picked_mask=0,
            dropped_mask=0,
            current_loc=vehicle.start_loc,
            curr_time=float(vehicle.avail_from),
            effective_start=None,
            total_dist=0.0,
            load=0,
            active_mask=0,
            soft_lateness=0.0,
            capacity_excess=0.0,
            sharing_excess=0.0,
            premium_mismatch_count=0.0,
            hard_infeasible=False,
        )

        route = Route(vehicle=vehicle, employees=[], stop_sequence=copy.deepcopy(best_sequence))
        GeneticOperators(problem)._sync_route_employees(route)
        single = Individual(routes=[route], unassigned=[])
        evaluate_individual_final(problem, single)
        route = single.routes[0]
        result = _RouteSolveResult(
            score=float(route.total_cost * problem.cost_weight + route.total_time * problem.time_weight + sum(float(v) for v in route.penalty_breakdown.values())),
            route=route,
            stats={"nodesExplored": int(nodes_explored)},
        )
        route_cache[key] = result
        return result

    unassigned_penalty_each = (
        PENALTY_UNASSIGNED
        * EXACT_SMALL_FINAL_PENALTY_FACTOR
        * (0.5 + 1.5 * EXACT_SMALL_FINAL_STRICTNESS)
    )

    @lru_cache(maxsize=None)
    def dp(vehicle_idx: int, remaining_mask: int) -> float:
        if vehicle_idx >= len(vehicles):
            return float(int(remaining_mask).bit_count()) * float(unassigned_penalty_each)

        best = float("inf")
        subset = int(remaining_mask)
        while True:
            route_result = route_for_subset(vehicle_idx, subset)
            candidate = float(route_result.score) + float(dp(vehicle_idx + 1, remaining_mask ^ subset))
            if candidate < best:
                best = float(candidate)
            if subset == 0:
                break
            subset = (subset - 1) & int(remaining_mask)
        return float(best)

    chosen_subsets: Dict[int, int] = {}

    def reconstruct(vehicle_idx: int, remaining_mask: int) -> None:
        if vehicle_idx >= len(vehicles):
            return
        best = dp(vehicle_idx, remaining_mask)
        subset = int(remaining_mask)
        while True:
            route_result = route_for_subset(vehicle_idx, subset)
            candidate = float(route_result.score) + float(dp(vehicle_idx + 1, remaining_mask ^ subset))
            if abs(candidate - best) <= 1e-6:
                chosen_subsets[vehicle_idx] = int(subset)
                reconstruct(vehicle_idx + 1, remaining_mask ^ subset)
                return
            if subset == 0:
                break
            subset = (subset - 1) & int(remaining_mask)
        chosen_subsets[vehicle_idx] = 0
        reconstruct(vehicle_idx + 1, remaining_mask)

    reconstruct(0, full_mask)

    routes: List[Route] = []
    assigned_mask = 0
    for vehicle_idx, vehicle in enumerate(vehicles):
        subset_mask = int(chosen_subsets.get(vehicle_idx, 0))
        assigned_mask |= subset_mask
        route_result = route_for_subset(vehicle_idx, subset_mask)
        route_copy = copy.deepcopy(route_result.route)
        route_copy.vehicle = vehicle
        routes.append(route_copy)

    unassigned = list(forced_unassigned_employees)
    for idx, emp in enumerate(assignable_employees):
        if not (assigned_mask & (1 << idx)):
            unassigned.append(emp)

    individual = Individual(routes=routes, unassigned=unassigned)
    evaluate_individual_final(problem, individual)
    individual.structural_hash = structural_hash(individual)
    individual.metadata.update(
        {
            "exactSmallMode": True,
            "globalOptimalityProven": True,
            "exactnessStatus": "globally_optimal",
            "boundScope": "global",
            "lowerBound": float(individual.objective_score),
            "proofModeEnabled": True,
            "stopReason": "exact_small_complete",
            "routePoolSizeConsidered": None,
            "unsafePruningEnabled": False,
            "exactSmallLimits": {
                "maxEmployees": int(limits.max_employees),
                "maxVehicles": int(limits.max_vehicles),
            },
            "exactSmallStats": {
                "routeSubsetCalls": int(route_calls),
                "routeNodesExplored": int(route_nodes),
                "vehicleDpStates": int(dp.cache_info().currsize),
                "forcedUnassigned": int(len(forced_unassigned_employees)),
                "solveDurationSec": float(max(0.0, time.time() - started_at)),
            },
        }
    )

    return ExactSmallResult(
        status="optimal",
        individual=individual,
        message="globally optimal within exact-small supported scope",
        stats=dict(individual.metadata.get("exactSmallStats", {}) or {}),
        limits=limits,
    )
