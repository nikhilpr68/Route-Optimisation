from __future__ import annotations

import math
import os
import sys
import time
from typing import Dict, List, Optional, Tuple

from models import ProblemInstance
from utils import get_distance

def _ortools_disabled() -> bool:
    raw = str(os.getenv("ENGINE_DISABLE_ORTOOLS", "")).strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    # Local Python 3.13 builds have shown hard native crashes while importing
    # OR-Tools/protobuf. Fall back automatically instead of aborting the run.
    if sys.version_info >= (3, 13):
        return True
    return False


if _ortools_disabled():
    cp_model = None
else:
    try:
        from ortools.sat.python import cp_model  # type: ignore
    except Exception:
        cp_model = None


def build_assignment_seed(
    problem: ProblemInstance,
    time_limit_sec: float = 8.0,
    seed: int = 123456,
) -> Dict[str, object]:
    """
    Build an employee -> vehicle assignment seed.

    Uses OR-Tools CP-SAT when available; otherwise deterministic greedy fallback.
    """
    start = time.perf_counter()
    if cp_model is not None:
        sat_result = _cp_sat_assignment(problem, time_limit_sec=time_limit_sec, seed=seed)
        if sat_result.get("assignment"):
            sat_result.setdefault("solveTimeSec", float(max(0.0, time.perf_counter() - start)))
            return sat_result

    fallback = _greedy_assignment(problem)
    fallback["backend"] = "greedy_fallback"
    fallback.setdefault("status", "fallback")
    fallback.setdefault("timeLimitSec", float(time_limit_sec))
    fallback.setdefault("seed", int(seed))
    fallback.setdefault("solveTimeSec", float(max(0.0, time.perf_counter() - start)))
    return fallback


def _cp_sat_assignment(
    problem: ProblemInstance,
    time_limit_sec: float,
    seed: int,
) -> Dict[str, object]:
    solve_start = time.perf_counter()
    model = cp_model.CpModel()

    employees = list(problem.employees)
    vehicles = list(problem.vehicles)
    if not employees or not vehicles:
        return {
            "assignment": {},
            "status": "empty_problem",
            "backend": "ortools_cp_sat",
            "seed": int(seed),
            "timeLimitSec": float(time_limit_sec),
            "solveTimeSec": float(max(0.0, time.perf_counter() - solve_start)),
        }

    y = {}
    u = {}

    for e_idx, employee in enumerate(employees):
        u[e_idx] = model.NewBoolVar(f"u_{employee.id}")
        vars_for_employee = [u[e_idx]]
        for v_idx, vehicle in enumerate(vehicles):
            var = model.NewBoolVar(f"y_{employee.id}_{vehicle.id}")
            y[(e_idx, v_idx)] = var

            # Premium compatibility hard in seed assignment.
            e_pref = str(employee.vehicle_pref or "").strip().lower()
            v_cat = str(vehicle.category or "").strip().lower()
            if e_pref == "premium" and v_cat != "premium":
                model.Add(var == 0)
            vars_for_employee.append(var)

        model.Add(sum(vars_for_employee) == 1)

    for v_idx, vehicle in enumerate(vehicles):
        model.Add(sum(y[(e_idx, v_idx)] for e_idx in range(len(employees))) <= int(vehicle.capacity))

    objective_terms = []
    # Keep seed generation aligned with the main evaluator: leaving an employee
    # unassigned should be a last resort, not a normal trade-off.
    unassigned_penalty = 5_000_000_000

    for e_idx, employee in enumerate(employees):
        objective_terms.append(unassigned_penalty * u[e_idx])
        for v_idx, vehicle in enumerate(vehicles):
            proxy = _assignment_proxy_cost(employee, vehicle)
            objective_terms.append(proxy * y[(e_idx, v_idx)])

    model.Minimize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.2, float(time_limit_sec))
    solver.parameters.random_seed = int(seed)
    solver.parameters.num_search_workers = 1

    status = solver.Solve(model)
    status_name = {
        cp_model.OPTIMAL: "optimal",
        cp_model.FEASIBLE: "feasible",
        cp_model.INFEASIBLE: "infeasible",
        cp_model.MODEL_INVALID: "model_invalid",
        cp_model.UNKNOWN: "unknown",
    }.get(status, f"status_{status}")

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {
            "assignment": {},
            "status": status_name,
            "backend": "ortools_cp_sat",
            "seed": int(seed),
            "timeLimitSec": float(time_limit_sec),
            "solveTimeSec": float(max(0.0, time.perf_counter() - solve_start)),
        }

    assignment: Dict[str, Optional[str]] = {}
    unassigned_ids: List[str] = []

    for e_idx, employee in enumerate(employees):
        if solver.Value(u[e_idx]) > 0:
            assignment[str(employee.id)] = None
            unassigned_ids.append(str(employee.id))
            continue

        assigned_vehicle_id = None
        for v_idx, vehicle in enumerate(vehicles):
            if solver.Value(y[(e_idx, v_idx)]) > 0:
                assigned_vehicle_id = str(vehicle.id)
                break
        assignment[str(employee.id)] = assigned_vehicle_id

    return {
        "assignment": assignment,
        "status": status_name,
        "backend": "ortools_cp_sat",
        "seed": int(seed),
        "timeLimitSec": float(time_limit_sec),
        "unassigned": unassigned_ids,
        "solveTimeSec": float(max(0.0, time.perf_counter() - solve_start)),
    }


def _greedy_assignment(problem: ProblemInstance) -> Dict[str, object]:
    employees = sorted(
        problem.employees,
        key=lambda e: (
            e.priority,
            e.latest_drop - e.earliest_pickup,
            str(e.id),
        ),
    )
    vehicles = list(problem.vehicles)

    remaining_capacity = {str(vehicle.id): int(vehicle.capacity) for vehicle in vehicles}
    assignment: Dict[str, Optional[str]] = {}
    unassigned: List[str] = []

    for employee in employees:
        choices: List[Tuple[float, str]] = []
        for vehicle in vehicles:
            vehicle_id = str(vehicle.id)
            if remaining_capacity[vehicle_id] <= 0:
                continue

            e_pref = str(employee.vehicle_pref or "").strip().lower()
            v_cat = str(vehicle.category or "").strip().lower()
            if e_pref == "premium" and v_cat != "premium":
                continue

            proxy_cost = _assignment_proxy_cost(employee, vehicle)
            fill_ratio = 1.0 - (remaining_capacity[vehicle_id] / max(1, vehicle.capacity))
            score = proxy_cost * (1.0 + (0.08 * fill_ratio))
            choices.append((score, vehicle_id))

        if not choices:
            assignment[str(employee.id)] = None
            unassigned.append(str(employee.id))
            continue

        choices.sort(key=lambda row: (row[0], row[1]))
        _, vehicle_id = choices[0]
        assignment[str(employee.id)] = vehicle_id
        remaining_capacity[vehicle_id] -= 1

    return {
        "assignment": assignment,
        "status": "feasible" if not unassigned else "partial",
        "unassigned": unassigned,
    }


def _assignment_proxy_cost(employee, vehicle) -> int:
    # Integer proxy for CP-SAT objective.
    start_to_pick = get_distance(vehicle.start_loc, employee.pickup_loc)
    pick_to_drop = get_distance(employee.pickup_loc, employee.drop_loc)

    dist_component = (start_to_pick + pick_to_drop) * float(vehicle.cost_per_km)

    tw_mid = (float(employee.earliest_pickup) + float(employee.latest_drop)) * 0.5
    wait_penalty = max(0.0, float(vehicle.avail_from) - tw_mid) * 0.05

    value = (dist_component + wait_penalty) * 100.0
    if not math.isfinite(value):
        return 10_000_000
    return max(1, int(round(value)))
