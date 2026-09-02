from __future__ import annotations

import copy
import math
import random
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from exact_lns import ExactLnsConfig, ExactLnsSignals, run_exact_lns_attempt
from models import Employee, ProblemInstance
from objective import ObjectiveEvaluator
from operators import GeneticOperators
from representation import Individual, Route
from route_pool import build_route_pool
from set_partition import solve_set_partition
from solution_objective import get_solution_base_objective
from solution_status import is_solution_feasible
from utils import haversine_km


@dataclass(frozen=True)
class DecompositionConfig:
    enabled: bool
    auto_enabled: bool
    employee_threshold: int
    unique_locations_threshold: int
    spread_km_threshold: float
    max_clusters: int
    min_cluster_size: int
    cluster_time_weight: float
    cluster_geo_weight: float
    cluster_solve_ratio: float
    merge_ratio: float
    improve_ratio: float


def default_config(metadata: Dict[str, Any]) -> DecompositionConfig:
    def _b(key: str, default: bool) -> bool:
        raw = (metadata or {}).get(key)
        if raw is None:
            return bool(default)
        if isinstance(raw, bool):
            return raw
        return str(raw).strip().lower() in ("1", "true", "yes", "on")

    def _i(key: str, default: int, lo: int, hi: int) -> int:
        raw = (metadata or {}).get(key)
        if raw is None:
            return int(default)
        try:
            v = int(float(raw))
        except Exception:
            return int(default)
        return max(lo, min(hi, v))

    def _f(key: str, default: float, lo: float, hi: float) -> float:
        raw = (metadata or {}).get(key)
        if raw is None:
            return float(default)
        try:
            v = float(raw)
        except Exception:
            return float(default)
        return max(lo, min(hi, v))

    return DecompositionConfig(
        enabled=_b("DECOMPOSITION_ENABLED", False),
        # Auto mode is conservative: only triggers for genuinely large cases.
        auto_enabled=_b("DECOMPOSITION_AUTO_ENABLED", True),
        employee_threshold=_i("DECOMPOSITION_EMPLOYEE_THRESHOLD", 200, 40, 10_000),
        unique_locations_threshold=_i("DECOMPOSITION_UNIQUE_LOCATIONS_THRESHOLD", 380, 50, 50_000),
        spread_km_threshold=_f("DECOMPOSITION_SPREAD_KM_THRESHOLD", 12.0, 0.0, 10_000.0),
        max_clusters=_i("DECOMPOSITION_MAX_CLUSTERS", 8, 2, 30),
        min_cluster_size=_i("DECOMPOSITION_MIN_CLUSTER_SIZE", 12, 2, 10_000),
        cluster_time_weight=_f("DECOMPOSITION_CLUSTER_TIME_WEIGHT", 0.25, 0.0, 10.0),
        cluster_geo_weight=_f("DECOMPOSITION_CLUSTER_GEO_WEIGHT", 1.0, 0.0, 10.0),
        # Budget split (must sum <= 1.0; remainder is slack).
        cluster_solve_ratio=_f("DECOMPOSITION_CLUSTER_SOLVE_RATIO", 0.62, 0.1, 0.95),
        merge_ratio=_f("DECOMPOSITION_MERGE_RATIO", 0.25, 0.05, 0.9),
        improve_ratio=_f("DECOMPOSITION_IMPROVE_RATIO", 0.10, 0.0, 0.5),
    )


def _unique_locations(problem: ProblemInstance) -> int:
    seen = set()
    for emp in getattr(problem, "employees", []) or []:
        for loc in (getattr(emp, "pickup_loc", None), getattr(emp, "drop_loc", None)):
            if loc is None:
                continue
            try:
                seen.add((round(float(loc.lat), 6), round(float(loc.lng), 6)))
            except Exception:
                continue
    for veh in getattr(problem, "vehicles", []) or []:
        loc = getattr(veh, "start_loc", None)
        if loc is None:
            continue
        try:
            seen.add((round(float(loc.lat), 6), round(float(loc.lng), 6)))
        except Exception:
            continue
    return int(len(seen))


def _spread_km(problem: ProblemInstance) -> float:
    lats = []
    lngs = []
    for emp in getattr(problem, "employees", []) or []:
        loc = getattr(emp, "pickup_loc", None)
        if loc is None:
            continue
        try:
            lats.append(float(loc.lat))
            lngs.append(float(loc.lng))
        except Exception:
            continue
    if not lats or not lngs:
        return 0.0
    min_lat, max_lat = min(lats), max(lats)
    min_lng, max_lng = min(lngs), max(lngs)
    try:
        corner1 = type("Loc", (), {"lat": min_lat, "lng": min_lng})()
        corner2 = type("Loc", (), {"lat": max_lat, "lng": max_lng})()
        return float(haversine_km(corner1, corner2))
    except Exception:
        return 0.0


def should_activate(problem: ProblemInstance, metadata: Dict[str, Any]) -> Tuple[bool, Dict[str, Any]]:
    cfg = default_config(metadata)
    employees = getattr(problem, "employees", []) or []
    emp_count = int(len(employees))
    uniq = _unique_locations(problem)
    spread = _spread_km(problem)
    forced = cfg.enabled
    disabled = str((metadata or {}).get("DECOMPOSITION_ENABLED", "")).strip().lower() in ("0", "false", "no", "off")

    features = {
        "employeeCount": emp_count,
        "uniqueLocations": int(uniq),
        "spreadKm": float(spread),
        "thresholds": {
            "employee": int(cfg.employee_threshold),
            "uniqueLocations": int(cfg.unique_locations_threshold),
            "spreadKm": float(cfg.spread_km_threshold),
        },
    }

    if disabled:
        return False, {"enabled": False, "reason": "explicit_disabled", **features}
    if forced:
        return True, {"enabled": True, "reason": "explicit_enabled", **features}
    if not cfg.auto_enabled:
        return False, {"enabled": False, "reason": "auto_disabled", **features}

    large_by_emp = emp_count >= int(cfg.employee_threshold)
    large_by_loc = uniq >= int(cfg.unique_locations_threshold)
    large_by_spread = spread >= float(cfg.spread_km_threshold)
    if (large_by_emp and large_by_spread) or (large_by_loc and large_by_spread):
        return True, {"enabled": True, "reason": "auto_large", **features}
    return False, {"enabled": False, "reason": "below_thresholds", **features}


def _k_for_employees(emp_count: int, max_clusters: int) -> int:
    # Conservative: k grows slowly; avoids many tiny clusters.
    if emp_count <= 0:
        return 0
    k = int(round(max(2.0, min(float(max_clusters), math.sqrt(emp_count) / 2.0))))
    return max(2, min(int(max_clusters), k))


def cluster_employee_ids(
    problem: ProblemInstance,
    *,
    seed: int,
    max_clusters: int,
    min_cluster_size: int,
    geo_weight: float,
    time_weight: float,
) -> Tuple[List[List[str]], Dict[str, Any]]:
    employees: List[Employee] = list(getattr(problem, "employees", []) or [])
    if not employees:
        return [], {"k": 0, "reason": "no_employees"}

    rng = random.Random(int(seed))
    k = _k_for_employees(len(employees), int(max_clusters))
    if k <= 1:
        return [sorted(str(e.id) for e in employees)], {"k": 1, "reason": "single_cluster"}

    # Feature: pickup lat/lng and time-window center (latest_drop midpoint).
    rows = []
    for emp in employees:
        try:
            lat = float(emp.pickup_loc.lat)
            lng = float(emp.pickup_loc.lng)
            t_center = 0.5 * (float(emp.earliest_pickup) + float(emp.latest_drop))
        except Exception:
            lat, lng, t_center = 0.0, 0.0, 0.0
        rows.append((str(emp.id), lat, lng, t_center))

    # Initialize centers from quantiles of sorted by (lat,lng,t).
    ordered = sorted(rows, key=lambda r: (r[1], r[2], r[3], r[0]))
    centers = []
    for i in range(k):
        idx = int(round((i + 0.5) * (len(ordered) / k)))
        idx = max(0, min(len(ordered) - 1, idx))
        _, lat, lng, t = ordered[idx]
        # small jitter to avoid zero-variance traps (deterministic)
        lat += (rng.random() - 0.5) * 1e-6
        lng += (rng.random() - 0.5) * 1e-6
        t += (rng.random() - 0.5) * 1e-3
        centers.append([lat, lng, t])

    def dist2(r, c):
        _, lat, lng, t = r
        d_geo = (lat - c[0]) ** 2 + (lng - c[1]) ** 2
        d_time = (t - c[2]) ** 2
        return float(geo_weight) * d_geo + float(time_weight) * d_time

    assignments = [0] * len(rows)
    for _ in range(6):
        # assign
        for i, r in enumerate(rows):
            best = min(range(k), key=lambda j: dist2(r, centers[j]))
            assignments[i] = best
        # update centers
        counts = [0] * k
        sums = [[0.0, 0.0, 0.0] for _ in range(k)]
        for r, a in zip(rows, assignments):
            _, lat, lng, t = r
            sums[a][0] += lat
            sums[a][1] += lng
            sums[a][2] += t
            counts[a] += 1
        for j in range(k):
            if counts[j] <= 0:
                continue
            centers[j][0] = sums[j][0] / counts[j]
            centers[j][1] = sums[j][1] / counts[j]
            centers[j][2] = sums[j][2] / counts[j]

    clusters: List[List[str]] = [[] for _ in range(k)]
    for (emp_id, _, _, _), a in zip(rows, assignments):
        clusters[int(a)].append(str(emp_id))

    clusters = [sorted(c) for c in clusters if c]
    clusters.sort(key=lambda c: (-len(c), c[0]))

    # Merge tiny clusters into nearest large cluster.
    if min_cluster_size > 1 and len(clusters) > 1:
        big = [c for c in clusters if len(c) >= int(min_cluster_size)]
        small = [c for c in clusters if len(c) < int(min_cluster_size)]
        if not big:
            big = [clusters[0]]
            small = clusters[1:]
        if small:
            # Precompute centroid for big clusters in raw space.
            emp_by_id = {str(e.id): e for e in employees}

            def centroid(ids):
                lats, lngs, ts = [], [], []
                for eid in ids:
                    e = emp_by_id.get(str(eid))
                    if e is None:
                        continue
                    lats.append(float(e.pickup_loc.lat))
                    lngs.append(float(e.pickup_loc.lng))
                    ts.append(0.5 * (float(e.earliest_pickup) + float(e.latest_drop)))
                return (sum(lats) / max(1, len(lats)), sum(lngs) / max(1, len(lngs)), sum(ts) / max(1, len(ts)))

            big_centroids = [centroid(c) for c in big]

            def cdist2(ca, cb):
                return float(geo_weight) * ((ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2) + float(time_weight) * (
                    (ca[2] - cb[2]) ** 2
                )

            for s in small:
                cs = centroid(s)
                j = min(range(len(big)), key=lambda idx: cdist2(cs, big_centroids[idx]))
                big[j].extend(s)
                big[j] = sorted(set(big[j]))
                big_centroids[j] = centroid(big[j])
            clusters = big

    clusters.sort(key=lambda c: (-len(c), c[0]))
    meta = {
        "k": int(len(clusters)),
        "sizes": [int(len(c)) for c in clusters],
        "minClusterSize": int(min_cluster_size),
    }
    return clusters, meta


def _empty_individual(problem: ProblemInstance) -> Individual:
    routes = [Route(vehicle=v, employees=[], stop_sequence=[]) for v in (problem.vehicles or [])]
    return Individual(routes=routes, unassigned=list(problem.employees or []))


def _lift_cluster_solution(full_problem: ProblemInstance, cluster_solution: Individual) -> Individual:
    emp_by_id = {str(e.id): e for e in (full_problem.employees or [])}
    veh_by_id = {str(v.id): v for v in (full_problem.vehicles or [])}
    routes_by_vid = {str(r.vehicle.id): r for r in (cluster_solution.routes or [])}
    lifted_routes: List[Route] = []
    for vid, vehicle in veh_by_id.items():
        src = routes_by_vid.get(vid)
        if src is None:
            lifted_routes.append(Route(vehicle=vehicle, employees=[], stop_sequence=[]))
            continue
        # Normalize employees to full_problem objects.
        employees = []
        for e in (src.employees or []):
            eid = str(getattr(e, "id", ""))
            if eid in emp_by_id:
                employees.append(emp_by_id[eid])
        stop_sequence = []
        for stop in (src.stop_sequence or []):
            if not isinstance(stop, dict):
                continue
            typ = stop.get("type")
            emp = stop.get("emp")
            if typ not in ("p", "d") or emp is None:
                continue
            eid = str(getattr(emp, "id", ""))
            if eid in emp_by_id:
                stop_sequence.append({"type": typ, "emp": emp_by_id[eid]})
        lifted_routes.append(Route(vehicle=vehicle, employees=employees, stop_sequence=stop_sequence))
    return Individual(routes=lifted_routes, unassigned=[])


def solve_with_decomposition(
    *,
    problem: ProblemInstance,
    run_id: int,
    seed: int,
    time_limit_sec: float,
    pop_size: int,
    generations: int,
    alns_iterations: int,
    route_pool_pruning_mode: str,
) -> Tuple[Individual, Dict[str, Any]]:
    """Heuristic decomposition for large instances.

    This is *not* an exact method. It clusters employees, solves each cluster as
    a subproblem (reusing the existing solver), then merges via set partition on
    the union of routes and runs a small global repair/improvement pass.
    """
    meta = dict(getattr(problem, "metadata", {}) or {})
    cfg = default_config(meta)
    clusters, cluster_meta = cluster_employee_ids(
        problem,
        seed=int(seed),
        max_clusters=int(cfg.max_clusters),
        min_cluster_size=int(cfg.min_cluster_size),
        geo_weight=float(cfg.cluster_geo_weight),
        time_weight=float(cfg.cluster_time_weight),
    )

    start = time.perf_counter()
    cluster_budget_total = max(0.1, float(time_limit_sec) * float(cfg.cluster_solve_ratio))
    merge_budget = max(0.05, float(time_limit_sec) * float(cfg.merge_ratio))
    improve_budget = max(0.0, float(time_limit_sec) * float(cfg.improve_ratio))
    slack = max(0.0, float(time_limit_sec) - (cluster_budget_total + merge_budget + improve_budget))

    cluster_time_each = max(0.10, cluster_budget_total / max(1, len(clusters)))
    cluster_summaries: List[Dict[str, Any]] = []
    lifted_individuals: List[Individual] = []

    from solver import GeneticSolver

    for idx, emp_ids in enumerate(clusters):
        cluster_start = time.perf_counter()
        sub_meta = dict(meta)
        sub_meta["TIME_LIMIT_SEC"] = float(min(cluster_time_each, max(0.2, float(time_limit_sec) - (time.perf_counter() - start))))
        sub_problem = ProblemInstance(
            employees=[e for e in problem.employees if str(e.id) in set(emp_ids)],
            vehicles=list(problem.vehicles),
            metadata=sub_meta,
            baseline={k: v for k, v in (getattr(problem, "baseline", {}) or {}).items() if str(k) in set(emp_ids)},
        )
        solver = GeneticSolver(
            sub_problem,
            pop_size=max(8, int(round(pop_size * 0.65))),
            generations=max(8, int(round(generations * 0.65))),
            alns_iterations=max(0, int(round(alns_iterations * 0.5))),
            strategy_config={"name": f"DecompCluster{idx+1}", "regret": 0.55, "grasp": 0.25, "random": 0.20},
            seed=int(seed) + 50_003 * (idx + 1),
        )
        sol, run_meta = solver.solve(run_id=idx + 1)
        cluster_runtime = float(time.perf_counter() - cluster_start)
        lifted = _lift_cluster_solution(problem, sol)
        lifted_individuals.append(lifted)
        cluster_summaries.append(
            {
                "cluster": int(idx + 1),
                "employeeCount": int(len(emp_ids)),
                "timeLimitSec": float(sub_meta["TIME_LIMIT_SEC"]),
                "runtimeSec": float(cluster_runtime),
                "objective": float(get_solution_base_objective(sol)),
                "feasible": bool(is_solution_feasible(sol)),
                "stopReason": str((run_meta or {}).get("stopReason", "")),
            }
        )

    evaluator = ObjectiveEvaluator(problem)
    merge_start = time.perf_counter()
    pool_routes, pool_stats = build_route_pool(
        problem=problem,
        individuals=lifted_individuals,
        archives=[],
        max_routes=int(meta.get("DECOMPOSITION_POOL_MAX_ROUTES", 900) or 900),
        evaluator=evaluator,
        pruning_mode=str(route_pool_pruning_mode or "heuristic"),
    )

    merge_result = solve_set_partition(
        problem,
        pool_routes,
        time_limit_sec=float(merge_budget + slack),
        allow_relaxed_fallback=False,
        evaluator=evaluator,
    )
    merge_runtime = float(time.perf_counter() - merge_start)

    candidate = merge_result.individual if merge_result.individual is not None else _empty_individual(problem)
    # Global strict repair pass to avoid losing coverage.
    ops = GeneticOperators(problem, rng=random.Random(int(seed)))
    candidate = ops.force_reassign_unassigned(candidate, max_passes=3, strictness=1.0)
    evaluator.evaluate(candidate, penalty_factor=15.0, phase_progress=1.0, enforce_hard=True)

    exact_lns_payload = None
    if improve_budget > 0.05 and bool(meta.get("EXACT_LNS_ENABLED", False) or str(meta.get("EXACT_LNS_ENABLED", "")).strip().lower() in ("1","true","yes","on")):
        # One best-effort exact dive, guided by cluster-local signals if available.
        lns_cfg = ExactLnsConfig(
            enabled=True,
            attempts=1,
            strategy=str(meta.get("DECOMPOSITION_EXACT_LNS_STRATEGY", "auto")),
            fragment_routes=int(meta.get("DECOMPOSITION_EXACT_LNS_FRAGMENT_ROUTES", 2) or 2),
            max_fragment_employees=int(meta.get("DECOMPOSITION_EXACT_LNS_MAX_FRAGMENT_EMPLOYEES", 18) or 18),
            include_unassigned=True,
            seed_population=int(meta.get("DECOMPOSITION_EXACT_LNS_SEED_POPULATION", 8) or 8),
            pool_max_routes=int(meta.get("DECOMPOSITION_EXACT_LNS_POOL_MAX_ROUTES", 200) or 200),
            pool_pruning_mode=str(route_pool_pruning_mode or "heuristic"),
            time_limit_sec=float(min(3.0, improve_budget)),
        )
        signals = ExactLnsSignals(employee_scores={}, employee_instability={}, source="decomposition")
        attempt = run_exact_lns_attempt(
            problem=problem,
            incumbent=candidate,
            config=lns_cfg,
            rng=random.Random(int(seed) + 999),
            time_budget_sec=float(min(3.0, improve_budget)),
            signals=signals,
        )
        exact_lns_payload = {
            "status": str(attempt.status),
            "accepted": bool(attempt.accepted),
            "gain": float(attempt.incumbent_base_objective - attempt.improved_base_objective),
            "solveTimeSec": float(attempt.solve_time_sec),
            "fragmentEmployeeCount": int(len(attempt.fragment_employee_ids)),
            "fragmentVehicleCount": int(len(attempt.fragment_vehicle_ids)),
            "fragment": dict((attempt.pool_stats or {}).get("fragment") or {}),
        }
        if attempt.accepted and attempt.candidate is not None:
            candidate = attempt.candidate
            evaluator.evaluate(candidate, penalty_factor=15.0, phase_progress=1.0, enforce_hard=True)

    decomposition_meta = {
        "enabled": True,
        "clusters": cluster_meta,
        "clusterRuns": cluster_summaries,
        "budgets": {
            "timeLimitSec": float(time_limit_sec),
            "clusterSolveTotalSec": float(cluster_budget_total),
            "mergeSec": float(merge_budget + slack),
            "improveSec": float(improve_budget),
        },
        "runtimeSec": float(time.perf_counter() - start),
        "merge": {
            "status": str(merge_result.status),
            "backend": str(merge_result.backend),
            "runtimeSec": float(merge_runtime),
            "poolStats": dict(pool_stats or {}),
            "setPartitionStats": dict(merge_result.metadata or {}),
        },
        "postMergeFeasible": bool(is_solution_feasible(candidate)),
        "exactDive": exact_lns_payload,
    }
    candidate.metadata = dict(getattr(candidate, "metadata", {}) or {})
    candidate.metadata["decomposition"] = decomposition_meta
    candidate.metadata["decompositionMode"] = "spatiotemporal_clusters"
    return candidate, decomposition_meta
