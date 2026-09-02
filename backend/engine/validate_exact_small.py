from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from exact_small_cases import get_exact_small_validation_cases


ENGINE_DIR = Path(__file__).resolve().parent
ENGINE_MAIN = ENGINE_DIR / "main.py"


def _extract_last_json(text: str):
    decoder = json.JSONDecoder()
    idx = 0
    last_obj = None
    while idx < len(text):
        try:
            obj, end = decoder.raw_decode(text, idx)
            if isinstance(obj, dict):
                last_obj = obj
            idx = end
            continue
        except json.JSONDecodeError:
            idx += 1
    if last_obj is None:
        raise RuntimeError("No JSON object found in engine output")
    return last_obj


def _run_engine(args: list[str], canonical: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, str(ENGINE_MAIN), *args],
        cwd=str(ENGINE_DIR),
        input=json.dumps(canonical),
        text=True,
        capture_output=True,
        timeout=180,
        check=True,
        # Validation harness should not mutate repo-local distance caches.
        env={
            **os.environ,
            "DISTANCE_CACHE_PERSIST": "0",
        },
    )
    stdout_only = (proc.stdout or "").strip()
    if stdout_only:
        try:
            return _extract_last_json(stdout_only)
        except RuntimeError:
            pass
    combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
    return _extract_last_json(combined)


def main() -> int:
    argp = argparse.ArgumentParser(description="Compare heuristic engine output against exact-small reference mode")
    argp.add_argument("--intensity", choices=["low", "medium", "high", "custom"], default="low")
    argp.add_argument("--runs", type=int, default=1)
    argp.add_argument("--max-workers", type=int, default=1)
    argp.add_argument("--seed", type=int, default=4242)
    argp.add_argument("--exact-small-max-employees", type=int, default=5)
    argp.add_argument("--exact-small-max-vehicles", type=int, default=3)
    args = argp.parse_args()

    rows = []
    misses_by_pattern: dict[str, int] = {}
    cases = get_exact_small_validation_cases()

    for case in cases:
        canonical = dict(case["canonical"])
        heuristic = _run_engine(
            [
                "--intensity",
                args.intensity,
                "--runs",
                str(args.runs),
                "--max-workers",
                str(args.max_workers),
                "--seed",
                str(args.seed),
            ],
            canonical,
        )
        exact = _run_engine(
            [
                "--exact-small-mode",
                "true",
                "--exact-small-max-employees",
                str(args.exact_small_max_employees),
                "--exact-small-max-vehicles",
                str(args.exact_small_max_vehicles),
                "--seed",
                str(args.seed),
            ],
            canonical,
        )

        heuristic_obj = heuristic.get("objectiveScore")
        exact_obj = exact.get("objectiveScore")
        exact_gap = None
        if heuristic_obj is not None and exact_obj is not None:
            exact_gap = float(heuristic_obj) - float(exact_obj)

        missed = bool(exact_gap is not None and exact_gap > 1e-6)
        if missed:
            misses_by_pattern[case["pattern"]] = misses_by_pattern.get(case["pattern"], 0) + 1

        rows.append(
            {
                "case": case["name"],
                "pattern": case["pattern"],
                "heuristic_status": heuristic.get("status"),
                "heuristic_exactness": heuristic.get("exactness_status"),
                "heuristic_objective": heuristic_obj,
                "exact_status": exact.get("status"),
                "exact_exactness": exact.get("exactness_status"),
                "exact_objective": exact_obj,
                "objective_gap": exact_gap,
                "heuristic_missed_optimum": missed,
            }
        )

    summary = {
        "case_count": int(len(rows)),
        "heuristic_miss_count": int(sum(1 for row in rows if row["heuristic_missed_optimum"])),
        "miss_patterns_ranked": [
            {"pattern": pattern, "count": int(count)}
            for pattern, count in sorted(
                misses_by_pattern.items(),
                key=lambda item: (-item[1], item[0]),
            )
        ],
        "rows": rows,
    }
    sys.stdout.write(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
