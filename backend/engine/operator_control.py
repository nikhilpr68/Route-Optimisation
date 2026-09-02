from __future__ import annotations

import math
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Deque, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


def _clip01(x: float) -> float:
    try:
        return max(0.0, min(1.0, float(x)))
    except Exception:
        return 0.0


@dataclass(frozen=True)
class SearchContext:
    phase_progress: float
    strictness: float
    current_feasible: bool
    unassigned_frac: float
    stagnation_best_steps: int
    stagnation_current_steps: int
    ruin_fraction: float
    max_victims: int


@dataclass
class _ArmStat:
    uses: int = 0
    reward_sum: float = 0.0
    delta_sum: float = 0.0
    accepted: int = 0
    improved_current: int = 0
    improved_best: int = 0
    failed: int = 0

    def update(
        self,
        reward: float,
        delta: float,
        accepted: bool,
        improved_current: bool,
        improved_best: bool,
        failed: bool,
    ) -> None:
        self.uses += 1
        self.reward_sum += float(reward)
        self.delta_sum += float(delta)
        if accepted:
            self.accepted += 1
        if improved_current:
            self.improved_current += 1
        if improved_best:
            self.improved_best += 1
        if failed:
            self.failed += 1

    def mean_reward(self) -> float:
        return float(self.reward_sum / max(1, self.uses))

    def mean_delta(self) -> float:
        return float(self.delta_sum / max(1, self.uses))

    def snapshot(self) -> Dict[str, float]:
        uses = max(1, int(self.uses))
        return {
            "uses": int(self.uses),
            "meanReward": float(self.reward_sum / uses),
            "meanDelta": float(self.delta_sum / uses),
            "acceptedRate": float(self.accepted / uses),
            "improvedCurrentRate": float(self.improved_current / uses),
            "improvedBestRate": float(self.improved_best / uses),
            "failureRate": float(self.failed / uses),
        }


@dataclass(frozen=True)
class ContextKey:
    phase: str
    feasible: str
    unassigned: str
    stagnation: str
    ruin: str

    def as_tuple(self) -> Tuple[str, str, str, str, str]:
        return (self.phase, self.feasible, self.unassigned, self.stagnation, self.ruin)


def _bucket_phase(strictness: float) -> str:
    s = _clip01(strictness)
    if s < 0.33:
        return "early"
    if s < 0.66:
        return "mid"
    return "late"


def _bucket_unassigned(frac: float) -> str:
    try:
        f = max(0.0, float(frac))
    except Exception:
        f = 0.0
    if f <= 1e-6:
        return "none"
    if f < 0.05:
        return "some"
    return "many"


def _bucket_stagnation(steps_since_best: int) -> str:
    try:
        s = max(0, int(steps_since_best))
    except Exception:
        s = 0
    if s <= 5:
        return "fresh"
    if s <= 25:
        return "plateau"
    return "stuck"


def _bucket_ruin(ruin_fraction: float) -> str:
    try:
        r = max(0.0, float(ruin_fraction))
    except Exception:
        r = 0.0
    if r <= 0.12:
        return "small"
    if r <= 0.25:
        return "medium"
    return "large"


def context_key(ctx: SearchContext) -> ContextKey:
    return ContextKey(
        phase=_bucket_phase(ctx.strictness),
        feasible=("feasible" if bool(ctx.current_feasible) else "infeasible"),
        unassigned=_bucket_unassigned(ctx.unassigned_frac),
        stagnation=_bucket_stagnation(ctx.stagnation_best_steps),
        ruin=_bucket_ruin(ctx.ruin_fraction),
    )


@dataclass(frozen=True)
class ContextualUCBConfig:
    explore_c: float = 0.9
    ucb_scale: float = 0.55
    softmax_temp: float = 1.0
    epsilon: float = 0.05
    recent_window: int = 200
    dead_min_uses: int = 30
    dead_improve_rate_max: float = 0.001


class ContextualUCBSelector:
    """
    Bucketed contextual bandit:
      - Context is a small tuple of buckets derived from SearchContext.
      - Each context bucket maintains per-arm reward averages.
      - Selection uses a prior from base weights and an Upper-Confidence-Bound bonus.

    This stays dependency-free and makes operator choice responsive to the search state.
    """

    def __init__(self, name: str, arms: Sequence[str], config: Optional[ContextualUCBConfig] = None):
        self.name = str(name)
        self.arms = list(arms)
        self.config = config or ContextualUCBConfig()
        self._stats: Dict[Tuple[str, ...], Dict[str, _ArmStat]] = defaultdict(dict)
        self._recent: Deque[Tuple[str, Tuple[str, ...]]] = deque(maxlen=max(10, int(self.config.recent_window)))
        self._by_phase: Dict[str, Dict[str, _ArmStat]] = defaultdict(dict)

    def _ctx_tuple(self, ctx: SearchContext) -> Tuple[str, ...]:
        return context_key(ctx).as_tuple()

    def _ensure_arm(self, bucket: Tuple[str, ...], arm: str) -> _ArmStat:
        arm = str(arm)
        entry = self._stats[bucket].get(arm)
        if entry is None:
            entry = _ArmStat()
            self._stats[bucket][arm] = entry
        return entry

    def _phase_stat(self, phase: str, arm: str) -> _ArmStat:
        phase = str(phase)
        arm = str(arm)
        entry = self._by_phase[phase].get(arm)
        if entry is None:
            entry = _ArmStat()
            self._by_phase[phase][arm] = entry
        return entry

    def choose(
        self,
        ctx: SearchContext,
        arms: Sequence[str],
        base_weights: Optional[Mapping[str, float]] = None,
        rng=None,
        deterministic: bool = False,
    ) -> str:
        candidates = [str(a) for a in arms]
        if not candidates:
            raise ValueError("No arms provided")

        base_weights = dict(base_weights or {})
        bucket = self._ctx_tuple(ctx)
        total_uses = 0
        for arm in candidates:
            total_uses += self._ensure_arm(bucket, arm).uses

        scores: Dict[str, float] = {}
        for arm in candidates:
            stat = self._ensure_arm(bucket, arm)
            mean = stat.mean_reward()
            bonus = self.config.explore_c * math.sqrt(
                math.log(1.0 + max(1, total_uses)) / (1.0 + max(0, stat.uses))
            )
            prior_w = float(base_weights.get(arm, 1.0))
            prior = math.log(max(1e-8, prior_w))
            scores[arm] = float(prior + self.config.ucb_scale * (mean + bonus))

        if deterministic:
            best = max(sorted(scores.keys()), key=lambda a: (scores[a], a))
            return best

        # epsilon-greedy on top of softmax for diversity/robustness.
        if rng is not None and float(self.config.epsilon) > 0.0:
            if rng.random() < float(self.config.epsilon):
                return rng.choice(candidates)

        temp = max(1e-6, float(self.config.softmax_temp))
        max_s = max(scores.values())
        exps = {}
        total = 0.0
        for arm in candidates:
            z = (scores[arm] - max_s) / temp
            z = max(-50.0, min(50.0, z))
            e = math.exp(z)
            exps[arm] = e
            total += e
        if total <= 0.0 or rng is None:
            return candidates[0]

        threshold = rng.random() * total
        running = 0.0
        for arm in candidates:
            running += exps[arm]
            if running >= threshold:
                return arm
        return candidates[-1]

    def update(
        self,
        ctx: SearchContext,
        arm: str,
        reward: float,
        delta: float,
        accepted: bool,
        improved_current: bool,
        improved_best: bool,
        failed: bool,
    ) -> None:
        arm = str(arm)
        bucket = self._ctx_tuple(ctx)
        stat = self._ensure_arm(bucket, arm)
        stat.update(
            reward=reward,
            delta=delta,
            accepted=accepted,
            improved_current=improved_current,
            improved_best=improved_best,
            failed=failed,
        )

        ck = context_key(ctx)
        phase_stat = self._phase_stat(ck.phase, arm)
        phase_stat.update(
            reward=reward,
            delta=delta,
            accepted=accepted,
            improved_current=improved_current,
            improved_best=improved_best,
            failed=failed,
        )
        self._recent.append((arm, bucket))

    def _diversity_snapshot(self) -> Dict[str, float]:
        window = list(self._recent)
        if not window:
            return {"entropy": 0.0, "unique": 0.0, "window": 0.0}
        counts: Dict[str, int] = {}
        for arm, _ in window:
            counts[arm] = counts.get(arm, 0) + 1
        total = float(len(window))
        entropy = 0.0
        for c in counts.values():
            p = c / total
            entropy -= p * math.log(max(1e-12, p))
        return {"entropy": float(entropy), "unique": float(len(counts)), "window": float(len(window))}

    def _dead_arms(self) -> List[str]:
        # Use global (across contexts) view derived from by_phase aggregation.
        agg: Dict[str, _ArmStat] = {}
        for phase_map in self._by_phase.values():
            for arm, st in phase_map.items():
                a = agg.get(arm)
                if a is None:
                    a = _ArmStat()
                    agg[arm] = a
                a.uses += st.uses
                a.reward_sum += st.reward_sum
                a.delta_sum += st.delta_sum
                a.accepted += st.accepted
                a.improved_current += st.improved_current
                a.improved_best += st.improved_best
                a.failed += st.failed

        dead = []
        for arm, st in agg.items():
            if st.uses < int(self.config.dead_min_uses):
                continue
            uses = max(1, st.uses)
            improve_rate = (st.improved_current + st.improved_best) / uses
            if float(improve_rate) <= float(self.config.dead_improve_rate_max):
                dead.append(str(arm))
        return sorted(dead)

    def snapshot(self, max_contexts: int = 40) -> Dict[str, object]:
        # Surface most-used contexts only to avoid huge logs.
        ctx_usage: List[Tuple[int, Tuple[str, ...]]] = []
        for bucket, arm_map in self._stats.items():
            uses = sum(st.uses for st in arm_map.values())
            ctx_usage.append((uses, bucket))
        ctx_usage.sort(reverse=True)

        top_buckets = [b for _, b in ctx_usage[: max(0, int(max_contexts))]]
        contexts_out: Dict[str, Dict[str, Dict[str, float]]] = {}
        for bucket in top_buckets:
            arm_map = self._stats.get(bucket) or {}
            contexts_out["|".join(bucket)] = {arm: st.snapshot() for arm, st in arm_map.items()}

        by_phase = {
            phase: {arm: st.snapshot() for arm, st in arm_map.items()}
            for phase, arm_map in self._by_phase.items()
        }

        return {
            "name": self.name,
            "config": {
                "exploreC": float(self.config.explore_c),
                "ucbScale": float(self.config.ucb_scale),
                "softmaxTemp": float(self.config.softmax_temp),
                "epsilon": float(self.config.epsilon),
                "recentWindow": int(self.config.recent_window),
            },
            "byPhase": by_phase,
            "contexts": contexts_out,
            "deadArms": self._dead_arms(),
            "diversity": self._diversity_snapshot(),
        }


@dataclass(frozen=True)
class OperatorControlConfig:
    enabled: bool = True
    deterministic: bool = False
    destroy: ContextualUCBConfig = field(default_factory=ContextualUCBConfig)
    repair: ContextualUCBConfig = field(default_factory=ContextualUCBConfig)
    neighborhood: ContextualUCBConfig = field(
        default_factory=lambda: ContextualUCBConfig(explore_c=0.7, ucb_scale=0.50, epsilon=0.08)
    )


class OperatorControlSuite:
    def __init__(
        self,
        destroy_arms: Sequence[str],
        repair_arms: Sequence[str],
        neighborhood_arms: Sequence[str],
        config: Optional[OperatorControlConfig] = None,
    ):
        self.config = config or OperatorControlConfig()
        self.destroy = ContextualUCBSelector("destroy", destroy_arms, config=self.config.destroy)
        self.repair = ContextualUCBSelector("repair", repair_arms, config=self.config.repair)
        self.neighborhood = ContextualUCBSelector(
            "neighborhood", neighborhood_arms, config=self.config.neighborhood
        )

    def snapshot(self) -> Dict[str, object]:
        return {
            "enabled": bool(self.config.enabled),
            "deterministic": bool(self.config.deterministic),
            "destroy": self.destroy.snapshot(),
            "repair": self.repair.snapshot(),
            "neighborhood": self.neighborhood.snapshot(),
        }
