import concurrent.futures
import multiprocessing
import os
import sys
import json
import argparse
import math
import time
from contextlib import contextmanager

from diversity import structural_hash
from exact_small import ExactSmallLimits, solve_exact_small
from budget_recalibration import (
    is_budget_recalibration_enabled,
    physical_cores,
    recommend_budget,
)
from models import get_max_allowed_delay
from parser import FileParser, JsonParser
from run_progress import SharedRunProgressTracker
from lower_bound import compute_gap, compute_lower_bound
from solution_objective import get_solution_base_objective, get_solution_search_objective
from solution_status import assignment_status, classify_solution_status, is_solution_feasible, is_solution_fully_assigned
from solver import GeneticSolver
from decomposition import should_activate as decomposition_should_activate, solve_with_decomposition
from utils import (
    TURNAROUND_BUFFER_MINUTES,
    calculate_travel_time,
    configure_distance_metric,
    ensure_distance_backend_ready,
    get_distance,
    get_distance_mode,
    precompute_distance_matrix,
)

STRATEGIES = [
    {'name': 'Logic', 'regret': 0.8, 'grasp': 0.1, 'random': 0.1},
    {'name': 'Chaos', 'regret': 0.0, 'grasp': 0.1, 'random': 0.9},
    {'name': 'Sniper', 'regret': 0.1, 'grasp': 0.9, 'random': 0.0},
    {'name': 'Explore', 'regret': 0.0, 'grasp': 0.8, 'random': 0.2},
    {'name': 'Balance', 'regret': 0.1, 'grasp': 0.5, 'random': 0.4},
    {'name': 'Hybrid', 'regret': 0.4, 'grasp': 0.0, 'random': 0.6},
    {'name': 'Spec-A', 'regret': 0.2, 'grasp': 0.6, 'random': 0.2},
    {'name': 'Spec-B', 'regret': 0.0, 'grasp': 1.0, 'random': 0.0},
]

NUM_PARALLEL_RUNS = 8
MAX_WORKERS = None
INTENSITY_CONFIG = {
    'low': {'runs_mul': 0.7, 'pop_mul': 0.4, 'gen_mul': 0.40, 'alns_mul': 0.78, 'generation_scale': 1},
    'medium': {'runs_mul': 1.00, 'pop_mul': 1.00, 'gen_mul': 1, 'alns_mul': 1.00, 'generation_scale': 1.00},
    'high': {'runs_mul': 1.00, 'pop_mul': 1.00, 'gen_mul': 1.00, 'alns_mul': 1.00, 'generation_scale': 1.00},
}
FIXED_GENERATIONS_BY_INTENSITY = {
    'low': 30,
    'medium': 60,
    'high': 135,
}
FIXED_TIME_LIMIT_SEC_BY_INTENSITY = {
    'low': 40.0,
    'medium': 110.0,
    'high': 160.0,
}
FIXED_RUNS_BY_INTENSITY = {
    'low': 7,
    'medium': 7,
    'high': 7,
}
LOW_CONVERGENCE_DEFAULTS = {
    "CHECKPOINT_EVERY_SEC": 5.0,
    "EPS_REL": 0.0,
    "STALL_CHECKPOINTS": 4,
    "DIVERSITY_MIN": 0.04,
    "BURST_SEC": 5.5,
    "STAGNATION_GRACE_GENERATIONS": 10,
    "BEST_RUN_GRACE_GENERATIONS": 16,
    "LAGGING_RUN_GRACE_GENERATIONS": 10,
    "CROSS_RUN_TARGET_REL_GAP": 0.03,
    "CROSS_RUN_TARGET_ABS_GAP": 1.25,
    "PLATEAU_PATIENCE_GENERATIONS": 10,
    "INFEASIBLE_PLATEAU_PATIENCE_GENERATIONS": 7,
    "PLATEAU_DIVERSITY_MAX": 0.12,
    "RESTARTS_BEFORE_CONVERGENCE_STOP": 1,
}
MEDIUM_CONVERGENCE_DEFAULTS = {
    "CHECKPOINT_EVERY_SEC": 6.0,
    "EPS_REL": 0.0,
    "STALL_CHECKPOINTS": 5,
    "DIVERSITY_MIN": 0.03,
    "BURST_SEC": 8.0,
    "STAGNATION_GRACE_GENERATIONS": 28,
    "BEST_RUN_GRACE_GENERATIONS": 36,
    "LAGGING_RUN_GRACE_GENERATIONS": 18,
    "CROSS_RUN_TARGET_REL_GAP": 0.03,
    "CROSS_RUN_TARGET_ABS_GAP": 1.5,
    "PLATEAU_PATIENCE_GENERATIONS": 18,
    "INFEASIBLE_PLATEAU_PATIENCE_GENERATIONS": 8,
    "PLATEAU_DIVERSITY_MAX": 0.11,
    "RESTARTS_BEFORE_CONVERGENCE_STOP": 2,
}
HIGH_CONVERGENCE_DEFAULTS = {
    "CHECKPOINT_EVERY_SEC": 7.0,
    "EPS_REL": 0.0,
    "STALL_CHECKPOINTS": 6,
    "DIVERSITY_MIN": 0.025,
    "BURST_SEC": 10.0,
    "STAGNATION_GRACE_GENERATIONS": 34,
    "BEST_RUN_GRACE_GENERATIONS": 44,
    "LAGGING_RUN_GRACE_GENERATIONS": 22,
    "CROSS_RUN_TARGET_REL_GAP": 0.032,
    "CROSS_RUN_TARGET_ABS_GAP": 2.0,
    "PLATEAU_PATIENCE_GENERATIONS": 22,
    "INFEASIBLE_PLATEAU_PATIENCE_GENERATIONS": 9,
    "PLATEAU_DIVERSITY_MAX": 0.10,
    "RESTARTS_BEFORE_CONVERGENCE_STOP": 2,
}
# Baseline starting values. Actual runtime config is derived from dataset
# complexity in `_estimate_problem_complexity()` / `_derive_solver_config()`.
SOLVER_POP_SIZE = 34
SOLVER_GENERATIONS = 120
SOLVER_ALNS_ITERATIONS = 6
LARGE_CASE_EMPLOYEE_THRESHOLD = 100
LARGE_CASE_VEHICLE_THRESHOLD = 25
LARGE_CASE_VEHICLE_EMPLOYEE_FLOOR = 70
LARGE_CASE_LOCATION_THRESHOLD = 240
MAX_SUPPORTED_EMPLOYEES = 300
MAX_SUPPORTED_VEHICLES = 120
MAX_SUPPORTED_UNIQUE_LOCATIONS = 700
MAX_SUPPORTED_VEHICLE_CAPACITY = 100
MAX_SUPPORTED_COST_PER_KM = 10000.0
MAX_SUPPORTED_SPEED_KMPH = 150.0
FREE_LARGE_CASE_MAX_RUNTIME_SEC = 120.0
PREMIUM_LARGE_CASE_MAX_RUNTIME_SEC = 20.0 * 60.0
FREE_LARGE_CASE_PROFILE = {
    "runs": 1,
    "pop_size": 14,
    "generations": 36,
    "alns_iterations": 1,
    "time_limit_sec": FREE_LARGE_CASE_MAX_RUNTIME_SEC,
    "min_runtime_sec": 0.0,
    "min_early_stop_generations": 12,
    "checkpoint_every_sec": 5.0,
    "stall_checkpoints": 3,
    "route_pool_enabled": False,
    "seed_assignment_enabled": False,
    "skip_distance_precompute": True,
    "force_distance_metric": "haversine",
}
PREMIUM_LARGE_CASE_PROFILE = {
    "runs": 2,
    "pop_size": 26,
    "generations": 120,
    "alns_iterations": 4,
    "time_limit_sec": PREMIUM_LARGE_CASE_MAX_RUNTIME_SEC,
    "min_runtime_sec": 0.0,
    "min_early_stop_generations": 24,
    "checkpoint_every_sec": 8.0,
    "stall_checkpoints": 4,
    "route_pool_enabled": True,
    "seed_assignment_enabled": False,
    "skip_distance_precompute": False,
    "force_distance_metric": None,
}

def _strategy_for_run(problem, run_id):
    metadata = getattr(problem, "metadata", {}) or {}
    large_mode = str(metadata.get("LARGE_CASE_MODE") or "").strip().lower()
    if large_mode == "free":
        return {
            "name": "Large-Free",
            "regret": 0.8,
            "grasp": 0.2,
            "random": 0.0,
        }
    if large_mode == "premium":
        return {
            "name": "Large-Premium",
            "regret": 0.55,
            "grasp": 0.25,
            "random": 0.20,
        }
    return STRATEGIES[(run_id - 1) % len(STRATEGIES)]


def run_single_solver(run_id, problem, base_seed, alns_iterations, pop_size=None, generations=None, progress_tracker=None):
    strategy = _strategy_for_run(problem, run_id)
    run_seed = int(base_seed) + (int(run_id) * 10_007)
    with redirect_stdout_to_stderr(True):
        metadata = dict(getattr(problem, "metadata", {}) or {})
        decomp_active, decomp_info = decomposition_should_activate(problem, metadata)
        if decomp_active:
            t0 = time.perf_counter()
            tl = float(metadata.get("TIME_LIMIT_SEC", metadata.get("MAX_RUN_SECONDS", 25)) or 25.0)
            solution, decomp_meta = solve_with_decomposition(
                problem=problem,
                run_id=int(run_id),
                seed=int(run_seed),
                time_limit_sec=float(tl),
                pop_size=int(pop_size or SOLVER_POP_SIZE),
                generations=int(generations or SOLVER_GENERATIONS),
                alns_iterations=int(alns_iterations),
                route_pool_pruning_mode=str(metadata.get("ROUTE_POOL_PRUNING_MODE", "heuristic")),
            )
            duration = float(time.perf_counter() - t0)
            run_meta = dict(getattr(solution, "metadata", {}) or {})
            run_meta["decompositionActivation"] = dict(decomp_info or {})
            run_meta["decomposition"] = dict(decomp_meta or {})
            run_meta.setdefault("terminationReason", "decomposition")
            run_meta.setdefault("stopReason", "decomposition")
            run_meta.setdefault("durationSeconds", float(duration))
            run_meta.setdefault("runtimeSec", float(duration))
            run_meta.setdefault("generationsPlanned", 0)
            run_meta.setdefault("generationsExecuted", 0)
        else:
            solver = GeneticSolver(
                problem,
                pop_size=pop_size or SOLVER_POP_SIZE,
                generations=generations or SOLVER_GENERATIONS,
                alns_iterations=alns_iterations,
                strategy_config=strategy,
                seed=run_seed,
            )
            solution, run_meta = solver.solve(run_id=run_id, progress_tracker=progress_tracker)
    if not isinstance(run_meta, dict):
        run_meta = {}
    run_meta.setdefault("runId", int(run_id))
    run_meta.setdefault("strategy", str(strategy.get("name") or f"Run-{run_id}"))
    run_meta.setdefault("seed", int(run_seed))
    return {"solution": solution, "meta": run_meta}


def safe_sum_baseline(problem):
    try:
        base_cost = sum(b.cost for b in problem.baseline.values()) if getattr(problem, "baseline", None) else 0.0
        base_time = sum(b.time for b in problem.baseline.values()) if getattr(problem, "baseline", None) else 0.0
        return float(base_cost), float(base_time)
    except Exception:
        return 0.0, 0.0


def _clamp(val, lo, hi):
    return max(lo, min(hi, val))


def _employee_scaled_runtime_floor_sec(employee_count):
    return max(4.0, float(employee_count) * 1.5)


def _parse_id_list(raw):
    if raw is None:
        return []
    if isinstance(raw, (list, tuple, set)):
        values = [str(v).strip() for v in raw]
    else:
        text = str(raw).strip()
        if not text:
            return []
        values = [chunk.strip() for chunk in text.split(",")]

    out = []
    seen = set()
    for v in values:
        if not v or v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out


def _forced_unassigned_id_set(metadata):
    return set(_parse_id_list((metadata or {}).get("FORCED_UNASSIGNED_IDS")))


def _count_unique_locations(problem):
    seen = set()

    def _push(loc):
        if loc is None:
            return
        try:
            key = (round(float(loc.lat), 6), round(float(loc.lng), 6))
        except Exception:
            return
        seen.add(key)

    for emp in (getattr(problem, "employees", []) or []):
        _push(getattr(emp, "pickup_loc", None))
        _push(getattr(emp, "drop_loc", None))
    for veh in (getattr(problem, "vehicles", []) or []):
        _push(getattr(veh, "start_loc", None))
    return len(seen)


def _large_case_context(problem):
    complexity = _estimate_problem_complexity(problem)
    unique_locations = _count_unique_locations(problem)
    employee_count = int(complexity.get("n_emp", 0))
    vehicle_count = int(complexity.get("n_veh", 0))
    vehicle_pressure_large = (
        vehicle_count > LARGE_CASE_VEHICLE_THRESHOLD
        and employee_count >= LARGE_CASE_VEHICLE_EMPLOYEE_FLOOR
    )
    is_large = (
        employee_count > LARGE_CASE_EMPLOYEE_THRESHOLD
        or vehicle_pressure_large
        or int(unique_locations) > LARGE_CASE_LOCATION_THRESHOLD
    )
    return {
        "is_large": bool(is_large),
        "employee_count": employee_count,
        "vehicle_count": vehicle_count,
        "unique_locations": int(unique_locations),
        "vehiclePressureLarge": bool(vehicle_pressure_large),
    }


def _resolve_compute_tier(raw_value):
    text = str(raw_value or "").strip().lower()
    if text in ("premium", "paid", "pro"):
        return "premium"
    return "free"


def _apply_large_case_profile(problem, metadata, compute_tier):
    context = _large_case_context(problem)
    if not context["is_large"]:
        metadata["COMPUTE_TIER"] = _resolve_compute_tier(compute_tier)
        metadata["large_case_mode"] = "false"
        return metadata, context, None

    tier = _resolve_compute_tier(compute_tier)
    profile = dict(PREMIUM_LARGE_CASE_PROFILE if tier == "premium" else FREE_LARGE_CASE_PROFILE)

    metadata["COMPUTE_TIER"] = tier
    metadata["LARGE_CASE_MODE"] = tier
    metadata["large_case_mode"] = "true"
    metadata["BYPASS_SOLVER_SIZE_FLOORS"] = "true"
    metadata["TIME_LIMIT_SEC"] = float(profile["time_limit_sec"])
    metadata["MAX_RUN_SECONDS"] = float(profile["time_limit_sec"])
    metadata["MIN_RUNTIME_SEC"] = float(profile["min_runtime_sec"])
    metadata["MIN_EARLY_STOP_GENERATIONS"] = int(profile["min_early_stop_generations"])
    metadata["CHECKPOINT_EVERY_SEC"] = float(profile["checkpoint_every_sec"])
    metadata["STALL_CHECKPOINTS"] = int(profile["stall_checkpoints"])
    metadata["ROUTE_POOL_ENABLED"] = "true" if profile["route_pool_enabled"] else "false"
    metadata["ORTOOLS_SEED_ASSIGNMENT_ENABLED"] = "true" if profile["seed_assignment_enabled"] else "false"
    metadata["SKIP_DISTANCE_PRECOMPUTE"] = "true" if profile["skip_distance_precompute"] else "false"
    metadata["LARGE_CASE_FIXED_RUNS"] = int(profile["runs"])
    metadata["LARGE_CASE_FIXED_POP_SIZE"] = int(profile["pop_size"])
    metadata["LARGE_CASE_FIXED_GENERATIONS"] = int(profile["generations"])
    metadata["LARGE_CASE_FIXED_ALNS_ITERATIONS"] = int(profile["alns_iterations"])

    if tier == "premium":
        route_pool_allowed = (
            context["employee_count"] <= 150
            and context["vehicle_count"] <= 35
            and context["unique_locations"] <= 320
        )
        metadata["ROUTE_POOL_ENABLED"] = "true" if route_pool_allowed else "false"
        metadata["SKIP_DISTANCE_PRECOMPUTE"] = "true" if context["unique_locations"] > 320 else "false"
        profile["route_pool_enabled"] = route_pool_allowed
        profile["skip_distance_precompute"] = bool(context["unique_locations"] > 320)

    return metadata, context, profile


def _validate_problem_for_solve(problem):
    errors = []
    employees = list(getattr(problem, "employees", []) or [])
    vehicles = list(getattr(problem, "vehicles", []) or [])
    metadata = getattr(problem, "metadata", {}) or {}

    for idx, emp in enumerate(employees, start=1):
        emp_id = str(getattr(emp, "display_id", "") or getattr(emp, "original_id", "") or getattr(emp, "id", "") or f"employee-{idx}")
        pickup = getattr(emp, "pickup_loc", None)
        drop = getattr(emp, "drop_loc", None)
        for label, loc in (("pickup", pickup), ("dropoff", drop)):
            try:
                lat = float(getattr(loc, "lat", float("nan")))
                lng = float(getattr(loc, "lng", float("nan")))
            except Exception:
                lat = float("nan")
                lng = float("nan")
            if not math.isfinite(lat) or not math.isfinite(lng):
                errors.append(f"employee {emp_id} has invalid {label} coordinates")
            elif lat < -90 or lat > 90 or lng < -180 or lng > 180:
                errors.append(f"employee {emp_id} has out-of-range {label} coordinates")
        try:
            earliest = float(getattr(emp, "earliest_pickup", 0))
            latest = float(getattr(emp, "latest_drop", 0))
        except Exception:
            earliest = 0.0
            latest = 0.0
        if latest < earliest:
            errors.append(f"employee {emp_id} latest drop must be after earliest pickup")

    for idx, veh in enumerate(vehicles, start=1):
        veh_id = str(getattr(veh, "display_id", "") or getattr(veh, "original_id", "") or getattr(veh, "id", "") or f"vehicle-{idx}")
        try:
            capacity = int(getattr(veh, "capacity", 0))
        except Exception:
            capacity = 0
        if capacity < 1 or capacity > MAX_SUPPORTED_VEHICLE_CAPACITY:
            errors.append(
                f"vehicle {veh_id} capacity must be between 1 and {MAX_SUPPORTED_VEHICLE_CAPACITY}"
            )
        try:
            cost_per_km = float(getattr(veh, "cost_per_km", 0.0))
        except Exception:
            cost_per_km = -1.0
        if (not math.isfinite(cost_per_km)) or cost_per_km < 0 or cost_per_km > MAX_SUPPORTED_COST_PER_KM:
            errors.append(
                f"vehicle {veh_id} cost_per_km must be between 0 and {int(MAX_SUPPORTED_COST_PER_KM)}"
            )
        try:
            speed_kmph = float(getattr(veh, "speed_kmph", 0.0))
        except Exception:
            speed_kmph = -1.0
        if (not math.isfinite(speed_kmph)) or speed_kmph <= 0 or speed_kmph > MAX_SUPPORTED_SPEED_KMPH:
            errors.append(
                f"vehicle {veh_id} speed_kmph must be between 0 and {int(MAX_SUPPORTED_SPEED_KMPH)}"
            )
        loc = getattr(veh, "start_loc", None)
        try:
            lat = float(getattr(loc, "lat", float("nan")))
            lng = float(getattr(loc, "lng", float("nan")))
        except Exception:
            lat = float("nan")
            lng = float("nan")
        if not math.isfinite(lat) or not math.isfinite(lng):
            errors.append(f"vehicle {veh_id} has invalid start coordinates")
        elif lat < -90 or lat > 90 or lng < -180 or lng > 180:
            errors.append(f"vehicle {veh_id} has out-of-range start coordinates")

    for weight_name, keys in (
        ("cost", ["objective_cost_weight", "objectiveCostWeight", "cost_weight", "costWeight", "OBJECTIVE_COST_WEIGHT"]),
        ("time", ["objective_time_weight", "objectiveTimeWeight", "time_weight", "timeWeight", "OBJECTIVE_TIME_WEIGHT"]),
    ):
        raw_value = None
        for key in keys:
            if key in metadata:
                raw_value = metadata.get(key)
                break
        if raw_value is None or str(raw_value).strip() == "":
            continue
        try:
            weight = float(raw_value)
        except Exception:
            errors.append(f"objective {weight_name} weight must be numeric")
            continue
        if (not math.isfinite(weight)) or weight < 0 or weight > 1:
            errors.append(f"objective {weight_name} weight must be between 0 and 1")

    return list(dict.fromkeys(errors))


def _estimate_problem_complexity(problem):
    employees = list(getattr(problem, "employees", []) or [])
    forced_ids = _forced_unassigned_id_set(getattr(problem, "metadata", {}) or {})
    if forced_ids:
        employees = [e for e in employees if str(getattr(e, "id", "")) not in forced_ids]
    vehicles = list(getattr(problem, "vehicles", []) or [])
    n_emp = len(employees)
    n_veh = len(vehicles)
    emp_per_vehicle = n_emp / max(1, n_veh)

    # Time-window tightness signal: tighter windows increase search difficulty.
    widths = []
    for e in employees:
        try:
            widths.append(max(0, int(e.latest_drop) - int(e.earliest_pickup)))
        except Exception:
            pass
    avg_window = (sum(widths) / len(widths)) if widths else 90.0
    tightness_boost = 1.15 if avg_window < 45 else (1.08 if avg_window < 75 else 1.0)

    # Mix of hard constraints (premium/single-sharing) also increases complexity.
    premium_count = 0
    single_count = 0
    for e in employees:
        pref = str(getattr(e, "vehicle_pref", "") or "").strip().lower()
        share = str(getattr(e, "sharing_pref", "") or "").strip().lower()
        if pref == "premium":
            premium_count += 1
        if share in ("single", "1"):
            single_count += 1
    hard_ratio = (premium_count + single_count) / max(1, n_emp)
    hard_boost = 1.12 if hard_ratio > 0.35 else (1.06 if hard_ratio > 0.18 else 1.0)

    # Baseline starting point requested by the user:
    # runs=8, pop=34, generations=120, alns=6.
    #
    # From there, dataset size and difficulty increase the budget. Generations
    # should depend on the dataset because larger employee counts, tighter
    # windows, and harder preferences typically require more search depth.
    extra_pop = (
        max(0, n_emp - 20) * 0.25
        + max(0.0, emp_per_vehicle - 3.0) * 2.0
        + max(0, n_veh - 6) * 0.5
    )
    base_pop = 34 + int(round(extra_pop))

    extra_gen = (
        max(0, n_emp - 20) * 1.4
        + max(0.0, emp_per_vehicle - 3.5) * 10.0
        + max(0, n_veh - 6) * 2.5
    )
    base_gen = 108 + int(round(extra_gen))

    base_runs = int(NUM_PARALLEL_RUNS)
    if n_emp >= 50:
        base_runs += 1
    if n_emp >= 90:
        base_runs += 1
    if (avg_window < 45) or (hard_ratio > 0.35):
        base_runs += 1

    base_alns = 6
    if n_emp >= 40:
        base_alns += 1
    if n_emp >= 75:
        base_alns += 1
    if (avg_window < 60) or (hard_ratio > 0.25) or (emp_per_vehicle >= 5.0):
        base_alns += 1

    search_boost = tightness_boost * hard_boost
    pop_boost = 1.0 + ((search_boost - 1.0) * 0.80)
    gen_boost = 1.0 + ((search_boost - 1.0) * 1.10)
    alns_boost = 1.0 + ((search_boost - 1.0) * 0.65)

    base_pop = int(round(base_pop * pop_boost))
    base_gen = int(round(base_gen * gen_boost))
    base_alns = int(round(base_alns * alns_boost))

    return {
        "n_emp": n_emp,
        "n_veh": n_veh,
        "emp_per_vehicle": emp_per_vehicle,
        "avg_window": avg_window,
        "hard_ratio": hard_ratio,
        "base_pop": _clamp(base_pop, 24, 140),
        "base_gen": _clamp(base_gen, 72, 360),
        "base_runs": _clamp(base_runs, 4, 16),
        "base_alns": _clamp(base_alns, 4, 14),
    }


def _derive_solver_config(problem, intensity, runs_override):
    c = _estimate_problem_complexity(problem)
    intensity_name = str(intensity or "").strip().lower()
    fixed_generations = int(FIXED_GENERATIONS_BY_INTENSITY.get(intensity_name, FIXED_GENERATIONS_BY_INTENSITY["medium"]))
    fixed_time_limit_sec = float(
        FIXED_TIME_LIMIT_SEC_BY_INTENSITY.get(intensity_name, FIXED_TIME_LIMIT_SEC_BY_INTENSITY["medium"])
    )
    fixed_runs = int(FIXED_RUNS_BY_INTENSITY.get(intensity_name, FIXED_RUNS_BY_INTENSITY["medium"]))
    metadata = getattr(problem, "metadata", {}) or {}
    if is_budget_recalibration_enabled(metadata):
        # Budget recalibration mode (experimental):
        # derive run/pop/gen/etc from time budget throughput-oriented formulas.
        budget = recommend_budget(
            employees=int(c["n_emp"]),
            time_budget_sec=float(metadata.get("PROJECT_TIME_LIMIT_SEC", metadata.get("TIME_LIMIT_SEC", fixed_time_limit_sec))),
            cores=physical_cores(),
        )
        # Optional bounded tweaks (used for benchmark-based accept/reject).
        # These are clamped to the exact ranges requested in the prompt.
        try:
            runs_delta = int(float(metadata.get("BUDGET_TWEAK_RUNS_DELTA", 0) or 0))
        except Exception:
            runs_delta = 0
        try:
            pop_delta = int(float(metadata.get("BUDGET_TWEAK_POP_DELTA", 0) or 0))
        except Exception:
            pop_delta = 0
        try:
            alns_delta = int(float(metadata.get("BUDGET_TWEAK_ALNS_DELTA", 0) or 0))
        except Exception:
            alns_delta = 0
        runs_delta = max(-1, min(1, runs_delta))
        pop_delta = max(-4, min(4, pop_delta))
        alns_delta = max(-2, min(2, alns_delta))

        # Allow floor below the legacy 20-gen default in this mode.
        metadata["MIN_GENERATION_FLOOR_BELOW_20"] = "true"
        metadata["MIN_GENERATION_FLOOR"] = int(budget.planned_generations)
        metadata["DYNAMIC_GENERATION_CALIBRATION_ENABLED"] = "true"
        metadata.setdefault("GEN_CALIBRATION_WARMUP_GENERATIONS", 3)
        metadata.setdefault("GEN_CALIBRATION_RESERVE_RATIO", 0.18)
        metadata["STAGNATION_LIMIT_GEN"] = int(budget.restart_after_nonimproving)
        metadata["PLATEAU_PATIENCE_GENERATIONS"] = int(budget.plateau_patience_generations)
        metadata["MAX_RESTARTS"] = int(budget.max_restarts)
        # Set-partition budget derived from per-run time budget.
        metadata["SET_PARTITION_TIME_LIMIT_SEC"] = float(budget.set_partition_time_limit_sec)
        # Elite size derived from pop size.
        metadata["ELITE_SIZE"] = int(budget.elite_size)
        problem.metadata = metadata

        pop_size = int(max(24, min(56, int(budget.pop_size) + int(pop_delta))))
        generations = int(max(5, budget.planned_generations))
        auto_runs = int(max(1, int(budget.runs) + int(runs_delta)))
        runs = int(auto_runs if not (runs_override and runs_override > 0) else int(runs_override))
        alns_iterations = int(max(0, int(budget.alns_iterations) + int(alns_delta)))
        return {
            "runs": runs,
            "pop_size": pop_size,
            "generations": generations,
            "alns_iterations": alns_iterations,
            "generation_scale": 1.0,
            "min_generation_floor": int(budget.planned_generations),
            "min_runtime_floor_sec": float(_employee_scaled_runtime_floor_sec(c["n_emp"])),
            "time_limit_sec": float(metadata.get("PROJECT_TIME_LIMIT_SEC", metadata.get("TIME_LIMIT_SEC", fixed_time_limit_sec))),
            "meta": c | {"budgetRecalibration": True},
        }

    min_generation_floor = int(fixed_generations)
    min_runtime_floor_sec = _employee_scaled_runtime_floor_sec(c["n_emp"])
    mul = INTENSITY_CONFIG.get(intensity, INTENSITY_CONFIG["medium"])
    metadata["MIN_GENERATION_FLOOR"] = int(min_generation_floor)
    problem.metadata = metadata

    pop_size = _clamp(int(round(c["base_pop"] * mul["pop_mul"])), 24, 180)
    generations = int(min_generation_floor)
    runs = int(fixed_runs)
    alns_iterations = _clamp(int(round(c["base_alns"] * mul.get("alns_mul", 1.0))), 4, 16)
    if runs_override and runs_override > 0:
        runs = int(runs_override)

    return {
        "runs": runs,
        "pop_size": pop_size,
        "generations": generations,
        "alns_iterations": alns_iterations,
        "generation_scale": 1.0,
        "min_generation_floor": int(min_generation_floor),
        "min_runtime_floor_sec": float(min_runtime_floor_sec),
        "time_limit_sec": float(fixed_time_limit_sec),
        "meta": c,
    }


def _default_executor_workers(stdin_mode):
    cpu_count = max(1, int(os.cpu_count() or 1))
    if stdin_mode:
        return min(32, cpu_count + 4)
    return cpu_count


def _apply_intensity_stop_profile(metadata, intensity):
    intensity_name = str(intensity or "").strip().lower()
    if intensity_name == "low":
        for key, value in LOW_CONVERGENCE_DEFAULTS.items():
            metadata.setdefault(key, value)
    elif intensity_name == "medium":
        for key, value in MEDIUM_CONVERGENCE_DEFAULTS.items():
            metadata.setdefault(key, value)
    elif intensity_name == "high":
        for key, value in HIGH_CONVERGENCE_DEFAULTS.items():
            metadata.setdefault(key, value)


def _fmt_hhmm(minute_value):
    if minute_value is None:
        return None
    try:
        minute_int = int(round(float(minute_value)))
    except Exception:
        return None
    hh = (minute_int // 60) % 24
    mm = minute_int % 60
    return f"{hh:02d}:{mm:02d}"


def _normalized_id_maps(problem):
    metadata = getattr(problem, "metadata", {}) or {}
    employee_original_map = dict(metadata.get("normalized_employee_id_map") or {})
    employee_display_map = dict(metadata.get("normalized_employee_display_map") or {})
    vehicle_original_map = dict(metadata.get("normalized_vehicle_id_map") or {})
    vehicle_display_map = dict(metadata.get("normalized_vehicle_display_map") or {})
    return employee_original_map, employee_display_map, vehicle_original_map, vehicle_display_map


def _employee_original_id(problem, normalized_id):
    employee_original_map, _, _, _ = _normalized_id_maps(problem)
    text = str(normalized_id or "").strip()
    return str(employee_original_map.get(text) or text)


def _employee_display_id(problem, normalized_id):
    _, employee_display_map, _, _ = _normalized_id_maps(problem)
    text = str(normalized_id or "").strip()
    return str(employee_display_map.get(text) or text)


def _vehicle_original_id(problem, normalized_id):
    _, _, vehicle_original_map, _ = _normalized_id_maps(problem)
    text = str(normalized_id or "").strip()
    return str(vehicle_original_map.get(text) or text)


def _vehicle_display_id(problem, normalized_id):
    _, _, _, vehicle_display_map = _normalized_id_maps(problem)
    text = str(normalized_id or "").strip()
    return str(vehicle_display_map.get(text) or text)


def _normalize_employee_ids(values):
    out = []
    seen = set()
    for value in (values or []):
        s = str(value or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _push_state_segment(segments, state, start_minute, end_minute, employees_onboard=None):
    try:
        start = float(start_minute)
        end = float(end_minute)
    except Exception:
        return

    if not (end > start):
        return

    onboard = _normalize_employee_ids(employees_onboard)

    if segments:
        last = segments[-1]
        same_state = str(last.get("state")) == str(state)
        same_onboard = _normalize_employee_ids(last.get("employeesOnboard")) == onboard
        contiguous = abs(float(last.get("endMinute", 0.0)) - start) <= 1e-6
        if same_state and same_onboard and contiguous:
            last["endMinute"] = end
            last["endTime"] = _fmt_hhmm(end)
            return

    segments.append({
        "state": str(state),
        "startMinute": start,
        "endMinute": end,
        "startTime": _fmt_hhmm(start),
        "endTime": _fmt_hhmm(end),
        "employeesOnboard": onboard,
    })


def build_route_timeline(problem, route):
    vehicle = getattr(route, "vehicle", None)
    stop_sequence = list(getattr(route, "stop_sequence", []) or [])
    if vehicle is None or not stop_sequence:
        return {
            "path": [],
            "state_timeline": [],
            "start_minute": None,
            "end_minute": None,
        }

    first_stop = stop_sequence[0]
    first_emp = first_stop.get("emp")
    first_type = first_stop.get("type")
    if first_emp is None or first_type not in ("p", "d"):
        return {
            "path": [],
            "state_timeline": [],
            "start_minute": None,
            "end_minute": None,
        }

    first_loc = first_emp.pickup_loc if first_type == "p" else first_emp.drop_loc
    dist_to_first = get_distance(vehicle.start_loc, first_loc)
    travel_to_first = calculate_travel_time(dist_to_first, vehicle.speed_kmph)
    target_arrival = float(first_emp.earliest_pickup)
    jit_start = target_arrival - float(travel_to_first)
    effective_start = max(float(vehicle.avail_from), float(jit_start))

    curr_time = float(effective_start)
    curr_loc = vehicle.start_loc
    current_load = 0
    onboard_employee_ids = []
    stop_rows = []
    state_timeline = []

    for idx, stop in enumerate(stop_sequence):
        emp = stop.get("emp")
        stop_type = stop.get("type")
        if emp is None or stop_type not in ("p", "d"):
            continue

        target_loc = emp.pickup_loc if stop_type == "p" else emp.drop_loc
        distance_km = float(get_distance(curr_loc, target_loc))
        travel_minutes = float(calculate_travel_time(distance_km, vehicle.speed_kmph))
        if travel_minutes < 0 or travel_minutes == float("inf"):
            travel_minutes = 0.0

        departure_minute = float(curr_time)
        arrival_minute = departure_minute + travel_minutes

        if travel_minutes > 0:
            leg_state = "occupied" if current_load > 0 else "travel"
            _push_state_segment(
                state_timeline,
                leg_state,
                departure_minute,
                arrival_minute,
                employees_onboard=onboard_employee_ids,
            )

        if current_load == 0 and stop_type == "p" and idx > 0 and TURNAROUND_BUFFER_MINUTES > 0:
            turnaround_end = arrival_minute + float(TURNAROUND_BUFFER_MINUTES)
            _push_state_segment(
                state_timeline,
                "idle",
                arrival_minute,
                turnaround_end,
                employees_onboard=onboard_employee_ids,
            )
            arrival_minute = turnaround_end

        if stop_type == "p" and arrival_minute < float(emp.earliest_pickup):
            wait_until = float(emp.earliest_pickup)
            _push_state_segment(
                state_timeline,
                "idle",
                arrival_minute,
                wait_until,
                employees_onboard=onboard_employee_ids,
            )
            arrival_minute = wait_until

        onboard_before = _normalize_employee_ids(
            [_employee_display_id(problem, emp_id) for emp_id in onboard_employee_ids]
        )
        load_before = int(current_load)
        normalized_emp_id = str(emp.id)
        display_emp_id = _employee_display_id(problem, normalized_emp_id)
        source_emp_id = _employee_original_id(problem, normalized_emp_id)
        if stop_type == "p":
            current_load += 1
            if normalized_emp_id not in onboard_employee_ids:
                onboard_employee_ids.append(normalized_emp_id)
            normalized_type = "pickup"
        else:
            current_load = max(0, current_load - 1)
            onboard_employee_ids = [e_id for e_id in onboard_employee_ids if e_id != normalized_emp_id]
            normalized_type = "dropoff"
        onboard_after = _normalize_employee_ids(
            [_employee_display_id(problem, emp_id) for emp_id in onboard_employee_ids]
        )

        stop_rows.append({
            "index": int(idx + 1),
            "type": normalized_type,
            "employeeId": display_emp_id,
            "sourceEmployeeId": source_emp_id,
            "normalizedEmployeeId": normalized_emp_id,
            "lat": float(target_loc.lat),
            "lng": float(target_loc.lng),
            "distanceFromPrevKm": float(distance_km),
            "travelMinutesFromPrev": float(travel_minutes),
            "departureMinute": float(departure_minute),
            "arrivalMinute": float(arrival_minute),
            "departureTime": _fmt_hhmm(departure_minute),
            "arrivalTime": _fmt_hhmm(arrival_minute),
            "loadBefore": int(load_before),
            "loadAfter": int(current_load),
            "employeesOnboardBefore": onboard_before,
            "employeesOnboardAfter": onboard_after,
        })

        curr_time = float(arrival_minute)
        curr_loc = target_loc

    verification_errors = []
    seen_pickups = set()
    prev_arrival_minute = None
    for stop in stop_rows:
        typ = str(stop.get("type") or "").strip().lower()
        emp_id = str(stop.get("employeeId") or "").strip()
        arrival_minute = stop.get("arrivalMinute")
        if isinstance(arrival_minute, (int, float)):
            if prev_arrival_minute is not None and float(arrival_minute) < float(prev_arrival_minute) - 1e-6:
                verification_errors.append("arrival_minutes_not_monotonic")
            prev_arrival_minute = float(arrival_minute)

        if typ == "pickup":
            seen_pickups.add(emp_id)
        elif typ == "dropoff":
            if emp_id not in seen_pickups:
                verification_errors.append(f"dropoff_before_pickup:{emp_id}")
        else:
            verification_errors.append(f"unknown_stop_type:{typ or 'empty'}")

    route_stop_count = len(stop_rows)
    route_verification = {
        "isConsistent": len(verification_errors) == 0,
        "stopCount": int(route_stop_count),
        "errors": verification_errors,
    }

    return {
        "path": stop_rows,
        "state_timeline": state_timeline,
        "availability_minute": float(vehicle.avail_from),
        "start_minute": float(effective_start),
        "end_minute": float(curr_time),
        "verification": route_verification,
    }


def solution_to_json(problem, best_solution):
    rides = []
    total_cost = 0.0
    total_time = 0.0
    total_distance = 0.0

    for route in getattr(best_solution, "routes", []):
        if hasattr(route, "is_empty") and route.is_empty():
            continue

        total_cost += float(getattr(route, "total_cost", 0.0))
        total_time += float(getattr(route, "total_time", 0.0))

        timeline_data = build_route_timeline(problem, route)
        path = list(timeline_data.get("path", []))
        state_timeline = list(timeline_data.get("state_timeline", []))
        route_distance_km = float(sum(float(stop.get("distanceFromPrevKm") or 0.0) for stop in path))
        total_distance += route_distance_km
        availability_minute = timeline_data.get("availability_minute")
        start_minute = timeline_data.get("start_minute")
        end_minute = timeline_data.get("end_minute")
        timeline_verification = timeline_data.get("verification") or {}
        assigned = [str(p.get("employeeId")) for p in path if p.get("employeeId")]
        assigned_original = [str(p.get("sourceEmployeeId")) for p in path if p.get("sourceEmployeeId")]
        assigned_normalized = [str(p.get("normalizedEmployeeId")) for p in path if p.get("normalizedEmployeeId")]

        # Extract detailed violation information
        violation_details = {}
        violation_msg = getattr(route, "violation_msg", "") or ""
        vehicle = getattr(route, "vehicle", None)
        
        if violation_msg and vehicle:
            # Parse violation type and extract relevant details
            if "Over Capacity" in violation_msg:
                # Extract current load from violation message
                import re
                match = re.search(r'\((\d+)\)', violation_msg)
                current_load = int(match.group(1)) if match else len(assigned)
                violation_details = {
                    "type": "capacity",
                    "expected": vehicle.capacity,
                    "actual": current_load,
                    "message": f"Vehicle capacity is {vehicle.capacity}, but {current_load} passengers were assigned"
                }
            elif "Late Drop" in violation_msg:
                # Extract employee ID from violation message
                emp_id = violation_msg.replace("Late Drop ", "").strip()
                # Find the employee to get timing details
                emp = next((e for e in getattr(route, "employees", []) if e.id == emp_id), None)
                if emp:
                    latest_allowed = emp.latest_drop + get_max_allowed_delay(
                        emp.priority,
                        getattr(problem, "metadata", {}) or {},
                    )
                    delay_minutes = getattr(route, "employee_delay_minutes", {}).get(emp_id, 0)
                    actual_drop_time = latest_allowed + delay_minutes
                    violation_details = {
                        "type": "time_window",
                        "employeeId": _employee_display_id(problem, emp_id),
                        "sourceEmployeeId": _employee_original_id(problem, emp_id),
                        "normalizedEmployeeId": str(emp_id),
                        "expected": f"{latest_allowed // 60:02d}:{latest_allowed % 60:02d}",
                        "actual": f"{int(actual_drop_time) // 60:02d}:{int(actual_drop_time) % 60:02d}",
                        "delayMinutes": delay_minutes,
                        "message": f"Employee {_employee_display_id(problem, emp_id)} dropped at {int(actual_drop_time) // 60:02d}:{int(actual_drop_time) % 60:02d}, exceeding latest allowed time {latest_allowed // 60:02d}:{latest_allowed % 60:02d}"
                    }
            elif "Premium Pax in Non-Premium Veh" in violation_msg:
                violation_details = {
                    "type": "premium",
                    "expected": "premium",
                    "actual": vehicle.category or "standard",
                    "message": f"Premium passenger requires premium vehicle, but assigned to {vehicle.category or 'standard'} vehicle"
                }
            elif "Sharing Violation" in violation_msg:
                emp_id = violation_msg.replace("Sharing Violation ", "").strip()
                emp = next((e for e in getattr(route, "employees", []) if e.id == emp_id), None)
                if emp:
                    sharing_pref = emp.sharing_pref or "2"
                    violation_details = {
                        "type": "sharing",
                        "employeeId": _employee_display_id(problem, emp_id),
                        "sourceEmployeeId": _employee_original_id(problem, emp_id),
                        "normalizedEmployeeId": str(emp_id),
                        "expected": sharing_pref,
                        "actual": str(len(assigned)),
                        "message": f"Employee {_employee_display_id(problem, emp_id)} prefers {sharing_pref} passenger(s), but {len(assigned)} passengers assigned"
                    }
            elif "Drop before pickup" in violation_msg:
                emp_id = violation_msg.replace("Drop before pickup ", "").strip()
                violation_details = {
                    "type": "precedence",
                    "employeeId": _employee_display_id(problem, emp_id),
                    "sourceEmployeeId": _employee_original_id(problem, emp_id),
                    "normalizedEmployeeId": str(emp_id),
                    "expected": "pickup before dropoff",
                    "actual": "dropoff before pickup",
                    "message": f"Employee {_employee_display_id(problem, emp_id)} has dropoff scheduled before pickup"
                }
            elif "Empty Stop Sequence" in violation_msg:
                violation_details = {
                    "type": "empty_route",
                    "expected": "at least one stop",
                    "actual": "0 stops",
                    "message": "Route has employees assigned but no stops in sequence"
                }

        normalized_vehicle_id = str(route.vehicle.id) if getattr(route, "vehicle", None) else None
        display_vehicle_id = _vehicle_display_id(problem, normalized_vehicle_id)
        source_vehicle_id = _vehicle_original_id(problem, normalized_vehicle_id)
        raw_employee_delay = getattr(route, "employee_delay_minutes", {}) or {}
        display_employee_delay = {
            _employee_display_id(problem, emp_id): float(delay or 0.0)
            for emp_id, delay in raw_employee_delay.items()
        }

        rides.append({
            "vehicleId": display_vehicle_id,
            "sourceVehicleId": source_vehicle_id,
            "normalizedVehicleId": normalized_vehicle_id,
            "assignedEmployees": list(dict.fromkeys(assigned)),
            "assignedEmployeeOriginalIds": list(dict.fromkeys(assigned_original)),
            "assignedEmployeeNormalizedIds": list(dict.fromkeys(assigned_normalized)),
            "availabilityMinute": float(availability_minute) if availability_minute is not None else None,
            "availabilityTime": _fmt_hhmm(availability_minute),
            "startMinute": float(start_minute) if start_minute is not None else None,
            "endMinute": float(end_minute) if end_minute is not None else None,
            "startTime": _fmt_hhmm(start_minute),
            "endTime": _fmt_hhmm(end_minute),
            "path": path,
            "stateTimeline": state_timeline,
            "timelineVerification": timeline_verification,
            "metrics": {
                "totalTimeMinutes": float(getattr(route, "total_time", 0.0)),
                "totalDistance": route_distance_km,
                "totalDistanceKm": route_distance_km,
                "cost": float(getattr(route, "total_cost", 0.0)),
                "delayMinutes": float(getattr(route, "total_delay", 0.0)),
                "employeeDelayMinutes": display_employee_delay,
            },
            "feasible": bool(getattr(route, "is_feasible", True)),
            "violation": violation_msg,
            "violations": list(getattr(route, "violations", []) or []),
            "consistencyErrors": list(getattr(route, "consistency_errors", []) or []),
            "penaltyBreakdown": dict(getattr(route, "penalty_breakdown", {}) or {}),
            "violationDetails": violation_details
        })

    base_cost, base_time = safe_sum_baseline(problem)

    metrics = {
        "totalSystemCost": float(total_cost),
        "totalTimeMinutes": float(total_time),
        "totalDistanceKm": float(total_distance),
        "baselineCost": float(base_cost),
        "baselineTimeMinutes": float(base_time),
        "savings": float(max(0.0, base_cost - total_cost)),
        "savingsPercent": float(((max(0.0, base_cost - total_cost) / base_cost) * 100.0) if base_cost > 0 else 0.0),
    }

    unassigned_employees = list(getattr(best_solution, "unassigned", []) or []) if hasattr(best_solution, "unassigned") else []
    unassigned = [_employee_display_id(problem, e.id) for e in unassigned_employees]
    unassigned_original = [_employee_original_id(problem, e.id) for e in unassigned_employees]
    unassigned_normalized = [str(e.id) for e in unassigned_employees]
    sol_hash = str(getattr(best_solution, "structural_hash", "") or "")
    if not sol_hash:
        try:
            sol_hash = structural_hash(best_solution)
        except Exception:
            sol_hash = ""

    feasible = bool(is_solution_feasible(best_solution))
    fully_assigned = bool(is_solution_fully_assigned(best_solution))
    objective_score = float(get_solution_base_objective(best_solution, problem.cost_weight, problem.time_weight))
    search_objective_score = float(get_solution_search_objective(best_solution))

    return {
        "metrics": metrics,
        "rides": rides,
        "unassigned": unassigned,
        "unassignedOriginalIds": unassigned_original,
        "unassignedNormalizedIds": unassigned_normalized,
        "objectiveScore": objective_score,
        "searchObjectiveScore": search_objective_score,
        "structuralHash": sol_hash,
        "penaltyBreakdown": dict(getattr(best_solution, "penalty_breakdown", {}) or {}),
        "routePenaltyBreakdown": dict(getattr(best_solution, "route_penalty_breakdown", {}) or {}),
        "violations": list(getattr(best_solution, "violations", []) or []),
        "consistencyErrors": list(getattr(best_solution, "consistency_errors", []) or []),
        "solverMetadata": dict(getattr(best_solution, "metadata", {}) or {}),
        "feasible": feasible,
        "fullyAssigned": fully_assigned,
        "assignmentStatus": assignment_status(best_solution),
        "status": classify_solution_status(best_solution),
        "unassignedCount": int(len(unassigned_employees)),
    }


def summarize_solver_run(run_result):
    solution = (run_result or {}).get("solution")
    run_meta = (run_result or {}).get("meta") or {}
    run_id = int(run_meta.get("runId", 0) or 0)
    strategy = str(run_meta.get("strategy") or f"Run-{run_id}")
    duration_seconds = float(run_meta.get("durationSeconds", 0.0) or 0.0)

    routes = [r for r in getattr(solution, "routes", []) if not (hasattr(r, "is_empty") and r.is_empty())]

    total_cost = 0.0
    total_time = 0.0
    total_delay = 0.0
    total_stops = 0
    any_infeasible = False
    for route in routes:
        total_cost += float(getattr(route, "total_cost", 0.0))
        total_time += float(getattr(route, "total_time", 0.0))
        total_delay += float(getattr(route, "total_delay", 0.0))
        total_stops += len(getattr(route, "stop_sequence", []) or [])
        if not bool(getattr(route, "is_feasible", True)):
            any_infeasible = True

    unassigned = list(getattr(solution, "unassigned", []) or [])
    is_feasible = not any_infeasible
    fully_assigned = len(unassigned) == 0
    objective_score = float(get_solution_base_objective(solution))
    search_objective_score = float(get_solution_search_objective(solution))

    return {
        "runId": run_id,
        "strategy": strategy,
        "seed": int(run_meta.get("seed", 0) or 0),
        "objectiveScore": objective_score,
        "searchObjectiveScore": search_objective_score,
        "structuralHash": str(getattr(solution, "structural_hash", "") or ""),
        "totalSystemCost": float(total_cost),
        "totalTimeMinutes": float(total_time),
        "totalDelayMinutes": float(total_delay),
        "feasible": bool(is_feasible),
        "fullyAssigned": bool(fully_assigned),
        "assignmentStatus": ("complete" if fully_assigned else "partial"),
        "status": ("infeasible" if not is_feasible else ("partial" if not fully_assigned else "feasible")),
        "vehiclesUsed": int(len(routes)),
        "stops": int(total_stops),
        "unassignedCount": int(len(unassigned)),
        "durationSeconds": float(duration_seconds),
        "durationMs": int(round(duration_seconds * 1000.0)),
        "generationsPlanned": int(run_meta.get("generationsPlanned", 0) or 0),
        "generationsExecuted": int(run_meta.get("generationsExecuted", 0) or 0),
        "terminatedEarly": bool(run_meta.get("terminatedEarly", False)),
        "terminationReason": str(run_meta.get("terminationReason", "") or ""),
        "stopReason": str(run_meta.get("stopReason", run_meta.get("terminationReason", "")) or ""),
        "lastImprovementGeneration": int(run_meta.get("lastImprovementGeneration", 0) or 0),
        "restartCount": int(run_meta.get("restartCount", 0) or 0),
        "maxRunSeconds": (
            float(run_meta.get("maxRunSeconds"))
            if run_meta.get("maxRunSeconds") is not None
            else None
        ),
        "runtimeSec": float(run_meta.get("runtimeSec", duration_seconds) or duration_seconds),
        "lowerBound": run_meta.get("lowerBound"),
        "boundScope": str(run_meta.get("boundScope") or "none"),
        "exactnessStatus": str(run_meta.get("exactnessStatus") or "heuristic_incumbent_only"),
        "proofModeEnabled": bool(run_meta.get("proofModeEnabled", False)),
        "routePoolSizeConsidered": run_meta.get("routePoolSizeConsidered"),
        "unsafePruningEnabled": bool(run_meta.get("unsafePruningEnabled", False)),
        "generationObjectiveHistory": list(run_meta.get("generationObjectiveHistory") or []),
        "bestHistory": list(run_meta.get("bestHistory") or []),
        "diversityHistory": list(run_meta.get("diversityHistory") or []),
    }



def _detect_delay_impossible_employee_ids(problem):
    employees = list(getattr(problem, "employees", []) or [])
    vehicles = list(getattr(problem, "vehicles", []) or [])
    metadata = getattr(problem, "metadata", {}) or {}
    preset_forced = _forced_unassigned_id_set(metadata)

    if not employees:
        return []
    if not vehicles:
        return sorted(str(getattr(e, "id", "")) for e in employees if str(getattr(e, "id", "")))

    impossible = []
    for emp in employees:
        emp_id = str(getattr(emp, "id", "")).strip()
        if not emp_id or emp_id in preset_forced:
            continue

        max_allowed_delay = float(get_max_allowed_delay(getattr(emp, "priority", 3), metadata))
        latest_allowed_minute = float(getattr(emp, "latest_drop", 0.0)) + max_allowed_delay
        feasible_for_any_vehicle = False

        for veh in vehicles:
            try:
                to_pick_min = float(
                    calculate_travel_time(
                        get_distance(getattr(veh, "start_loc", None), getattr(emp, "pickup_loc", None)),
                        float(getattr(veh, "speed_kmph", 0.0)),
                    )
                )
                pick_arrival = max(
                    float(getattr(veh, "avail_from", 0.0)) + to_pick_min,
                    float(getattr(emp, "earliest_pickup", 0.0)),
                )
                to_drop_min = float(
                    calculate_travel_time(
                        get_distance(getattr(emp, "pickup_loc", None), getattr(emp, "drop_loc", None)),
                        float(getattr(veh, "speed_kmph", 0.0)),
                    )
                )
                drop_arrival = pick_arrival + to_drop_min
            except Exception:
                continue

            if drop_arrival != drop_arrival or drop_arrival == float("inf"):
                continue
            if drop_arrival <= latest_allowed_minute + 1e-9:
                feasible_for_any_vehicle = True
                break

        if not feasible_for_any_vehicle:
            impossible.append(emp_id)

    return sorted(impossible)


def load_problem(args):
    stdin_text = ""
    try:
        if not sys.stdin.isatty():
            stdin_text = sys.stdin.read().strip()
    except Exception:
        stdin_text = ""

    if stdin_text:
        payload = json.loads(stdin_text)
        canonical = payload.get("canonical") if isinstance(payload, dict) else payload
        if canonical is None:
            canonical = payload
        return JsonParser().load_from_canonical(canonical), True

    def _resolve_testcase_dir(raw_value: str) -> str:
        raw = str(raw_value or "").strip()
        if not raw:
            raw = "testcase1"
        expanded = os.path.expandvars(os.path.expanduser(raw))
        candidates = [expanded]

        engine_dir = os.path.dirname(os.path.abspath(__file__))
        if not os.path.isabs(expanded):
            candidates.append(os.path.join(engine_dir, expanded))

        required = ("employees.csv", "vehicles.csv", "metadata.csv", "baseline.csv")
        for candidate in candidates:
            candidate = os.path.abspath(candidate)
            if not os.path.isdir(candidate):
                continue
            if all(os.path.exists(os.path.join(candidate, name)) for name in required):
                return candidate

        msg = (
            f"Testcase directory not found or incomplete: {raw!r}. "
            "Expected employees.csv, vehicles.csv, metadata.csv, baseline.csv. "
            f"Tried: {', '.join(os.path.abspath(c) for c in candidates)}"
        )
        raise FileNotFoundError(msg)

    testcase_dir = _resolve_testcase_dir(getattr(args, "testcase", "testcase1"))
    fp = FileParser(
        os.path.join(testcase_dir, "employees.csv"),
        os.path.join(testcase_dir, "vehicles.csv"),
        os.path.join(testcase_dir, "metadata.csv"),
        os.path.join(testcase_dir, "baseline.csv"),
    )
    return fp.load_data(), False


@contextmanager
def redirect_stdout_to_stderr(enabled: bool):
    if not enabled:
        yield
        return
    orig_stdout = sys.stdout
    try:
        sys.stdout = sys.stderr
        yield
    finally:
        sys.stdout = orig_stdout


def _resolve_seed(args_seed, metadata):
    if args_seed is not None:
        return int(args_seed)
    for key in ("solver_seed", "seed", "rng_seed"):
        if key in (metadata or {}):
            try:
                return int(float((metadata or {}).get(key)))
            except Exception:
                continue
    return 123456


def _resolve_alns_iterations(args_alns, metadata, default_value):
    if args_alns is not None:
        return max(0, int(args_alns))
    raw = (
        (metadata or {}).get("alns_iterations")
        or (metadata or {}).get("ALNS_ITERATIONS")
        or (metadata or {}).get("solver_alns_iterations")
    )
    try:
        if raw is not None:
            return max(0, int(float(raw)))
    except Exception:
        pass
    return max(0, int(default_value))


def _parse_bool_arg(value):
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return None


def _is_truthy(value):
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    return text in ("1", "true", "yes", "on")


def _normalize_preference_relaxation(value, default="none"):
    text = str(value or "").strip().lower()
    if not text:
        return default
    if text in ("none", "off", "false", "no"):
        return "none"
    if text in ("sharing", "share"):
        return "sharing"
    if text in ("vehicle", "premium", "veh"):
        return "vehicle"
    if text == "both":
        return "both"
    return default


def _resolve_preference_relaxation(cli_value, metadata):
    if cli_value is not None:
        normalized = _normalize_preference_relaxation(cli_value, default=None)
        if normalized is None:
            raise ValueError(
                "Invalid --preference-relaxation value. Use one of: "
                "none, sharing, vehicle, premium, both."
            )
        return normalized

    meta = metadata or {}
    raw = meta.get("preference_relaxation")
    if raw is not None:
        return _normalize_preference_relaxation(raw, default="none")

    allow_sharing = _is_truthy(meta.get("ALLOW_SHARING_VIOLATION")) or _is_truthy(meta.get("allow_sharing_violation"))
    allow_premium = _is_truthy(meta.get("ALLOW_PREMIUM_MISMATCH")) or _is_truthy(meta.get("allow_premium_mismatch"))
    if allow_sharing and allow_premium:
        return "both"
    if allow_sharing:
        return "sharing"
    if allow_premium:
        return "vehicle"
    return "none"


def _apply_preference_relaxation(metadata, preference_relaxation):
    mode = _normalize_preference_relaxation(preference_relaxation, default="none")
    allow_sharing = mode in ("sharing", "both")
    allow_premium = mode in ("vehicle", "both")
    metadata["preference_relaxation"] = mode
    metadata["ALLOW_SHARING_VIOLATION"] = "true" if allow_sharing else "false"
    metadata["ALLOW_PREMIUM_MISMATCH"] = "true" if allow_premium else "false"
    metadata["allow_sharing_violation"] = bool(allow_sharing)
    metadata["allow_premium_mismatch"] = bool(allow_premium)
    return mode


def _build_exact_small_payload(
    problem,
    exact_result,
    metadata,
    requested_metric,
    distance_fallback_occurred,
    args,
):
    best_solution = exact_result.individual
    payload = solution_to_json(problem, best_solution)
    bound_info = compute_lower_bound(
        incumbent_objective=payload.get("objectiveScore"),
        solver_metadata=dict(getattr(best_solution, "metadata", {}) or {}),
    )
    payload["feasible"] = bool(is_solution_feasible(best_solution))
    payload["fullyAssigned"] = bool(is_solution_fully_assigned(best_solution))
    payload["assignmentStatus"] = assignment_status(best_solution)
    payload["status"] = classify_solution_status(best_solution)
    payload["incumbent_objective"] = bound_info.incumbent_objective
    payload["lower_bound"] = bound_info.lower_bound
    payload["optimality_gap_absolute"] = bound_info.optimality_gap_absolute
    payload["optimality_gap_percent"] = bound_info.optimality_gap_percent
    payload["exactness_status"] = bound_info.exactness_status
    payload["anytime_bounds_trace"] = list((getattr(best_solution, "metadata", {}) or {}).get("anytimeBoundsTrace") or [])
    payload["proof_mode_enabled"] = True
    payload["route_pool_size_considered"] = None
    payload["unsafe_pruning_enabled"] = False
    payload["distance_backend_requested"] = str(metadata.get("requested_distance_metric", requested_metric or "osrm"))
    payload["distance_backend_used"] = str(metadata.get("distance_metric", metadata.get("distance_method", "osrm")))
    payload["fallback_occurred"] = bool(distance_fallback_occurred)
    payload["stop_reason"] = str((getattr(best_solution, "metadata", {}) or {}).get("stopReason", "exact_small_complete"))
    payload["bound_scope"] = bound_info.bound_scope
    payload["exactSmallMode"] = True
    payload["exactSmallLimits"] = dict((getattr(best_solution, "metadata", {}) or {}).get("exactSmallLimits", {}) or {})
    payload["exactSmallStats"] = dict((getattr(best_solution, "metadata", {}) or {}).get("exactSmallStats", {}) or {})
    payload["solverRuns"] = []
    payload["solverRunsByOrder"] = []
    payload["objectiveTrend"] = []
    payload["runErrors"] = []
    payload["selectionPolicy"] = "exact_small_global_search"
    payload["solverConfig"] = {
        "intensity": args.intensity,
        "seed": int(_resolve_seed(args.seed, metadata)),
        "mode": "exact_small",
        "maxEmployees": int(payload["exactSmallLimits"].get("maxEmployees", 0) or 0),
        "maxVehicles": int(payload["exactSmallLimits"].get("maxVehicles", 0) or 0),
    }
    payload["objectiveWeights"] = {
        "cost": float(problem.cost_weight),
        "time": float(problem.time_weight),
    }
    payload["distance"] = get_distance_mode()
    return payload


def main():
    global SOLVER_POP_SIZE, SOLVER_GENERATIONS, SOLVER_ALNS_ITERATIONS

    argp = argparse.ArgumentParser(description="Optimization engine (stdin JSON or testcase CSV)")
    argp.add_argument('--testcase', default='testcase1')
    argp.add_argument('--runs', type=int, default=None)
    argp.add_argument('--max-workers', type=int, default=MAX_WORKERS)
    argp.add_argument('--intensity', choices=['low', 'medium', 'high', 'custom'], default='medium')
    argp.add_argument('--seed', type=int, default=None)
    argp.add_argument('--generations', type=int, default=None)
    argp.add_argument('--alns-iterations', type=int, default=None)
    argp.add_argument(
        '--distance-metric',
        '--distance-method',
        dest='distance_metric',
        type=str,
        default=None,
        help="Override distance metric (osrm or haversine) for this run.",
    )
    argp.add_argument('--route-pool-enabled', type=str, default=None)
    argp.add_argument('--route-pool-max-routes', type=int, default=None)
    argp.add_argument('--set-partition-time-limit-sec', type=float, default=None)
    argp.add_argument('--ortools-seed-assignment-enabled', type=str, default=None)
    argp.add_argument('--ortools-assign-time-limit-sec', type=float, default=None)
    argp.add_argument('--max-run-seconds', type=float, default=None)
    argp.add_argument('--time-limit-sec', type=float, default=None)
    argp.add_argument('--min-runtime-sec', type=float, default=None)
    argp.add_argument('--checkpoint-every-sec', type=float, default=None)
    argp.add_argument('--eps-rel', type=float, default=None)
    argp.add_argument('--stall-checkpoints', type=int, default=None)
    argp.add_argument('--early-stop-enabled', type=str, default=None)
    argp.add_argument('--compute-tier', choices=['free', 'premium'], default=None)
    argp.add_argument(
        '--preference-relaxation',
        '--relax-constraints',
        dest='preference_relaxation',
        type=str,
        default=None,
    )
    argp.add_argument('--exact-small-mode', type=str, default=None)
    argp.add_argument('--exact-small-max-employees', type=int, default=5)
    argp.add_argument('--exact-small-max-vehicles', type=int, default=3)
    args = argp.parse_args()

    problem, stdin_mode = load_problem(args)
    validation_errors = _validate_problem_for_solve(problem)
    if validation_errors:
        payload = {
            "status": "error",
            "error": "Invalid testcase for solve",
            "validationErrors": validation_errors,
        }
        if stdin_mode:
            sys.stdout.write(json.dumps(payload))
            return
        raise ValueError("; ".join(validation_errors))
    metadata = dict(getattr(problem, "metadata", {}) or {})
    if args.distance_metric is not None:
        metadata["distance_metric"] = str(args.distance_metric)
        metadata["distance_method"] = str(args.distance_metric)
    requested_metric = metadata.get("distance_metric") or metadata.get("distance_method")
    distance_fallback_occurred = False
    requested_compute_tier = _resolve_compute_tier(
        args.compute_tier or metadata.get("compute_tier") or metadata.get("requested_compute_tier")
    )

    route_pool_enabled = _parse_bool_arg(args.route_pool_enabled)
    if route_pool_enabled is not None:
        metadata["ROUTE_POOL_ENABLED"] = "true" if route_pool_enabled else "false"
    if args.route_pool_max_routes is not None:
        metadata["ROUTE_POOL_MAX_ROUTES"] = int(args.route_pool_max_routes)
    if args.set_partition_time_limit_sec is not None:
        metadata["SET_PARTITION_TIME_LIMIT_SEC"] = float(args.set_partition_time_limit_sec)

    seed_assignment_enabled = _parse_bool_arg(args.ortools_seed_assignment_enabled)
    if seed_assignment_enabled is not None:
        metadata["ORTOOLS_SEED_ASSIGNMENT_ENABLED"] = "true" if seed_assignment_enabled else "false"
    if args.ortools_assign_time_limit_sec is not None:
        metadata["ORTOOLS_ASSIGN_TIME_LIMIT_SEC"] = float(args.ortools_assign_time_limit_sec)
    if args.time_limit_sec is not None:
        metadata["TIME_LIMIT_SEC"] = float(args.time_limit_sec)
    if args.max_run_seconds is not None:
        metadata["TIME_LIMIT_SEC"] = float(args.max_run_seconds)
        metadata["MAX_RUN_SECONDS"] = float(args.max_run_seconds)
    if args.min_runtime_sec is not None:
        metadata["MIN_RUNTIME_SEC"] = float(args.min_runtime_sec)
    if args.checkpoint_every_sec is not None:
        metadata["CHECKPOINT_EVERY_SEC"] = float(args.checkpoint_every_sec)
    if args.eps_rel is not None:
        metadata["EPS_REL"] = float(args.eps_rel)
    if args.stall_checkpoints is not None:
        metadata["STALL_CHECKPOINTS"] = int(args.stall_checkpoints)
    early_stop_enabled = _parse_bool_arg(args.early_stop_enabled)
    if early_stop_enabled is not None:
        metadata["EARLY_STOP_ENABLED"] = "true" if early_stop_enabled else "false"
    _apply_intensity_stop_profile(metadata, args.intensity)
    try:
        preference_relaxation = _resolve_preference_relaxation(args.preference_relaxation, metadata)
    except ValueError as e:
        argp.error(str(e))
    _apply_preference_relaxation(metadata, preference_relaxation)
    metadata["COMPUTE_TIER"] = requested_compute_tier
    metadata["requested_compute_tier"] = requested_compute_tier
    metadata["requested_distance_metric"] = requested_metric or "osrm"

    metadata, large_case_context, large_case_profile = _apply_large_case_profile(
        problem,
        metadata,
        requested_compute_tier,
    )
    effective_distance_metric = (
        large_case_profile.get("force_distance_metric")
        if large_case_profile and large_case_profile.get("force_distance_metric")
        else metadata.get("distance_metric") or metadata.get("distance_method") or requested_metric
    )
    metadata["distance_metric"] = effective_distance_metric
    metadata["distance_method"] = effective_distance_metric

    configure_distance_metric(effective_distance_metric)
    strict_road_required = bool(get_distance_mode().get("strictRoad"))
    try:
        ensure_distance_backend_ready()
    except Exception as e:
        if strict_road_required:
            raise RuntimeError(
                f"Road distance backend is required but unavailable: {e}"
            ) from e
        configure_distance_metric("haversine")
        metadata["distance_metric"] = "haversine"
        metadata["distance_method"] = "haversine"
        distance_fallback_occurred = True
        with redirect_stdout_to_stderr(stdin_mode):
            print(f"[engine] distance backend unavailable, falling back to haversine: {e}")

    # Fast pre-check: mark employees as forced-unassigned when no vehicle can
    # satisfy their delay limit even in a dedicated direct trip.
    problem.metadata = metadata
    preset_forced = _forced_unassigned_id_set(metadata)
    detected_forced = set(_detect_delay_impossible_employee_ids(problem))
    all_forced = sorted(preset_forced | detected_forced)
    if all_forced:
        metadata["FORCED_UNASSIGNED_IDS"] = ",".join(all_forced)
    else:
        metadata.pop("FORCED_UNASSIGNED_IDS", None)

    problem.metadata = metadata
    solver_cfg = _derive_solver_config(problem, args.intensity, args.runs)
    if args.generations is not None:
        solver_cfg["generations"] = max(5, int(args.generations))
        solver_cfg["min_generation_floor"] = int(solver_cfg["generations"])
        metadata["MIN_GENERATION_FLOOR"] = int(solver_cfg["generations"])
        problem.metadata = metadata
    base_seed = _resolve_seed(args.seed, metadata)
    SOLVER_ALNS_ITERATIONS = _resolve_alns_iterations(
        args.alns_iterations,
        metadata,
        solver_cfg.get('alns_iterations', SOLVER_ALNS_ITERATIONS),
    )
    if large_case_profile is not None:
        solver_cfg["runs"] = int(large_case_profile["runs"])
        solver_cfg["pop_size"] = int(large_case_profile["pop_size"])
        solver_cfg["generations"] = int(large_case_profile["generations"])
        SOLVER_ALNS_ITERATIONS = int(large_case_profile["alns_iterations"])
    runs = int(solver_cfg['runs'])
    SOLVER_POP_SIZE = int(solver_cfg['pop_size'])
    SOLVER_GENERATIONS = int(solver_cfg['generations'])
    effective_max_workers = args.max_workers
    if large_case_profile is not None:
        if requested_compute_tier == "free":
            effective_max_workers = 1
        elif effective_max_workers is None:
            effective_max_workers = min(2, runs)
        else:
            effective_max_workers = max(1, min(int(effective_max_workers), runs, 2))
    elif effective_max_workers is None:
        effective_max_workers = min(runs, _default_executor_workers(stdin_mode))
    else:
        effective_max_workers = max(1, min(int(effective_max_workers), runs))

    explicit_time_limit = "TIME_LIMIT_SEC" in metadata or "MAX_RUN_SECONDS" in metadata
    project_time_limit_sec = float(
        metadata.get(
            "TIME_LIMIT_SEC",
            metadata.get("MAX_RUN_SECONDS", solver_cfg.get("time_limit_sec", 25.0)),
        )
    )
    if not explicit_time_limit:
        project_time_limit_sec = float(solver_cfg.get("time_limit_sec", project_time_limit_sec))
    run_batches = max(1, int(math.ceil(float(runs) / float(max(1, effective_max_workers)))))
    per_run_time_limit_sec = max(1.0, float(project_time_limit_sec) / float(run_batches))
    metadata["PROJECT_TIME_LIMIT_SEC"] = float(project_time_limit_sec)
    metadata["TIME_LIMIT_SEC"] = float(per_run_time_limit_sec)
    metadata["MAX_RUN_SECONDS"] = float(per_run_time_limit_sec)
    problem.metadata = metadata

    with redirect_stdout_to_stderr(stdin_mode):
        print(
            f"[engine] intensity={args.intensity} runs={runs} pop_size={SOLVER_POP_SIZE} "
            f"generations={SOLVER_GENERATIONS} generation_scale={solver_cfg.get('generation_scale')} "
            f"seed={base_seed} alns_iterations={SOLVER_ALNS_ITERATIONS} "
            f"min_gen_floor={solver_cfg.get('min_generation_floor')} "
            f"min_runtime_floor_sec={solver_cfg.get('min_runtime_floor_sec')}"
        )
        print(
            "[engine] hybrid "
            f"route_pool={metadata.get('ROUTE_POOL_ENABLED', 'true')} "
            f"route_pool_max={metadata.get('ROUTE_POOL_MAX_ROUTES', '700')} "
            f"set_partition_tl={metadata.get('SET_PARTITION_TIME_LIMIT_SEC', '20')} "
            f"seed_assignment={metadata.get('ORTOOLS_SEED_ASSIGNMENT_ENABLED', 'true')} "
            f"seed_assign_tl={metadata.get('ORTOOLS_ASSIGN_TIME_LIMIT_SEC', '8')} "
            f"project_time_limit_sec={metadata.get('PROJECT_TIME_LIMIT_SEC', metadata.get('TIME_LIMIT_SEC', metadata.get('MAX_RUN_SECONDS', '25')))} "
            f"per_run_time_limit_sec={metadata.get('TIME_LIMIT_SEC', metadata.get('MAX_RUN_SECONDS', '25'))} "
            f"min_runtime_sec={metadata.get('MIN_RUNTIME_SEC', '4')} "
            f"checkpoint_sec={metadata.get('CHECKPOINT_EVERY_SEC', '3')} "
            f"min_early_stop_gen={metadata.get('MIN_EARLY_STOP_GENERATIONS', '20')}"
        )
        print(
            "[engine] preferences "
            f"relaxation={metadata.get('preference_relaxation', 'none')} "
            f"allow_sharing={metadata.get('ALLOW_SHARING_VIOLATION', 'false')} "
            f"allow_premium={metadata.get('ALLOW_PREMIUM_MISMATCH', 'false')}"
        )
        print(
            "[engine] mode "
            f"compute_tier={requested_compute_tier} "
            f"large_case={large_case_context.get('is_large')} "
            f"employees={large_case_context.get('employee_count')} "
            f"vehicles={large_case_context.get('vehicle_count')} "
            f"unique_locations={large_case_context.get('unique_locations')} "
            f"workers={effective_max_workers if effective_max_workers is not None else 'auto'}"
        )
        print(
            "[engine] complexity "
            f"employees={solver_cfg['meta']['n_emp']} vehicles={solver_cfg['meta']['n_veh']} "
            f"emp_per_vehicle={solver_cfg['meta']['emp_per_vehicle']:.2f} "
            f"avg_window={solver_cfg['meta']['avg_window']:.1f}min "
            f"hard_ratio={solver_cfg['meta']['hard_ratio']:.2f}"
        )
        if all_forced:
            print(
                "[engine] precheck "
                f"forced_unassigned_by_delay={len(all_forced)} ids={','.join(all_forced)}"
            )
        mode = get_distance_mode()
        print(
            "[engine] distance "
            f"metric={mode.get('metric')} backend={mode.get('backend')} "
            f"strict_road={mode.get('strictRoad')} osrm_base={mode.get('osrmBaseUrl')} "
            f"osrm_profile={mode.get('osrmProfile')}"
        )

    # Any prints during preprocessing should not pollute stdout in stdin_mode
    with redirect_stdout_to_stderr(stdin_mode):
        all_locations = []
        for emp in problem.employees:
            all_locations.append(emp.pickup_loc)
            all_locations.append(emp.drop_loc)
        for veh in problem.vehicles:
            all_locations.append(veh.start_loc)
        if _is_truthy(metadata.get("SKIP_DISTANCE_PRECOMPUTE")):
            print("[engine] precompute skipped due to large-case profile")
        else:
            try:
                precompute_distance_matrix(all_locations)
            except Exception as e:
                if strict_road_required:
                    raise RuntimeError(
                        f"Road distance precompute failed and fallback is disabled: {e}"
                    ) from e
                configure_distance_metric("haversine")
                metadata["distance_metric"] = "haversine"
                metadata["distance_method"] = "haversine"
                distance_fallback_occurred = True
                print(f"[engine] precompute failed, continuing with haversine fallback: {e}")

    exact_small_requested = _parse_bool_arg(args.exact_small_mode)
    if exact_small_requested is None:
        exact_small_requested = _is_truthy(metadata.get("EXACT_SMALL_MODE"))
    if exact_small_requested:
        limits = ExactSmallLimits(
            max_employees=max(1, int(args.exact_small_max_employees)),
            max_vehicles=max(1, int(args.exact_small_max_vehicles)),
        )
        exact_result = solve_exact_small(problem, limits=limits)
        if exact_result.status != "optimal" or exact_result.individual is None:
            sys.stdout.write(
                json.dumps(
                    {
                        "status": "error",
                        "error": exact_result.message or "exact-small mode rejected the instance",
                        "exactSmallMode": True,
                        "exactSmallStatus": exact_result.status,
                        "proof_mode_enabled": True,
                        "incumbent_objective": None,
                        "lower_bound": None,
                        "optimality_gap_absolute": None,
                        "optimality_gap_percent": None,
                        "exactness_status": "heuristic_incumbent_only",
                        "bound_scope": "none",
                        "route_pool_size_considered": None,
                        "unsafe_pruning_enabled": False,
                        "stop_reason": "exact_small_rejected",
                        "exactSmallLimits": {
                            "maxEmployees": int(limits.max_employees),
                            "maxVehicles": int(limits.max_vehicles),
                        },
                        "employeeCount": int(len(getattr(problem, "employees", []) or [])),
                        "vehicleCount": int(len(getattr(problem, "vehicles", []) or [])),
                        "distance_backend_requested": str(metadata.get("requested_distance_metric", requested_metric or "osrm")),
                        "distance_backend_used": str(metadata.get("distance_metric", metadata.get("distance_method", "osrm"))),
                        "fallback_occurred": bool(distance_fallback_occurred),
                    }
                )
            )
            return
        payload = _build_exact_small_payload(
            problem=problem,
            exact_result=exact_result,
            metadata=metadata,
            requested_metric=requested_metric,
            distance_fallback_occurred=distance_fallback_occurred,
            args=args,
        )
        sys.stdout.write(json.dumps(payload, default=str))
        return

    # IMPORTANT:
    # - Worker prints are redirected to stderr inside `run_single_solver`, so
    #   stdout remains clean for the final JSON payload in both modes.
    # - Prefer process-based parallelism for this CPU-bound solver.
    results = []
    run_errors = []

    with redirect_stdout_to_stderr(stdin_mode):
        def run_with_executor(executor_cls):
            local_results = []
            shared_tracker = (
                SharedRunProgressTracker()
                if executor_cls is concurrent.futures.ThreadPoolExecutor
                else None
            )
            with executor_cls(max_workers=effective_max_workers) as executor:
                futures = {
                    executor.submit(
                        run_single_solver,
                        i,
                        problem,
                        base_seed,
                        SOLVER_ALNS_ITERATIONS,
                        SOLVER_POP_SIZE,
                        SOLVER_GENERATIONS,
                        shared_tracker,
                    ): i
                    for i in range(1, runs + 1)
                }
                for future in concurrent.futures.as_completed(futures):
                    try:
                        res = future.result()
                        if isinstance(res, dict) and "solution" in res:
                            local_results.append(res)
                    except Exception as exc:
                        run_errors.append(str(exc))
            return local_results

        try:
            results = run_with_executor(concurrent.futures.ProcessPoolExecutor)
        except (PermissionError, OSError) as e:
            print(f"[engine] process pool unavailable ({e}), falling back to threads")
            results = run_with_executor(concurrent.futures.ThreadPoolExecutor)

    if not results:
        sys.stdout.write(json.dumps({
            "status": "error",
            "error": "No solutions produced",
            "runErrors": run_errors,
        }))
        return

    run_summaries = [summarize_solver_run(r) for r in results]
    runs_by_objective = sorted(run_summaries, key=lambda x: x.get("searchObjectiveScore", x.get("objectiveScore", float("inf"))))
    runs_by_order = sorted(run_summaries, key=lambda x: x.get("runId", 0))

    best_so_far_obj = float("inf")
    best_so_far_search_obj = float("inf")
    best_so_far_cost = float("inf")
    objective_trend = []
    for row in runs_by_order:
        obj = float(row.get("objectiveScore", float("inf")))
        search_obj = float(row.get("searchObjectiveScore", obj))
        cost = float(row.get("totalSystemCost", float("inf")))
        best_so_far_obj = min(best_so_far_obj, obj)
        best_so_far_search_obj = min(best_so_far_search_obj, search_obj)
        best_so_far_cost = min(best_so_far_cost, cost)
        objective_trend.append({
            "runId": int(row.get("runId", 0)),
            "objectiveScore": obj,
            "bestObjectiveSoFar": float(best_so_far_obj),
            "searchObjectiveScore": search_obj,
            "bestSearchObjectiveSoFar": float(best_so_far_search_obj),
            "totalSystemCost": cost,
            "bestCostSoFar": float(best_so_far_cost),
        })

    feasible_results = []
    for row in results:
        solution = row.get("solution")
        if solution is None:
            continue
        try:
            if is_solution_feasible(solution):
                feasible_results.append(row)
        except Exception:
            continue

    selection_pool = feasible_results if feasible_results else results
    best_solution = min(selection_pool, key=lambda x: x["solution"].objective_score)["solution"]
    payload = solution_to_json(problem, best_solution)
    bound_info = compute_lower_bound(
        incumbent_objective=payload.get("objectiveScore"),
        solver_metadata=dict(getattr(best_solution, "metadata", {}) or {}),
    )
    objective_cost_weight = float(problem.cost_weight)
    objective_time_weight = float(problem.time_weight)
    bypass_size_floors = bool(_is_truthy(metadata.get("BYPASS_SOLVER_SIZE_FLOORS")))
    configured_time_limit_sec = float(metadata.get("TIME_LIMIT_SEC", metadata.get("MAX_RUN_SECONDS", 25)))
    configured_project_time_limit_sec = float(metadata.get("PROJECT_TIME_LIMIT_SEC", configured_time_limit_sec))
    configured_min_runtime_sec = float(metadata.get("MIN_RUNTIME_SEC", 4))
    configured_min_early_stop_generations = int(float(metadata.get("MIN_EARLY_STOP_GENERATIONS", 20)))
    if not bypass_size_floors:
        configured_min_early_stop_generations = max(configured_min_early_stop_generations, int(float(solver_cfg.get("min_generation_floor", 20))))
    configured_min_runtime_sec = min(configured_min_runtime_sec, configured_time_limit_sec)
    payload["solverRuns"] = runs_by_objective
    payload["solverRunsByOrder"] = runs_by_order
    payload["objectiveTrend"] = objective_trend
    payload["runErrors"] = run_errors
    payload["feasible"] = bool(is_solution_feasible(best_solution))
    payload["fullyAssigned"] = bool(is_solution_fully_assigned(best_solution))
    payload["assignmentStatus"] = assignment_status(best_solution)
    payload["status"] = classify_solution_status(best_solution)
    payload["incumbent_objective"] = bound_info.incumbent_objective
    payload["lower_bound"] = bound_info.lower_bound
    payload["optimality_gap_absolute"] = bound_info.optimality_gap_absolute
    payload["optimality_gap_percent"] = bound_info.optimality_gap_percent
    payload["exactness_status"] = bound_info.exactness_status
    payload["exactness_status_v2"] = str((getattr(best_solution, "metadata", {}) or {}).get("exactnessStatusV2") or "")
    payload["anytime_bounds_trace"] = list((getattr(best_solution, "metadata", {}) or {}).get("anytimeBoundsTrace") or [])
    payload["proof_mode_enabled"] = bool((getattr(best_solution, "metadata", {}) or {}).get("proofModeEnabled", False))
    payload["route_pool_size_considered"] = (getattr(best_solution, "metadata", {}) or {}).get("routePoolSizeConsidered")
    payload["unsafe_pruning_enabled"] = bool((getattr(best_solution, "metadata", {}) or {}).get("unsafePruningEnabled", False))
    payload["distance_backend_requested"] = str(metadata.get("requested_distance_metric", requested_metric or "osrm"))
    payload["distance_backend_used"] = str(metadata.get("distance_metric", metadata.get("distance_method", "osrm")))
    payload["fallback_occurred"] = bool(distance_fallback_occurred)
    payload["stop_reason"] = str((getattr(best_solution, "metadata", {}) or {}).get("stopReason", ""))
    payload["bound_scope"] = bound_info.bound_scope
    payload["selectionPolicy"] = "best_feasible_only" if feasible_results else "best_infeasible_fallback"
    payload["solverConfig"] = {
        "intensity": args.intensity,
        "runs": runs,
        "maxWorkers": effective_max_workers,
        "popSize": SOLVER_POP_SIZE,
        "generations": SOLVER_GENERATIONS,
        "generationScale": float(solver_cfg.get("generation_scale", 1.0)),
        "minGenerationFloor": int(solver_cfg.get("min_generation_floor", 20)),
        "minRuntimeFloorSec": float(solver_cfg.get("min_runtime_floor_sec", 0.0)),
        "seed": int(base_seed),
        "alnsIterations": int(SOLVER_ALNS_ITERATIONS),
        "routePoolEnabled": str(metadata.get("ROUTE_POOL_ENABLED", "true")).strip().lower() in ("1", "true", "yes", "on"),
        "routePoolPruningMode": str(metadata.get("ROUTE_POOL_PRUNING_MODE", "safe" if str(metadata.get("ROUTE_POOL_SAFE_MODE", "false")).strip().lower() in ("1", "true", "yes", "on") else "heuristic")),
        "routePoolMaxRoutes": int(float(metadata.get("ROUTE_POOL_MAX_ROUTES", 700))),
        "setPartitionTimeLimitSec": float(metadata.get("SET_PARTITION_TIME_LIMIT_SEC", 20)),
        "seedAssignmentEnabled": str(metadata.get("ORTOOLS_SEED_ASSIGNMENT_ENABLED", "true")).strip().lower() in ("1", "true", "yes", "on"),
        "seedAssignmentTimeLimitSec": float(metadata.get("ORTOOLS_ASSIGN_TIME_LIMIT_SEC", 8)),
        "projectTimeLimitSec": float(configured_project_time_limit_sec),
        "timeLimitSec": float(configured_time_limit_sec),
        "maxRunSeconds": float(configured_time_limit_sec),
        "minRuntimeSec": float(configured_min_runtime_sec),
        "checkpointEverySec": float(metadata.get("CHECKPOINT_EVERY_SEC", 3)),
        "epsRel": float(metadata.get("EPS_REL", 0.0002)),
        "stallCheckpoints": int(float(metadata.get("STALL_CHECKPOINTS", 6))),
        "diversityMin": float(metadata.get("DIVERSITY_MIN", 0.06)),
        "burstSec": float(metadata.get("BURST_SEC", 6.0)),
        "minEarlyStopGenerations": int(configured_min_early_stop_generations),
        "stagnationGraceGenerations": int(float(metadata.get("STAGNATION_GRACE_GENERATIONS", 10))),
        "bestRunGraceGenerations": int(float(metadata.get("BEST_RUN_GRACE_GENERATIONS", 24))),
        "crossRunTargetRelGap": float(metadata.get("CROSS_RUN_TARGET_REL_GAP", 0.015)),
        "crossRunTargetAbsGap": float(metadata.get("CROSS_RUN_TARGET_ABS_GAP", 0.5)),
        "distanceMetric": str(metadata.get("distance_metric", metadata.get("distance_method", "osrm"))),
        "requestedDistanceMetric": str(metadata.get("requested_distance_metric", requested_metric or "osrm")),
        "computeTier": requested_compute_tier,
        "largeCaseMode": str(metadata.get("LARGE_CASE_MODE", "")),
        "largeCase": bool(large_case_context.get("is_large")),
        "uniqueLocations": int(large_case_context.get("unique_locations", 0)),
        "precomputeSkipped": bool(_is_truthy(metadata.get("SKIP_DISTANCE_PRECOMPUTE"))),
        "preferenceRelaxation": str(metadata.get("preference_relaxation", "none")),
        "allowSharingViolation": str(metadata.get("ALLOW_SHARING_VIOLATION", "false")).strip().lower() in ("1", "true", "yes", "on"),
        "allowPremiumMismatch": str(metadata.get("ALLOW_PREMIUM_MISMATCH", "false")).strip().lower() in ("1", "true", "yes", "on"),
        "objectiveCostWeight": objective_cost_weight,
        "objectiveTimeWeight": objective_time_weight,
    }
    payload["objectiveWeights"] = {
        "cost": objective_cost_weight,
        "time": objective_time_weight,
    }
    payload["distance"] = get_distance_mode()
    payload["solveMode"] = {
        "computeTier": requested_compute_tier,
        "largeCase": bool(large_case_context.get("is_large")),
        "mode": str(metadata.get("LARGE_CASE_MODE", "standard") or "standard"),
        "quality": ("fast" if requested_compute_tier == "free" and large_case_context.get("is_large") else ("premium" if requested_compute_tier == "premium" and large_case_context.get("is_large") else "standard")),
        "employeeCount": int(large_case_context.get("employee_count", 0)),
        "vehicleCount": int(large_case_context.get("vehicle_count", 0)),
        "uniqueLocations": int(large_case_context.get("unique_locations", 0)),
        "timeBudgetSec": float(metadata.get("TIME_LIMIT_SEC", metadata.get("MAX_RUN_SECONDS", 25))),
        "requestedDistanceMetric": str(metadata.get("requested_distance_metric", requested_metric or "osrm")),
        "effectiveDistanceMetric": str(metadata.get("distance_metric", metadata.get("distance_method", "osrm"))),
        "upgradeOffer": {
            "available": bool(large_case_context.get("is_large") and requested_compute_tier == "free"),
            "premiumComputeTier": "premium",
            "freeTimeBudgetSec": float(FREE_LARGE_CASE_MAX_RUNTIME_SEC),
            "premiumTimeBudgetSec": float(PREMIUM_LARGE_CASE_MAX_RUNTIME_SEC),
            "headline": "Find a better solution with Premium Large-Case Search",
            "message": "This large testcase ran in fast mode with a 120-second budget. Premium reruns the same testcase with a 20-minute search budget and stronger search settings.",
        },
    }
    sys.stdout.write(json.dumps(payload, default=str))


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
