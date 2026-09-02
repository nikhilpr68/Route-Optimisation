from __future__ import annotations

import argparse
import copy
import json
import logging
import math
import statistics
import sys
from pathlib import Path
from typing import Dict, List, Sequence

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from parser import JsonParser
from solver import GeneticSolver
from solution_status import classify_solution_status, is_solution_feasible, is_solution_fully_assigned
from utils import configure_distance_metric


def _default_cases() -> Dict[str, Dict]:
    return {
        "small": {
            "schema_version": "1.0",
            "problem_type": "employee_transport_many_to_one",
            "metadata": {"distance_metric": "haversine"},
            "employees": [
                {
                    "id": "E1",
                    "priority": "High",
                    "pickup": {"lat": 12.9716, "lng": 77.5946},
                    "dropoff": {"lat": 12.9352, "lng": 77.6245},
                    "time_window": {"start": "08:00", "end": "09:30"},
                    "vehicle_preference": "normal",
                    "sharing_preference": "double",
                },
                {
                    "id": "E2",
                    "priority": "Medium",
                    "pickup": {"lat": 12.9611, "lng": 77.6387},
                    "dropoff": {"lat": 12.9304, "lng": 77.6784},
                    "time_window": {"start": "08:10", "end": "09:40"},
                    "vehicle_preference": "normal",
                    "sharing_preference": "double",
                },
                {
                    "id": "E3",
                    "priority": "Low",
                    "pickup": {"lat": 12.9857, "lng": 77.6050},
                    "dropoff": {"lat": 12.9225, "lng": 77.6402},
                    "time_window": {"start": "08:05", "end": "09:55"},
                    "vehicle_preference": "normal",
                    "sharing_preference": "double",
                },
            ],
            "vehicles": [
                {
                    "id": "V1",
                    "fuel_type": "petrol",
                    "capacity": 2,
                    "cost_per_km": 12,
                    "avg_speed_kmph": 24,
                    "start_location": {"lat": 12.9760, "lng": 77.5993},
                    "available_time": "07:40",
                    "category": "normal",
                },
                {
                    "id": "V2",
                    "fuel_type": "diesel",
                    "capacity": 2,
                    "cost_per_km": 10,
                    "avg_speed_kmph": 26,
                    "start_location": {"lat": 12.9485, "lng": 77.5921},
                    "available_time": "07:45",
                    "category": "normal",
                },
            ],
            "baseline": {
                "E1": {"cost": 220, "time": 45},
                "E2": {"cost": 240, "time": 48},
                "E3": {"cost": 250, "time": 50},
            },
        },
        "medium": {
            "schema_version": "1.0",
            "problem_type": "employee_transport_many_to_one",
            "metadata": {"distance_metric": "haversine"},
            "employees": [
                {
                    "id": "E1",
                    "priority": "High",
                    "pickup": {"lat": 12.9716, "lng": 77.5946},
                    "dropoff": {"lat": 12.9352, "lng": 77.6245},
                    "time_window": {"start": "08:00", "end": "09:30"},
                    "vehicle_preference": "premium",
                    "sharing_preference": "single",
                },
                {
                    "id": "E2",
                    "priority": "Medium",
                    "pickup": {"lat": 12.9611, "lng": 77.6387},
                    "dropoff": {"lat": 12.9304, "lng": 77.6784},
                    "time_window": {"start": "08:10", "end": "09:45"},
                    "vehicle_preference": "normal",
                    "sharing_preference": "double",
                },
                {
                    "id": "E3",
                    "priority": "Low",
                    "pickup": {"lat": 12.9857, "lng": 77.6050},
                    "dropoff": {"lat": 12.9225, "lng": 77.6402},
                    "time_window": {"start": "08:05", "end": "09:55"},
                    "vehicle_preference": "normal",
                    "sharing_preference": "double",
                },
                {
                    "id": "E4",
                    "priority": "Low",
                    "pickup": {"lat": 12.9570, "lng": 77.6100},
                    "dropoff": {"lat": 12.9190, "lng": 77.6440},
                    "time_window": {"start": "08:15", "end": "10:00"},
                    "vehicle_preference": "normal",
                    "sharing_preference": "double",
                },
                {
                    "id": "E5",
                    "priority": "Medium",
                    "pickup": {"lat": 12.9490, "lng": 77.6220},
                    "dropoff": {"lat": 12.9280, "lng": 77.6060},
                    "time_window": {"start": "08:05", "end": "09:50"},
                    "vehicle_preference": "normal",
                    "sharing_preference": "double",
                },
            ],
            "vehicles": [
                {
                    "id": "V1",
                    "fuel_type": "petrol",
                    "capacity": 2,
                    "cost_per_km": 13,
                    "avg_speed_kmph": 26,
                    "start_location": {"lat": 12.9760, "lng": 77.5993},
                    "available_time": "07:40",
                    "category": "premium",
                },
                {
                    "id": "V2",
                    "fuel_type": "diesel",
                    "capacity": 3,
                    "cost_per_km": 10,
                    "avg_speed_kmph": 25,
                    "start_location": {"lat": 12.9485, "lng": 77.5921},
                    "available_time": "07:45",
                    "category": "normal",
                },
                {
                    "id": "V3",
                    "fuel_type": "diesel",
                    "capacity": 2,
                    "cost_per_km": 11,
                    "avg_speed_kmph": 24,
                    "start_location": {"lat": 12.9420, "lng": 77.6100},
                    "available_time": "07:50",
                    "category": "normal",
                },
            ],
            "baseline": {
                "E1": {"cost": 250, "time": 50},
                "E2": {"cost": 240, "time": 48},
                "E3": {"cost": 230, "time": 46},
                "E4": {"cost": 220, "time": 44},
                "E5": {"cost": 225, "time": 45},
            },
        },
    }


def _load_case_map(case_files: Sequence[str]) -> Dict[str, Dict]:
    if not case_files:
        return _default_cases()

    out = {}
    for path_str in case_files:
        path = Path(path_str).expanduser().resolve()
        with path.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        name = path.stem
        out[name] = payload
    return out


def _bool_label(flag: bool) -> str:
    return "exact" if flag else "heuristic"


def _run_single(canonical: Dict, seed: int, exact_enabled: bool, generations: int, pop_size: int, alns_iterations: int) -> Dict:
    config = copy.deepcopy(canonical)
    metadata = dict(config.get("metadata") or {})
    metadata["distance_metric"] = "haversine"
    metadata["ROUTE_POOL_ENABLED"] = "true" if exact_enabled else "false"
    metadata["ORTOOLS_SEED_ASSIGNMENT_ENABLED"] = "false"
    metadata["TIME_LIMIT_SEC"] = metadata.get("TIME_LIMIT_SEC", 25)
    metadata["MIN_RUNTIME_SEC"] = metadata.get("MIN_RUNTIME_SEC", 2)
    config["metadata"] = metadata

    configure_distance_metric("haversine")
    problem = JsonParser().load_from_canonical(config)
    solver = GeneticSolver(
        problem,
        generations=generations,
        pop_size=pop_size,
        alns_iterations=alns_iterations,
        seed=int(seed),
    )
    solver.logger.setLevel(logging.WARNING)
    solution, run_meta = solver.solve(run_id=1)

    feasible = bool(is_solution_feasible(solution))
    fully_assigned = bool(is_solution_fully_assigned(solution))
    return {
        "objective": float(solution.objective_score),
        "feasible": feasible,
        "fullyAssigned": fully_assigned,
        "status": classify_solution_status(solution),
        "runtimeSec": float(run_meta.get("runtimeSec", run_meta.get("durationSeconds", 0.0))),
        "stopReason": str(run_meta.get("stopReason") or ""),
        "structuralHash": str(solution.structural_hash),
        "finalSource": str(run_meta.get("finalBestSource") or ""),
        "heuristicBestObjective": float(run_meta.get("heuristicBestObjective") or solution.objective_score),
        "exactSelectedObjective": run_meta.get("exactSelectedObjective"),
    }


def _aggregate(rows: List[Dict]) -> Dict[str, object]:
    objectives = [float(r["objective"]) for r in rows]
    runtimes = [float(r["runtimeSec"]) for r in rows]
    feasible_rate = sum(1 for r in rows if r["feasible"]) / max(1, len(rows))

    return {
        "runs": int(len(rows)),
        "bestObjective": float(min(objectives) if objectives else math.inf),
        "meanObjective": float(statistics.fmean(objectives) if objectives else math.inf),
        "stdObjective": float(statistics.pstdev(objectives) if len(objectives) > 1 else 0.0),
        "meanRuntimeSec": float(statistics.fmean(runtimes) if runtimes else 0.0),
        "stdRuntimeSec": float(statistics.pstdev(runtimes) if len(runtimes) > 1 else 0.0),
        "feasibilityRate": float(feasible_rate),
    }


def _markdown_summary(result: Dict[str, object]) -> str:
    lines = []
    lines.append("# Benchmark Summary")
    lines.append("")
    lines.append(f"Seeds: `{result['seeds']}`")
    lines.append("")
    lines.append("| Variant | Runs | Best Obj | Mean Obj | Std Obj | Feasibility | Mean Runtime (s) |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|")

    for variant in ("heuristic", "exact"):
        agg = result["aggregates"].get(variant, {})
        lines.append(
            "| {variant} | {runs} | {best:.3f} | {mean:.3f} | {std:.3f} | {feas:.1%} | {runtime:.3f} |".format(
                variant=variant,
                runs=int(agg.get("runs", 0)),
                best=float(agg.get("bestObjective", math.inf)),
                mean=float(agg.get("meanObjective", math.inf)),
                std=float(agg.get("stdObjective", 0.0)),
                feas=float(agg.get("feasibilityRate", 0.0)),
                runtime=float(agg.get("meanRuntimeSec", 0.0)),
            )
        )

    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Run engine benchmarks and write results.json + summary.md")
    parser.add_argument("--case-file", action="append", default=[], help="Path to canonical JSON testcase (repeatable)")
    parser.add_argument("--seeds", default="101,202,303", help="Comma separated seeds")
    parser.add_argument("--generations", type=int, default=80)
    parser.add_argument("--pop-size", type=int, default=14)
    parser.add_argument("--alns-iterations", type=int, default=5)
    parser.add_argument("--output-dir", default=str(ENGINE_DIR / "benchmarks"))
    args = parser.parse_args()

    seeds = [int(s.strip()) for s in str(args.seeds).split(",") if s.strip()]
    case_map = _load_case_map(args.case_file)

    raw_rows = []
    by_variant: Dict[str, List[Dict]] = {"heuristic": [], "exact": []}

    for case_name, canonical in case_map.items():
        for seed in seeds:
            for exact_enabled in (False, True):
                variant = _bool_label(exact_enabled)
                row = _run_single(
                    canonical=canonical,
                    seed=seed,
                    exact_enabled=exact_enabled,
                    generations=int(args.generations),
                    pop_size=int(args.pop_size),
                    alns_iterations=int(args.alns_iterations),
                )
                row["case"] = case_name
                row["seed"] = int(seed)
                row["variant"] = variant
                raw_rows.append(row)
                by_variant[variant].append(row)

    results = {
        "seeds": seeds,
        "cases": sorted(case_map.keys()),
        "aggregates": {
            "heuristic": _aggregate(by_variant["heuristic"]),
            "exact": _aggregate(by_variant["exact"]),
        },
        "rows": raw_rows,
    }

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    results_json = output_dir / "results.json"
    summary_md = output_dir / "summary.md"

    results_json.write_text(json.dumps(results, indent=2), encoding="utf-8")
    summary_md.write_text(_markdown_summary(results), encoding="utf-8")

    print(str(results_json))
    print(str(summary_md))


if __name__ == "__main__":
    main()
