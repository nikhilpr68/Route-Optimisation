from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Optional


ENGINE_DIR = Path(__file__).resolve().parents[1]
ENGINE_MAIN = ENGINE_DIR / "main.py"

if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from benchmarks.tunable_params import validate_overrides_allowlisted


def _parse_kv_pairs(items: list[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for item in items or []:
        if "=" not in item:
            raise SystemExit(f"Invalid --param entry (expected KEY=VALUE): {item}")
        k, v = item.split("=", 1)
        k = str(k).strip()
        v = str(v).strip()
        if not k:
            continue
        # Keep values as strings; engine metadata parser handles booleans/numbers.
        out[k] = v
    # Enforce that tuning cannot change objective/feasibility semantics.
    validate_overrides_allowlisted(out)
    return out


def _parse_irace_positional(argv: list[str]) -> Optional[Dict[str, Any]]:
    """Support irace's default calling convention:

        targetRunner <configuration_id> <instance_path> <seed> <parameters...>

    Returns a dict compatible with argparse output, or None if not in positional form.
    """
    if not argv:
        return None
    if "--instance" in argv:
        return None
    # Heuristic: require at least 3 positionals.
    if len(argv) < 3:
        return None
    conf_id = argv[0]
    instance = argv[1]
    seed_raw = argv[2]
    try:
        seed = int(seed_raw)
    except Exception:
        return None
    # Remaining args are flags produced from the parameters file.
    # We support:
    #   --param KEY=VALUE
    #   --param KEY=<value>  (irace fills value into same arg)
    params = []
    idx = 3
    while idx < len(argv):
        token = argv[idx]
        if token == "--param" and (idx + 1) < len(argv):
            params.append(argv[idx + 1])
            idx += 2
            continue
        if token.startswith("--param"):
            # e.g., "--param KEY=VALUE" (rare; but accept)
            rest = token[len("--param") :].strip()
            if rest.startswith("="):
                rest = rest[1:]
            if rest:
                params.append(rest)
            idx += 1
            continue
        # Most commonly, parameters file uses switches like: --param KEY= 5
        # but we encode as single arg: --param KEY=<value> so ignore unknown tokens.
        if token.startswith("--param "):
            params.append(token[len("--param ") :])
        idx += 1
    return {
        "instance": instance,
        "seed": seed,
        "intensity": "low",
        "runs": 1,
        "max_workers": 1,
        "param": params,
        "print_json": False,
        "config_id": conf_id,
        "positional": True,
    }


def main(argv: Optional[list[str]] = None) -> int:
    argv_list = list(argv) if argv is not None else None
    if argv_list is None:
        argv_list = list(sys.argv[1:])

    pos = _parse_irace_positional(argv_list)
    if pos is not None:
        instance_path = Path(pos["instance"]).expanduser().resolve()
        seed = int(pos["seed"])
        intensity = str(pos["intensity"])
        runs = int(pos["runs"])
        max_workers = int(pos["max_workers"])
        params = list(pos["param"])
        print_json = bool(pos["print_json"])
    else:
        ap = argparse.ArgumentParser()
        ap.add_argument("--instance", required=True, help="Path to canonical JSON instance")
        ap.add_argument("--seed", required=True, type=int, help="Reproducibility seed for the engine run")
        ap.add_argument("--intensity", default="low")
        ap.add_argument("--runs", type=int, default=1)
        ap.add_argument("--max-workers", type=int, default=1)
        ap.add_argument("--param", action="append", default=[], help="Metadata override KEY=VALUE (repeatable)")
        ap.add_argument("--print-json", action="store_true", help="Print full engine payload JSON (debug)")
        args = ap.parse_args(argv_list)
        instance_path = Path(args.instance).expanduser().resolve()
        seed = int(args.seed)
        intensity = str(args.intensity)
        runs = int(args.runs)
        max_workers = int(args.max_workers)
        params = list(args.param)
        print_json = bool(args.print_json)

    canonical = json.loads(instance_path.read_text(encoding="utf-8"))
    meta = dict(canonical.get("metadata") or {})
    meta.setdefault("distance_metric", "haversine")
    meta["seed"] = int(seed)
    meta.update(_parse_kv_pairs(list(params)))
    canonical["metadata"] = meta

    cmd = [
        sys.executable,
        str(ENGINE_MAIN),
        "--intensity",
        str(intensity),
        "--runs",
        str(int(runs)),
        "--max-workers",
        str(int(max_workers)),
        "--seed",
        str(int(seed)),
    ]

    env = dict(os.environ)
    env.setdefault("DISTANCE_METRIC", "haversine")
    env.setdefault("DISTANCE_CACHE_PERSIST", "0")
    env.setdefault("PYTHONHASHSEED", "0")

    proc = subprocess.run(
        cmd,
        cwd=str(ENGINE_DIR),
        input=json.dumps(canonical),
        text=True,
        capture_output=True,
        env=env,
        timeout=600,
        check=True,
    )

    payload = None
    stdout = (proc.stdout or "").strip()
    if stdout:
        payload = json.loads(stdout.splitlines()[-1])
    else:
        payload = json.loads((proc.stderr or "").splitlines()[-1])

    if print_json:
        sys.stdout.write(json.dumps(payload, indent=2, default=str) + "\n")
        return 0

    # irace expects a single numeric cost (minimization).
    score = payload.get("objectiveScore")
    if score is None:
        raise SystemExit("Engine payload missing objectiveScore")
    sys.stdout.write(str(float(score)) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
