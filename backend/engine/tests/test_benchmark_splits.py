from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def test_split_is_reproducible_and_non_overlapping():
    from benchmarks.splits import make_train_val_test_split, validate_no_overlap

    ids = [f"tierX/case{i}" for i in range(10)]
    a = make_train_val_test_split(ids, split_seed=123, train_frac=0.6, val_frac=0.2)
    b = make_train_val_test_split(ids, split_seed=123, train_frac=0.6, val_frac=0.2)
    assert a == b
    validate_no_overlap(a)
    assert set(a["train"]) | set(a["val"]) | set(a["test"]) == set(ids)


def test_split_changes_with_seed():
    from benchmarks.splits import make_train_val_test_split

    ids = [f"tierX/case{i}" for i in range(10)]
    a = make_train_val_test_split(ids, split_seed=1, train_frac=0.6, val_frac=0.2)
    b = make_train_val_test_split(ids, split_seed=2, train_frac=0.6, val_frac=0.2)
    assert a != b


def test_split_has_non_empty_val_and_test_when_possible():
    from benchmarks.splits import make_train_val_test_split

    ids = ["a", "b", "c", "d", "e"]
    s = make_train_val_test_split(ids, split_seed=7, train_frac=0.8, val_frac=0.1)
    assert len(s["val"]) >= 1
    assert len(s["test"]) >= 1


def test_materialize_and_manifest_smoke(tmp_path: Path):
    from benchmarks.splits import build_split_manifest, list_instances, materialize_corpus, validate_no_overlap

    corpus = materialize_corpus(tmp_path, tiers=["tier1", "tier2"])
    instances = list_instances(corpus)
    assert len(instances) >= 1
    for inst in instances:
        assert Path(inst.path).exists()

    manifest = build_split_manifest(corpus, split_seed=123, train_frac=0.6, val_frac=0.2, name="x")
    validate_no_overlap(manifest["splits"])
    all_ids = set(manifest["splits"]["train"]) | set(manifest["splits"]["val"]) | set(manifest["splits"]["test"])
    assert all_ids == {i.instance_id for i in instances}
