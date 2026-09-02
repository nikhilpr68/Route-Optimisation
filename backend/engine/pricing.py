from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from bcp_foundation import reduced_cost
from models import Employee, ProblemInstance, Vehicle, get_max_allowed_delay
from representation import Route
from route_pool import PooledRoute, RoutePoolManager
from utils import TURNAROUND_BUFFER_MINUTES, calculate_travel_time, get_distance


def _is_truthy(raw) -> bool:
    if isinstance(raw, bool):
        return bool(raw)
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


@dataclass
class PricingStats:
    mode: str
    vehicle_id: str
    candidate_employees: int
    expanded_labels: int = 0
    dominance_pruned: int = 0
    completed_routes: int = 0
    evaluated_routes: int = 0
    negative_reduced_cost_found: int = 0
    best_reduced_cost: Optional[float] = None
    runtime_sec: float = 0.0
    fallback_reason: Optional[str] = None


@dataclass(frozen=True)
class PricingResult:
    routes: List[PooledRoute]
    stats: PricingStats


def _sharing_limit(pref: str) -> int:
    text = str(pref or "").strip().lower()
    if text in ("single", "1"):
        return 1
    if text in ("double", "2"):
        return 2
    if text in ("triple", "3"):
        return 3
    try:
        return max(1, int(text))
    except Exception:
        return 2


def _premium_mismatch_disallowed(problem: ProblemInstance) -> bool:
    meta = getattr(problem, "metadata", {}) or {}
    # The engine uses allowPremiumMismatch metadata in some payloads; preserve both.
    if _is_truthy(meta.get("ALLOW_PREMIUM_MISMATCH", False)) or _is_truthy(meta.get("allowPremiumMismatch", False)):
        return False
    return True


def _sharing_violation_disallowed(problem: ProblemInstance) -> bool:
    meta = getattr(problem, "metadata", {}) or {}
    if _is_truthy(meta.get("ALLOW_SHARING_VIOLATION", False)) or _is_truthy(meta.get("allowSharingViolation", False)):
        return False
    return True


def _employee_by_id(problem: ProblemInstance) -> Dict[str, Employee]:
    return {str(e.id): e for e in (getattr(problem, "employees", []) or [])}


def _vehicle_by_id(problem: ProblemInstance) -> Dict[str, Vehicle]:
    return {str(v.id): v for v in (getattr(problem, "vehicles", []) or [])}


def _build_route_from_sequence(vehicle: Vehicle, sequence: List[Tuple[str, Employee]]) -> Route:
    stop_sequence = [{"type": t, "emp": emp} for t, emp in sequence]
    return Route(vehicle=vehicle, employees=[], stop_sequence=stop_sequence)


def _dominates(a: Tuple[float, float], b: Tuple[float, float], eps: float = 1e-9) -> bool:
    # a dominates b if time<= and dist<= and at least one strict.
    at, ad = a
    bt, bd = b
    if at <= bt + eps and ad <= bd + eps:
        return (at < bt - eps) or (ad < bd - eps)
    return False


def _prune_pareto_front(front: List[Tuple[float, float]], cand: Tuple[float, float]) -> Tuple[bool, int]:
    """
    Maintain a Pareto front over (time, dist). Returns (kept, pruned_count).
    """
    pruned = 0
    for existing in front:
        if _dominates(existing, cand):
            return False, 0
    new_front = []
    for existing in front:
        if _dominates(cand, existing):
            pruned += 1
            continue
        new_front.append(existing)
    new_front.append(cand)
    front[:] = new_front
    return True, pruned


def _simulate_next_stop(
    problem: ProblemInstance,
    vehicle: Vehicle,
    *,
    curr_loc,
    curr_time: float,
    load: int,
    active: List[Employee],
    picked: set,
    stop_type: str,
    emp: Employee,
    stop_index: int,
) -> Optional[Tuple[object, float, int, List[Employee], set]]:
    """
    Partial feasibility simulation matching the engine's hard constraints:
    - precedence
    - capacity
    - max delay beyond latest_drop (hard)
    - sharing and premium mismatch are treated as hard when engine disallows them
      (consistent with enforce_hard/strictness=1 route-pool evaluation).
    """
    if stop_type not in ("p", "d"):
        return None
    if stop_type == "d" and str(emp.id) not in picked:
        return None

    target = emp.pickup_loc if stop_type == "p" else emp.drop_loc
    d = get_distance(curr_loc, target)
    curr_time = float(curr_time) + calculate_travel_time(float(d), float(vehicle.speed_kmph))

    if load == 0 and stop_type == "p" and stop_index > 0:
        curr_time += float(TURNAROUND_BUFFER_MINUTES)

    if stop_type == "p":
        curr_time = max(curr_time, float(emp.earliest_pickup))
        # Premium mismatch becomes hard infeasible in pool evaluation when disallowed.
        if _premium_mismatch_disallowed(problem):
            e_pref = str(emp.vehicle_pref or "").strip().lower()
            v_cat = str(vehicle.category or "").strip().lower()
            if e_pref == "premium" and v_cat != "premium":
                return None
        load += 1
        if load > int(vehicle.capacity):
            return None
        picked_next = set(picked)
        picked_next.add(str(emp.id))
        active_next = list(active) + [emp]
        # Sharing becomes hard infeasible when disallowed (pool enforce_hard).
        if _sharing_violation_disallowed(problem):
            for p in active_next:
                if load > _sharing_limit(getattr(p, "sharing_pref", "")):
                    return None
        return target, float(curr_time), int(load), active_next, picked_next

    # drop
    max_delay = float(get_max_allowed_delay(emp.priority, getattr(problem, "metadata", {}) or {}))
    delay = max(0.0, float(curr_time) - float(emp.latest_drop))
    if delay > max_delay + 1e-9:
        return None
    load = max(0, int(load) - 1)
    active_next = [p for p in active if str(p.id) != str(emp.id)]
    if _sharing_violation_disallowed(problem):
        for p in active_next:
            if load > _sharing_limit(getattr(p, "sharing_pref", "")):
                return None
    return target, float(curr_time), int(load), active_next, set(picked)


def price_vehicle_exact_small(
    problem: ProblemInstance,
    *,
    vehicle: Vehicle,
    candidate_employee_ids: Sequence[str],
    employee_duals: Dict[str, float],
    vehicle_duals: Dict[str, float],
    cut_duals: Optional[Dict[str, float]] = None,
    cuts: Optional[Sequence[object]] = None,
    pool_manager: RoutePoolManager,
    run_id: int,
    iteration: int,
    max_candidates: int = 8,
    max_columns: int = 6,
    min_reduced_cost: float = -1e-6,
    time_limit_sec: float = 0.6,
    dominance_enabled: bool = True,
) -> PricingResult:
    """
    Exact pricing for a *restricted scope* via complete enumeration with safe
    dominance pruning on (time, distance) for partial states.

    Exactness scope:
    - only over the provided `candidate_employee_ids` (capped by `max_candidates`)
    - only for a single vehicle
    - does not guarantee finding globally best reduced-cost columns if the best
      route involves employees outside the candidate set
    """
    start = time.perf_counter()
    stats = PricingStats(
        mode="exact_enumeration_pricing_small",
        vehicle_id=str(vehicle.id),
        candidate_employees=int(len(candidate_employee_ids or [])),
    )

    cand = [str(eid) for eid in candidate_employee_ids if str(eid).strip()]
    cand = list(dict.fromkeys(cand))
    if len(cand) > int(max_candidates):
        stats.fallback_reason = "too_many_candidates"
        stats.runtime_sec = float(time.perf_counter() - start)
        return PricingResult(routes=[], stats=stats)

    emp_map = _employee_by_id(problem)
    employees: List[Employee] = []
    for eid in cand:
        if eid in emp_map:
            employees.append(emp_map[eid])
    if not employees:
        stats.fallback_reason = "no_candidate_employees"
        stats.runtime_sec = float(time.perf_counter() - start)
        return PricingResult(routes=[], stats=stats)

    E = len(employees)
    id_by_idx = [str(e.id) for e in employees]

    # State: (picked_mask, dropped_mask, last_node) where last_node indexes:
    # 0 = start, 1..E pickups, E+1..2E drops.
    # Label data: (curr_time, total_dist, curr_loc, load, active_list, picked_set, seq)
    initial_time = float(vehicle.avail_from)
    initial_loc = vehicle.start_loc
    initial = (0, 0, 0, initial_time, 0.0, initial_loc, 0, [], set(), [])  # type: ignore

    fronts: Dict[Tuple[int, int, int], List[Tuple[float, float]]] = {}
    stack: List[Tuple] = [initial]
    completed_sequences: List[List[Tuple[str, Employee]]] = []

    while stack:
        if time.perf_counter() - start > float(time_limit_sec):
            stats.fallback_reason = "time_limit"
            break

        picked_mask, dropped_mask, last_node, curr_time, dist, curr_loc, load, active, picked_set, seq = stack.pop()
        stats.expanded_labels += 1

        if dominance_enabled:
            key = (int(picked_mask), int(dropped_mask), int(last_node))
            front = fronts.setdefault(key, [])
            kept, pruned = _prune_pareto_front(front, (float(curr_time), float(dist)))
            stats.dominance_pruned += int(pruned)
            if not kept:
                continue

        # Completion: any non-empty served set with no onboard passengers.
        if picked_mask != 0 and picked_mask == dropped_mask and load == 0:
            completed_sequences.append(list(seq))
            stats.completed_routes += 1
            continue

        # Expand: pickups and drops.
        for idx, emp in enumerate(employees):
            bit = 1 << idx
            emp_id = id_by_idx[idx]

            # Pickup if not picked yet.
            if (picked_mask & bit) == 0:
                nxt = _simulate_next_stop(
                    problem,
                    vehicle,
                    curr_loc=curr_loc,
                    curr_time=curr_time,
                    load=load,
                    active=active,
                    picked=picked_set,
                    stop_type="p",
                    emp=emp,
                    stop_index=len(seq),
                )
                if nxt is None:
                    continue
                nloc, ntime, nload, nactive, npicked = nxt
                ndist = float(dist) + float(get_distance(curr_loc, emp.pickup_loc))
                stack.append(
                    (
                        picked_mask | bit,
                        dropped_mask,
                        1 + idx,
                        float(ntime),
                        float(ndist),
                        nloc,
                        int(nload),
                        nactive,
                        npicked,
                        seq + [("p", emp)],
                    )
                )

            # Drop if picked and not dropped.
            if (picked_mask & bit) != 0 and (dropped_mask & bit) == 0:
                if emp_id not in picked_set:
                    continue
                nxt = _simulate_next_stop(
                    problem,
                    vehicle,
                    curr_loc=curr_loc,
                    curr_time=curr_time,
                    load=load,
                    active=active,
                    picked=picked_set,
                    stop_type="d",
                    emp=emp,
                    stop_index=len(seq),
                )
                if nxt is None:
                    continue
                nloc, ntime, nload, nactive, npicked = nxt
                ndist = float(dist) + float(get_distance(curr_loc, emp.drop_loc))
                stack.append(
                    (
                        picked_mask,
                        dropped_mask | bit,
                        1 + E + idx,
                        float(ntime),
                        float(ndist),
                        nloc,
                        int(nload),
                        nactive,
                        npicked,
                        seq + [("d", emp)],
                    )
                )

    # Evaluate completed sequences exactly via the pool's evaluator.
    pooled: List[PooledRoute] = []
    for seq in completed_sequences:
        if len(pooled) >= int(max_columns) and time.perf_counter() - start > float(time_limit_sec):
            break
        route = _build_route_from_sequence(vehicle, seq)
        pooled_route = pool_manager.canonicalize_route(
            route,
            source=f"pricing_exact_iter_{int(iteration) + 1}",
            run_id=int(run_id),
            generation=int(iteration),
        )
        stats.evaluated_routes += 1
        if pooled_route is None:
            continue
        if not pooled_route.passenger_set:
            continue
        if not bool(pooled_route.is_feasible):
            continue
        rc = reduced_cost(
            pooled_route,
            employee_duals=employee_duals,
            vehicle_duals=vehicle_duals,
            cut_duals=(cut_duals or {}),
            cuts=cuts,
        )
        stats.best_reduced_cost = rc if stats.best_reduced_cost is None else float(min(stats.best_reduced_cost, rc))
        if float(rc) < float(min_reduced_cost):
            pooled.append(pooled_route)

    pooled.sort(
        key=lambda r: reduced_cost(
            r,
            employee_duals=employee_duals,
            vehicle_duals=vehicle_duals,
            cut_duals=(cut_duals or {}),
            cuts=cuts,
        )
    )
    if len(pooled) > int(max_columns):
        pooled = pooled[: int(max_columns)]
    stats.negative_reduced_cost_found = int(len(pooled))
    stats.runtime_sec = float(time.perf_counter() - start)
    return PricingResult(routes=pooled, stats=stats)
