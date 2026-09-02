from __future__ import annotations

import os
import random
import sys
import time
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))


def _bench(label: str, fn, coords, iters: int) -> float:
    t0 = time.perf_counter()
    acc = 0.0
    for i in range(iters):
        lat1, lng1, lat2, lng2 = coords[i % len(coords)]
        k = fn(lat1, lng1, lat2, lng2)
        # keep result live
        acc += float(k[0]) + float(k[1]) + float(k[2]) + float(k[3])
    dt = time.perf_counter() - t0
    print(f"{label:22s}  {dt:8.4f}s  ({iters/dt:10.1f} keys/s)  checksum={acc:.3f}")
    return dt


def main() -> int:
    # Enable key timing before importing utils so module-level flags pick it up.
    os.environ["DISTANCE_KEY_TIMING_ENABLED"] = "true"
    from utils import _distance_cache_key_from_coords, distance_key_stats

    rng = random.Random(123)
    coords = [
        (
            rng.uniform(-90.0, 90.0),
            rng.uniform(-180.0, 180.0),
            rng.uniform(-90.0, 90.0),
            rng.uniform(-180.0, 180.0),
        )
        for _ in range(5000)
    ]

    iters = int(os.environ.get("MICROBENCH_ITERS", "200000"))

    distance_key_stats(reset=True)

    print("Distance-key microbench (cache-key generation only)")
    _bench("distance_key (utils)", _distance_cache_key_from_coords, coords, iters)
    print("Stats:", distance_key_stats(reset=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
