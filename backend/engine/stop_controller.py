from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


@dataclass
class StopSnapshot:
    t: float
    best: float
    diversity: float
    structural_hash: str
    rel_improvement: float


@dataclass
class StopController:
    time_limit_sec: float = 25.0
    min_runtime_sec: float = 4.0
    checkpoint_every_sec: float = 2.0
    eps_rel: float = 0.001
    stall_checkpoints: int = 4
    diversity_min: float = 0.15
    burst_sec: float = 3.0
    mip_probe_time_sec: float = 5.0
    mip_gap_tol: float = 0.005
    start_time: float = field(default_factory=time.perf_counter)

    next_checkpoint_time: float = field(init=False)
    snapshots: List[StopSnapshot] = field(default_factory=list)
    stagnant_checkpoints: int = 0
    stagnation_detected: bool = False
    escape_burst_attempted: bool = False
    escape_burst_improved: bool = False

    def __post_init__(self) -> None:
        tl = float(self.time_limit_sec)
        self.time_limit_sec = 0.0 if tl <= 0 else tl
        if self.time_limit_sec > 0:
            self.min_runtime_sec = _clamp(float(self.min_runtime_sec), 0.0, self.time_limit_sec)
        else:
            self.min_runtime_sec = max(0.0, float(self.min_runtime_sec))

        self.checkpoint_every_sec = max(0.1, float(self.checkpoint_every_sec))
        self.eps_rel = max(0.0, float(self.eps_rel))
        self.stall_checkpoints = max(1, int(self.stall_checkpoints))
        self.diversity_min = _clamp(float(self.diversity_min), 0.0, 1.0)
        self.burst_sec = max(0.1, float(self.burst_sec))
        self.mip_probe_time_sec = max(0.1, float(self.mip_probe_time_sec))
        self.mip_gap_tol = _clamp(float(self.mip_gap_tol), 0.0, 1.0)
        self.next_checkpoint_time = self.checkpoint_every_sec

    def elapsed_sec(self) -> float:
        return max(0.0, time.perf_counter() - self.start_time)

    def remaining_sec(self) -> float:
        if self.time_limit_sec <= 0.0:
            return float("inf")
        return max(0.0, self.time_limit_sec - self.elapsed_sec())

    def time_limit_reached(self) -> bool:
        if self.time_limit_sec <= 0.0:
            return False
        return self.elapsed_sec() >= self.time_limit_sec

    def can_run_for(self, seconds_needed: float) -> bool:
        return self.remaining_sec() > max(0.0, float(seconds_needed))

    def note_progress(
        self,
        best_score: float,
        diversity: float,
        structural_hash: str,
        force: bool = False,
    ) -> bool:
        """
        Records time checkpoints and updates stagnation state.

        Returns True if at least one checkpoint was committed.
        """
        elapsed = self.elapsed_sec()
        committed = False

        while (elapsed >= self.next_checkpoint_time) or (force and (not committed)):
            committed = True
            prev_best = self.snapshots[-1].best if self.snapshots else float(best_score)
            denominator = max(1.0, abs(prev_best))
            rel_improvement = max(0.0, (prev_best - float(best_score)) / denominator)

            snap = StopSnapshot(
                t=round(elapsed, 3),
                best=float(best_score),
                diversity=float(diversity),
                structural_hash=str(structural_hash or ""),
                rel_improvement=float(rel_improvement),
            )
            self.snapshots.append(snap)

            if len(self.snapshots) >= 2:
                if rel_improvement < self.eps_rel:
                    self.stagnant_checkpoints += 1
                else:
                    self.stagnant_checkpoints = 0
                if self.stagnant_checkpoints >= self.stall_checkpoints:
                    self.stagnation_detected = True

            self.next_checkpoint_time += self.checkpoint_every_sec
            if force:
                break

        return committed

    def should_stop_for_stagnation(self, diversity: float) -> bool:
        if self.elapsed_sec() < self.min_runtime_sec:
            return False
        if not self.stagnation_detected:
            return False
        if float(diversity) >= self.diversity_min:
            return False
        if not self.escape_burst_attempted:
            return False
        return True

    def mark_escape_burst_started(self) -> None:
        self.escape_burst_attempted = True

    def mark_escape_burst_completed(self, improved: bool) -> None:
        self.escape_burst_attempted = True
        if improved:
            self.escape_burst_improved = True
            self.stagnation_detected = False
            self.stagnant_checkpoints = 0

    def compressed_best_history(self) -> List[Tuple[float, float]]:
        if not self.snapshots:
            return []
        return [(float(s.t), float(s.best)) for s in self.snapshots]

    def compressed_diversity_history(self) -> List[Tuple[float, float]]:
        if not self.snapshots:
            return []
        return [(float(s.t), float(s.diversity)) for s in self.snapshots]

    def last_checkpoint(self) -> Optional[StopSnapshot]:
        if not self.snapshots:
            return None
        return self.snapshots[-1]

    def config_snapshot(self) -> Dict[str, float]:
        return {
            "time_limit_sec": float(self.time_limit_sec),
            "min_runtime_sec": float(self.min_runtime_sec),
            "checkpoint_every_sec": float(self.checkpoint_every_sec),
            "eps_rel": float(self.eps_rel),
            "stall_checkpoints": int(self.stall_checkpoints),
            "diversity_min": float(self.diversity_min),
            "burst_sec": float(self.burst_sec),
            "mip_probe_time_sec": float(self.mip_probe_time_sec),
            "mip_gap_tol": float(self.mip_gap_tol),
        }
