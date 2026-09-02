from typing import Any


def has_unassigned_employees(solution: Any) -> bool:
    return bool(getattr(solution, "unassigned", []) or [])


def is_solution_feasible(solution: Any) -> bool:
    if solution is None:
        return False
    for route in getattr(solution, "routes", []) or []:
        if getattr(route, "stop_sequence", None) and not bool(getattr(route, "is_feasible", True)):
            return False
        if getattr(route, "consistency_errors", None):
            return False
    if list(getattr(solution, "consistency_errors", []) or []):
        return False
    return True


def is_solution_fully_assigned(solution: Any) -> bool:
    if solution is None:
        return False
    return not has_unassigned_employees(solution)


def assignment_status(solution: Any) -> str:
    return "complete" if is_solution_fully_assigned(solution) else "partial"


def classify_solution_status(solution: Any) -> str:
    if not is_solution_feasible(solution):
        return "infeasible"
    if not is_solution_fully_assigned(solution):
        return "partial"
    return "feasible"
