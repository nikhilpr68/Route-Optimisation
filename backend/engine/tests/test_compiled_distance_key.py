"""
Correctness tests for optional compiled accelerators.

These tests must pass even when the compiled extension is not built.
When the extension is available, we assert equivalence with the pure-Python
reference behaviour for the coordinate rounding used in distance-cache keys.
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _py_key(lat1: float, lng1: float, lat2: float, lng2: float, ndigits: int):
    return (
        round(float(lat1), ndigits),
        round(float(lng1), ndigits),
        round(float(lat2), ndigits),
        round(float(lng2), ndigits),
    )


def _compiled_ext_available() -> bool:
    try:
        from compiled import _distance_ext  # noqa: F401

        return True
    except Exception:
        return False


class TestCompiledDistanceKeyOptional:
    def test_utils_imports_without_compiled_ext(self, monkeypatch):
        # Even if compiled is missing, importing utils must work.
        import utils  # noqa: F401

    @pytest.mark.skipif(not _compiled_ext_available(), reason="compiled._distance_ext not built")
    def test_compiled_key_matches_python_round_for_geo_ranges(self):
        from compiled import _distance_ext

        ndigits = 6
        rng = random.Random(123)
        for _ in range(20_000):
            lat1 = rng.uniform(-90.0, 90.0)
            lng1 = rng.uniform(-180.0, 180.0)
            lat2 = rng.uniform(-90.0, 90.0)
            lng2 = rng.uniform(-180.0, 180.0)
            py = _py_key(lat1, lng1, lat2, lng2, ndigits)
            cc = _distance_ext.distance_cache_key(lat1, lng1, lat2, lng2, ndigits)
            assert tuple(float(x) for x in cc) == py

    @pytest.mark.skipif(not _compiled_ext_available(), reason="compiled._distance_ext not built")
    def test_compiled_round_coord_matches_python_round(self):
        from compiled import _distance_ext

        ndigits = 6
        rng = random.Random(7)
        for _ in range(50_000):
            x = rng.uniform(-200.0, 200.0)
            assert float(_distance_ext.round_coord(x, ndigits)) == round(x, ndigits)

