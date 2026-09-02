from __future__ import annotations

import copy
import random
from typing import List, Optional, Tuple

from models import Employee, ProblemInstance
from objective import ObjectiveEvaluator
from operators import GeneticOperators
from representation import Individual
from operator_control import ContextualUCBSelector, SearchContext


class NeighborhoodSearch:
    def __init__(
        self,
        problem: ProblemInstance,
        operators: GeneticOperators,
        evaluator: ObjectiveEvaluator,
        rng: Optional[random.Random] = None,
    ):
        self.problem = problem
        self.ops = operators
        self.evaluator = evaluator
        self.rng = rng or random.Random()
        meta = getattr(problem, "metadata", {}) or {}
        raw = meta.get("DELTA_EVAL_ENABLED", meta.get("delta_eval_enabled", True))
        if isinstance(raw, bool):
            self.delta_eval_enabled = bool(raw)
        else:
            text = str(raw).strip().lower()
            self.delta_eval_enabled = text not in ("0", "false", "no", "off")

    def improve(
        self,
        individual: Individual,
        max_moves: int = 6,
        penalty_factor: float = 1.0,
        phase_progress: float = 1.0,
        operator_control: Optional[ContextualUCBSelector] = None,
        search_context: Optional[SearchContext] = None,
        deterministic: bool = False,
    ) -> Individual:
        best = copy.deepcopy(individual)
        enforce_hard = phase_progress >= 0.95
        self.evaluator.evaluate(
            best,
            penalty_factor=penalty_factor,
            phase_progress=phase_progress,
            enforce_hard=enforce_hard,
        )
        inc_state = None
        if self.delta_eval_enabled:
            inc_state = self.evaluator.build_incremental_state(
                best,
                penalty_factor=penalty_factor,
                phase_progress=phase_progress,
                enforce_hard=enforce_hard,
            )

        strictness = max(0.0, min(1.0, float(phase_progress)))
        moves = 0
        metrics = {
            "candidateEvaluations": 0,
            "incrementalEvaluations": 0,
            "fullEvaluations": 1,  # initial full eval above
            # "hit rates" = how often each neighborhood produced an accepted improvement.
            "neighborhoods": {},
        }

        while moves < max_moves:
            improved_any = False
            fns = [
                self._inter_route_relocate,
                self._inter_route_swap,
                self._intra_route_pair_reinsert,
                self._small_route_reorder,
            ]
            fn_by_name = {str(getattr(fn, "__name__", "unknown")).lstrip("_"): fn for fn in fns}
            tried = set()

            ctx = search_context
            if ctx is None:
                ctx = SearchContext(
                    phase_progress=float(phase_progress),
                    strictness=float(strictness),
                    current_feasible=True,
                    unassigned_frac=float(len(getattr(best, "unassigned", []) or []) / max(1, len(self.problem.employees))),
                    stagnation_best_steps=0,
                    stagnation_current_steps=0,
                    ruin_fraction=0.0,
                    max_victims=0,
                )

            for _ in range(len(fns)):
                if operator_control is None:
                    fn = fns[len(tried)]
                    name = str(getattr(fn, "__name__", "unknown")).lstrip("_")
                else:
                    remaining = [n for n in fn_by_name.keys() if n not in tried]
                    if not remaining:
                        break
                    name = operator_control.choose(
                        ctx=ctx,
                        arms=remaining,
                        base_weights=None,
                        rng=self.rng,
                        deterministic=bool(deterministic),
                    )
                    fn = fn_by_name.get(str(name))
                    if fn is None:
                        fn = fn_by_name[remaining[0]]
                        name = remaining[0]

                tried.add(str(name))
                nm = metrics["neighborhoods"].setdefault(str(name), {"attempts": 0, "hits": 0})
                nm["attempts"] += 1
                candidate = fn(
                    best,
                    inc_state=inc_state,
                    penalty_factor=penalty_factor,
                    strictness=strictness,
                    enforce_hard=(strictness >= 0.90),
                    metrics=metrics,
                )

                if candidate is None:
                    if operator_control is not None:
                        operator_control.update(
                            ctx=ctx,
                            arm=str(name),
                            reward=0.10,
                            delta=0.0,
                            accepted=False,
                            improved_current=False,
                            improved_best=False,
                            failed=True,
                        )
                    continue

                delta = float(candidate.objective_score - best.objective_score)
                improved = candidate.objective_score + 1e-9 < best.objective_score
                if operator_control is not None:
                    operator_control.update(
                        ctx=ctx,
                        arm=str(name),
                        reward=(5.0 if improved else 0.30),
                        delta=float(delta),
                        accepted=bool(improved),
                        improved_current=bool(improved),
                        improved_best=False,
                        failed=False,
                    )
                if improved:
                    best = candidate
                    if self.delta_eval_enabled:
                        inc_state = self.evaluator.build_incremental_state(
                            best,
                            penalty_factor=penalty_factor,
                            phase_progress=phase_progress,
                            enforce_hard=enforce_hard,
                        )
                    improved_any = True
                    nm["hits"] += 1
                    moves += 1
                    break
            if not improved_any:
                break

        best.metadata = dict(getattr(best, "metadata", {}) or {})
        best.metadata["deltaEvalMetrics"] = dict(metrics)
        best.metadata["neighborhoodMetrics"] = dict(metrics.get("neighborhoods") or {})
        return best

    def _inter_route_relocate(
        self,
        individual: Individual,
        inc_state: ObjectiveEvaluator.IncrementalEvalState,
        penalty_factor: float,
        strictness: float,
        enforce_hard: bool,
        metrics: dict,
    ) -> Optional[Individual]:
        best_candidate = None
        best_score = individual.objective_score

        route_indices = [idx for idx, r in enumerate(individual.routes) if self.ops._pickup_employee_ids(r)]
        for src_idx in route_indices:
            src_route = individual.routes[src_idx]
            src_ids = self.ops._pickup_employee_ids(src_route)
            self.rng.shuffle(src_ids)

            for emp_id in src_ids[: min(4, len(src_ids))]:
                src_without = [s for s in src_route.stop_sequence if str(s.get("emp").id) != str(emp_id)]
                if not self.ops._check_precedence(src_without):
                    continue

                emp = self.ops._employee_by_id.get(str(emp_id))
                if emp is None:
                    continue

                for dst_idx, dst_route in enumerate(individual.routes):
                    if dst_idx == src_idx:
                        continue

                    seq_dst, _ = self.ops._find_best_insertion_for_route(
                        dst_route,
                        emp,
                        strictness=strictness,
                        penalty_factor=penalty_factor,
                        allow_soft=False,
                    )
                    if seq_dst is None:
                        continue

                    candidate = copy.deepcopy(individual)
                    candidate.routes[src_idx].stop_sequence = src_without
                    self.ops._sync_route_employees(candidate.routes[src_idx])
                    candidate.routes[dst_idx].stop_sequence = seq_dst
                    self.ops._sync_route_employees(candidate.routes[dst_idx])
                    self.ops._sync_unassigned(candidate)

                    metrics["candidateEvaluations"] += 1
                    if inc_state is None:
                        self.evaluator.evaluate(
                            candidate,
                            penalty_factor=penalty_factor,
                            phase_progress=strictness,
                            enforce_hard=enforce_hard,
                        )
                        metrics["fullEvaluations"] += 1
                    else:
                        used_inc = self.evaluator.evaluate_incremental(
                            candidate,
                            state=inc_state,
                            changed_route_indices=[src_idx, dst_idx],
                            penalty_factor=penalty_factor,
                            phase_progress=strictness,
                            enforce_hard=enforce_hard,
                        )
                        if used_inc:
                            metrics["incrementalEvaluations"] += 1
                        else:
                            metrics["fullEvaluations"] += 1

                    if candidate.objective_score + 1e-9 < best_score:
                        best_score = candidate.objective_score
                        best_candidate = candidate

        return best_candidate

    def _inter_route_swap(
        self,
        individual: Individual,
        inc_state: ObjectiveEvaluator.IncrementalEvalState,
        penalty_factor: float,
        strictness: float,
        enforce_hard: bool,
        metrics: dict,
    ) -> Optional[Individual]:
        best_candidate = None
        best_score = individual.objective_score

        non_empty = [idx for idx, r in enumerate(individual.routes) if self.ops._pickup_employee_ids(r)]
        for i in range(len(non_empty)):
            for j in range(i + 1, len(non_empty)):
                left_idx = non_empty[i]
                right_idx = non_empty[j]
                left_route = individual.routes[left_idx]
                right_route = individual.routes[right_idx]

                left_ids = self.ops._pickup_employee_ids(left_route)
                right_ids = self.ops._pickup_employee_ids(right_route)
                self.rng.shuffle(left_ids)
                self.rng.shuffle(right_ids)

                for emp_left in left_ids[: min(3, len(left_ids))]:
                    for emp_right in right_ids[: min(3, len(right_ids))]:
                        if str(emp_left) == str(emp_right):
                            continue

                        left_emp = self.ops._employee_by_id.get(str(emp_left))
                        right_emp = self.ops._employee_by_id.get(str(emp_right))
                        if left_emp is None or right_emp is None:
                            continue

                        left_without = [
                            s
                            for s in left_route.stop_sequence
                            if str(s.get("emp").id) != str(emp_left)
                        ]
                        right_without = [
                            s
                            for s in right_route.stop_sequence
                            if str(s.get("emp").id) != str(emp_right)
                        ]

                        if not self.ops._check_precedence(left_without):
                            continue
                        if not self.ops._check_precedence(right_without):
                            continue

                        left_tmp = copy.deepcopy(left_route)
                        right_tmp = copy.deepcopy(right_route)
                        left_tmp.stop_sequence = left_without
                        right_tmp.stop_sequence = right_without

                        seq_left, _ = self.ops._find_best_insertion_for_route(
                            left_tmp,
                            right_emp,
                            strictness=strictness,
                            penalty_factor=penalty_factor,
                            allow_soft=False,
                        )
                        if seq_left is None:
                            continue

                        right_tmp.stop_sequence = right_without
                        seq_right, _ = self.ops._find_best_insertion_for_route(
                            right_tmp,
                            left_emp,
                            strictness=strictness,
                            penalty_factor=penalty_factor,
                            allow_soft=False,
                        )
                        if seq_right is None:
                            continue

                        candidate = copy.deepcopy(individual)
                        candidate.routes[left_idx].stop_sequence = seq_left
                        candidate.routes[right_idx].stop_sequence = seq_right
                        self.ops._sync_route_employees(candidate.routes[left_idx])
                        self.ops._sync_route_employees(candidate.routes[right_idx])
                        self.ops._sync_unassigned(candidate)

                        metrics["candidateEvaluations"] += 1
                        if inc_state is None:
                            self.evaluator.evaluate(
                                candidate,
                                penalty_factor=penalty_factor,
                                phase_progress=strictness,
                                enforce_hard=enforce_hard,
                            )
                            metrics["fullEvaluations"] += 1
                        else:
                            used_inc = self.evaluator.evaluate_incremental(
                                candidate,
                                state=inc_state,
                                changed_route_indices=[left_idx, right_idx],
                                penalty_factor=penalty_factor,
                                phase_progress=strictness,
                                enforce_hard=enforce_hard,
                            )
                            if used_inc:
                                metrics["incrementalEvaluations"] += 1
                            else:
                                metrics["fullEvaluations"] += 1

                        if candidate.objective_score + 1e-9 < best_score:
                            best_score = candidate.objective_score
                            best_candidate = candidate

        return best_candidate

    def _intra_route_pair_reinsert(
        self,
        individual: Individual,
        inc_state: ObjectiveEvaluator.IncrementalEvalState,
        penalty_factor: float,
        strictness: float,
        enforce_hard: bool,
        metrics: dict,
    ) -> Optional[Individual]:
        best_candidate = None
        best_score = individual.objective_score

        for route_idx, route in enumerate(individual.routes):
            emp_ids = self.ops._pickup_employee_ids(route)
            if len(emp_ids) <= 1:
                continue

            for emp_id in emp_ids[: min(5, len(emp_ids))]:
                emp = self.ops._employee_by_id.get(str(emp_id))
                if emp is None:
                    continue

                reduced = [s for s in route.stop_sequence if str(s.get("emp").id) != str(emp_id)]
                if not self.ops._check_precedence(reduced):
                    continue

                temp_route = copy.deepcopy(route)
                temp_route.stop_sequence = reduced
                seq, _ = self.ops._find_best_insertion_for_route(
                    temp_route,
                    emp,
                    strictness=strictness,
                    penalty_factor=penalty_factor,
                    allow_soft=False,
                )
                if seq is None or seq == route.stop_sequence:
                    continue

                candidate = copy.deepcopy(individual)
                candidate.routes[route_idx].stop_sequence = seq
                self.ops._sync_route_employees(candidate.routes[route_idx])
                self.ops._sync_unassigned(candidate)

                metrics["candidateEvaluations"] += 1
                if inc_state is None:
                    self.evaluator.evaluate(
                        candidate,
                        penalty_factor=penalty_factor,
                        phase_progress=strictness,
                        enforce_hard=enforce_hard,
                    )
                    metrics["fullEvaluations"] += 1
                else:
                    used_inc = self.evaluator.evaluate_incremental(
                        candidate,
                        state=inc_state,
                        changed_route_indices=[route_idx],
                        penalty_factor=penalty_factor,
                        phase_progress=strictness,
                        enforce_hard=enforce_hard,
                    )
                    if used_inc:
                        metrics["incrementalEvaluations"] += 1
                    else:
                        metrics["fullEvaluations"] += 1

                if candidate.objective_score + 1e-9 < best_score:
                    best_score = candidate.objective_score
                    best_candidate = candidate

        return best_candidate

    def _small_route_reorder(
        self,
        individual: Individual,
        inc_state: ObjectiveEvaluator.IncrementalEvalState,
        penalty_factor: float,
        strictness: float,
        enforce_hard: bool,
        metrics: dict,
    ) -> Optional[Individual]:
        best_candidate = None
        best_score = individual.objective_score

        for route_idx, route in enumerate(individual.routes):
            seq = list(route.stop_sequence)
            n = len(seq)
            if n < 4 or n > 8:
                continue

            # Limited beam: adjacent exchanges only, but strict precedence/feasibility-safe.
            for i in range(n - 1):
                candidate_seq = list(seq)
                candidate_seq[i], candidate_seq[i + 1] = candidate_seq[i + 1], candidate_seq[i]
                if not self.ops._check_precedence(candidate_seq):
                    continue

                valid, _ = self.ops._check_sequence_validity_and_cost(
                    candidate_seq,
                    route.vehicle,
                    strictness=strictness,
                    penalty_factor=penalty_factor,
                    allow_soft=False,
                )
                if not valid:
                    continue

                candidate = copy.deepcopy(individual)
                candidate.routes[route_idx].stop_sequence = candidate_seq
                self.ops._sync_route_employees(candidate.routes[route_idx])
                self.ops._sync_unassigned(candidate)

                metrics["candidateEvaluations"] += 1
                if inc_state is None:
                    self.evaluator.evaluate(
                        candidate,
                        penalty_factor=penalty_factor,
                        phase_progress=strictness,
                        enforce_hard=enforce_hard,
                    )
                    metrics["fullEvaluations"] += 1
                else:
                    used_inc = self.evaluator.evaluate_incremental(
                        candidate,
                        state=inc_state,
                        changed_route_indices=[route_idx],
                        penalty_factor=penalty_factor,
                        phase_progress=strictness,
                        enforce_hard=enforce_hard,
                    )
                    if used_inc:
                        metrics["incrementalEvaluations"] += 1
                    else:
                        metrics["fullEvaluations"] += 1

                if candidate.objective_score + 1e-9 < best_score:
                    best_score = candidate.objective_score
                    best_candidate = candidate

        return best_candidate
