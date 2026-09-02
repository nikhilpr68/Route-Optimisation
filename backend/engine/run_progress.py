from __future__ import annotations

import multiprocessing
import threading
from typing import Dict, Optional


class SharedRunProgressTracker:
    """
    Thread-safe tracker for cross-run best-objective coordination.

    This is only used when solver runs share memory, e.g. threaded execution
    from stdin mode. Process-pooled runs fall back to per-run stopping.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._global_best_score = float("inf")
        self._global_best_run_id: Optional[int] = None
        self._run_best_scores: Dict[int, float] = {}

    def update(self, run_id: int, generation: int, best_score: float) -> None:
        run_id = int(run_id)
        score = float(best_score)
        with self._lock:
            prev = self._run_best_scores.get(run_id, float("inf"))
            if score + 1e-9 < prev:
                self._run_best_scores[run_id] = score
            elif run_id not in self._run_best_scores:
                self._run_best_scores[run_id] = score

            if score + 1e-9 < self._global_best_score:
                self._global_best_score = score
                self._global_best_run_id = run_id

    def snapshot(self, run_id: int) -> Dict[str, Optional[float]]:
        with self._lock:
            return {
                "runId": int(run_id),
                "runBestScore": float(self._run_best_scores.get(int(run_id), float("inf"))),
                "globalBestScore": float(self._global_best_score),
                "globalBestRunId": (
                    int(self._global_best_run_id)
                    if self._global_best_run_id is not None
                    else None
                ),
            }


class ProcessSharedRunProgressTracker:
    """
    Process-safe tracker for cross-run best-objective coordination.

    Uses multiprocessing manager proxies so API/stdin solve runs can share
    best-score snapshots even when they execute in separate worker processes.
    """

    def __init__(self) -> None:
        self._manager = multiprocessing.Manager()
        self._lock = self._manager.Lock()
        self._global_best_score = self._manager.Value("d", float("inf"))
        self._global_best_run_id = self._manager.Value("i", -1)
        self._run_best_scores = self._manager.dict()

    def update(self, run_id: int, generation: int, best_score: float) -> None:
        del generation
        run_id = int(run_id)
        score = float(best_score)
        with self._lock:
            prev = float(self._run_best_scores.get(run_id, float("inf")))
            if score + 1e-9 < prev or run_id not in self._run_best_scores:
                self._run_best_scores[run_id] = score

            if score + 1e-9 < float(self._global_best_score.value):
                self._global_best_score.value = score
                self._global_best_run_id.value = run_id

    def snapshot(self, run_id: int) -> Dict[str, Optional[float]]:
        run_id = int(run_id)
        with self._lock:
            global_best_run_id = int(self._global_best_run_id.value)
            return {
                "runId": run_id,
                "runBestScore": float(self._run_best_scores.get(run_id, float("inf"))),
                "globalBestScore": float(self._global_best_score.value),
                "globalBestRunId": global_best_run_id if global_best_run_id >= 0 else None,
            }

    def shutdown(self) -> None:
        try:
            self._manager.shutdown()
        except Exception:
            pass
