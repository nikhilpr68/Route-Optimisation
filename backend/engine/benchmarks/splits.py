from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class CorpusInstance:
    instance_id: str
    tier: str
    name: str
    path: str


def _stable_hash_int(text: str) -> int:
    h = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return int(h[:16], 16)


def materialize_corpus(
    out_dir: Path,
    *,
    tiers: Sequence[str],
) -> Dict[str, Any]:
    """
    Materialize the benchmark ladder corpus as JSON instance files on disk.

    This creates a stable set of instance files that can be referenced by
    external tuners (e.g., irace) without accidentally mixing in holdout cases.
    """
    out_dir = Path(out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # Late import to keep this module lightweight.
    from benchmarks.ladder import build_tier_cases

    cases = [c for c in build_tier_cases() if c.tier in set(tiers)]
    instances: List[Dict[str, Any]] = []

    for case in cases:
        tier_dir = out_dir / "instances" / str(case.tier)
        tier_dir.mkdir(parents=True, exist_ok=True)
        path = tier_dir / f"{case.name}.json"
        payload = json.loads(json.dumps(case.canonical))
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        instances.append(
            {
                "instance_id": f"{case.tier}/{case.name}",
                "tier": str(case.tier),
                "name": str(case.name),
                "path": str(path),
                "exact_small_reference": bool(case.exact_small_reference),
            }
        )

    index = {
        "schema_version": 1,
        "corpus_root": str(out_dir),
        "instances": instances,
    }
    (out_dir / "corpus_index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    return index


def load_corpus_index(path: Path) -> Dict[str, Any]:
    path = Path(path).expanduser().resolve()
    return json.loads(path.read_text(encoding="utf-8"))


def list_instances(corpus_index: Dict[str, Any]) -> List[CorpusInstance]:
    out: List[CorpusInstance] = []
    for row in corpus_index.get("instances") or []:
        out.append(
            CorpusInstance(
                instance_id=str(row.get("instance_id")),
                tier=str(row.get("tier")),
                name=str(row.get("name")),
                path=str(row.get("path")),
            )
        )
    out.sort(key=lambda x: (x.tier, x.name, x.instance_id))
    return out


def make_train_val_test_split(
    instance_ids: Sequence[str],
    *,
    split_seed: int,
    train_frac: float = 0.6,
    val_frac: float = 0.2,
) -> Dict[str, List[str]]:
    """
    Deterministic split based on hashing (no RNG state).

    Ensures:
    - reproducible across machines (given same seed + instance IDs)
    - disjoint train/val/test
    - non-empty val/test when possible (N>=3)
    """
    ids = [str(x) for x in instance_ids if str(x).strip()]
    ids = sorted(set(ids))
    if not ids:
        return {"train": [], "val": [], "test": []}

    train_frac = float(max(0.0, min(1.0, train_frac)))
    val_frac = float(max(0.0, min(1.0, val_frac)))
    if train_frac + val_frac > 1.0:
        # renormalize
        total = max(1e-9, train_frac + val_frac)
        train_frac /= total
        val_frac /= total

    ranked = sorted(ids, key=lambda s: (_stable_hash_int(f"{int(split_seed)}::{s}"), s))
    n = len(ranked)
    n_train = int(round(n * train_frac))
    n_val = int(round(n * val_frac))

    # Keep at least one in val/test if feasible.
    if n >= 3:
        n_train = max(1, min(n - 2, n_train))
        n_val = max(1, min(n - n_train - 1, n_val))

    train = ranked[:n_train]
    val = ranked[n_train : n_train + n_val]
    test = ranked[n_train + n_val :]
    return {"train": train, "val": val, "test": test}


def validate_no_overlap(split: Dict[str, Sequence[str]]) -> None:
    train = set(split.get("train") or [])
    val = set(split.get("val") or [])
    test = set(split.get("test") or [])
    if (train & val) or (train & test) or (val & test):
        raise ValueError("Split overlap detected")


def build_split_manifest(
    corpus_index: Dict[str, Any],
    *,
    split_seed: int,
    train_frac: float,
    val_frac: float,
    name: str,
) -> Dict[str, Any]:
    instances = list_instances(corpus_index)
    instance_ids = [i.instance_id for i in instances]
    split = make_train_val_test_split(
        instance_ids,
        split_seed=int(split_seed),
        train_frac=float(train_frac),
        val_frac=float(val_frac),
    )
    validate_no_overlap(split)
    return {
        "schema_version": 1,
        "name": str(name),
        "split_seed": int(split_seed),
        "train_frac": float(train_frac),
        "val_frac": float(val_frac),
        "splits": {k: list(v) for k, v in split.items()},
    }


def save_split_manifest(out_path: Path, manifest: Dict[str, Any]) -> None:
    out_path = Path(out_path).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def load_split_manifest(path: Path) -> Dict[str, Any]:
    path = Path(path).expanduser().resolve()
    return json.loads(path.read_text(encoding="utf-8"))

