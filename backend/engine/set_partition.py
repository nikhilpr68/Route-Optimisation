from __future__ import annotations

import copy
import math
import os
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from bcp_foundation import MasterSolveOptions, reduced_cost
from cuts import CutStore, SubsetRowCut, separate_subset_row_cuts
from diversity import structural_hash
from models import ProblemInstance
from objective import ObjectiveEvaluator
from operators import GeneticOperators
from representation import Individual, Route
from route_pool import PooledRoute

def _try_create_lp_solver():
    if pywraplp is None:
        return None
    # Prefer a pure-LP solver for a fast relaxation bound.
    for name in ("GLOP", "CLP"):
        try:
            solver = pywraplp.Solver.CreateSolver(name)
        except Exception:
            solver = None
        if solver is not None:
            return solver
    return None


def restricted_master_lp_relaxation_bound(
    problem: ProblemInstance,
    routes: Sequence[PooledRoute],
    time_limit_sec: float = 1.0,
) -> Tuple[Optional[float], str, float]:
    """Lower bound from LP relaxation of the restricted master (route-pool set partition).

    This is a *restricted-route-pool* bound only. It is NOT a global lower bound
    for the original routing problem (the pool may omit necessary routes).
    """
    solve_start = time.perf_counter()
    solver = _try_create_lp_solver()
    if solver is None:
        return None, "solver_unavailable", 0.0

    solver.SetTimeLimit(int(max(0.05, float(time_limit_sec)) * 1000))
    try:
        solver.SetNumThreads(1)
    except Exception:
        pass

    employee_ids = sorted(str(emp.id) for emp in problem.employees)
    vehicle_ids = sorted(str(vehicle.id) for vehicle in problem.vehicles)

    x_vars = [solver.NumVar(0.0, 1.0, f"x_{idx}") for idx in range(len(routes))]

    for emp_id in employee_ids:
        cover_expr = solver.Sum(
            x_vars[idx]
            for idx, route in enumerate(routes)
            if emp_id in route.passenger_set
        )
        solver.Add(cover_expr == 1)

    for vehicle_id in vehicle_ids:
        solver.Add(
            solver.Sum(
                x_vars[idx]
                for idx, route in enumerate(routes)
                if route.vehicle_id == vehicle_id
            )
            <= 1
        )

    objective = solver.Objective()
    for idx, route in enumerate(routes):
        objective.SetCoefficient(x_vars[idx], float(route.objective_score))
    objective.SetMinimization()

    status = solver.Solve()
    solve_time = max(0.0, time.perf_counter() - solve_start)
    status_map = {
        pywraplp.Solver.OPTIMAL: "optimal",
        pywraplp.Solver.FEASIBLE: "feasible",
        pywraplp.Solver.INFEASIBLE: "infeasible",
        pywraplp.Solver.NOT_SOLVED: "not_solved",
        pywraplp.Solver.UNBOUNDED: "unbounded",
        pywraplp.Solver.ABNORMAL: "abnormal",
    }
    status_label = status_map.get(status, f"status_{status}")

    if status not in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
        return None, status_label, float(solve_time)
    try:
        value = float(solver.Objective().Value())
    except Exception:
        value = None
    return value, status_label, float(solve_time)


@dataclass(frozen=True)
class RestrictedMasterLPSolution:
    objective_value: Optional[float]
    status: str
    solve_time_sec: float
    employee_duals: Dict[str, float]
    vehicle_duals: Dict[str, float]
    primal_values: Dict[str, float]
    reduced_cost_min: Optional[float]
    cut_duals: Dict[str, float]
    cuts_added: int
    cuts_total: int


def solve_restricted_master_lp(
    problem: ProblemInstance,
    routes: Sequence[PooledRoute],
    *,
    time_limit_sec: float = 1.0,
    options: Optional[MasterSolveOptions] = None,
    cut_store: Optional[CutStore] = None,
) -> RestrictedMasterLPSolution:
    """
    Solve the restricted master LP relaxation and, when supported by the LP
    backend, extract dual values for employee and vehicle constraints.

    This is still *restricted-route-pool* reasoning: the pool may omit columns
    required for the global optimum of the original routing problem.
    """
    solve_start = time.perf_counter()
    solver = _try_create_lp_solver()
    if solver is None:
        return RestrictedMasterLPSolution(
            objective_value=None,
            status="solver_unavailable",
            solve_time_sec=0.0,
            employee_duals={},
            vehicle_duals={},
            primal_values={},
            reduced_cost_min=None,
            cut_duals={},
            cuts_added=0,
            cuts_total=0,
        )

    options = options or MasterSolveOptions()
    solver.SetTimeLimit(int(max(0.05, float(time_limit_sec)) * 1000))
    try:
        solver.SetNumThreads(1)
    except Exception:
        pass

    employee_ids = sorted(str(emp.id) for emp in problem.employees)
    vehicle_ids = sorted(str(vehicle.id) for vehicle in problem.vehicles)

    # Apply cut/branching restrictions via variable bounds.
    fixed_out = set(options.branching.fixed_out_route_ids)
    fixed_in = set(options.branching.fixed_in_route_ids)
    if options.cuts.disallow_infeasible_routes:
        for route in routes:
            if (not bool(getattr(route, "is_feasible", True))) or int(getattr(route, "hard_violation_count", 0) or 0) > 0:
                fixed_out.add(str(route.route_id))

    x_vars = []
    route_by_idx: List[PooledRoute] = list(routes)
    for idx, route in enumerate(route_by_idx):
        rid = str(route.route_id)
        lb, ub = 0.0, 1.0
        if rid in fixed_out:
            lb, ub = 0.0, 0.0
        if rid in fixed_in:
            lb, ub = 1.0, 1.0
        x_vars.append(solver.NumVar(lb, ub, f"x_{idx}"))

    emp_constraints: Dict[str, Any] = {}
    for emp_id in employee_ids:
        cover_expr = solver.Sum(
            x_vars[idx]
            for idx, route in enumerate(route_by_idx)
            if emp_id in route.passenger_set
        )
        emp_constraints[emp_id] = solver.Add(cover_expr == 1)

    veh_constraints: Dict[str, Any] = {}
    for vehicle_id in vehicle_ids:
        veh_constraints[vehicle_id] = solver.Add(
            solver.Sum(
                x_vars[idx]
                for idx, route in enumerate(route_by_idx)
                if str(route.vehicle_id) == vehicle_id
            )
            <= 1
        )

    objective = solver.Objective()
    for idx, route in enumerate(route_by_idx):
        objective.SetCoefficient(x_vars[idx], float(route.objective_score))
    objective.SetMinimization()

    status = solver.Solve()
    solve_time = max(0.0, time.perf_counter() - solve_start)
    status_map = {
        pywraplp.Solver.OPTIMAL: "optimal",
        pywraplp.Solver.FEASIBLE: "feasible",
        pywraplp.Solver.INFEASIBLE: "infeasible",
        pywraplp.Solver.NOT_SOLVED: "not_solved",
        pywraplp.Solver.UNBOUNDED: "unbounded",
        pywraplp.Solver.ABNORMAL: "abnormal",
    }
    status_label = status_map.get(status, f"status_{status}")

    if status not in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
        return RestrictedMasterLPSolution(
            objective_value=None,
            status=status_label,
            solve_time_sec=float(solve_time),
            employee_duals={},
            vehicle_duals={},
            primal_values={},
            reduced_cost_min=None,
            cut_duals={},
            cuts_added=0,
            cuts_total=(len(cut_store) if cut_store is not None else 0),
        )

    objective_value = None
    try:
        objective_value = float(solver.Objective().Value())
    except Exception:
        objective_value = None

    employee_duals: Dict[str, float] = {}
    vehicle_duals: Dict[str, float] = {}
    primal_values: Dict[str, float] = {}
    cut_duals: Dict[str, float] = {}

    # Dual values are available only for LP solvers (GLOP/CLP). Guard with hasattr.
    for emp_id, ct in emp_constraints.items():
        if hasattr(ct, "dual_value"):
            try:
                employee_duals[str(emp_id)] = float(ct.dual_value())
            except Exception:
                pass
    for vehicle_id, ct in veh_constraints.items():
        if hasattr(ct, "dual_value"):
            try:
                vehicle_duals[str(vehicle_id)] = float(ct.dual_value())
            except Exception:
                pass
    for idx, var in enumerate(x_vars):
        try:
            primal_values[str(route_by_idx[idx].route_id)] = float(var.solution_value())
        except Exception:
            pass

    # Optional: inject existing cuts and (optionally) separate new SRC cuts.
    cuts_added = 0
    if cut_store is not None and options.cuts.subset_row_cuts_enabled:
        # First add existing cuts.
        cut_constraints = {}
        for cut in cut_store.cuts():
            coeffs = []
            for idx, route in enumerate(route_by_idx):
                a = int(cut.coefficient(route))
                if a:
                    coeffs.append((idx, a))
            if not coeffs:
                continue
            ct = solver.Add(solver.Sum(x_vars[i] * float(a) for i, a in coeffs) <= float(cut.rhs))
            cut_constraints[cut.cut_id] = ct

        # One lightweight separation round using current primal values.
        new_cuts = separate_subset_row_cuts(
            route_by_idx,
            primal_values_by_route_id=primal_values,
            max_tries=int(options.cuts.subset_row_cuts_sep_tries),
            min_frac_x=float(options.cuts.subset_row_cuts_min_frac_x),
            max_set_size=int(options.cuts.subset_row_cuts_max_set_size),
        )
        for cut in new_cuts:
            if cut_store.add(cut):
                cuts_added += 1
                coeffs = []
                for idx, route in enumerate(route_by_idx):
                    a = int(cut.coefficient(route))
                    if a:
                        coeffs.append((idx, a))
                if coeffs:
                    ct = solver.Add(solver.Sum(x_vars[i] * float(a) for i, a in coeffs) <= float(cut.rhs))
                    cut_constraints[cut.cut_id] = ct

        # If we added any cut, re-solve quickly to reflect bound tightening and duals.
        if cuts_added:
            status = solver.Solve()
            status_label = status_map.get(status, f"status_{status}")
            if status in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
                try:
                    objective_value = float(solver.Objective().Value())
                except Exception:
                    objective_value = objective_value
                primal_values = {}
                for idx, var in enumerate(x_vars):
                    try:
                        primal_values[str(route_by_idx[idx].route_id)] = float(var.solution_value())
                    except Exception:
                        pass

        # Extract cut duals (when supported).
        for cid, ct in cut_constraints.items():
            if hasattr(ct, "dual_value"):
                try:
                    cut_duals[str(cid)] = float(ct.dual_value())
                except Exception:
                    pass

    min_rc = None
    if employee_duals or vehicle_duals or cut_duals:
        values = []
        for route in route_by_idx:
            try:
                values.append(
                    reduced_cost(
                        route,
                        employee_duals=employee_duals,
                        vehicle_duals=vehicle_duals,
                        cut_duals=cut_duals,
                        cuts=(cut_store.cuts() if cut_store is not None else None),
                    )
                )
            except Exception:
                continue
        if values:
            min_rc = float(min(values))

    return RestrictedMasterLPSolution(
        objective_value=objective_value,
        status=status_label,
        solve_time_sec=float(solve_time),
        employee_duals=employee_duals,
        vehicle_duals=vehicle_duals,
        primal_values=primal_values,
        reduced_cost_min=min_rc,
        cut_duals=cut_duals,
        cuts_added=int(cuts_added),
        cuts_total=(len(cut_store) if cut_store is not None else 0),
    )


def _ortools_disabled() -> bool:
    raw = str(os.getenv("ENGINE_DISABLE_ORTOOLS", "")).strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if sys.version_info >= (3, 13):
        return True
    return False


if _ortools_disabled():
    pywraplp = None
else:
    try:
        from ortools.linear_solver import pywraplp  # type: ignore
    except Exception:
        pywraplp = None


@dataclass
class SetPartitionResult:
    individual: Optional[Individual]
    objective_score: float
    status: str
    backend: str
    selected_route_ids: List[str]
    uncovered_employee_ids: List[str]
    mip_gap: Optional[float]
    metadata: Dict[str, object]


def solve_set_partition(
    problem: ProblemInstance,
    pool_routes: Sequence[PooledRoute],
    time_limit_sec: float = 20.0,
    allow_relaxed_fallback: bool = True,
    evaluator: Optional[ObjectiveEvaluator] = None,
    master_options: Optional[MasterSolveOptions] = None,
) -> SetPartitionResult:
    evaluator = evaluator or ObjectiveEvaluator(problem)
    master_options = master_options or MasterSolveOptions()
    routes = [route for route in pool_routes if route.passenger_set]
    if master_options.cuts.disallow_infeasible_routes:
        routes = [
            route
            for route in routes
            if bool(getattr(route, "is_feasible", True)) and int(getattr(route, "hard_violation_count", 0) or 0) <= 0
        ]
    if master_options.branching.fixed_out_route_ids:
        routes = [route for route in routes if str(route.route_id) not in master_options.branching.fixed_out_route_ids]
    if not routes:
        return SetPartitionResult(
            individual=None,
            objective_score=float("inf"),
            status="no_routes",
            backend="none",
            selected_route_ids=[],
            uncovered_employee_ids=[str(emp.id) for emp in problem.employees],
            mip_gap=None,
            metadata={
                "reason": "route_pool_empty",
                "lowerBound": None,
                "boundScope": "none",
                "exactnessStatus": "heuristic_incumbent_only",
            },
        )

    lp_bound, lp_status, lp_solve_time = restricted_master_lp_relaxation_bound(
        problem,
        routes,
        time_limit_sec=min(1.0, max(0.05, float(time_limit_sec) * 0.15)),
    )

    if pywraplp is not None:
        strict_result = _solve_with_mip(
            problem,
            routes,
            relaxed=False,
            time_limit_sec=time_limit_sec,
            evaluator=evaluator,
            master_options=master_options,
        )
        if strict_result.individual is not None:
            meta = dict(strict_result.metadata or {})
            meta.update(
                {
                    "lpRelaxationLowerBound": lp_bound,
                    "lpRelaxationStatus": lp_status,
                    "lpRelaxationSolveTimeSec": float(lp_solve_time),
                }
            )
            strict_result.metadata = meta
            return strict_result

        if allow_relaxed_fallback:
            relaxed_result = _solve_with_mip(
                problem,
                routes,
                relaxed=True,
                time_limit_sec=time_limit_sec,
                evaluator=evaluator,
                master_options=master_options,
            )
            if relaxed_result.individual is not None:
                meta = dict(relaxed_result.metadata or {})
                meta.update(
                    {
                        "lpRelaxationLowerBound": lp_bound,
                        "lpRelaxationStatus": lp_status,
                        "lpRelaxationSolveTimeSec": float(lp_solve_time),
                    }
                )
                relaxed_result.metadata = meta
                return relaxed_result

    fallback_result = _solve_with_search(
        problem,
        routes,
        time_limit_sec=time_limit_sec,
        allow_relaxed_fallback=allow_relaxed_fallback,
        evaluator=evaluator,
        master_options=master_options,
    )
    meta = dict(fallback_result.metadata or {})
    meta.update(
        {
            "lpRelaxationLowerBound": lp_bound,
            "lpRelaxationStatus": lp_status,
            "lpRelaxationSolveTimeSec": float(lp_solve_time),
        }
    )
    if meta.get("lowerBound") is None and lp_bound is not None:
        meta["lowerBound"] = float(lp_bound)
        meta["boundScope"] = "restricted_route_pool"
        meta["exactnessStatus"] = "bounded_restricted_route_pool"
        meta["boundSource"] = "restricted_master_lp_relaxation"
    fallback_result.metadata = meta
    return fallback_result


def _solve_with_mip(
    problem: ProblemInstance,
    routes: Sequence[PooledRoute],
    relaxed: bool,
    time_limit_sec: float,
    evaluator: ObjectiveEvaluator,
    master_options: MasterSolveOptions,
) -> SetPartitionResult:
    solve_start = time.perf_counter()
    solver = pywraplp.Solver.CreateSolver("SCIP")
    if solver is None:
        solver = pywraplp.Solver.CreateSolver("CBC")
    if solver is None:
        return SetPartitionResult(
            individual=None,
            objective_score=float("inf"),
            status="solver_unavailable",
            backend="ortools_mip",
            selected_route_ids=[],
            uncovered_employee_ids=[str(emp.id) for emp in problem.employees],
            mip_gap=None,
            metadata={"relaxed": bool(relaxed)},
        )

    solver.SetTimeLimit(int(max(0.1, float(time_limit_sec)) * 1000))
    try:
        solver.SetNumThreads(1)
    except Exception:
        pass

    employee_ids = sorted(str(emp.id) for emp in problem.employees)
    vehicle_ids = sorted(str(vehicle.id) for vehicle in problem.vehicles)

    x_vars = [solver.BoolVar(f"x_{idx}") for idx in range(len(routes))]
    uncovered_vars = {}

    fixed_in = set(master_options.branching.fixed_in_route_ids)
    fixed_in_indices = [idx for idx, route in enumerate(routes) if str(route.route_id) in fixed_in]
    missing_fixed_in = [rid for rid in fixed_in if rid not in {str(r.route_id) for r in routes}]
    if missing_fixed_in and (not relaxed):
        return SetPartitionResult(
            individual=None,
            objective_score=float("inf"),
            status="fixed_in_missing",
            backend="ortools_mip",
            selected_route_ids=[],
            uncovered_employee_ids=[str(emp.id) for emp in problem.employees],
            mip_gap=None,
            metadata={"relaxed": bool(relaxed), "missingFixedInRouteIds": missing_fixed_in},
        )

    for emp_id in employee_ids:
        cover_expr = solver.Sum(
            x_vars[idx]
            for idx, route in enumerate(routes)
            if emp_id in route.passenger_set
        )
        if relaxed:
            u = solver.BoolVar(f"u_{emp_id}")
            uncovered_vars[emp_id] = u
            solver.Add(cover_expr + u == 1)
        else:
            solver.Add(cover_expr == 1)

    for vehicle_id in vehicle_ids:
        solver.Add(
            solver.Sum(
                x_vars[idx]
                for idx, route in enumerate(routes)
                if route.vehicle_id == vehicle_id
            )
            <= 1
        )

    objective = solver.Objective()
    for idx, route in enumerate(routes):
        objective.SetCoefficient(x_vars[idx], float(route.objective_score))

    if relaxed:
        uncovered_penalty = 25_000_000.0
        for emp_id in employee_ids:
            objective.SetCoefficient(uncovered_vars[emp_id], uncovered_penalty)

    # Apply branching constraints (fix columns in).
    for idx in fixed_in_indices:
        solver.Add(x_vars[idx] == 1)

    objective.SetMinimization()
    status = solver.Solve()
    solve_time = max(0.0, time.perf_counter() - solve_start)

    status_map = {
        pywraplp.Solver.OPTIMAL: "optimal",
        pywraplp.Solver.FEASIBLE: "feasible",
        pywraplp.Solver.INFEASIBLE: "infeasible",
        pywraplp.Solver.NOT_SOLVED: "not_solved",
        pywraplp.Solver.UNBOUNDED: "unbounded",
        pywraplp.Solver.ABNORMAL: "abnormal",
    }
    status_label = status_map.get(status, f"status_{status}")

    if status not in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
        lower_bound = None
        try:
            maybe_bound = float(solver.Objective().BestBound())
            if math.isfinite(maybe_bound):
                lower_bound = maybe_bound
        except Exception:
            lower_bound = None
        return SetPartitionResult(
            individual=None,
            objective_score=float("inf"),
            status=status_label,
            backend="ortools_mip",
            selected_route_ids=[],
            uncovered_employee_ids=employee_ids,
            mip_gap=None,
            metadata={
                "relaxed": bool(relaxed),
                "solveTimeSec": float(solve_time),
                "poolSize": int(len(routes)),
                "lowerBound": (None if relaxed else lower_bound),
                "boundScope": ("none" if relaxed or lower_bound is None else "restricted_route_pool"),
                "exactnessStatus": ("heuristic_incumbent_only" if relaxed or lower_bound is None else "bounded_restricted_route_pool"),
                "boundSource": ("none" if relaxed or lower_bound is None else "restricted_master_mip_best_bound"),
            },
        )

    selected_indices = [idx for idx, var in enumerate(x_vars) if var.solution_value() > 0.5]
    uncovered_employee_ids = []
    if relaxed:
        uncovered_employee_ids = [
            emp_id
            for emp_id, var in uncovered_vars.items()
            if var.solution_value() > 0.5
        ]

    individual = _individual_from_selected_routes(
        problem,
        routes,
        selected_indices,
        evaluator=evaluator,
        uncovered_employee_ids=uncovered_employee_ids,
    )

    if individual is None:
        return SetPartitionResult(
            individual=None,
            objective_score=float("inf"),
            status="selection_build_failed",
            backend="ortools_mip",
            selected_route_ids=[routes[idx].route_id for idx in selected_indices],
            uncovered_employee_ids=list(uncovered_employee_ids),
            mip_gap=None,
            metadata={"relaxed": bool(relaxed)},
        )

    mip_gap = None
    objective_value = None
    best_bound = None
    try:
        objective_value = float(solver.Objective().Value())
    except Exception:
        objective_value = None
    try:
        best_bound = float(solver.Objective().BestBound())
    except Exception:
        best_bound = None
    if status == pywraplp.Solver.OPTIMAL:
        mip_gap = 0.0
    elif objective_value is not None and best_bound is not None:
        denom = max(1.0, abs(objective_value))
        mip_gap = max(0.0, abs(objective_value - best_bound) / denom)

    lower_bound = None if relaxed else best_bound
    exactness_status = "heuristic_incumbent_only"
    bound_scope = "none"
    if not relaxed:
        bound_scope = "restricted_route_pool"
        if status == pywraplp.Solver.OPTIMAL:
            exactness_status = "exact_restricted_route_pool"
            if objective_value is not None:
                lower_bound = objective_value
        elif lower_bound is not None:
            exactness_status = "bounded_restricted_route_pool"
    bound_source = "none"
    if not relaxed and lower_bound is not None:
        bound_source = "restricted_master_mip_best_bound" if status != pywraplp.Solver.OPTIMAL else "restricted_master_mip_optimal"

    return SetPartitionResult(
        individual=individual,
        objective_score=float(individual.objective_score),
        status=status_label,
        backend="ortools_mip",
        selected_route_ids=[routes[idx].route_id for idx in selected_indices],
        uncovered_employee_ids=list(uncovered_employee_ids),
        mip_gap=mip_gap,
        metadata={
            "relaxed": bool(relaxed),
            "selectedRoutes": int(len(selected_indices)),
            "poolSize": int(len(routes)),
            "solveTimeSec": float(solve_time),
            "objectiveValue": objective_value,
            "bestBound": best_bound,
            "relativeGap": mip_gap,
            "lowerBound": lower_bound,
            "boundScope": bound_scope,
            "exactnessStatus": exactness_status,
            "boundSource": bound_source,
        },
    )


def _solve_with_search(
    problem: ProblemInstance,
    routes: Sequence[PooledRoute],
    time_limit_sec: float,
    allow_relaxed_fallback: bool,
    evaluator: ObjectiveEvaluator,
    master_options: MasterSolveOptions,
) -> SetPartitionResult:
    employee_ids = sorted(str(emp.id) for emp in problem.employees)
    vehicle_ids = sorted(str(vehicle.id) for vehicle in problem.vehicles)

    feasible_routes = [route for route in routes if route.is_feasible]
    if not feasible_routes:
        feasible_routes = list(routes)

    # Branching fixed-in is not supported in the DFS fallback (scaffold only).
    # If requested, return an honest status instead of silently ignoring.
    if master_options.branching.fixed_in_route_ids:
        return SetPartitionResult(
            individual=None,
            objective_score=float("inf"),
            status="branching_unsupported_in_fallback",
            backend="dfs_search",
            selected_route_ids=[],
            uncovered_employee_ids=employee_ids,
            mip_gap=None,
            metadata={"relaxed": False},
        )

    # Trim candidate set for deterministic runtime.
    feasible_route_count = len(feasible_routes)
    feasible_routes = sorted(
        feasible_routes,
        key=lambda route: (
            route.objective_score,
            len(route.passenger_set),
            route.vehicle_id,
            route.sequence_signature,
        ),
    )[:320]
    trimmed = (
        len(feasible_routes) < feasible_route_count
        if feasible_route_count > 0
        else len(feasible_routes) < len(routes)
    )

    route_sets = [set(route.passenger_set) for route in feasible_routes]
    candidates_by_employee: Dict[str, List[int]] = {emp_id: [] for emp_id in employee_ids}
    for idx, route in enumerate(feasible_routes):
        for emp_id in route.passenger_set:
            if emp_id in candidates_by_employee:
                candidates_by_employee[emp_id].append(idx)

    best_selection: List[int] = []
    best_cost = float("inf")
    nodes = 0
    start = time.time()

    def timed_out() -> bool:
        return (time.time() - start) >= max(0.2, float(time_limit_sec))

    def dfs(
        covered: Set[str],
        used_vehicles: Set[str],
        selection: List[int],
        cost: float,
    ) -> None:
        nonlocal best_selection, best_cost, nodes
        nodes += 1

        if cost >= best_cost:
            return
        if timed_out():
            return
        if len(covered) == len(employee_ids):
            best_cost = cost
            best_selection = list(selection)
            return

        uncovered = [emp_id for emp_id in employee_ids if emp_id not in covered]
        pivot = min(
            uncovered,
            key=lambda emp_id: len(candidates_by_employee.get(emp_id) or []),
        )
        route_indices = candidates_by_employee.get(pivot) or []
        if not route_indices:
            return

        for idx in route_indices:
            route = feasible_routes[idx]
            if route.vehicle_id in used_vehicles:
                continue
            passenger_ids = route_sets[idx]
            if passenger_ids & covered:
                continue
            dfs(
                covered=covered | passenger_ids,
                used_vehicles=used_vehicles | {route.vehicle_id},
                selection=selection + [idx],
                cost=cost + float(route.objective_score),
            )

    dfs(set(), set(), [], 0.0)

    if best_selection:
        individual = _individual_from_selected_routes(
            problem,
            feasible_routes,
            best_selection,
            evaluator=evaluator,
            uncovered_employee_ids=[],
        )
        if individual is not None:
            return SetPartitionResult(
                individual=individual,
                objective_score=float(individual.objective_score),
                status="optimal" if not timed_out() else "time_limited_feasible",
                backend="search_exact",
                selected_route_ids=[feasible_routes[idx].route_id for idx in best_selection],
                uncovered_employee_ids=[],
                mip_gap=None,
                metadata={
                    "nodes": int(nodes),
                    "vehicleCount": int(len(vehicle_ids)),
                    "poolSize": int(len(feasible_routes)),
                    "timeSeconds": float(time.time() - start),
                    "trimmed": bool(trimmed),
                    "lowerBound": (float(individual.objective_score) if not timed_out() else None),
                    "boundScope": "restricted_route_pool",
                    "exactnessStatus": ("exact_restricted_route_pool" if not timed_out() else "heuristic_incumbent_only"),
                },
            )

    if not allow_relaxed_fallback:
        return SetPartitionResult(
            individual=None,
            objective_score=float("inf"),
            status="infeasible",
            backend="search_exact",
            selected_route_ids=[],
            uncovered_employee_ids=employee_ids,
            mip_gap=None,
            metadata={
                "nodes": int(nodes),
                "poolSize": int(len(feasible_routes)),
                "trimmed": bool(trimmed),
                "lowerBound": None,
                "boundScope": "none",
                "exactnessStatus": "heuristic_incumbent_only",
            },
        )

    greedy_selection, uncovered = _greedy_relaxed_cover(
        employee_ids=employee_ids,
        routes=feasible_routes,
    )

    individual = _individual_from_selected_routes(
        problem,
        feasible_routes,
        greedy_selection,
        evaluator=evaluator,
        uncovered_employee_ids=list(uncovered),
    )

    if individual is None:
        return SetPartitionResult(
            individual=None,
            objective_score=float("inf"),
            status="relaxed_failed",
            backend="search_relaxed",
            selected_route_ids=[feasible_routes[idx].route_id for idx in greedy_selection],
            uncovered_employee_ids=list(uncovered),
            mip_gap=None,
            metadata={
                "nodes": int(nodes),
                "poolSize": int(len(feasible_routes)),
                "trimmed": bool(trimmed),
                "lowerBound": None,
                "boundScope": "none",
                "exactnessStatus": "heuristic_incumbent_only",
            },
        )

    return SetPartitionResult(
        individual=individual,
        objective_score=float(individual.objective_score),
        status="relaxed_feasible" if not uncovered else "relaxed_with_uncovered",
        backend="search_relaxed",
        selected_route_ids=[feasible_routes[idx].route_id for idx in greedy_selection],
        uncovered_employee_ids=list(uncovered),
        mip_gap=None,
        metadata={
            "nodes": int(nodes),
            "poolSize": int(len(feasible_routes)),
            "timeSeconds": float(time.time() - start),
            "trimmed": bool(trimmed),
            "lowerBound": None,
            "boundScope": "none",
            "exactnessStatus": "heuristic_incumbent_only",
        },
    )


def _greedy_relaxed_cover(employee_ids: Sequence[str], routes: Sequence[PooledRoute]) -> Tuple[List[int], List[str]]:
    uncovered = set(employee_ids)
    used_vehicles = set()
    selected: List[int] = []

    ranked_indices = list(range(len(routes)))

    while uncovered:
        best_idx = None
        best_key = None
        for idx in ranked_indices:
            route = routes[idx]
            if route.vehicle_id in used_vehicles:
                continue
            newly_covered = len(set(route.passenger_set) & uncovered)
            if newly_covered <= 0:
                continue

            score = float(route.objective_score) / float(max(1, newly_covered))
            key = (score, -newly_covered, len(route.passenger_set), route.vehicle_id)
            if best_key is None or key < best_key:
                best_key = key
                best_idx = idx

        if best_idx is None:
            break

        selected.append(best_idx)
        chosen_route = routes[best_idx]
        used_vehicles.add(chosen_route.vehicle_id)
        uncovered -= set(chosen_route.passenger_set)

    return selected, sorted(uncovered)


def _individual_from_selected_routes(
    problem: ProblemInstance,
    routes: Sequence[PooledRoute],
    selected_indices: Sequence[int],
    evaluator: ObjectiveEvaluator,
    uncovered_employee_ids: Sequence[str],
) -> Optional[Individual]:
    vehicle_by_id = {str(vehicle.id): vehicle for vehicle in problem.vehicles}
    employee_by_id = {str(emp.id): emp for emp in problem.employees}

    selected_route_by_vehicle: Dict[str, PooledRoute] = {}
    for idx in selected_indices:
        if idx < 0 or idx >= len(routes):
            continue
        route = routes[idx]
        current = selected_route_by_vehicle.get(route.vehicle_id)
        if current is None or route.objective_score + 1e-9 < current.objective_score:
            selected_route_by_vehicle[route.vehicle_id] = route

    built_routes: List[Route] = []
    for vehicle in problem.vehicles:
        route_data = selected_route_by_vehicle.get(str(vehicle.id))
        if route_data is None:
            built_routes.append(Route(vehicle=vehicle, employees=[], stop_sequence=[]))
            continue

        normalized_sequence = _normalize_stop_sequence(route_data.stop_sequence, employee_by_id)
        built_route = Route(vehicle=vehicle, employees=[], stop_sequence=normalized_sequence)
        _sync_route_employees(built_route)
        built_routes.append(built_route)

    individual = Individual(routes=built_routes, unassigned=[])

    ops = GeneticOperators(problem)
    ops._sync_unassigned(individual)

    if uncovered_employee_ids:
        # Heuristic repair to fill any uncovered employees from relaxed selection.
        missing = [employee_by_id[emp_id] for emp_id in uncovered_employee_ids if emp_id in employee_by_id]
        ops.repair_employees(
            individual,
            employees=missing,
            repair_mode="regret3",
            strictness=1.0,
            penalty_factor=12.0,
        )

    individual = ops.force_reassign_unassigned(individual, max_passes=4, strictness=1.0)
    evaluator.evaluate(individual, penalty_factor=15.0, phase_progress=1.0, enforce_hard=True)
    individual.structural_hash = structural_hash(individual)
    return individual


def _normalize_stop_sequence(stop_sequence: Sequence[Dict], employee_by_id: Dict[str, object]) -> List[Dict]:
    out: List[Dict] = []
    for stop in stop_sequence:
        emp = stop.get("emp") if isinstance(stop, dict) else None
        stop_type = stop.get("type") if isinstance(stop, dict) else None
        if emp is None or stop_type not in ("p", "d"):
            continue
        emp_id = str(getattr(emp, "id", ""))
        if emp_id not in employee_by_id:
            continue
        out.append({"type": stop_type, "emp": employee_by_id[emp_id]})
    return out


def _sync_route_employees(route: Route) -> None:
    seen = set()
    employees = []
    for stop in route.stop_sequence:
        if stop.get("type") != "p":
            continue
        emp = stop.get("emp")
        if emp is None:
            continue
        emp_id = str(emp.id)
        if emp_id in seen:
            continue
        seen.add(emp_id)
        employees.append(emp)
    route.employees = employees
