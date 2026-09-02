from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from benchmarks.ladder import extract_run_metrics, run_engine_main, write_artifacts
from benchmarks.splits import (
    build_split_manifest,
    list_instances,
    load_corpus_index,
    load_split_manifest,
    materialize_corpus,
    save_split_manifest,
)
from benchmarks.tunable_params import irace_parameters_text


def _load_config(path: Path) -> Dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Config JSON must be an object")
    return data


def _env_for_bench(disable_ortools: bool) -> Dict[str, str]:
    env = dict(os.environ)
    env["DISTANCE_METRIC"] = "haversine"
    env["DISTANCE_CACHE_PERSIST"] = "0"
    env["PYTHONHASHSEED"] = "0"
    if disable_ortools:
        env["ENGINE_DISABLE_ORTOOLS"] = "1"
    return env


def _instance_by_id(corpus_index: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for row in corpus_index.get("instances") or []:
        iid = str(row.get("instance_id") or "")
        if not iid:
            continue
        out[iid] = dict(row)
    return out


def evaluate_split(
    *,
    corpus_index: Dict[str, Any],
    split_manifest: Dict[str, Any],
    split_name: str,
    config: Dict[str, Any],
    seeds: Sequence[int],
    out_dir: Path,
    intensity: str,
    runs: int,
    max_workers: int,
    disable_ortools: bool,
) -> List[Dict[str, Any]]:
    split = dict((split_manifest.get("splits") or {})).get(split_name)
    if split is None:
        raise ValueError(f"Unknown split: {split_name}. Expected one of: train,val,test")

    instance_map = _instance_by_id(corpus_index)
    env = _env_for_bench(disable_ortools=disable_ortools)
    meta_overrides = dict(config.get("metadata_overrides") or {})
    cli_overrides = dict(config.get("cli_overrides") or {})

    rows: List[Dict[str, Any]] = []
    for iid in split:
        row_meta = instance_map.get(str(iid))
        if row_meta is None:
            raise ValueError(f"Instance id not found in corpus: {iid}")
        canonical = json.loads(Path(row_meta["path"]).read_text(encoding="utf-8"))

        for seed in seeds:
            start = time.perf_counter()
            payload = run_engine_main(
                canonical,
                intensity=intensity,
                runs=runs,
                seed=int(seed),
                max_workers=max_workers,
                cli_overrides=cli_overrides,
                metadata_overrides=meta_overrides,
                exact_small=False,
                exact_small_limits=(0, 0),
                env=env,
            )
            wall = time.perf_counter() - start
            metrics = extract_run_metrics(payload)
            rows.append(
                {
                    "split": split_name,
                    "instance_id": str(iid),
                    "tier": str(row_meta.get("tier")),
                    "case": str(row_meta.get("name")),
                    "seed": int(seed),
                    "wallSec": float(wall),
                    **metrics,
                }
            )
            run_dir = Path(out_dir) / "runs" / split_name / str(row_meta.get("tier")) / str(row_meta.get("name"))
            run_dir.mkdir(parents=True, exist_ok=True)
            (run_dir / f"seed_{seed}.json").write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")

    write_artifacts(Path(out_dir) / split_name, rows)
    return rows


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    ap_corpus = sub.add_parser("materialize-corpus")
    ap_corpus.add_argument("--out-dir", required=True)
    ap_corpus.add_argument("--tiers", default="tier1,tier2,tier3")

    ap_split = sub.add_parser("make-splits")
    ap_split.add_argument("--corpus-index", required=True)
    ap_split.add_argument("--out", required=True)
    ap_split.add_argument("--name", default="default")
    ap_split.add_argument("--split-seed", type=int, default=123)
    ap_split.add_argument("--train-frac", type=float, default=0.6)
    ap_split.add_argument("--val-frac", type=float, default=0.2)

    ap_eval = sub.add_parser("evaluate")
    ap_eval.add_argument("--corpus-index", required=True)
    ap_eval.add_argument("--splits", required=True)
    ap_eval.add_argument("--split", choices=["train", "val", "test"], required=True)
    ap_eval.add_argument("--config", required=True, help="Config JSON with metadata_overrides/cli_overrides")
    ap_eval.add_argument("--seeds", default="1,2,3")
    ap_eval.add_argument("--out-dir", required=True)
    ap_eval.add_argument("--intensity", default="low")
    ap_eval.add_argument("--runs", type=int, default=1)
    ap_eval.add_argument("--max-workers", type=int, default=1)
    ap_eval.add_argument("--disable-ortools", action="store_true")

    ap_irace = sub.add_parser("export-irace")
    ap_irace.add_argument("--corpus-index", required=True)
    ap_irace.add_argument("--splits", required=True)
    ap_irace.add_argument("--split", choices=["train", "val", "test"], default="train")
    ap_irace.add_argument("--out-dir", required=True)
    ap_irace.add_argument("--intensity", default="low")
    ap_irace.add_argument("--runs", type=int, default=1)
    ap_irace.add_argument("--max-workers", type=int, default=1)
    ap_irace.add_argument("--seed-list", default="1,2,3,4,5")
    ap_irace.add_argument("--budget-sec", type=float, default=None, help="Optional per-instance TIME_LIMIT_SEC override (for fair racing).")
    ap_irace.add_argument("--disable-ortools", action="store_true")

    args = ap.parse_args(list(argv) if argv is not None else None)

    if args.cmd == "materialize-corpus":
        tiers = [t.strip() for t in str(args.tiers).split(",") if t.strip()]
        index = materialize_corpus(Path(args.out_dir), tiers=tiers)
        sys.stdout.write(json.dumps(index, indent=2) + "\n")
        return 0

    if args.cmd == "make-splits":
        corpus_index = load_corpus_index(Path(args.corpus_index))
        manifest = build_split_manifest(
            corpus_index,
            split_seed=int(args.split_seed),
            train_frac=float(args.train_frac),
            val_frac=float(args.val_frac),
            name=str(args.name),
        )
        save_split_manifest(Path(args.out), manifest)
        sys.stdout.write(json.dumps(manifest, indent=2) + "\n")
        return 0

    if args.cmd == "evaluate":
        corpus_index = load_corpus_index(Path(args.corpus_index))
        split_manifest = load_split_manifest(Path(args.splits))
        config = _load_config(Path(args.config))
        seeds = [int(s.strip()) for s in str(args.seeds).split(",") if s.strip()]
        out_dir = Path(args.out_dir).expanduser().resolve()
        evaluate_split(
            corpus_index=corpus_index,
            split_manifest=split_manifest,
            split_name=str(args.split),
            config=config,
            seeds=seeds,
            out_dir=out_dir,
            intensity=str(args.intensity),
            runs=int(args.runs),
            max_workers=int(args.max_workers),
            disable_ortools=bool(args.disable_ortools),
        )
        return 0

    if args.cmd == "export-irace":
        corpus_index = load_corpus_index(Path(args.corpus_index))
        split_manifest = load_split_manifest(Path(args.splits))
        split_name = str(args.split)
        split_ids = list((split_manifest.get("splits") or {}).get(split_name) or [])
        if not split_ids:
            raise ValueError(f"Split '{split_name}' is empty.")

        instance_map = _instance_by_id(corpus_index)
        out_dir = Path(args.out_dir).expanduser().resolve()
        out_dir.mkdir(parents=True, exist_ok=True)

        # Resolve instance paths for the split.
        instance_paths: List[str] = []
        for iid in split_ids:
            row_meta = instance_map.get(str(iid))
            if row_meta is None:
                raise ValueError(f"Instance id not found in corpus: {iid}")
            instance_paths.append(str(row_meta["path"]))

        # Write trainInstances list for irace (one path per line).
        (out_dir / f"{split_name}_instances.txt").write_text("\n".join(instance_paths) + "\n", encoding="utf-8")

        # Parameters file (allowlisted tunables only).
        (out_dir / "parameters.irace").write_text(irace_parameters_text(), encoding="utf-8")

        seeds = [s.strip() for s in str(args.seed_list).split(",") if s.strip()]
        seed_count = max(1, len(seeds))

        # Scenario file template. Users may need to adapt irace binary path.
        runner = str((ENGINE_DIR / "benchmarks" / "irace_target_runner.py").resolve())
        scenario_lines = [
            "# irace scenario (auto-generated by tuning_workflow.py export-irace)",
            f"targetRunner = {sys.executable} {runner} --instance $instance --seed $seed --intensity {str(args.intensity)} --runs {int(args.runs)} --max-workers {int(args.max_workers)}",
            f"trainInstances = {str((out_dir / f'{split_name}_instances.txt').resolve())}",
            "instancesFile = ",
            f"maxExperiments = {int(seed_count * len(instance_paths))}",
            "parallel = 1",
            "logFile = irace.log",
            "execDir = .",
            "digits = 10",
        ]
        if args.budget_sec is not None:
            scenario_lines.append(f"# NOTE: Set TIME_LIMIT_SEC in instances or via irace parameters is disallowed by allowlist; apply budget by rewriting instances if needed.")
        (out_dir / "scenario.irace").write_text("\n".join(scenario_lines) + "\n", encoding="utf-8")

        meta = {
            "split": split_name,
            "instanceCount": int(len(instance_paths)),
            "seeds": seeds,
            "intensity": str(args.intensity),
            "runs": int(args.runs),
            "maxWorkers": int(args.max_workers),
            "disableOrtools": bool(args.disable_ortools),
        }
        (out_dir / "export_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        sys.stdout.write(json.dumps(meta, indent=2) + "\n")
        return 0

    raise SystemExit("Unknown command")


if __name__ == "__main__":
    raise SystemExit(main())
