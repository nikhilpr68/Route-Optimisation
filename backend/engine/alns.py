from __future__ import annotations

import copy
import math
import random
import time
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

from models import ProblemInstance
from neighborhoods import NeighborhoodSearch
from objective import ObjectiveEvaluator
from operators import GeneticOperators
from representation import Individual
from solution_status import is_solution_feasible
from operator_control import OperatorControlConfig, OperatorControlSuite, SearchContext


@dataclass
class _OperatorStat:
    uses: int = 0
    accepted: int = 0
    improved_current: int = 0
    improved_best: int = 0
    feasible_count: int = 0
    failures: int = 0
    delta_sum: float = 0.0

    def record(
        self,
        delta: float,
        accepted: bool,
        improved_current: bool,
        improved_best: bool,
        feasible: bool,
        failed: bool,
    ) -> None:
        self.uses += 1
        self.delta_sum += float(delta)
        if accepted:
            self.accepted += 1
        if improved_current:
            self.improved_current += 1
        if improved_best:
            self.improved_best += 1
        if feasible:
            self.feasible_count += 1
        if failed:
            self.failures += 1

    def snapshot(self) -> Dict[str, float]:
        uses = max(1, self.uses)
        return {
            "uses": int(self.uses),
            "accepted": int(self.accepted),
            "improved_current": int(self.improved_current),
            "improved_best": int(self.improved_best),
            "avg_delta": float(self.delta_sum / uses),
            "feasibility_rate": float(self.feasible_count / uses),
            "failure_rate": float(self.failures / uses),
        }


class ALNSEngine:
    def __init__(
        self,
        problem: ProblemInstance,
        operators: GeneticOperators,
        evaluator: ObjectiveEvaluator,
        neighborhoods: Optional[NeighborhoodSearch] = None,
        rng: Optional[random.Random] = None,
    ):
        self.problem = problem
        self.ops = operators
        self.evaluator = evaluator
        self.neighborhoods = neighborhoods
        self.rng = rng or random.Random()

        self.destroy_weights = {
            "random": 1.0,
            "worst": 1.0,
            "related": 1.0,
            "route": 1.0,
        }
        self.repair_weights = {
            "greedy": 1.0,
            "regret2": 1.0,
            "regret3": 1.0,
        }

        self.destroy_stats = {name: _OperatorStat() for name in self.destroy_weights.keys()}
        self.repair_stats = {name: _OperatorStat() for name in self.repair_weights.keys()}

        meta = getattr(problem, "metadata", {}) or {}
        enabled = _meta_bool(meta, "STATE_AWARE_OPERATOR_CONTROL_ENABLED", default=True)
        deterministic = _meta_bool(meta, "STATE_AWARE_OPERATOR_CONTROL_DETERMINISTIC", default=False)
        self.operator_control: Optional[OperatorControlSuite] = None
        if enabled:
            self.operator_control = OperatorControlSuite(
                destroy_arms=list(self.destroy_weights.keys()),
                repair_arms=list(self.repair_weights.keys()),
                neighborhood_arms=[
                    "inter_route_relocate",
                    "inter_route_swap",
                    "intra_route_pair_reinsert",
                    "small_route_reorder",
                ],
                config=OperatorControlConfig(enabled=True, deterministic=deterministic),
            )

        self.last_stats = {
            "destroy": dict(self.destroy_weights),
            "repair": dict(self.repair_weights),
            "destroy_stats": {k: v.snapshot() for k, v in self.destroy_stats.items()},
            "repair_stats": {k: v.snapshot() for k, v in self.repair_stats.items()},
        }

    def improve(
        self,
        individual: Individual,
        iterations: int,
        penalty_factor: float,
        phase_progress: float,
        ruin_fraction: float,
        max_victims: int,
        stop_controller=None,
        max_runtime_sec: Optional[float] = None,
    ) -> Tuple[Individual, Dict[str, Dict[str, float]]]:
        iterations = max(0, int(iterations))
        if iterations == 0:
            return copy.deepcopy(individual), self.last_stats

        local_start = time.perf_counter()

        def _time_exhausted() -> bool:
            if max_runtime_sec is not None and (time.perf_counter() - local_start) >= max(0.01, float(max_runtime_sec)):
                return True
            if stop_controller is not None and stop_controller.time_limit_reached():
                return True
            return False

        strictness = max(0.0, min(1.0, float(phase_progress)))
        current = copy.deepcopy(individual)
        self.evaluator.evaluate(
            current,
            penalty_factor=penalty_factor,
            phase_progress=strictness,
            enforce_hard=False,
        )

        best = copy.deepcopy(current)
        temperature = max(1.0, 120.0 * (1.0 - strictness) + 2.0)
        reaction = 0.18
        normalize_every = 25
        last_best_improve_step = 0
        last_current_improve_step = 0

        for step in range(iterations):
            if _time_exhausted():
                break

            ctx = SearchContext(
                phase_progress=float(phase_progress),
                strictness=float(strictness),
                current_feasible=self._is_individual_feasible(current),
                unassigned_frac=float(len(getattr(current, "unassigned", []) or []) / max(1, len(self.problem.employees))),
                stagnation_best_steps=int(step - last_best_improve_step),
                stagnation_current_steps=int(step - last_current_improve_step),
                ruin_fraction=float(ruin_fraction),
                max_victims=int(max_victims),
            )

            if self.operator_control is not None:
                destroy_name = self.operator_control.destroy.choose(
                    ctx=ctx,
                    arms=list(self.destroy_weights.keys()),
                    base_weights=self.destroy_weights,
                    rng=self.rng,
                    deterministic=bool(self.operator_control.config.deterministic),
                )
                repair_name = self.operator_control.repair.choose(
                    ctx=ctx,
                    arms=list(self.repair_weights.keys()),
                    base_weights=self.repair_weights,
                    rng=self.rng,
                    deterministic=bool(self.operator_control.config.deterministic),
                )
            else:
                destroy_name = self._roulette(self.destroy_weights)
                repair_name = self._roulette(self.repair_weights)

            candidate = copy.deepcopy(current)
            removed = self._destroy(
                candidate,
                mode=destroy_name,
                ruin_fraction=ruin_fraction,
                max_victims=max_victims,
                penalty_factor=penalty_factor,
                strictness=strictness,
            )

            if not removed:
                self._record_and_update(
                    destroy_name=destroy_name,
                    repair_name=repair_name,
                    delta=0.0,
                    accepted=False,
                    improved_current=False,
                    improved_best=False,
                    feasible=False,
                    failed=True,
                    reward=0.12,
                    reaction=reaction,
                )
                if self.operator_control is not None:
                    self.operator_control.destroy.update(
                        ctx=ctx,
                        arm=destroy_name,
                        reward=0.12,
                        delta=0.0,
                        accepted=False,
                        improved_current=False,
                        improved_best=False,
                        failed=True,
                    )
                    self.operator_control.repair.update(
                        ctx=ctx,
                        arm=repair_name,
                        reward=0.12,
                        delta=0.0,
                        accepted=False,
                        improved_current=False,
                        improved_best=False,
                        failed=True,
                    )
                temperature = max(0.2, temperature * 0.996)
                continue

            self.ops.repair_employees(
                candidate,
                removed,
                repair_mode=repair_name,
                strictness=strictness,
                penalty_factor=penalty_factor,
            )

            if self.neighborhoods is not None and strictness >= 0.55 and not _time_exhausted():
                candidate = self.neighborhoods.improve(
                    candidate,
                    max_moves=1,
                    penalty_factor=penalty_factor,
                    phase_progress=strictness,
                    operator_control=(self.operator_control.neighborhood if self.operator_control is not None else None),
                    search_context=ctx,
                    deterministic=(bool(self.operator_control.config.deterministic) if self.operator_control is not None else False),
                )

            self.evaluator.evaluate(
                candidate,
                penalty_factor=penalty_factor,
                phase_progress=strictness,
                enforce_hard=False,
            )

            delta = float(candidate.objective_score - current.objective_score)
            feasible = self._is_individual_feasible(candidate)
            improved_current = delta < -1e-9
            improved_best = candidate.objective_score + 1e-9 < best.objective_score

            accept = False
            if improved_current:
                accept = True
            elif temperature > 1e-6:
                accept_prob = math.exp(-max(0.0, delta) / temperature)
                if self.rng.random() < accept_prob:
                    accept = True

            if accept:
                current = candidate

            if improved_best:
                best = copy.deepcopy(candidate)
                last_best_improve_step = int(step)
            if improved_current:
                last_current_improve_step = int(step)

            reward = 0.5
            if improved_best:
                reward = 12.0
            elif improved_current:
                reward = 5.0
            elif accept:
                reward = 1.5
            if not feasible:
                reward = min(reward, 0.45)
            if not removed:
                reward = min(reward, 0.20)

            self._record_and_update(
                destroy_name=destroy_name,
                repair_name=repair_name,
                delta=delta,
                accepted=accept,
                improved_current=improved_current,
                improved_best=improved_best,
                feasible=feasible,
                failed=False,
                reward=reward,
                reaction=reaction,
            )
            if self.operator_control is not None:
                self.operator_control.destroy.update(
                    ctx=ctx,
                    arm=destroy_name,
                    reward=float(reward),
                    delta=float(delta),
                    accepted=bool(accept),
                    improved_current=bool(improved_current),
                    improved_best=bool(improved_best),
                    failed=False,
                )
                self.operator_control.repair.update(
                    ctx=ctx,
                    arm=repair_name,
                    reward=float(reward),
                    delta=float(delta),
                    accepted=bool(accept),
                    improved_current=bool(improved_current),
                    improved_best=bool(improved_best),
                    failed=False,
                )

            if (step + 1) % normalize_every == 0:
                self._normalize_weights()

            temperature = max(0.2, temperature * 0.996)

        self._normalize_weights()
        self.last_stats = {
            "destroy": dict(self.destroy_weights),
            "repair": dict(self.repair_weights),
            "destroy_stats": {k: v.snapshot() for k, v in self.destroy_stats.items()},
            "repair_stats": {k: v.snapshot() for k, v in self.repair_stats.items()},
        }
        if self.operator_control is not None:
            self.last_stats["operator_control"] = self.operator_control.snapshot()
        return best, self.last_stats

    def _record_and_update(
        self,
        destroy_name: str,
        repair_name: str,
        delta: float,
        accepted: bool,
        improved_current: bool,
        improved_best: bool,
        feasible: bool,
        failed: bool,
        reward: float,
        reaction: float,
    ) -> None:
        d_stat = self.destroy_stats[destroy_name]
        r_stat = self.repair_stats[repair_name]

        d_stat.record(
            delta=delta,
            accepted=accepted,
            improved_current=improved_current,
            improved_best=improved_best,
            feasible=feasible,
            failed=failed,
        )
        r_stat.record(
            delta=delta,
            accepted=accepted,
            improved_current=improved_current,
            improved_best=improved_best,
            feasible=feasible,
            failed=failed,
        )

        if failed:
            reward = min(float(reward), 0.2)

        self.destroy_weights[destroy_name] = self._update_weight(
            self.destroy_weights[destroy_name], reward, reaction
        )
        self.repair_weights[repair_name] = self._update_weight(
            self.repair_weights[repair_name], reward, reaction
        )

    def _normalize_weights(self) -> None:
        self._normalize_weight_map(self.destroy_weights)
        self._normalize_weight_map(self.repair_weights)

    def _normalize_weight_map(self, weights: Dict[str, float]) -> None:
        total = sum(max(1e-6, float(v)) for v in weights.values())
        if total <= 0:
            n = max(1, len(weights))
            for key in weights:
                weights[key] = 1.0 / n
            return

        n = max(1, len(weights))
        for key in list(weights.keys()):
            normalized = max(1e-6, float(weights[key])) / total
            weights[key] = max(0.05, min(20.0, normalized * n))

    def _is_individual_feasible(self, individual: Individual) -> bool:
        return bool(is_solution_feasible(individual))

    def _destroy(
        self,
        individual: Individual,
        mode: str,
        ruin_fraction: float,
        max_victims: int,
        penalty_factor: float,
        strictness: float,
    ):
        removed = self.ops._apply_ruin(
            individual,
            ruin_fraction=max(0.05, min(0.9, ruin_fraction)),
            max_victims=max(1, int(max_victims)),
            destroy_mode=mode,
            penalty_factor=penalty_factor,
            strictness=strictness,
        )
        return removed

    def _roulette(self, weights: Dict[str, float]) -> str:
        total = sum(max(1e-8, float(v)) for v in weights.values())
        threshold = self.rng.random() * total
        running = 0.0
        for name, w in weights.items():
            running += max(1e-8, float(w))
            if running >= threshold:
                return name
        return next(iter(weights.keys()))

    def _update_weight(self, current_weight: float, reward: float, reaction: float) -> float:
        updated = (1.0 - reaction) * float(current_weight) + reaction * float(reward)
        return max(0.05, min(20.0, updated))


def _meta_bool(meta: object, key: str, default: bool) -> bool:
    if not isinstance(meta, dict):
        return bool(default)
    if key not in meta:
        return bool(default)
    raw = meta.get(key)
    if isinstance(raw, bool):
        return bool(raw)
    text = str(raw).strip().lower()
    if text in ("1", "true", "yes", "on", "y", "t"):
        return True
    if text in ("0", "false", "no", "off", "n", "f"):
        return False
    return bool(default)
