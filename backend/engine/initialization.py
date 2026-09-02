from __future__ import annotations

import random
from typing import Callable, Dict, List, Optional

from models import ProblemInstance
from objective import ObjectiveEvaluator
from operators import GeneticOperators
from representation import Individual, Route


class PopulationInitializer:
    def __init__(
        self,
        problem: ProblemInstance,
        rng: Optional[random.Random] = None,
        assignment_seed: Optional[Dict[str, Optional[str]]] = None,
    ):
        self.problem = problem
        self.rng = rng or random.Random()
        self.evaluator = ObjectiveEvaluator(problem)
        self.ops = GeneticOperators(problem, rng=self.rng)
        self.assignment_seed = dict(assignment_seed or {})
        self._vehicle_index = {str(v.id): idx for idx, v in enumerate(problem.vehicles)}

    def generate_population(
        self,
        pop_size: int,
        config: Dict = None,
        should_stop: Optional[Callable[[], bool]] = None,
    ) -> List[Individual]:
        config = config or {}
        pop_size = max(2, int(pop_size))
        min_required = min(2, pop_size)

        regret_ratio = float(config.get("regret", 0.45))
        grasp_ratio = float(config.get("grasp", 0.35))
        random_ratio = float(config.get("random", 0.20))

        total = max(1e-9, regret_ratio + grasp_ratio + random_ratio)
        regret_ratio /= total
        grasp_ratio /= total
        random_ratio /= total

        seeded_population: List[Individual] = []
        if self.assignment_seed:
            seeded_population.append(self._create_seed_from_assignment(mode="regret"))
            if pop_size >= 6:
                seeded_population.append(self._create_seed_from_assignment(mode="greedy"))

        base_count = max(0, pop_size - len(seeded_population))
        n_regret = int(round(base_count * regret_ratio))
        n_grasp = int(round(base_count * grasp_ratio))
        n_random = base_count - n_regret - n_grasp

        population = []
        for ind in seeded_population:
            self.evaluator.evaluate(ind, penalty_factor=0.7, phase_progress=0.15, enforce_hard=False)
            population.append(ind)

        for _ in range(max(1, n_regret)):
            if should_stop is not None and len(population) >= min_required and should_stop():
                break
            ind = self._create_seed_individual(mode="regret")
            self.evaluator.evaluate(ind, penalty_factor=0.6, phase_progress=0.0, enforce_hard=False)
            population.append(ind)

        for _ in range(max(1, n_grasp)):
            if should_stop is not None and len(population) >= min_required and should_stop():
                break
            ind = self._create_seed_individual(mode="greedy")
            self.evaluator.evaluate(ind, penalty_factor=0.6, phase_progress=0.0, enforce_hard=False)
            population.append(ind)

        for _ in range(max(1, n_random)):
            if should_stop is not None and len(population) >= min_required and should_stop():
                break
            ind = self._create_seed_individual(mode="random")
            self.evaluator.evaluate(ind, penalty_factor=0.6, phase_progress=0.0, enforce_hard=False)
            population.append(ind)

        if len(population) > pop_size:
            population = population[:pop_size]
        while len(population) < pop_size:
            if should_stop is not None and len(population) >= min_required and should_stop():
                break
            ind = self._create_seed_individual(mode="random")
            self.evaluator.evaluate(ind, penalty_factor=0.6, phase_progress=0.0, enforce_hard=False)
            population.append(ind)

        return population

    def _empty_individual(self) -> Individual:
        routes = [Route(vehicle=v, employees=[], stop_sequence=[]) for v in self.problem.vehicles]
        return Individual(routes=routes, unassigned=[])

    def _create_seed_individual(self, mode: str = "regret") -> Individual:
        mode = str(mode or "regret").strip().lower()
        individual = self._empty_individual()

        employees = list(self.problem.employees)
        if mode == "random":
            self.rng.shuffle(employees)
        elif mode == "greedy":
            # Moderate ordering: priority first, random tie-break.
            keyed = [
                (e.priority, e.latest_drop - e.earliest_pickup, self.rng.random(), e)
                for e in employees
            ]
            keyed.sort(key=lambda x: (x[0], x[1], x[2]))
            employees = [row[3] for row in keyed]
        else:
            employees.sort(key=lambda e: (e.priority, e.latest_drop - e.earliest_pickup, str(e.id)))

        if mode == "regret":
            self.ops.repair_employees(
                individual,
                employees,
                repair_mode="regret3",
                strictness=0.35,
                penalty_factor=0.7,
            )
            self.ops._sync_unassigned(individual)
            return individual

        # Greedy/random constructive insertion with low strictness early.
        for emp in employees:
            route_order = list(range(len(individual.routes)))
            if mode == "random":
                self.rng.shuffle(route_order)

            best_idx = None
            best_seq = None
            best_diff = float("inf")

            for idx in route_order:
                route = individual.routes[idx]
                seq, diff = self.ops._find_best_insertion_for_route(
                    route,
                    emp,
                    strictness=0.25 if mode == "random" else 0.45,
                    penalty_factor=0.7,
                    allow_soft=True,
                )
                if seq is None:
                    continue
                if diff < best_diff:
                    best_diff = diff
                    best_idx = idx
                    best_seq = seq

            if best_idx is None:
                individual.unassigned.append(emp)
                continue

            route = individual.routes[best_idx]
            route.stop_sequence = best_seq
            self.ops._sync_route_employees(route)

        self.ops._sync_unassigned(individual)
        return individual

    def _create_seed_from_assignment(self, mode: str = "regret") -> Individual:
        individual = self._empty_individual()
        mode = str(mode or "regret").strip().lower()

        pending = []
        employees = sorted(
            self.problem.employees,
            key=lambda e: (e.priority, e.latest_drop - e.earliest_pickup, str(e.id)),
        )
        if mode == "greedy":
            self.rng.shuffle(employees)

        for emp in employees:
            assigned_vehicle = self.assignment_seed.get(str(emp.id))
            route_idx = self._vehicle_index.get(str(assigned_vehicle))
            if route_idx is None:
                pending.append(emp)
                continue

            target_route = individual.routes[route_idx]
            seq, _ = self.ops._find_best_insertion_for_route(
                target_route,
                emp,
                strictness=0.45,
                penalty_factor=0.9,
                allow_soft=True,
            )
            if seq is None:
                pending.append(emp)
                continue

            target_route.stop_sequence = seq
            self.ops._sync_route_employees(target_route)

        if pending:
            repair_mode = "regret3" if mode == "regret" else "greedy"
            self.ops.repair_employees(
                individual,
                pending,
                repair_mode=repair_mode,
                strictness=0.45,
                penalty_factor=0.9,
            )

        self.ops._sync_unassigned(individual)
        return individual
