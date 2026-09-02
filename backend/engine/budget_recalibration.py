from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple


def _clamp_int(value: float, lo: int, hi: int) -> int:
    return max(int(lo), min(int(hi), int(round(float(value)))))


def _clamp_float(value: float, lo: float, hi: float) -> float:
    return max(float(lo), min(float(hi), float(value)))


def physical_cores() -> int:
    return max(1, int(os.cpu_count() or 1))


def runs_for_time_budget_sec(T: float) -> int:
    """Implements the user-provided piecewise runs(T) schedule.

    Note: runs(T) is undefined for T < 45 in the prompt; we choose 2 as a
    conservative minimum for multi-start robustness.
    """
    T = float(T)
    if T < 45:
        return 2
    if T < 90:
        return 3
    if T < 150:
        return 4
    if T < 240:
        return 5
    if T < 360:
        return 6
    return 7


def runs_final(T: float, cores: int) -> int:
    base = runs_for_time_budget_sec(T)
    cap = max(2, int(cores) - 1)
    return int(min(base, cap))


def pop_size(E: int, T: float) -> int:
    E = max(0, int(E))
    T = float(T)
    raw = 24.0 + 1.5 * math.sqrt(float(E)) + 0.04 * float(T)
    out = _clamp_int(raw, 24, 56)

    if T < 90:
        out = min(out, 32)
    elif T < 180:
        out = min(out, 40)
    elif T < 300:
        out = min(out, 48)
    else:
        out = min(out, 56)

    return int(max(24, out))


def planned_generations_fallback_band(T: float) -> Tuple[int, int]:
    T = float(T)
    if T < 90:
        return 8, 12
    if T < 180:
        return 18, 30
    if T < 300:
        return 28, 45
    return 40, 70


def planned_generations_fallback(T: float) -> int:
    lo, hi = planned_generations_fallback_band(T)
    # Deterministic midpoint for reproducibility.
    return int(round((lo + hi) / 2.0))


def planned_generations_from_throughput(
    *,
    T: float,
    sec_per_generation: float,
    reserve_ratio: float = 0.18,
) -> Tuple[int, Dict[str, float]]:
    """Compute planned generations from measured throughput.

    Returns (planned_generations, debug_info).
    """
    T = max(0.0, float(T))
    sec_per_generation = max(1e-6, float(sec_per_generation))
    reserve_ratio = _clamp_float(float(reserve_ratio), 0.0, 0.8)

    usable_time = T * (1.0 - reserve_ratio)
    reachable = int(math.floor(usable_time / sec_per_generation)) if usable_time > 0 else 0
    planned = _clamp_int(0.85 * float(reachable), 8, 80)
    return planned, {
        "secPerGeneration": float(sec_per_generation),
        "reserveRatio": float(reserve_ratio),
        "usableTimeSec": float(usable_time),
        "reachableGenerations": float(reachable),
    }


def stagnation_limit(planned_generations: int) -> int:
    return max(5, int(round(0.28 * max(1, int(planned_generations)))))


def plateau_patience(planned_generations: int) -> int:
    # Mapped from "early_stop_patience" in the prompt; the engine uses plateau
    # patience to trigger intensification/escape behaviour.
    return max(4, int(round(0.18 * max(1, int(planned_generations)))))


def restart_after_nonimproving(planned_generations: int) -> int:
    return max(6, int(round(0.35 * max(1, int(planned_generations)))))


def max_restarts_for_time_budget_sec(T: float) -> int:
    T = float(T)
    if T < 90:
        return 0
    if T < 240:
        return 1
    return 2


def alns_iterations(pop: int) -> int:
    return _clamp_int(8.0 + 0.18 * float(max(0, int(pop))), 10, 18)


def elite_size(pop: int) -> int:
    return _clamp_int(float(max(0, int(pop))) / 10.0, 3, 5)


def set_partition_time_limit_sec(T: float) -> float:
    T = float(T)
    if T < 60:
        return 0.0
    if T < 120:
        return float(min(4.0, 0.08 * T))
    if T < 240:
        return float(min(8.0, 0.10 * T))
    return float(min(12.0, 0.12 * T))


@dataclass(frozen=True)
class BudgetRecommendation:
    time_budget_sec: float
    employees: int
    cores: int
    runs: int
    pop_size: int
    planned_generations: int
    stagnation_limit: int
    plateau_patience_generations: int
    restart_after_nonimproving: int
    max_restarts: int
    alns_iterations: int
    elite_size: int
    set_partition_time_limit_sec: float


def recommend_budget(
    *,
    employees: int,
    time_budget_sec: float,
    cores: Optional[int] = None,
) -> BudgetRecommendation:
    E = max(0, int(employees))
    T = max(0.0, float(time_budget_sec))
    cores = int(cores) if cores is not None else physical_cores()

    r = runs_final(T, cores=cores)
    pop = pop_size(E, T)
    planned = planned_generations_fallback(T)

    return BudgetRecommendation(
        time_budget_sec=float(T),
        employees=int(E),
        cores=int(cores),
        runs=int(r),
        pop_size=int(pop),
        planned_generations=int(planned),
        stagnation_limit=int(stagnation_limit(planned)),
        plateau_patience_generations=int(plateau_patience(planned)),
        restart_after_nonimproving=int(restart_after_nonimproving(planned)),
        max_restarts=int(max_restarts_for_time_budget_sec(T)),
        alns_iterations=int(alns_iterations(pop)),
        elite_size=int(elite_size(pop)),
        set_partition_time_limit_sec=float(set_partition_time_limit_sec(T)),
    )


def is_budget_recalibration_enabled(metadata: Dict[str, Any]) -> bool:
    meta = dict(metadata or {})
    raw = meta.get("BUDGET_RECALIBRATION_ENABLED", meta.get("budget_recalibration_enabled", False))
    if isinstance(raw, bool):
        return bool(raw)
    return str(raw).strip().lower() in ("1", "true", "yes", "on")

