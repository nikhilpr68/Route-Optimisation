from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

ENGINE_DIR = Path(__file__).resolve().parents[1]
ENGINE_MAIN = ENGINE_DIR / "main.py"


@dataclass(frozen=True)
class CaseSpec:
    tier: str
    name: str
    canonical: Dict[str, Any]
    exact_small_reference: bool = False


@dataclass(frozen=True)
class VariantSpec:
    name: str
    metadata_overrides: Dict[str, Any]
    cli_overrides: Dict[str, Any]


def _extract_last_json(text: str) -> Dict[str, Any]:
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
        raise ValueError("No JSON object found in engine output")
    return last_obj


def default_variants() -> List[VariantSpec]:
    return [
        VariantSpec("default", {}, {}),
        VariantSpec(
            "budget_recalibrated",
            {"BUDGET_RECALIBRATION_ENABLED": "true"},
            # Force auto-runs selection in recalibration mode.
            {"runs": 0},
        ),
        VariantSpec(
            "budget_recalibrated_runs_minus1",
            {"BUDGET_RECALIBRATION_ENABLED": "true", "BUDGET_TWEAK_RUNS_DELTA": -1},
            {"runs": 0},
        ),
        VariantSpec(
            "budget_recalibrated_runs1",
            {"BUDGET_RECALIBRATION_ENABLED": "true"},
            {"runs": 1},
        ),
        VariantSpec(
            "budget_recalibrated_tweak",
            {
                "BUDGET_RECALIBRATION_ENABLED": "true",
                "BUDGET_TWEAK_RUNS_DELTA": 0,
                "BUDGET_TWEAK_POP_DELTA": 4,
                "BUDGET_TWEAK_ALNS_DELTA": 2,
            },
            {"runs": 1},
        ),
        VariantSpec(
            "budget_recalibrated_tweak_auto",
            {
                "BUDGET_RECALIBRATION_ENABLED": "true",
                "BUDGET_TWEAK_RUNS_DELTA": 0,
                "BUDGET_TWEAK_POP_DELTA": 4,
                "BUDGET_TWEAK_ALNS_DELTA": 2,
            },
            {"runs": 0},
        ),
        VariantSpec("no_hgs_education", {"OFFSPRING_EDUCATION_ENABLED": "false"}, {}),
        VariantSpec("no_biased_parent", {"BIASED_PARENT_SELECTION": "false"}, {}),
        VariantSpec("no_delta_eval", {"DELTA_EVAL_ENABLED": "false"}, {}),
        VariantSpec("no_exact_lns", {"EXACT_LNS_ENABLED": "false"}, {}),
        VariantSpec("no_route_pool", {"ROUTE_POOL_ENABLED": "false"}, {}),
        VariantSpec(
            "one_shot_master",
            {"SET_PARTITION_ITERATIONS": 1, "ROUTE_POOL_TARGETED_VARIANTS": 0},
            {},
        ),
        VariantSpec("no_complementarity_pool", {"ROUTE_POOL_COMPLEMENTARITY_ENABLED": "false"}, {}),
        VariantSpec("safe_pool", {"ROUTE_POOL_PRUNING_MODE": "safe"}, {}),
    ]


def build_tier_cases() -> List[CaseSpec]:
    cases: List[CaseSpec] = []

    # Tier 1: tiny exact-solvable cases (exact-small reference)
    from exact_small_cases import get_exact_small_validation_cases

    for row in get_exact_small_validation_cases():
        canonical = dict(row.get("canonical") or {})
        cases.append(CaseSpec(tier="tier1", name=str(row.get("name")), canonical=canonical, exact_small_reference=True))

    # Tier 2/3: deterministic synthetic structured cases
    from benchmarks.case_factory import make_clustered_canonical_case

    cases.append(CaseSpec(tier="tier2", name="clustered_25e_10v", canonical=make_clustered_canonical_case("tier2_clustered_25e_10v", seed=1001, employee_count=25, vehicle_count=10)))
    cases.append(CaseSpec(tier="tier2", name="clustered_35e_14v", canonical=make_clustered_canonical_case("tier2_clustered_35e_14v", seed=1002, employee_count=35, vehicle_count=14)))
    cases.append(CaseSpec(tier="tier3", name="clustered_80e_30v", canonical=make_clustered_canonical_case("tier3_clustered_80e_30v", seed=2001, employee_count=80, vehicle_count=30)))
    cases.append(CaseSpec(tier="tier3", name="clustered_120e_44v", canonical=make_clustered_canonical_case("tier3_clustered_120e_44v", seed=2002, employee_count=120, vehicle_count=44)))

    return cases


def _merge_metadata(base: Dict[str, Any], overrides: Dict[str, Any], seed: int) -> Dict[str, Any]:
    meta = dict(base or {})
    meta.setdefault("distance_metric", "haversine")
    meta["seed"] = int(seed)
    for k, v in (overrides or {}).items():
        meta[k] = v
    return meta


def run_engine_main(
    canonical: Dict[str, Any],
    *,
    intensity: str,
    runs: int,
    seed: int,
    max_workers: int,
    cli_overrides: Dict[str, Any],
    metadata_overrides: Dict[str, Any],
    exact_small: bool,
    exact_small_limits: Tuple[int, int],
    env: Dict[str, str],
) -> Dict[str, Any]:
    payload = json.loads(json.dumps(canonical))  # deep copy
    payload["metadata"] = _merge_metadata(payload.get("metadata") or {}, metadata_overrides, seed=seed)

    args = [sys.executable, str(ENGINE_MAIN)]
    args += ["--intensity", str(intensity)]
    args += ["--runs", str(int(runs))]
    args += ["--max-workers", str(int(max_workers))]
    args += ["--seed", str(int(seed))]

    if exact_small:
        args += ["--exact-small-mode", "true"]
        args += ["--exact-small-max-employees", str(int(exact_small_limits[0]))]
        args += ["--exact-small-max-vehicles", str(int(exact_small_limits[1]))]

    # Simple CLI overrides hook.
    for key, value in (cli_overrides or {}).items():
        flag = f"--{key}"
        if isinstance(value, bool):
            args += [flag, "true" if value else "false"]
        else:
            args += [flag, str(value)]

    proc = subprocess.run(
        args,
        cwd=str(ENGINE_DIR),
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=env,
        timeout=env.get("ENGINE_TIMEOUT_SEC") and float(env["ENGINE_TIMEOUT_SEC"]) or 600,
        check=True,
    )
    # In stdin mode, `main.py` is designed to emit the final payload to stdout
    # while progress/log events go to stderr. Do not concatenate stdout+stderr
    # because that destroys ordering and can cause a log event to be selected.
    stdout_only = (proc.stdout or "").strip()
    if stdout_only:
        try:
            return _extract_last_json(stdout_only)
        except Exception:
            pass
    combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
    return _extract_last_json(combined)


def extract_run_metrics(engine_payload: Dict[str, Any]) -> Dict[str, Any]:
    meta = dict(engine_payload or {})
    solver_meta = dict(meta.get("solverMetadata") or {})
    distance = dict(meta.get("distance") or {})
    anytime_trace = list(meta.get("anytime_bounds_trace") or [])
    anytime_last = anytime_trace[-1] if anytime_trace else {}
    return {
        "objectiveScore": meta.get("objectiveScore"),
        "searchObjectiveScore": meta.get("searchObjectiveScore"),
        "incumbent_objective": meta.get("incumbent_objective"),
        "lower_bound": meta.get("lower_bound"),
        "optimality_gap_percent": meta.get("optimality_gap_percent"),
        "optimality_gap_absolute": meta.get("optimality_gap_absolute"),
        "exactness_status": meta.get("exactness_status"),
        "exactness_status_v2": meta.get("exactness_status_v2"),
        "bound_scope": meta.get("bound_scope"),
        "status": meta.get("status"),
        "feasible": meta.get("feasible"),
        "fullyAssigned": meta.get("fullyAssigned"),
        "stop_reason": meta.get("stop_reason"),
        "runtimeSec": solver_meta.get("runtimeSec") or solver_meta.get("runtime_sec") or solver_meta.get("runtime") or None,
        "distance_backend_used": meta.get("distance_backend_used") or distance.get("backend"),
        "fallback_occurred": meta.get("fallback_occurred"),
        # Anytime: high-level summary signals (full trace is stored in per-run payload JSON).
        "anytimeBoundsTraceLen": int(len(anytime_trace)),
        "anytimeLastLowerBound": anytime_last.get("lower_bound"),
        "anytimeLastGapPercent": anytime_last.get("optimality_gap_percent"),
        "solverConfig": dict(meta.get("solverConfig") or {}),
    }


def summarize_group(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    objs = [float(r["objectiveScore"]) for r in rows if r.get("objectiveScore") is not None]
    runtimes = [float(r["runtimeSec"]) for r in rows if r.get("runtimeSec") is not None]
    gaps = [float(r["optimality_gap_percent"]) for r in rows if r.get("optimality_gap_percent") is not None]
    out: Dict[str, Any] = {
        "count": int(len(rows)),
        "bestObjective": min(objs) if objs else None,
        "medianObjective": statistics.median(objs) if objs else None,
        "stdevObjective": statistics.pstdev(objs) if len(objs) >= 2 else 0.0 if objs else None,
        "meanRuntimeSec": (sum(runtimes) / len(runtimes)) if runtimes else None,
        "stdevRuntimeSec": statistics.pstdev(runtimes) if len(runtimes) >= 2 else 0.0 if runtimes else None,
        "meanGapPercent": (sum(gaps) / len(gaps)) if gaps else None,
        "feasibleRate": (sum(1 for r in rows if r.get("feasible")) / max(1, len(rows))),
    }
    return out


def write_artifacts(out_dir: Path, run_rows: Sequence[Dict[str, Any]]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    # JSONL: one row per run.
    (out_dir / "runs.jsonl").write_text(
        "\n".join(json.dumps(r, default=str) for r in run_rows) + "\n",
        encoding="utf-8",
    )

    # CSV summary at run-level.
    csv_path = out_dir / "runs.csv"
    if run_rows:
        fieldnames = sorted({k for row in run_rows for k in row.keys()})
        with csv_path.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            for row in run_rows:
                w.writerow(row)

    # Aggregated summary.
    grouped: Dict[Tuple[str, str, str], List[Dict[str, Any]]] = {}
    for row in run_rows:
        key = (str(row.get("tier")), str(row.get("case")), str(row.get("variant")))
        grouped.setdefault(key, []).append(row)

    summary_rows = []
    for (tier, case, variant), rows in sorted(grouped.items()):
        s = summarize_group(rows)
        summary_rows.append({"tier": tier, "case": case, "variant": variant, **s})

    (out_dir / "summary.json").write_text(json.dumps(summary_rows, indent=2), encoding="utf-8")
    with (out_dir / "summary.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["tier", "case", "variant", "count", "bestObjective", "medianObjective", "stdevObjective", "meanRuntimeSec", "stdevRuntimeSec", "meanGapPercent", "feasibleRate"])
        w.writeheader()
        for row in summary_rows:
            w.writerow(row)

    # Minimal leaderboard markdown.
    lines = ["# Benchmark Ladder Summary", "", "| Tier | Case | Variant | Best | Median | Stdev | Mean runtime (s) | Mean gap (%) | Feasible rate |", "|---|---|---|---:|---:|---:|---:|---:|---:|"]
    for row in summary_rows:
        lines.append(
            "| {tier} | {case} | {variant} | {bestObjective} | {medianObjective} | {stdevObjective} | {meanRuntimeSec} | {meanGapPercent} | {feasibleRate:.2f} |".format(
                tier=row["tier"],
                case=row["case"],
                variant=row["variant"],
                bestObjective=("%.4f" % row["bestObjective"] if row["bestObjective"] is not None else ""),
                medianObjective=("%.4f" % row["medianObjective"] if row["medianObjective"] is not None else ""),
                stdevObjective=("%.4f" % row["stdevObjective"] if row["stdevObjective"] is not None else ""),
                meanRuntimeSec=("%.2f" % row["meanRuntimeSec"] if row["meanRuntimeSec"] is not None else ""),
                meanGapPercent=("%.2f" % row["meanGapPercent"] if row["meanGapPercent"] is not None else ""),
                feasibleRate=float(row.get("feasibleRate") or 0.0),
            )
        )
    (out_dir / "leaderboard.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tiers", type=str, default="tier1,tier2")
    ap.add_argument("--variants", type=str, default="default")
    ap.add_argument("--seeds", type=str, default="1,2,3")
    ap.add_argument("--out-dir", type=str, default=str((ENGINE_DIR / "benchmarks" / "out").resolve()))
    ap.add_argument("--intensity", type=str, default="low")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--max-workers", type=int, default=1)
    ap.add_argument("--exact-small-max-employees", type=int, default=5)
    ap.add_argument("--exact-small-max-vehicles", type=int, default=3)
    ap.add_argument("--disable-ortools", action="store_true")
    args = ap.parse_args(list(argv) if argv is not None else None)

    tiers = [t.strip() for t in str(args.tiers).split(",") if t.strip()]
    variant_names = [v.strip() for v in str(args.variants).split(",") if v.strip()]
    seeds = [int(s.strip()) for s in str(args.seeds).split(",") if s.strip()]

    variants_by_name = {v.name: v for v in default_variants()}
    selected_variants = []
    for name in variant_names:
        if name not in variants_by_name:
            raise SystemExit(f"Unknown variant: {name}. Known: {sorted(variants_by_name.keys())}")
        selected_variants.append(variants_by_name[name])

    cases = [c for c in build_tier_cases() if c.tier in tiers]
    if not cases:
        raise SystemExit(f"No cases selected for tiers={tiers}")

    env = dict(os.environ)
    env["DISTANCE_METRIC"] = "haversine"
    env["DISTANCE_CACHE_PERSIST"] = "0"
    env["PYTHONHASHSEED"] = "0"
    if args.disable_ortools:
        env["ENGINE_DISABLE_ORTOOLS"] = "1"

    out_dir = Path(args.out_dir).expanduser().resolve()
    run_rows: List[Dict[str, Any]] = []

    for case in cases:
        for seed in seeds:
            # Tiny tier: also run exact-small reference for agreement (not a variant).
            exact_ref_payload = None
            if case.exact_small_reference:
                exact_ref_payload = run_engine_main(
                    case.canonical,
                    intensity=args.intensity,
                    runs=1,
                    seed=seed,
                    max_workers=args.max_workers,
                    cli_overrides={},
                    metadata_overrides={},
                    exact_small=True,
                    exact_small_limits=(args.exact_small_max_employees, args.exact_small_max_vehicles),
                    env=env,
                )

            for variant in selected_variants:
                start = time.perf_counter()
                payload = run_engine_main(
                    case.canonical,
                    intensity=args.intensity,
                    runs=args.runs,
                    seed=seed,
                    max_workers=args.max_workers,
                    cli_overrides=variant.cli_overrides,
                    metadata_overrides=variant.metadata_overrides,
                    exact_small=False,
                    exact_small_limits=(args.exact_small_max_employees, args.exact_small_max_vehicles),
                    env=env,
                )
                wall = time.perf_counter() - start

                metrics = extract_run_metrics(payload)
                row = {
                    "tier": case.tier,
                    "case": case.name,
                    "variant": variant.name,
                    "seed": int(seed),
                    "wallSec": float(wall),
                    **metrics,
                }
                if exact_ref_payload is not None:
                    row["exactSmallObjective"] = exact_ref_payload.get("objectiveScore")
                    row["exactSmallStatus"] = exact_ref_payload.get("status")
                    try:
                        if row.get("objectiveScore") is not None and row.get("exactSmallObjective") is not None:
                            row["exactSmallAbsGap"] = float(row["objectiveScore"]) - float(row["exactSmallObjective"])
                    except Exception:
                        row["exactSmallAbsGap"] = None
                run_rows.append(row)

                # Persist full payload.
                run_dir = out_dir / "runs" / case.tier / case.name / variant.name
                run_dir.mkdir(parents=True, exist_ok=True)
                (run_dir / f"seed_{seed}.json").write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")

    write_artifacts(out_dir, run_rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
