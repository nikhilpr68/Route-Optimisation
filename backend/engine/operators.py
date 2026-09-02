from __future__ import annotations

import copy
import random
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Set, Tuple

from diversity import (
    average_route_jaccard_distance,
    assignment_vector,
    biased_fitness_scores,
    normalized_hamming_distance,
    structural_hash,
)
from models import Employee, ProblemInstance, Vehicle, get_max_allowed_delay
from objective import ObjectiveEvaluator
from representation import Individual, Route
from utils import TURNAROUND_BUFFER_MINUTES, calculate_travel_time, get_distance


@dataclass(frozen=True)
class _SequencePrefixCache:
    """Prefix simulation snapshots for a *valid* stop sequence.

    Used to accelerate best-insertion evaluation by avoiding re-simulating
    the unchanged prefix for every (pickup_idx, drop_idx) candidate.

    Safety/semantics: this cache is only built when the base sequence is
    valid under the requested strictness/soft settings, so the snapshot
    masks/counts correspond to a consistent state.
    """

    loc_before: List[object]
    time_before: List[float]
    dist_before: List[float]
    load_before: List[int]
    soft_penalty_before: List[float]
    picked_mask_before: List[int]
    active_mask_before: List[int]
    share_counts_before: List[Tuple[int, ...]]
    emp_bit_index: Dict[str, int]
    share_limit_by_emp_id: Dict[str, int]
    max_delay_by_emp_id: Dict[str, float]


class SelectionEngine:
    def __init__(
        self,
        problem: Optional[ProblemInstance] = None,
        tournament_size: int = 3,
        rng: Optional[random.Random] = None,
    ):
        self.problem = problem
        self.tournament_size = tournament_size
        self.rng = rng or random.Random()
        self.last_survival_metrics: Dict[str, float] = {
            "avg_similarity": 0.0,
            "lambda_div": 0.0,
            "selected_count": 0.0,
            "candidate_count": 0.0,
        }

    def select_parents(
        self,
        population: List[Individual],
        k: int,
        use_biased_fitness: bool = False,
        lambda_div: float = 1.0,
    ) -> List[Individual]:
        """Tournament selection over *population*.

        When *use_biased_fitness* is True, tournament candidates are ranked by
        HGS biased fitness (objective rank + lambda_div * diversity rank)
        rather than raw ``objective_score``.  This encourages diverse parents
        to be selected even when they're not the best scorers.
        """
        if not population:
            return []
        parents = []
        k = max(1, int(k))

        if use_biased_fitness and self.problem is not None and len(population) > 1:
            bf = biased_fitness_scores(population, self.problem, lambda_div=lambda_div)
            # Lower biased fitness is better — minimise.
            for _ in range(k):
                cand_indices = self.rng.sample(range(len(population)), min(len(population), self.tournament_size))
                best_idx = min(cand_indices, key=lambda i: bf[i])
                parents.append(population[best_idx])
        else:
            for _ in range(k):
                candidates = self.rng.sample(population, min(len(population), self.tournament_size))
                best = min(candidates, key=lambda x: x.objective_score)
                parents.append(best)
        return parents

    def survival_elimination(
        self,
        population: List[Individual],
        target_size: int,
        lambda_div: float = 0.0,
    ) -> List[Individual]:
        """Structural dedup + diversity-aware survivor selection."""
        if target_size <= 0:
            return []

        ordered = sorted(population, key=lambda x: x.objective_score)
        seen: Set[str] = set()
        cleaned: List[Individual] = []
        for ind in ordered:
            sig = structural_hash(ind)
            ind.structural_hash = sig
            if sig not in seen:
                seen.add(sig)
                cleaned.append(ind)

        if len(cleaned) <= target_size:
            self.last_survival_metrics = {
                "avg_similarity": 0.0,
                "lambda_div": float(lambda_div),
                "selected_count": float(len(cleaned)),
                "candidate_count": float(len(cleaned)),
            }
            return cleaned

        if self.problem is None or lambda_div <= 0.0:
            selected = cleaned[:target_size]
            self.last_survival_metrics = {
                "avg_similarity": 0.0,
                "lambda_div": float(lambda_div),
                "selected_count": float(len(selected)),
                "candidate_count": float(len(cleaned)),
            }
            return selected

        # Diversity-aware greedy selection:
        # effective_score = normalized_objective + lambda_div * similarity_penalty
        obj_values = [float(ind.objective_score) for ind in cleaned]
        obj_min = min(obj_values)
        obj_span = max(1e-9, max(obj_values) - obj_min)

        vectors = {ind.structural_hash: assignment_vector(self.problem, ind) for ind in cleaned}
        selected: List[Individual] = []
        selected_hashes: Set[str] = set()
        cumulative_similarity = 0.0
        similarity_pairs = 0

        while len(selected) < target_size:
            best_ind = None
            best_score = float("inf")
            best_similarity = 0.0

            for ind in cleaned:
                if ind.structural_hash in selected_hashes:
                    continue

                normalized_objective = (float(ind.objective_score) - obj_min) / obj_span

                if not selected:
                    similarity_penalty = 0.0
                else:
                    sims = []
                    vec_ind = vectors[ind.structural_hash]
                    for chosen in selected:
                        vec_chosen = vectors[chosen.structural_hash]
                        assign_dist = normalized_hamming_distance(vec_ind, vec_chosen)
                        route_dist = average_route_jaccard_distance(ind, chosen)
                        # similarity in [0,1]: higher means structurally closer.
                        similarity = 1.0 - (0.65 * assign_dist + 0.35 * route_dist)
                        similarity = max(0.0, min(1.0, similarity))
                        sims.append(similarity)
                    similarity_penalty = sum(sims) / max(1, len(sims))

                effective_score = normalized_objective + (float(lambda_div) * similarity_penalty)
                tie_key = (effective_score, float(ind.objective_score), ind.structural_hash)
                best_key = (
                    best_score,
                    float(best_ind.objective_score) if best_ind is not None else float("inf"),
                    best_ind.structural_hash if best_ind is not None else "",
                )
                if best_ind is None or tie_key < best_key:
                    best_ind = ind
                    best_score = effective_score
                    best_similarity = similarity_penalty

            if best_ind is None:
                break

            selected.append(best_ind)
            selected_hashes.add(best_ind.structural_hash)
            cumulative_similarity += best_similarity
            similarity_pairs += 1

        selected.sort(key=lambda x: (x.objective_score, x.structural_hash))
        avg_similarity = cumulative_similarity / max(1, similarity_pairs)
        self.last_survival_metrics = {
            "avg_similarity": float(avg_similarity),
            "lambda_div": float(lambda_div),
            "selected_count": float(len(selected)),
            "candidate_count": float(len(cleaned)),
        }
        return selected[:target_size]


class GeneticOperators:
    def __init__(self, problem: ProblemInstance, rng: Optional[random.Random] = None):
        self.problem = problem
        self.evaluator = ObjectiveEvaluator(problem)
        self.rng = rng or random.Random()
        self._quick_cost_cache: Dict[Tuple, float] = {}
        self._quick_cost_cache_limit = 40_000
        self._employee_by_id = {str(e.id): e for e in problem.employees}
        self.metadata = getattr(problem, "metadata", {}) or {}
        self._forced_unassigned_ids = self._parse_forced_unassigned_ids(self.metadata)
        self.allow_sharing_violation = self._meta_bool("ALLOW_SHARING_VIOLATION", default=False)
        self.allow_premium_mismatch = self._meta_bool("ALLOW_PREMIUM_MISMATCH", default=False)
        self.insertion_prefix_eval_enabled = self._meta_bool(
            "INSERTION_PREFIX_EVAL_ENABLED",
            default=self._meta_bool("DELTA_EVAL_ENABLED", default=True),
        )
        self.insertion_eval_stats: Dict[str, int] = {
            "prefixUsed": 0,
            "fullUsed": 0,
            "candidateChecks": 0,
            "deltaPrunes": 0,
        }

    # ---------- Public search operators ----------

    def ruin_and_recreate(
        self,
        individual: Individual,
        ruin_fraction: float = 0.3,
        max_victims: int = 4,
        penalty_factor: float = 1.0,
        strictness: float = 0.5,
        destroy_mode: str = "random",
        repair_mode: str = "greedy",
    ) -> Individual:
        offspring = copy.deepcopy(individual)
        removed_employees = self._apply_ruin(
            offspring,
            ruin_fraction=ruin_fraction,
            max_victims=max_victims,
            destroy_mode=destroy_mode,
            penalty_factor=penalty_factor,
            strictness=strictness,
        )

        if offspring.unassigned:
            removed_employees.extend(offspring.unassigned)
            offspring.unassigned = []

        # Keep stable order while removing duplicates by employee id.
        seen_ids = set()
        unique_removed = []
        for emp in removed_employees:
            if emp.id in seen_ids:
                continue
            seen_ids.add(emp.id)
            unique_removed.append(emp)

        self.repair_employees(
            offspring,
            employees=unique_removed,
            repair_mode=repair_mode,
            strictness=strictness,
            penalty_factor=penalty_factor,
        )
        self._sync_unassigned(offspring)
        return offspring

    def repair_employees(
        self,
        individual: Individual,
        employees: Sequence[Employee],
        repair_mode: str = "greedy",
        strictness: float = 0.6,
        penalty_factor: float = 1.0,
    ) -> Individual:
        forced = [e for e in employees if self._is_forced_unassigned(e)]
        if forced:
            individual.unassigned.extend(forced)
        pending = sorted(
            [e for e in employees if not self._is_forced_unassigned(e)],
            key=lambda e: (e.priority, e.latest_drop - e.earliest_pickup, str(e.id)),
        )

        if repair_mode.startswith("regret"):
            k = 2
            if repair_mode == "regret3":
                k = 3
            self._regret_insert_pending(
                individual,
                pending,
                k=k,
                strictness=strictness,
                penalty_factor=penalty_factor,
            )
        else:
            for emp in pending:
                best_route_idx, best_seq, _ = self._find_best_global_insertion(
                    individual,
                    emp,
                    strictness=strictness,
                    penalty_factor=penalty_factor,
                    allow_soft=True,
                )
                if best_route_idx is None:
                    individual.unassigned.append(emp)
                    continue
                route = individual.routes[best_route_idx]
                route.stop_sequence = best_seq
                self._sync_route_employees(route)

        return individual

    def remove_employees(self, individual: Individual, employee_ids: Sequence[str]) -> List[Employee]:
        ids = {str(eid) for eid in employee_ids}
        removed: List[Employee] = []

        for route in individual.routes:
            removed.extend(self._remove_employees_from_route(route, ids))

        # Remove duplicates and any already-unassigned entries.
        seen = set()
        unique_removed = []
        for emp in removed:
            emp_id = str(emp.id)
            if emp_id in seen:
                continue
            seen.add(emp_id)
            unique_removed.append(emp)

        individual.unassigned = [e for e in individual.unassigned if str(e.id) not in ids]
        self._sync_unassigned(individual)
        return unique_removed

    def force_reassign_unassigned(
        self,
        individual: Individual,
        max_passes: int = 3,
        strictness: float = 1.0,
    ) -> Individual:
        """
        Deterministic reinsertion for remaining unassigned employees.
        """
        repaired = copy.deepcopy(individual)
        self._sync_unassigned(repaired)
        if not repaired.unassigned:
            return repaired

        for _ in range(max(1, int(max_passes))):
            if not repaired.unassigned:
                break

            progress = False
            pending = sorted(
                repaired.unassigned,
                key=lambda e: (e.priority, e.latest_drop - e.earliest_pickup, str(e.id)),
            )
            repaired.unassigned = []
            forced_pending: List[Employee] = []

            for emp in pending:
                if self._is_forced_unassigned(emp):
                    forced_pending.append(emp)
                    continue
                idx, seq, _ = self._find_best_global_insertion(
                    repaired,
                    emp,
                    strictness=strictness,
                    penalty_factor=10.0,
                    allow_soft=False,
                )
                if idx is None:
                    repaired.unassigned.append(emp)
                    continue

                route = repaired.routes[idx]
                route.stop_sequence = seq
                self._sync_route_employees(route)
                progress = True

            if forced_pending:
                repaired.unassigned.extend(forced_pending)

            if not progress:
                break

        self._sync_unassigned(repaired)
        return repaired

    def repair_to_feasible(self, individual: Individual, max_passes: int = 2) -> Individual:
        """
        Rebuild each route with strict insertion to remove accumulated soft violations.
        """
        repaired = copy.deepcopy(individual)
        overflow: List[Employee] = []

        for route in repaired.routes:
            employees = [self._employee_by_id[str(emp_id)] for emp_id in self._pickup_employee_ids(route) if str(emp_id) in self._employee_by_id]
            route.stop_sequence = []
            route.employees = []

            for emp in sorted(employees, key=lambda e: (e.priority, e.latest_drop - e.earliest_pickup, str(e.id))):
                seq, _ = self._find_best_insertion_for_route(
                    route,
                    emp,
                    strictness=1.0,
                    penalty_factor=10.0,
                    allow_soft=False,
                )
                if seq is None:
                    overflow.append(emp)
                else:
                    route.stop_sequence = seq
                    self._sync_route_employees(route)

        repaired.unassigned.extend(overflow)
        repaired = self.force_reassign_unassigned(repaired, max_passes=max_passes, strictness=1.0)
        self._sync_unassigned(repaired)
        return repaired

    def crossover(self, parent_a: Individual, parent_b: Individual) -> Individual:
        """Vehicle-partition crossover with duplicate-assignment prevention."""
        routes_a = {str(r.vehicle.id): r for r in parent_a.routes}
        routes_b = {str(r.vehicle.id): r for r in parent_b.routes}
        all_vids = sorted(set(routes_a.keys()) | set(routes_b.keys()))
        if not all_vids:
            return Individual(routes=[], unassigned=list(self.problem.employees))

        split = max(1, len(all_vids) // 2)
        first_half = set(self.rng.sample(all_vids, split))

        child_routes = []
        assigned_ids = set()

        for vid in all_vids:
            src = routes_a.get(vid) if vid in first_half else routes_b.get(vid)
            if src is None:
                src = routes_b.get(vid) if vid in first_half else routes_a.get(vid)
            if src is None:
                continue
            route = self._clone_route_without_duplicates(src, assigned_ids)
            child_routes.append(route)
            assigned_ids.update(self._pickup_employee_ids(route))

        # Ensure every vehicle exists exactly once in child.
        existing_vids = {str(r.vehicle.id) for r in child_routes}
        for vehicle in self.problem.vehicles:
            if str(vehicle.id) not in existing_vids:
                child_routes.append(Route(vehicle=vehicle, employees=[], stop_sequence=[]))

        unassigned = [e for e in self.problem.employees if str(e.id) not in assigned_ids]
        child = Individual(routes=child_routes, unassigned=unassigned)
        self._sync_unassigned(child)
        return child

    def _apply_two_opt(self, route: Route, strictness: float = 1.0, penalty_factor: float = 1.0) -> None:
        seq = list(route.stop_sequence)
        n = len(seq)
        if n < 4:
            return

        improved = True
        while improved:
            improved = False
            curr_valid, best_cost = self._check_sequence_validity_and_cost(
                seq,
                route.vehicle,
                strictness=strictness,
                penalty_factor=penalty_factor,
                allow_soft=False,
            )
            if not curr_valid:
                break
            for i in range(n - 1):
                for j in range(i + 1, n):
                    candidate = seq[:i] + seq[i : j + 1][::-1] + seq[j + 1 :]
                    if not self._check_precedence(candidate):
                        continue
                    valid, new_cost = self._check_sequence_validity_and_cost(
                        candidate,
                        route.vehicle,
                        strictness=strictness,
                        penalty_factor=penalty_factor,
                        allow_soft=False,
                    )
                    if not valid:
                        continue
                    if new_cost < best_cost - 1e-6:
                        seq = candidate
                        best_cost = new_cost
                        improved = True
                        break
                if improved:
                    break

        route.stop_sequence = seq
        self._sync_route_employees(route)

    # ---------- Destroy operators ----------

    def _apply_ruin(
        self,
        individual: Individual,
        ruin_fraction: float,
        max_victims: int,
        destroy_mode: str,
        penalty_factor: float,
        strictness: float,
    ) -> List[Employee]:
        active_routes = [r for r in individual.routes if r.stop_sequence]
        if not active_routes:
            return []

        ruin_fraction = max(0.05, min(0.9, float(ruin_fraction)))
        max_victims = max(1, int(max_victims))
        remove_count = max(1, int(sum(len(self._pickup_employee_ids(r)) for r in active_routes) * ruin_fraction))

        if destroy_mode == "route":
            return self._route_destroy(active_routes, remove_count)
        if destroy_mode == "worst":
            return self._worst_destroy(individual, remove_count, strictness, penalty_factor)
        if destroy_mode == "related":
            return self._related_destroy(individual, remove_count)
        return self._random_destroy(active_routes, remove_count, max_victims)

    def _random_destroy(self, routes: List[Route], remove_count: int, max_victims: int) -> List[Employee]:
        removed = []
        if remove_count <= 0:
            return removed

        candidate_routes = list(routes)
        self.rng.shuffle(candidate_routes)

        while len(removed) < remove_count and candidate_routes:
            route = self.rng.choice(candidate_routes)
            emp_ids = self._pickup_employee_ids(route)
            if not emp_ids:
                candidate_routes = [r for r in candidate_routes if self._pickup_employee_ids(r)]
                continue

            k = min(len(emp_ids), max_victims, remove_count - len(removed))
            victim_ids = set(self.rng.sample(emp_ids, k))
            removed.extend(self._remove_employees_from_route(route, victim_ids))

        return self._dedupe_employees(removed)

    def _worst_destroy(
        self,
        individual: Individual,
        remove_count: int,
        strictness: float,
        penalty_factor: float,
    ) -> List[Employee]:
        scored: List[Tuple[float, Route, str]] = []

        for route in individual.routes:
            emp_ids = self._pickup_employee_ids(route)
            if not emp_ids:
                continue
            for emp_id in emp_ids:
                score = self._marginal_employee_cost(route, emp_id, strictness, penalty_factor)
                scored.append((score, route, emp_id))

        scored.sort(key=lambda t: t[0], reverse=True)
        removed = []
        used_ids = set()
        for _, route, emp_id in scored:
            if len(removed) >= remove_count:
                break
            if emp_id in used_ids:
                continue
            rem = self._remove_employees_from_route(route, {emp_id})
            if rem:
                removed.extend(rem)
                used_ids.add(emp_id)

        return self._dedupe_employees(removed)

    def _related_destroy(self, individual: Individual, remove_count: int) -> List[Employee]:
        # Seed around a random passenger; remove spatial/time-window-related passengers.
        all_emp_ids = []
        for route in individual.routes:
            all_emp_ids.extend(self._pickup_employee_ids(route))
        if not all_emp_ids:
            return []

        seed_id = self.rng.choice(all_emp_ids)
        seed_emp = self._employee_by_id.get(str(seed_id))
        if seed_emp is None:
            return []

        related_scores: List[Tuple[float, str, Route]] = []
        for route in individual.routes:
            for emp_id in self._pickup_employee_ids(route):
                emp = self._employee_by_id.get(str(emp_id))
                if emp is None:
                    continue
                geo = get_distance(seed_emp.pickup_loc, emp.pickup_loc)
                tw = abs((seed_emp.earliest_pickup + seed_emp.latest_drop) - (emp.earliest_pickup + emp.latest_drop))
                related_scores.append((geo + (tw / 120.0), str(emp_id), route))

        related_scores.sort(key=lambda x: x[0])
        victims = related_scores[: max(1, remove_count)]

        removed = []
        used = set()
        for _, emp_id, route in victims:
            if emp_id in used:
                continue
            removed.extend(self._remove_employees_from_route(route, {emp_id}))
            used.add(emp_id)

        return self._dedupe_employees(removed)

    def _route_destroy(self, routes: List[Route], remove_count: int) -> List[Employee]:
        # Remove whole route(s) until target count is reached.
        removed = []
        candidates = sorted(routes, key=lambda r: len(self._pickup_employee_ids(r)), reverse=True)

        for route in candidates:
            if len(removed) >= remove_count:
                break
            ids = set(self._pickup_employee_ids(route))
            removed.extend(self._remove_employees_from_route(route, ids))

        return self._dedupe_employees(removed)

    # ---------- Repair helpers ----------

    def _regret_insert_pending(
        self,
        individual: Individual,
        pending: List[Employee],
        k: int,
        strictness: float,
        penalty_factor: float,
    ) -> None:
        remaining = [emp for emp in pending if not self._is_forced_unassigned(emp)]
        forced = [emp for emp in pending if self._is_forced_unassigned(emp)]
        if forced:
            individual.unassigned.extend(forced)

        while remaining:
            best_choice = None
            best_regret = float("-inf")
            best_best_cost = float("inf")

            for emp in remaining:
                candidates: List[Tuple[float, int, List[Dict]]] = []
                for idx, route in enumerate(individual.routes):
                    seq, diff = self._find_best_insertion_for_route(
                        route,
                        emp,
                        strictness=strictness,
                        penalty_factor=penalty_factor,
                        allow_soft=True,
                    )
                    if seq is None:
                        continue
                    candidates.append((diff, idx, seq))

                if not candidates:
                    continue

                candidates.sort(key=lambda x: x[0])
                base = candidates[0][0]
                k_idx = min(len(candidates) - 1, max(0, k - 1))
                regret = candidates[k_idx][0] - base

                if regret > best_regret or (abs(regret - best_regret) < 1e-9 and base < best_best_cost):
                    best_regret = regret
                    best_best_cost = base
                    best_choice = (emp, candidates[0][1], candidates[0][2])

            if best_choice is None:
                individual.unassigned.extend(remaining)
                break

            emp, route_idx, seq = best_choice
            route = individual.routes[route_idx]
            route.stop_sequence = seq
            self._sync_route_employees(route)
            remaining = [e for e in remaining if str(e.id) != str(emp.id)]

    def _find_best_global_insertion(
        self,
        individual: Individual,
        emp: Employee,
        strictness: float,
        penalty_factor: float,
        allow_soft: bool,
    ) -> Tuple[Optional[int], Optional[List[Dict]], float]:
        if self._is_forced_unassigned(emp):
            return None, None, float("inf")

        best_idx = None
        best_seq = None
        best_cost_increase = float("inf")

        for idx, route in enumerate(individual.routes):
            seq, cost_inc = self._find_best_insertion_for_route(
                route,
                emp,
                strictness=strictness,
                penalty_factor=penalty_factor,
                allow_soft=allow_soft,
            )
            if seq is None:
                continue
            if cost_inc < best_cost_increase:
                best_cost_increase = cost_inc
                best_seq = seq
                best_idx = idx

        return best_idx, best_seq, best_cost_increase

    def _find_best_insertion_for_route(
        self,
        route: Route,
        emp: Employee,
        strictness: float = 1.0,
        penalty_factor: float = 1.0,
        allow_soft: bool = True,
    ) -> Tuple[Optional[List[Dict]], float]:
        if self._is_forced_unassigned(emp):
            return None, float("inf")

        vehicle = route.vehicle
        current_seq = list(route.stop_sequence)
        prefix_cache: Optional[_SequencePrefixCache] = None
        if self.insertion_prefix_eval_enabled:
            base_valid, base_cost, prefix_cache = self._check_sequence_validity_and_cost_with_prefix_cache(
                current_seq,
                vehicle,
                strictness=strictness,
                penalty_factor=penalty_factor,
                allow_soft=allow_soft,
            )
        else:
            base_valid, base_cost = self._check_sequence_validity_and_cost(
                current_seq,
                vehicle,
                strictness=strictness,
                penalty_factor=penalty_factor,
                allow_soft=allow_soft,
            )
        if not base_valid:
            base_cost = self._quick_cost(current_seq, vehicle)
            prefix_cache = None

        min_cost_diff = float("inf")
        n = len(current_seq)
        pickup = {"type": "p", "emp": emp}
        drop = {"type": "d", "emp": emp}
        best_pickup_idx: Optional[int] = None
        best_drop_idx: Optional[int] = None

        for i in range(n + 1):
            for j in range(i + 1, n + 2):
                delta_est = self._delta_insert_pair_distance(current_seq, vehicle, pickup, drop, i, j)
                if min_cost_diff < float("inf") and delta_est > min_cost_diff * 1.35:
                    self.insertion_eval_stats["deltaPrunes"] += 1
                    continue

                self.insertion_eval_stats["candidateChecks"] += 1
                if prefix_cache is not None:
                    valid, total_metric = self._evaluate_insert_pair_from_prefix_cache(
                        prefix_cache,
                        base_sequence=current_seq,
                        vehicle=vehicle,
                        emp=emp,
                        pickup_idx=i,
                        drop_idx=j,
                        strictness=strictness,
                        penalty_factor=penalty_factor,
                        allow_soft=allow_soft,
                    )
                    self.insertion_eval_stats["prefixUsed"] += 1
                else:
                    candidate = list(current_seq)
                    candidate.insert(i, pickup)
                    candidate.insert(j, drop)
                    valid, total_metric = self._check_sequence_validity_and_cost(
                        candidate,
                        vehicle,
                        strictness=strictness,
                        penalty_factor=penalty_factor,
                        allow_soft=allow_soft,
                    )
                    self.insertion_eval_stats["fullUsed"] += 1
                if not valid:
                    continue

                diff = total_metric - base_cost
                if diff < min_cost_diff:
                    min_cost_diff = diff
                    best_pickup_idx = i
                    best_drop_idx = j

        if best_pickup_idx is None or best_drop_idx is None:
            return None, float("inf")

        best_seq = list(current_seq)
        best_seq.insert(best_pickup_idx, pickup)
        best_seq.insert(best_drop_idx, drop)
        return best_seq, min_cost_diff

    def _check_sequence_validity_and_cost_with_prefix_cache(
        self,
        sequence: List[Dict],
        vehicle: Vehicle,
        strictness: float,
        penalty_factor: float,
        allow_soft: bool,
    ) -> Tuple[bool, float, Optional[_SequencePrefixCache]]:
        """Like ``_check_sequence_validity_and_cost`` but also returns a prefix cache.

        The cache is only returned when the sequence is valid; otherwise (False, inf, None).
        """
        curr_loc = vehicle.start_loc
        curr_time = float(vehicle.avail_from)
        dist = 0.0
        load = 0
        picked_mask = 0
        active_mask = 0
        capacity = int(vehicle.capacity)

        emp_bit_index: Dict[str, int] = {}
        share_limit_by_emp_id: Dict[str, int] = {}
        max_delay_by_emp_id: Dict[str, float] = {}

        soft_penalty = 0.0
        latest_soft_multiplier = 100.0 * penalty_factor * (0.5 + 2.2 * strictness)
        sharing_soft_multiplier = 7_000.0 * penalty_factor * (0.4 + 1.8 * strictness)
        premium_soft_multiplier = 8_500.0 * penalty_factor * (0.4 + 2.1 * strictness)

        def _emp_bit(emp_id: str) -> int:
            idx = emp_bit_index.get(emp_id)
            if idx is None:
                idx = len(emp_bit_index)
                emp_bit_index[emp_id] = idx
            return 1 << idx

        def _share_limit(emp: Employee) -> int:
            emp_id = str(emp.id)
            cached = share_limit_by_emp_id.get(emp_id)
            if cached is not None:
                return cached
            limit = int(self._sharing_limit(getattr(emp, "sharing_pref", "")))
            limit = max(1, min(capacity, limit))
            share_limit_by_emp_id[emp_id] = limit
            return limit

        def _max_delay(emp: Employee) -> float:
            emp_id = str(emp.id)
            cached = max_delay_by_emp_id.get(emp_id)
            if cached is not None:
                return cached
            value = float(get_max_allowed_delay(emp.priority, self.problem.metadata))
            max_delay_by_emp_id[emp_id] = value
            return value

        # Snapshots are taken after processing the first i stops; index i is the
        # state "before" stop i in the original sequence (and an insertion at i).
        loc_before: List[object] = [curr_loc]
        time_before: List[float] = [curr_time]
        dist_before: List[float] = [dist]
        load_before: List[int] = [load]
        soft_before: List[float] = [soft_penalty]
        picked_before: List[int] = [picked_mask]
        active_before: List[int] = [active_mask]
        share_counts = [0] * (capacity + 1)  # index is share limit (clamped)
        share_before: List[Tuple[int, ...]] = [tuple(share_counts)]

        for pos, stop in enumerate(sequence):
            emp = stop.get("emp")
            stop_type = stop.get("type")
            if emp is None or stop_type not in ("p", "d"):
                return False, float("inf"), None
            if self._is_forced_unassigned(emp):
                return False, float("inf"), None

            target = emp.pickup_loc if stop_type == "p" else emp.drop_loc
            d = get_distance(curr_loc, target)
            dist += d
            curr_time += calculate_travel_time(d, vehicle.speed_kmph)

            if load == 0 and stop_type == "p" and pos > 0:
                curr_time += TURNAROUND_BUFFER_MINUTES

            emp_id = str(emp.id)
            bit = _emp_bit(emp_id)
            if stop_type == "p":
                curr_time = max(curr_time, float(emp.earliest_pickup))
                load += 1
                picked_mask |= bit
                if (active_mask & bit) == 0:
                    active_mask |= bit
                    share_counts[_share_limit(emp)] += 1

                e_pref = str(emp.vehicle_pref or "").strip().lower()
                v_cat = str(vehicle.category or "").strip().lower()
                if (not self.allow_premium_mismatch) and e_pref == "premium" and v_cat != "premium":
                    if not allow_soft or strictness >= 0.95:
                        return False, float("inf"), None
                    soft_penalty += premium_soft_multiplier
            else:
                if (picked_mask & bit) == 0:
                    return False, float("inf"), None
                if (active_mask & bit) != 0:
                    active_mask &= ~bit
                    share_counts[_share_limit(emp)] = max(0, share_counts[_share_limit(emp)] - 1)

                load = max(0, load - 1)

                max_allowed_delay = _max_delay(emp)
                delay_minutes = max(0.0, float(curr_time) - float(emp.latest_drop))
                if delay_minutes > max_allowed_delay + 1e-9:
                    return False, float("inf"), None
                if delay_minutes > 0.0:
                    soft_penalty += min(delay_minutes, max_allowed_delay) * latest_soft_multiplier

            if load > capacity:
                return False, float("inf"), None

            if not self.allow_sharing_violation and load > 0:
                if load > 1:
                    for limit in range(1, min(load, capacity)):
                        c = share_counts[limit]
                        if c <= 0:
                            continue
                        if not allow_soft or strictness >= 0.95:
                            return False, float("inf"), None
                        soft_penalty += (load - limit) * float(c) * sharing_soft_multiplier

            curr_loc = target

            loc_before.append(curr_loc)
            time_before.append(float(curr_time))
            dist_before.append(float(dist))
            load_before.append(int(load))
            soft_before.append(float(soft_penalty))
            picked_before.append(int(picked_mask))
            active_before.append(int(active_mask))
            share_before.append(tuple(share_counts))

        total_metric = (dist * vehicle.cost_per_km) + soft_penalty
        cache = _SequencePrefixCache(
            loc_before=loc_before,
            time_before=time_before,
            dist_before=dist_before,
            load_before=load_before,
            soft_penalty_before=soft_before,
            picked_mask_before=picked_before,
            active_mask_before=active_before,
            share_counts_before=share_before,
            emp_bit_index=emp_bit_index,
            share_limit_by_emp_id=share_limit_by_emp_id,
            max_delay_by_emp_id=max_delay_by_emp_id,
        )
        return True, float(total_metric), cache

    def _evaluate_insert_pair_from_prefix_cache(
        self,
        cache: _SequencePrefixCache,
        base_sequence: List[Dict],
        vehicle: Vehicle,
        emp: Employee,
        pickup_idx: int,
        drop_idx: int,
        strictness: float,
        penalty_factor: float,
        allow_soft: bool,
    ) -> Tuple[bool, float]:
        """Evaluate insertion (pickup, drop) without rebuilding the full sequence.

        Returns (valid, total_metric). Exact semantics match
        ``_check_sequence_validity_and_cost`` for sequences derived from
        *base_sequence* by inserting the pair at (pickup_idx, drop_idx).
        """
        n = len(base_sequence)
        if pickup_idx < 0 or pickup_idx > n:
            return False, float("inf")
        if drop_idx <= pickup_idx or drop_idx > n + 1:
            return False, float("inf")

        # Ensure the new employee has a bit index.
        emp_id_new = str(emp.id)
        if emp_id_new not in cache.emp_bit_index:
            cache.emp_bit_index[emp_id_new] = len(cache.emp_bit_index)
        bit_new = 1 << cache.emp_bit_index[emp_id_new]

        capacity = int(vehicle.capacity)
        latest_soft_multiplier = 100.0 * penalty_factor * (0.5 + 2.2 * strictness)
        sharing_soft_multiplier = 7_000.0 * penalty_factor * (0.4 + 1.8 * strictness)
        premium_soft_multiplier = 8_500.0 * penalty_factor * (0.4 + 2.1 * strictness)

        def share_limit_for(emp_obj: Employee) -> int:
            emp_id = str(emp_obj.id)
            cached = cache.share_limit_by_emp_id.get(emp_id)
            if cached is not None:
                return cached
            limit = int(self._sharing_limit(getattr(emp_obj, "sharing_pref", "")))
            limit = max(1, min(capacity, limit))
            cache.share_limit_by_emp_id[emp_id] = limit
            return limit

        def max_delay_for(emp_obj: Employee) -> float:
            emp_id = str(emp_obj.id)
            cached = cache.max_delay_by_emp_id.get(emp_id)
            if cached is not None:
                return cached
            value = float(get_max_allowed_delay(emp_obj.priority, self.problem.metadata))
            cache.max_delay_by_emp_id[emp_id] = value
            return value

        def process_stop(
            emp_obj: Employee,
            stop_type: str,
            pos: int,
            curr_loc: object,
            curr_time: float,
            dist: float,
            load: int,
            picked_mask: int,
            active_mask: int,
            share_counts: List[int],
            soft_penalty: float,
        ) -> Tuple[bool, object, float, float, int, int, int, float]:
            if emp_obj is None or stop_type not in ("p", "d"):
                return False, curr_loc, curr_time, dist, load, picked_mask, active_mask, float("inf")
            if self._is_forced_unassigned(emp_obj):
                return False, curr_loc, curr_time, dist, load, picked_mask, active_mask, float("inf")

            target = emp_obj.pickup_loc if stop_type == "p" else emp_obj.drop_loc
            d = get_distance(curr_loc, target)
            dist += d
            curr_time += calculate_travel_time(d, vehicle.speed_kmph)

            if load == 0 and stop_type == "p" and pos > 0:
                curr_time += TURNAROUND_BUFFER_MINUTES

            emp_id = str(emp_obj.id)
            if emp_id not in cache.emp_bit_index:
                cache.emp_bit_index[emp_id] = len(cache.emp_bit_index)
            bit = 1 << cache.emp_bit_index[emp_id]

            if stop_type == "p":
                curr_time = max(curr_time, float(emp_obj.earliest_pickup))
                load += 1
                picked_mask |= bit
                if (active_mask & bit) == 0:
                    active_mask |= bit
                    share_counts[share_limit_for(emp_obj)] += 1

                e_pref = str(emp_obj.vehicle_pref or "").strip().lower()
                v_cat = str(vehicle.category or "").strip().lower()
                if (not self.allow_premium_mismatch) and e_pref == "premium" and v_cat != "premium":
                    if not allow_soft or strictness >= 0.95:
                        return False, curr_loc, curr_time, dist, load, picked_mask, active_mask, float("inf")
                    soft_penalty += premium_soft_multiplier
            else:
                if (picked_mask & bit) == 0:
                    return False, curr_loc, curr_time, dist, load, picked_mask, active_mask, float("inf")
                if (active_mask & bit) != 0:
                    active_mask &= ~bit
                    limit = share_limit_for(emp_obj)
                    share_counts[limit] = max(0, share_counts[limit] - 1)
                load = max(0, load - 1)

                max_allowed_delay = max_delay_for(emp_obj)
                delay_minutes = max(0.0, float(curr_time) - float(emp_obj.latest_drop))
                if delay_minutes > max_allowed_delay + 1e-9:
                    return False, curr_loc, curr_time, dist, load, picked_mask, active_mask, float("inf")
                if delay_minutes > 0.0:
                    soft_penalty += min(delay_minutes, max_allowed_delay) * latest_soft_multiplier

            if load > capacity:
                return False, curr_loc, curr_time, dist, load, picked_mask, active_mask, float("inf")

            if not self.allow_sharing_violation and load > 0:
                if load > 1:
                    for limit in range(1, min(load, capacity)):
                        c = share_counts[limit]
                        if c <= 0:
                            continue
                        if not allow_soft or strictness >= 0.95:
                            return False, curr_loc, curr_time, dist, load, picked_mask, active_mask, float("inf")
                        soft_penalty += (load - limit) * float(c) * sharing_soft_multiplier

            curr_loc = target
            return True, curr_loc, curr_time, dist, load, picked_mask, active_mask, soft_penalty

        # Load prefix snapshot at pickup_idx (after pickup_idx original stops).
        curr_loc = cache.loc_before[pickup_idx]
        curr_time = float(cache.time_before[pickup_idx])
        dist = float(cache.dist_before[pickup_idx])
        load = int(cache.load_before[pickup_idx])
        soft_penalty = float(cache.soft_penalty_before[pickup_idx])
        picked_mask = int(cache.picked_mask_before[pickup_idx])
        active_mask = int(cache.active_mask_before[pickup_idx])
        share_counts = list(cache.share_counts_before[pickup_idx])

        pos = pickup_idx
        ok, curr_loc, curr_time, dist, load, picked_mask, active_mask, soft_penalty = process_stop(
            emp, "p", pos, curr_loc, curr_time, dist, load, picked_mask, active_mask, share_counts, soft_penalty
        )
        if not ok:
            return False, float("inf")
        # Ensure the inserted employee appears "picked" in masks even if it shared a bit index.
        picked_mask |= bit_new
        active_mask |= bit_new
        pos += 1

        # Original stops between pickup and drop.
        for k in range(pickup_idx, drop_idx - 1):
            if k >= n:
                break
            stop = base_sequence[k]
            ok, curr_loc, curr_time, dist, load, picked_mask, active_mask, soft_penalty = process_stop(
                stop.get("emp"),
                stop.get("type"),
                pos,
                curr_loc,
                curr_time,
                dist,
                load,
                picked_mask,
                active_mask,
                share_counts,
                soft_penalty,
            )
            if not ok:
                return False, float("inf")
            pos += 1

        ok, curr_loc, curr_time, dist, load, picked_mask, active_mask, soft_penalty = process_stop(
            emp, "d", pos, curr_loc, curr_time, dist, load, picked_mask, active_mask, share_counts, soft_penalty
        )
        if not ok:
            return False, float("inf")
        pos += 1

        # Remaining original stops after drop.
        for k in range(drop_idx - 1, n):
            stop = base_sequence[k]
            ok, curr_loc, curr_time, dist, load, picked_mask, active_mask, soft_penalty = process_stop(
                stop.get("emp"),
                stop.get("type"),
                pos,
                curr_loc,
                curr_time,
                dist,
                load,
                picked_mask,
                active_mask,
                share_counts,
                soft_penalty,
            )
            if not ok:
                return False, float("inf")
            pos += 1

        total_metric = (dist * vehicle.cost_per_km) + soft_penalty
        return True, float(total_metric)

    def _check_sequence_validity_and_cost(
        self,
        sequence: List[Dict],
        vehicle: Vehicle,
        strictness: float = 1.0,
        penalty_factor: float = 1.0,
        allow_soft: bool = True,
    ) -> Tuple[bool, float]:
        curr_loc = vehicle.start_loc
        curr_time = float(vehicle.avail_from)
        dist = 0.0
        load = 0
        active_passengers = set()
        picked_up_ids = set()

        soft_penalty = 0.0
        latest_soft_multiplier = 100.0 * penalty_factor * (0.5 + 2.2 * strictness)
        sharing_soft_multiplier = 7_000.0 * penalty_factor * (0.4 + 1.8 * strictness)
        premium_soft_multiplier = 8_500.0 * penalty_factor * (0.4 + 2.1 * strictness)

        for i, stop in enumerate(sequence):
            emp = stop.get("emp")
            stop_type = stop.get("type")
            if emp is None or stop_type not in ("p", "d"):
                return False, float("inf")
            if self._is_forced_unassigned(emp):
                return False, float("inf")

            target = emp.pickup_loc if stop_type == "p" else emp.drop_loc
            d = get_distance(curr_loc, target)
            dist += d
            curr_time += calculate_travel_time(d, vehicle.speed_kmph)

            if load == 0 and stop_type == "p" and i > 0:
                curr_time += TURNAROUND_BUFFER_MINUTES

            if stop_type == "p":
                curr_time = max(curr_time, float(emp.earliest_pickup))
                load += 1
                active_passengers.add(emp)
                picked_up_ids.add(emp.id)

                e_pref = str(emp.vehicle_pref or "").strip().lower()
                v_cat = str(vehicle.category or "").strip().lower()
                if (not self.allow_premium_mismatch) and e_pref == "premium" and v_cat != "premium":
                    if not allow_soft or strictness >= 0.95:
                        return False, float("inf")
                    soft_penalty += premium_soft_multiplier
            else:
                if emp.id not in picked_up_ids:
                    return False, float("inf")
                if emp in active_passengers:
                    active_passengers.remove(emp)
                load = max(0, load - 1)

                max_allowed_delay = float(
                    get_max_allowed_delay(emp.priority, self.problem.metadata)
                )
                delay_minutes = max(0.0, float(curr_time) - float(emp.latest_drop))

                # Delay remains soft up to max_allowed_delay. Beyond that, sequence is invalid.
                if delay_minutes > max_allowed_delay + 1e-9:
                    return False, float("inf")
                if delay_minutes > 0.0:
                    soft_penalty += min(delay_minutes, max_allowed_delay) * latest_soft_multiplier

            if load > vehicle.capacity:
                return False, float("inf")

            if not self.allow_sharing_violation:
                for p in active_passengers:
                    max_share = self._sharing_limit(getattr(p, "sharing_pref", ""))
                    if load > max_share:
                        if not allow_soft or strictness >= 0.95:
                            return False, float("inf")
                        soft_penalty += (load - max_share) * sharing_soft_multiplier

            curr_loc = target

        total_metric = (dist * vehicle.cost_per_km) + soft_penalty
        return True, total_metric

    def _quick_cost(self, sequence: List[Dict], vehicle: Vehicle) -> float:
        if not sequence:
            return 0.0

        key = (
            str(vehicle.id),
            tuple((s.get("type"), str(getattr(s.get("emp"), "id", ""))) for s in sequence),
        )
        cached = self._quick_cost_cache.get(key)
        if cached is not None:
            return cached

        curr = vehicle.start_loc
        dist = 0.0
        for stop in sequence:
            emp = stop.get("emp")
            target = emp.pickup_loc if stop.get("type") == "p" else emp.drop_loc
            dist += get_distance(curr, target)
            curr = target

        value = dist * vehicle.cost_per_km
        if len(self._quick_cost_cache) >= self._quick_cost_cache_limit:
            self._quick_cost_cache.clear()
        self._quick_cost_cache[key] = value
        return value

    # ---------- Delta helpers ----------

    def _delta_insert_pair_distance(
        self,
        sequence: List[Dict],
        vehicle: Vehicle,
        pickup_stop: Dict,
        drop_stop: Dict,
        pickup_idx: int,
        drop_idx: int,
    ) -> float:
        """
        O(1)-style local edge delta estimate for inserting pickup+drop pair.
        Used to prune expensive candidates before full validation.
        """

        def node_loc(node):
            if node is None:
                return None
            emp = node.get("emp")
            return emp.pickup_loc if node.get("type") == "p" else emp.drop_loc

        def edge_cost(left, right):
            if right is None:
                return 0.0
            if left is None:
                src = vehicle.start_loc
            else:
                src = node_loc(left)
            dst = node_loc(right)
            return get_distance(src, dst) * vehicle.cost_per_km

        n = len(sequence)
        if pickup_idx < 0 or pickup_idx > n:
            return float("inf")
        if drop_idx <= pickup_idx or drop_idx > n + 1:
            return float("inf")

        delta = 0.0

        prev_i = sequence[pickup_idx - 1] if pickup_idx > 0 else None
        next_i = sequence[pickup_idx] if pickup_idx < n else None
        delta += edge_cost(prev_i, pickup_stop) + edge_cost(pickup_stop, next_i) - edge_cost(prev_i, next_i)

        # drop_idx is on sequence after pickup insertion.
        if drop_idx - 1 == pickup_idx:
            prev_j = pickup_stop
        elif drop_idx - 1 < pickup_idx:
            prev_j = sequence[drop_idx - 1]
        else:
            prev_j = sequence[drop_idx - 2]

        if drop_idx == n + 1:
            next_j = None
        elif drop_idx <= pickup_idx:
            next_j = sequence[drop_idx]
        else:
            next_j = sequence[drop_idx - 1]

        delta += edge_cost(prev_j, drop_stop) + edge_cost(drop_stop, next_j) - edge_cost(prev_j, next_j)
        return delta

    def _marginal_employee_cost(
        self,
        route: Route,
        emp_id: str,
        strictness: float,
        penalty_factor: float,
    ) -> float:
        original_seq = list(route.stop_sequence)
        reduced_seq = [s for s in route.stop_sequence if str(getattr(s.get("emp"), "id", "")) != str(emp_id)]

        valid_orig, cost_orig = self._check_sequence_validity_and_cost(
            original_seq,
            route.vehicle,
            strictness=strictness,
            penalty_factor=penalty_factor,
            allow_soft=True,
        )
        if not valid_orig:
            cost_orig = self._quick_cost(original_seq, route.vehicle) + 250_000.0

        valid_new, cost_new = self._check_sequence_validity_and_cost(
            reduced_seq,
            route.vehicle,
            strictness=strictness,
            penalty_factor=penalty_factor,
            allow_soft=True,
        )
        if not valid_new:
            cost_new = self._quick_cost(reduced_seq, route.vehicle) + 250_000.0

        return cost_orig - cost_new

    # ---------- Route mutation helpers ----------

    def _remove_employees_from_route(self, route: Route, victim_ids: Set[str]) -> List[Employee]:
        if not victim_ids:
            return []
        removed = []
        for emp_id in list(victim_ids):
            emp_obj = self._employee_by_id.get(str(emp_id))
            if emp_obj is not None:
                removed.append(emp_obj)

        route.stop_sequence = [
            stop for stop in route.stop_sequence if str(getattr(stop.get("emp"), "id", "")) not in victim_ids
        ]
        self._sync_route_employees(route)
        return removed

    def _clone_route_without_duplicates(self, route: Route, assigned_ids: Set[str]) -> Route:
        new_route = Route(vehicle=route.vehicle, employees=[], stop_sequence=[])
        allowed_ids = []

        for emp_id in self._pickup_employee_ids(route):
            if emp_id in assigned_ids:
                continue
            allowed_ids.append(emp_id)
            assigned_ids.add(emp_id)

        allowed_set = set(allowed_ids)
        for stop in route.stop_sequence:
            emp = stop.get("emp")
            if emp is None:
                continue
            if str(emp.id) in allowed_set:
                new_route.stop_sequence.append(stop)

        self._sync_route_employees(new_route)
        return new_route

    def _pickup_employee_ids(self, route: Route) -> List[str]:
        ids = []
        seen = set()
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
            ids.append(emp_id)
        for emp in route.employees:
            emp_id = str(emp.id)
            if emp_id not in seen:
                seen.add(emp_id)
                ids.append(emp_id)
        return ids

    def _check_precedence(self, sequence: List[Dict]) -> bool:
        seen = set()
        for stop in sequence:
            emp = stop.get("emp")
            stop_type = stop.get("type")
            if emp is None or stop_type not in ("p", "d"):
                return False
            eid = str(emp.id)
            if stop_type == "p":
                seen.add(eid)
            elif eid not in seen:
                return False
        return True

    def _sharing_limit(self, sharing_pref: str) -> int:
        pref = str(sharing_pref or "").strip().lower()
        if pref in ("single", "1"):
            return 1
        if pref in ("double", "2"):
            return 2
        if pref in ("triple", "3"):
            return 3
        try:
            return max(1, int(pref))
        except Exception:
            return 2

    def _sync_route_employees(self, route: Route) -> None:
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

    def _sync_unassigned(self, individual: Individual) -> None:
        assigned_ids = set()
        for route in individual.routes:
            assigned_ids.update(self._pickup_employee_ids(route))
        individual.unassigned = [e for e in self.problem.employees if str(e.id) not in assigned_ids]

    def _parse_forced_unassigned_ids(self, metadata: Dict) -> Set[str]:
        raw = metadata.get("FORCED_UNASSIGNED_IDS")
        if raw is None:
            return set()
        items: List[str] = []
        if isinstance(raw, (list, tuple, set)):
            items = [str(v).strip() for v in raw]
        else:
            text = str(raw).strip()
            if text:
                items = [s.strip() for s in text.split(",")]
        return {s for s in items if s}

    def _is_forced_unassigned(self, emp: Optional[Employee]) -> bool:
        if emp is None:
            return False
        return str(getattr(emp, "id", "")) in self._forced_unassigned_ids

    def _meta_candidates(self, key: str) -> List[str]:
        text = str(key or "").strip()
        if not text:
            return []
        snake = text.replace("-", "_")
        ordered = [text, text.lower(), text.upper(), snake, snake.lower(), snake.upper()]
        out: List[str] = []
        for item in ordered:
            if item and item not in out:
                out.append(item)
        return out

    def _meta_raw(self, key: str):
        meta = self.metadata or {}
        for candidate in self._meta_candidates(key):
            if candidate in meta:
                return meta.get(candidate)
        return None

    def _meta_bool(self, key: str, default: bool) -> bool:
        raw = self._meta_raw(key)
        if raw is None:
            return bool(default)
        if isinstance(raw, bool):
            return raw
        text = str(raw).strip().lower()
        if text in ("1", "true", "yes", "on"):
            return True
        if text in ("0", "false", "no", "off"):
            return False
        return bool(default)

    def _dedupe_employees(self, employees: Sequence[Employee]) -> List[Employee]:
        out = []
        seen = set()
        for emp in employees:
            emp_id = str(emp.id)
            if emp_id in seen:
                continue
            seen.add(emp_id)
            out.append(emp)
        return out
