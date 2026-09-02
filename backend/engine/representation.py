from dataclasses import dataclass, field
from typing import List, Dict, Any

from models import Employee, Vehicle


@dataclass
class Route:
    vehicle: Vehicle
    employees: List[Employee] = field(default_factory=list)
    stop_sequence: List[Dict[str, Any]] = field(default_factory=list)

    total_cost: float = 0.0
    total_time: float = 0.0
    total_delay: float = 0.0
    employee_delay_minutes: Dict[str, float] = field(default_factory=dict)

    is_feasible: bool = True
    violation_msg: str = ""
    violations: List[str] = field(default_factory=list)
    penalty_breakdown: Dict[str, float] = field(default_factory=dict)
    consistency_errors: List[str] = field(default_factory=list)

    def add_employee(self, emp: Employee):
        self.employees.append(emp)

    def is_empty(self):
        return len(self.employees) == 0


@dataclass
class Individual:
    routes: List[Route]
    unassigned: List[Employee] = field(default_factory=list)
    objective_score: float = float("inf")
    base_objective_score: float = float("inf")

    penalty_breakdown: Dict[str, float] = field(default_factory=dict)
    route_penalty_breakdown: Dict[str, Dict[str, float]] = field(default_factory=dict)
    violations: List[str] = field(default_factory=list)
    consistency_errors: List[str] = field(default_factory=list)
    structural_hash: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __lt__(self, other):
        return self.objective_score < other.objective_score
