import math
from typing import Any


def get_solution_search_objective(solution: Any) -> float:
    try:
        return float(getattr(solution, "objective_score", float("inf")))
    except Exception:
        return float("inf")


def get_solution_base_objective(
    solution: Any,
    cost_weight: float | None = None,
    time_weight: float | None = None,
) -> float:
    if solution is None:
        return float("inf")

    try:
        base_value = float(getattr(solution, "base_objective_score", float("inf")))
        if math.isfinite(base_value):
            return base_value
    except Exception:
        pass

    if cost_weight is not None and time_weight is not None:
        try:
            total = 0.0
            for route in getattr(solution, "routes", []) or []:
                total += (
                    float(cost_weight) * float(getattr(route, "total_cost", 0.0))
                    + float(time_weight) * float(getattr(route, "total_time", 0.0))
                )
            return float(total)
        except Exception:
            pass

    return get_solution_search_objective(solution)
