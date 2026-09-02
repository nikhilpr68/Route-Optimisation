from __future__ import annotations

import copy
import random
import time
from typing import Optional

from models import ProblemInstance
from neighborhoods import NeighborhoodSearch
from objective import ObjectiveEvaluator
from operators import GeneticOperators
from representation import Individual


class FineTuner:
    def __init__(self, problem: ProblemInstance, rng: Optional[random.Random] = None):
        self.problem = problem
        self.rng = rng or random.Random()
        self.evaluator = ObjectiveEvaluator(problem)
        self.ops = GeneticOperators(problem, rng=self.rng)
        self.neighborhoods = NeighborhoodSearch(
            problem,
            operators=self.ops,
            evaluator=self.evaluator,
            rng=self.rng,
        )

    def tune(
        self,
        individual: Individual,
        stop_controller=None,
        max_runtime_sec: Optional[float] = None,
    ) -> Individual:
        best = copy.deepcopy(individual)
        self.evaluator.evaluate(best, penalty_factor=8.0, phase_progress=0.92, enforce_hard=False)
        start = time.perf_counter()

        def _time_exhausted() -> bool:
            if max_runtime_sec is not None and (time.perf_counter() - start) >= max(0.01, float(max_runtime_sec)):
                return True
            if stop_controller is not None and stop_controller.time_limit_reached():
                return True
            return False

        for _ in range(20):
            if _time_exhausted():
                break
            improved = False

            candidate = self.neighborhoods.improve(
                best,
                max_moves=4,
                penalty_factor=8.0,
                phase_progress=0.92,
            )
            if candidate.objective_score + 1e-9 < best.objective_score:
                best = candidate
                improved = True

            if _time_exhausted():
                break
            dismantled = self._try_dismantle_expensive_routes(best)
            if dismantled.objective_score + 1e-9 < best.objective_score:
                best = dismantled
                improved = True

            if not improved:
                break

        self.evaluator.evaluate(best, penalty_factor=12.0, phase_progress=1.0, enforce_hard=True)
        return best

    def _try_dismantle_expensive_routes(self, individual: Individual) -> Individual:
        candidate = copy.deepcopy(individual)
        self.evaluator.evaluate(candidate, penalty_factor=8.0, phase_progress=0.92, enforce_hard=False)
        current_score = candidate.objective_score

        active_routes = [r for r in candidate.routes if r.stop_sequence]
        active_routes.sort(key=lambda r: r.vehicle.cost_per_km, reverse=True)

        for expensive_route in active_routes:
            expensive_employees = [
                self.ops._employee_by_id[eid]
                for eid in self.ops._pickup_employee_ids(expensive_route)
                if eid in self.ops._employee_by_id
            ]
            if len(expensive_employees) <= 1:
                continue

            backup_sol = copy.deepcopy(candidate)
            expensive_route.stop_sequence = []
            expensive_route.employees = []

            failed = False
            for emp in sorted(expensive_employees, key=lambda e: (e.priority, e.latest_drop - e.earliest_pickup, str(e.id))):
                route_idx = None
                best_seq = None
                best_diff = float("inf")
                for idx, route in enumerate(candidate.routes):
                    if route.vehicle.id == expensive_route.vehicle.id:
                        continue
                    seq, diff = self.ops._find_best_insertion_for_route(
                        route,
                        emp,
                        strictness=0.98,
                        penalty_factor=10.0,
                        allow_soft=False,
                    )
                    if seq is None:
                        continue
                    if diff < best_diff:
                        best_diff = diff
                        route_idx = idx
                        best_seq = seq

                if route_idx is None:
                    failed = True
                    break

                target_route = candidate.routes[route_idx]
                target_route.stop_sequence = best_seq
                self.ops._sync_route_employees(target_route)

            if failed:
                candidate = backup_sol
                continue

            self.ops._sync_unassigned(candidate)
            self.evaluator.evaluate(candidate, penalty_factor=8.0, phase_progress=0.92, enforce_hard=False)
            if candidate.objective_score + 1e-9 < current_score:
                return candidate

            candidate = backup_sol

        return individual
