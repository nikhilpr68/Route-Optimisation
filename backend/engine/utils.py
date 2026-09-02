import atexit
import json
import math
import os
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

try:
    import requests
except Exception:
    requests = None


# Load .env file manually (no external dependency)
def _load_env():
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    env_path = os.path.abspath(env_path)
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    os.environ.setdefault(key.strip(), value.strip())


_load_env()

# --- CONFIGURATION ---
TURNAROUND_BUFFER_MINUTES = 0

def normalize_osrm_base_url(value: Optional[str]) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    raw = raw.rstrip("/")
    if "://" not in raw:
        raw = f"http://{raw}"
    return raw.rstrip("/")


OSRM_BASE_URL = normalize_osrm_base_url(os.environ.get("OSRM_BASE_URL", "https://router.project-osrm.org"))
OSRM_PROFILE = str(os.environ.get("OSRM_PROFILE", "driving") or "driving").strip() or "driving"


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return bool(default)
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return int(default)
    try:
        value = int(float(str(raw).strip()))
    except Exception:
        return int(default)
    return max(lo, min(hi, value))


def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return float(default)
    try:
        value = float(str(raw).strip())
    except Exception:
        return float(default)
    return max(float(lo), min(float(hi), float(value)))


_CACHE_COORD_PRECISION = _env_int("DISTANCE_CACHE_COORD_PRECISION", default=6, lo=4, hi=8)
_DISTANCE_CACHE_PERSIST = _env_flag("DISTANCE_CACHE_PERSIST", True)
_DISTANCE_CACHE_PERSIST_EVERY = _env_int("DISTANCE_CACHE_PERSIST_EVERY", default=250, lo=1, hi=5000)
_DISTANCE_CACHE_PATH = os.path.abspath(
    str(
        os.environ.get(
            "DISTANCE_CACHE_PATH",
            os.path.join(os.path.dirname(__file__), ".distance_cache.json"),
        )
        or ""
    ).strip()
)
_CACHE_LOCK = threading.Lock()
_PENDING_CACHE_WRITES = 0

# OSRM client configuration and safety controls.
_OSRM_CONNECT_TIMEOUT_SEC = _env_float("OSRM_CONNECT_TIMEOUT_SEC", default=3.0, lo=0.1, hi=30.0)
_OSRM_READ_TIMEOUT_SEC = _env_float("OSRM_READ_TIMEOUT_SEC", default=10.0, lo=0.1, hi=120.0)
_OSRM_TABLE_READ_TIMEOUT_SEC = _env_float("OSRM_TABLE_READ_TIMEOUT_SEC", default=30.0, lo=0.1, hi=240.0)
_OSRM_MAX_RETRIES = _env_int("OSRM_MAX_RETRIES", default=1, lo=0, hi=5)
_OSRM_RETRY_BACKOFF_SEC = _env_float("OSRM_RETRY_BACKOFF_SEC", default=0.6, lo=0.0, hi=10.0)
_OSRM_CIRCUIT_BREAKER_FAILURES = _env_int("OSRM_CIRCUIT_BREAKER_FAILURES", default=2, lo=1, hi=20)
_OSRM_DISABLE_COOLDOWN_SEC = _env_float("OSRM_DISABLE_COOLDOWN_SEC", default=60.0, lo=0.0, hi=3600.0)
_OSRM_LOG_EVERY_SEC = _env_float("OSRM_LOG_EVERY_SEC", default=30.0, lo=0.0, hi=600.0)
_OSRM_DEBUG = _env_flag("OSRM_DEBUG", False)
_OSRM_CONSECUTIVE_FAILURES = 0
_OSRM_DISABLED_UNTIL_TS = 0.0
_LOG_LAST_TS: Dict[str, float] = {}


def _throttled_log(key: str, message: str) -> None:
    if _OSRM_DEBUG:
        print(message)
        return
    interval = float(_OSRM_LOG_EVERY_SEC)
    if interval <= 0:
        return
    now = time.time()
    last = float(_LOG_LAST_TS.get(key, 0.0))
    if (now - last) >= interval:
        _LOG_LAST_TS[key] = now
        print(message)


def _osrm_circuit_open() -> bool:
    if REQUIRE_ROAD_DISTANCE:
        return False
    return time.time() < float(_OSRM_DISABLED_UNTIL_TS)


def _osrm_record_success() -> None:
    global _OSRM_CONSECUTIVE_FAILURES, _OSRM_DISABLED_UNTIL_TS
    _OSRM_CONSECUTIVE_FAILURES = 0
    _OSRM_DISABLED_UNTIL_TS = 0.0


def _osrm_record_failure(error: Exception) -> None:
    global _OSRM_CONSECUTIVE_FAILURES, _OSRM_DISABLED_UNTIL_TS
    _OSRM_CONSECUTIVE_FAILURES += 1
    if REQUIRE_ROAD_DISTANCE:
        _throttled_log(
            "osrm_failure_strict",
            (
                f"Warning: OSRM request failed (strict road distance enabled, no fallback): {error}. "
                "Unset/disable REQUIRE_ROAD_DISTANCE to allow haversine fallback."
            ),
        )
        return
    _throttled_log("osrm_failure", f"Warning: OSRM request failed: {error}")
    if _OSRM_DISABLE_COOLDOWN_SEC <= 0:
        return
    if _OSRM_CONSECUTIVE_FAILURES >= int(_OSRM_CIRCUIT_BREAKER_FAILURES):
        _OSRM_DISABLED_UNTIL_TS = time.time() + float(_OSRM_DISABLE_COOLDOWN_SEC)
        _OSRM_CONSECUTIVE_FAILURES = 0
        _throttled_log(
            "osrm_disabled",
            (
                "Warning: OSRM appears unavailable; temporarily disabling OSRM lookups and falling back to haversine. "
                "Set DISTANCE_METRIC=haversine to avoid OSRM calls, or REQUIRE_ROAD_DISTANCE=1 to hard-fail."
            ),
        )


def _osrm_get_json(url: str, params: Dict[str, Any], timeout: Tuple[float, float]) -> Optional[Dict[str, Any]]:
    if requests is None:
        return None
    if _osrm_circuit_open():
        return None

    client = _OSRM_SESSION or requests
    for attempt in range(int(_OSRM_MAX_RETRIES) + 1):
        try:
            response = client.get(url, params=params, timeout=timeout)
            response.raise_for_status()
            data = response.json()
            _osrm_record_success()
            return data if isinstance(data, dict) else None
        except Exception as e:
            _osrm_record_failure(e)
            if REQUIRE_ROAD_DISTANCE:
                raise
            if attempt >= int(_OSRM_MAX_RETRIES):
                return None
            backoff = float(_OSRM_RETRY_BACKOFF_SEC) * (2.0**attempt)
            if backoff > 0:
                time.sleep(backoff)
    return None

# Optional compiled accelerators (pure-Python fallback is the default).
_COMPILED_DISTANCE_EXT = None
try:
    from compiled import _distance_ext as _COMPILED_DISTANCE_EXT  # type: ignore
except Exception:
    _COMPILED_DISTANCE_EXT = None

_COMPILED_DISTANCE_ENABLED = _env_flag("COMPILED_DISTANCE_ENABLED", True) and (_COMPILED_DISTANCE_EXT is not None)
_DISTANCE_KEY_TIMING_ENABLED = _env_flag("DISTANCE_KEY_TIMING_ENABLED", False)
_DISTANCE_KEY_STATS = {
    "compiled_calls": 0,
    "python_calls": 0,
    "compiled_sec": 0.0,
    "python_sec": 0.0,
}


def _round_coord(value: float) -> float:
    if _COMPILED_DISTANCE_ENABLED and _COMPILED_DISTANCE_EXT is not None:
        t0 = time.perf_counter() if _DISTANCE_KEY_TIMING_ENABLED else None
        out = float(_COMPILED_DISTANCE_EXT.round_coord(float(value), int(_CACHE_COORD_PRECISION)))
        _DISTANCE_KEY_STATS["compiled_calls"] += 1
        if t0 is not None:
            _DISTANCE_KEY_STATS["compiled_sec"] += float(time.perf_counter() - t0)
        return out
    t0 = time.perf_counter() if _DISTANCE_KEY_TIMING_ENABLED else None
    out = round(float(value), _CACHE_COORD_PRECISION)
    _DISTANCE_KEY_STATS["python_calls"] += 1
    if t0 is not None:
        _DISTANCE_KEY_STATS["python_sec"] += float(time.perf_counter() - t0)
    return out


def _distance_cache_key_from_coords(
    lat1: float,
    lng1: float,
    lat2: float,
    lng2: float,
) -> Tuple[float, float, float, float]:
    if _COMPILED_DISTANCE_ENABLED and _COMPILED_DISTANCE_EXT is not None:
        t0 = time.perf_counter() if _DISTANCE_KEY_TIMING_ENABLED else None
        key = _COMPILED_DISTANCE_EXT.distance_cache_key(
            float(lat1),
            float(lng1),
            float(lat2),
            float(lng2),
            int(_CACHE_COORD_PRECISION),
        )
        _DISTANCE_KEY_STATS["compiled_calls"] += 4
        if t0 is not None:
            _DISTANCE_KEY_STATS["compiled_sec"] += float(time.perf_counter() - t0)
        return (float(key[0]), float(key[1]), float(key[2]), float(key[3]))
    return (
        _round_coord(lat1),
        _round_coord(lng1),
        _round_coord(lat2),
        _round_coord(lng2),
    )


def distance_key_stats(reset: bool = False) -> Dict[str, float]:
    """Return timing/call stats for cache-key generation.

    Note: This is intended for benchmarking/observability; it is not used in the
    objective and does not affect solver semantics.
    """
    snap = dict(_DISTANCE_KEY_STATS)
    snap["compiled_enabled"] = bool(_COMPILED_DISTANCE_ENABLED)
    snap["coord_precision"] = int(_CACHE_COORD_PRECISION)
    if reset:
        _DISTANCE_KEY_STATS["compiled_calls"] = 0
        _DISTANCE_KEY_STATS["python_calls"] = 0
        _DISTANCE_KEY_STATS["compiled_sec"] = 0.0
        _DISTANCE_KEY_STATS["python_sec"] = 0.0
    return snap


def _distance_cache_key_from_locations(loc1: Any, loc2: Any) -> Tuple[float, float, float, float]:
    return _distance_cache_key_from_coords(loc1.lat, loc1.lng, loc2.lat, loc2.lng)


def _encode_cache_key(key: Tuple[float, float, float, float]) -> str:
    lat1, lng1, lat2, lng2 = key
    return (
        f"{lat1:.{_CACHE_COORD_PRECISION}f},{lng1:.{_CACHE_COORD_PRECISION}f}|"
        f"{lat2:.{_CACHE_COORD_PRECISION}f},{lng2:.{_CACHE_COORD_PRECISION}f}"
    )


def _decode_cache_key(raw: str) -> Optional[Tuple[float, float, float, float]]:
    try:
        left, right = str(raw).split("|", 1)
        lat1_s, lng1_s = left.split(",", 1)
        lat2_s, lng2_s = right.split(",", 1)
        return _distance_cache_key_from_coords(
            float(lat1_s),
            float(lng1_s),
            float(lat2_s),
            float(lng2_s),
        )
    except Exception:
        return None


def normalize_distance_metric(metric: Optional[str]) -> str:
    text = str(metric or "").strip().lower().replace("-", "_").replace(" ", "_")
    if text in ("", "osrm", "osm", "openstreetmap", "road", "road_distance", "mapcn", "mapcn_dev"):
        return "osrm"
    if text in ("haversine", "geo", "straight_line", "great_circle"):
        return "haversine"
    return "osrm"


# Distance cache: maps (lat1,lng1,lat2,lng2) -> distance_km
_distance_cache: Dict[Tuple[float, float, float, float], float] = {}
_DISTANCE_METRIC_FROM_ENV = normalize_distance_metric(os.environ.get("DISTANCE_METRIC"))
DISTANCE_BACKEND = _DISTANCE_METRIC_FROM_ENV
USE_ROAD_DISTANCE = DISTANCE_BACKEND != "haversine"
_REQUIRE_ROAD_DISTANCE_OVERRIDE = "REQUIRE_ROAD_DISTANCE" in os.environ
REQUIRE_ROAD_DISTANCE = _env_flag("REQUIRE_ROAD_DISTANCE", False)
_OSRM_SESSION = requests.Session() if requests is not None else None


def _load_distance_cache_from_disk() -> None:
    if not _DISTANCE_CACHE_PERSIST or not _DISTANCE_CACHE_PATH:
        return
    if not os.path.exists(_DISTANCE_CACHE_PATH):
        return
    try:
        with open(_DISTANCE_CACHE_PATH, "r", encoding="utf-8") as f:
            raw = f.read()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            # Best-effort recovery for previously corrupted writes (e.g., concurrent processes).
            try:
                payload, _ = json.JSONDecoder().raw_decode(raw)
            except Exception as e:
                print(f"Warning: failed to load distance cache: invalid JSON ({e})")
                return
        if not isinstance(payload, dict):
            return
        loaded = 0
        for raw_key, raw_value in payload.items():
            key = _decode_cache_key(raw_key)
            if key is None:
                continue
            try:
                _distance_cache[key] = float(raw_value)
            except Exception:
                continue
            loaded += 1
        if loaded:
            print(f"Loaded {loaded} cached distances from disk.")
    except Exception as e:
        print(f"Warning: failed to load distance cache: {e}")


def _persist_distance_cache(force: bool = False) -> None:
    global _PENDING_CACHE_WRITES
    if not _DISTANCE_CACHE_PERSIST or not _DISTANCE_CACHE_PATH:
        return
    with _CACHE_LOCK:
        if _PENDING_CACHE_WRITES <= 0:
            return
        if (not force) and _PENDING_CACHE_WRITES < _DISTANCE_CACHE_PERSIST_EVERY:
            return
        snapshot = dict(_distance_cache)
        _PENDING_CACHE_WRITES = 0
    try:
        cache_dir = os.path.dirname(_DISTANCE_CACHE_PATH) or "."
        os.makedirs(cache_dir, exist_ok=True)
        serializable = {_encode_cache_key(key): value for key, value in snapshot.items()}
        tmp_path = None
        try:
            # Use a unique temp file to avoid multi-process collisions.
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=cache_dir,
                prefix=os.path.basename(_DISTANCE_CACHE_PATH) + ".",
                suffix=".tmp",
                delete=False,
            ) as f:
                tmp_path = f.name
                json.dump(serializable, f, separators=(",", ":"))
            os.replace(tmp_path, _DISTANCE_CACHE_PATH)
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
    except Exception as e:
        print(f"Warning: failed to persist distance cache: {e}")


def _cache_set_value(key: Tuple[float, float, float, float], value_km: float, check_flush: bool = True) -> None:
    global _PENDING_CACHE_WRITES
    if _DISTANCE_CACHE_PERSIST:
        with _CACHE_LOCK:
            _distance_cache[key] = float(value_km)
            _PENDING_CACHE_WRITES += 1
    else:
        _distance_cache[key] = float(value_km)
    if check_flush:
        _persist_distance_cache(force=False)


def _all_pairs_cached(
    origin_keys: List[Tuple[float, float]],
    dest_keys: List[Tuple[float, float]],
) -> bool:
    cache = _distance_cache
    for o_lat, o_lng in origin_keys:
        for d_lat, d_lng in dest_keys:
            if (o_lat, o_lng, d_lat, d_lng) not in cache:
                return False
    return True


_load_distance_cache_from_disk()
atexit.register(lambda: _persist_distance_cache(force=True))


def configure_distance_metric(metric: Optional[str]) -> str:
    """Configure active distance metric from metadata/env-compatible value."""
    global DISTANCE_BACKEND, USE_ROAD_DISTANCE, REQUIRE_ROAD_DISTANCE
    selected = normalize_distance_metric(metric)
    DISTANCE_BACKEND = selected
    USE_ROAD_DISTANCE = selected != "haversine"
    if USE_ROAD_DISTANCE:
        REQUIRE_ROAD_DISTANCE = _env_flag("REQUIRE_ROAD_DISTANCE", False) if _REQUIRE_ROAD_DISTANCE_OVERRIDE else False
    else:
        REQUIRE_ROAD_DISTANCE = False
    return selected


def ensure_distance_backend_ready() -> None:
    if not USE_ROAD_DISTANCE:
        return
    if requests is None:
        raise RuntimeError("Python 'requests' dependency is required for road distance lookups.")
    if DISTANCE_BACKEND == "osrm":
        if not OSRM_BASE_URL:
            raise RuntimeError("OSRM_BASE_URL is not configured.")
        parsed = urlparse(OSRM_BASE_URL)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise RuntimeError(
                "OSRM_BASE_URL must be a valid http(s) URL (for example: http://localhost:5000). "
                f"Got: {OSRM_BASE_URL!r}"
            )


def get_distance_mode() -> Dict[str, Any]:
    osrm_active = bool(USE_ROAD_DISTANCE and DISTANCE_BACKEND == "osrm")
    return {
        "metric": "osrm" if osrm_active else "haversine",
        "backend": DISTANCE_BACKEND,
        "strictRoad": bool(USE_ROAD_DISTANCE and REQUIRE_ROAD_DISTANCE),
        "osrmBaseUrl": OSRM_BASE_URL,
        "osrmProfile": OSRM_PROFILE,
        "osrmCircuitOpen": bool(osrm_active and _osrm_circuit_open()),
        "osrmDisabledUntilTs": float(_OSRM_DISABLED_UNTIL_TS) if osrm_active and _osrm_circuit_open() else None,
    }


def haversine_km(loc1, loc2) -> float:
    """Calculate straight-line distance between two locations (Haversine formula)."""
    r = 6371.0
    dlat = math.radians(loc2.lat - loc1.lat)
    dlon = math.radians(loc2.lng - loc1.lng)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(loc1.lat))
        * math.cos(math.radians(loc2.lat))
        * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def road_distance_km(
    origin: Tuple[float, float],
    destination: Tuple[float, float],
) -> Optional[float]:
    """
    Calculate road distance between two coordinates using configured backend.
    """
    if DISTANCE_BACKEND == "osrm":
        return _osrm_distance_km(origin, destination)
    return None


def _osrm_distance_km(origin: Tuple[float, float], destination: Tuple[float, float]) -> Optional[float]:
    if requests is None:
        return None
    if not OSRM_BASE_URL:
        return None
    if _osrm_circuit_open():
        return None

    lat1, lng1 = float(origin[0]), float(origin[1])
    lat2, lng2 = float(destination[0]), float(destination[1])
    url = (
        f"{OSRM_BASE_URL.rstrip('/')}/route/v1/{OSRM_PROFILE}/"
        f"{lng1},{lat1};{lng2},{lat2}"
    )

    data = _osrm_get_json(
        url,
        params={"overview": "false"},
        timeout=(float(_OSRM_CONNECT_TIMEOUT_SEC), float(_OSRM_READ_TIMEOUT_SEC)),
    )
    if not data:
        return None
    if data.get("code") != "Ok":
        _throttled_log(
            "osrm_api_error",
            f"Warning: OSRM API error - {data.get('code')}: {data.get('message', 'No msg')}",
        )
        return None

    routes = data.get("routes") or []
    if not routes:
        return None
    dist_m = routes[0].get("distance")
    if dist_m is None:
        return None
    return float(dist_m) / 1000.0


def get_distance(loc1, loc2) -> float:
    """
    Get distance between two locations using cached road distance or haversine fallback.
    """
    key = _distance_cache_key_from_locations(loc1, loc2)
    if key in _distance_cache:
        return _distance_cache[key]

    if key[0] == key[2] and key[1] == key[3]:
        _cache_set_value(key, 0.0)
        return 0.0

    if USE_ROAD_DISTANCE:
        ensure_distance_backend_ready()
        dist = road_distance_km((loc1.lat, loc1.lng), (loc2.lat, loc2.lng))
        if dist is not None:
            _cache_set_value(key, dist)
            return dist
        if REQUIRE_ROAD_DISTANCE:
            raise RuntimeError(
                f"{DISTANCE_BACKEND} distance lookup failed for origin=({loc1.lat},{loc1.lng}) "
                f"destination=({loc2.lat},{loc2.lng})."
            )

    dist = haversine_km(loc1, loc2)
    _cache_set_value(key, dist)
    return dist


def precompute_distance_matrix(locations: list) -> None:
    """
    Precompute all pairwise distances for a list of locations.
    Call this at the start of solving to batch API calls and warm the cache.
    """
    if not USE_ROAD_DISTANCE:
        return
    ensure_distance_backend_ready()

    deduped_locations = []
    seen_locations = set()
    deduped_keys = []
    for loc in locations:
        key = (_round_coord(loc.lat), _round_coord(loc.lng))
        if key in seen_locations:
            continue
        seen_locations.add(key)
        deduped_locations.append(loc)
        deduped_keys.append(key)
    locations = deduped_locations

    print(f"Precomputing {DISTANCE_BACKEND} road distances for {len(locations)} locations...")
    if DISTANCE_BACKEND == "osrm":
        _precompute_osrm_distance_matrix(locations, deduped_keys)
    else:
        return

    _persist_distance_cache(force=True)
    print(f"  Cached {len(_distance_cache)} distances.")


def _precompute_osrm_distance_matrix(
    locations: list,
    location_keys: Optional[List[Tuple[float, float]]] = None,
) -> None:
    # Keep batches moderate for public/demo OSRM servers.
    batch_size = _env_int("OSRM_TABLE_BATCH_SIZE", default=35, lo=2, hi=80)
    table_url = f"{OSRM_BASE_URL.rstrip('/')}/table/v1/{OSRM_PROFILE}"
    key_rows = location_keys or [(_round_coord(loc.lat), _round_coord(loc.lng)) for loc in locations]
    requested_batches = 0
    skipped_batches = 0

    for i in range(0, len(locations), batch_size):
        batch_origins = locations[i : i + batch_size]
        batch_origin_keys = key_rows[i : i + batch_size]
        for j in range(0, len(locations), batch_size):
            batch_dests = locations[j : j + batch_size]
            batch_dest_keys = key_rows[j : j + batch_size]
            if _all_pairs_cached(batch_origin_keys, batch_dest_keys):
                skipped_batches += 1
                continue

            requested_batches += 1
            merged_keys = list(batch_origin_keys) + list(batch_dest_keys)
            coords = ";".join(f"{lng},{lat}" for lat, lng in merged_keys)
            source_idx = ";".join(str(idx) for idx in range(len(batch_origins)))
            dest_idx = ";".join(str(len(batch_origins) + idx) for idx in range(len(batch_dests)))

            try:
                data = _osrm_get_json(
                    f"{table_url}/{coords}",
                    params={
                        "annotations": "distance",
                        "sources": source_idx,
                        "destinations": dest_idx,
                    },
                    timeout=(float(_OSRM_CONNECT_TIMEOUT_SEC), float(_OSRM_TABLE_READ_TIMEOUT_SEC)),
                )
                if not data:
                    if REQUIRE_ROAD_DISTANCE:
                        raise RuntimeError("OSRM table request failed.")
                    continue
                if data.get("code") != "Ok":
                    if REQUIRE_ROAD_DISTANCE:
                        raise RuntimeError(
                            f"OSRM table error: {data.get('code')} {data.get('message', '')}".strip()
                        )
                    print(f"  Warning: OSRM table error: {data.get('code')} {data.get('message', '')}")
                    continue

                distances = data.get("distances") or []
                for oi, row in enumerate(distances):
                    for di, dist_m in enumerate(row or []):
                        if dist_m is None:
                            if REQUIRE_ROAD_DISTANCE:
                                raise RuntimeError("OSRM table returned null distance.")
                            continue
                        o_lat, o_lng = batch_origin_keys[oi]
                        d_lat, d_lng = batch_dest_keys[di]
                        key = (o_lat, o_lng, d_lat, d_lng)
                        _cache_set_value(key, float(dist_m) / 1000.0, check_flush=False)
            except Exception as e:
                if REQUIRE_ROAD_DISTANCE:
                    raise RuntimeError(f"Batch OSRM distance request failed: {e}") from e
                _throttled_log("osrm_table_failure", f"  Warning: Batch OSRM distance request failed: {e}")
    if skipped_batches or requested_batches:
        print(f"  OSRM table batches requested={requested_batches}, skipped_from_cache={skipped_batches}")


def calculate_travel_time(dist_km: float, speed_kmph: float) -> float:
    if speed_kmph <= 0:
        return float("inf")
    return (dist_km / speed_kmph) * 60.0


def print_solution_analysis(solution: Any, title: str = "SOLUTION ANALYSIS"):
    print("\n" + "=" * 65)
    print(f"   {title} (Total Score: {solution.objective_score:.2f})")
    print("=" * 65)

    total_cost_sum = 0.0
    total_time_sum = 0.0

    # Sort routes by Vehicle ID for clarity
    sorted_routes = sorted(solution.routes, key=lambda r: r.vehicle.id)

    for route in sorted_routes:
        if route.is_empty():
            continue

        veh = route.vehicle
        total_cost_sum += route.total_cost
        total_time_sum += route.total_time

        status = "VALID" if route.is_feasible else f"INVALID ({route.violation_msg})"
        print(f"\n[Vehicle {veh.id}] ({veh.category.upper()}) - {status}")
        print(f"   metrics: Cost=${route.total_cost:.2f} | Time={route.total_time:.1f}m | Delay={route.total_delay:.1f}m")
        print("   stops:")

        # Mirror ObjectiveEvaluator's JIT timing so logs match scored time
        if not route.stop_sequence:
            print("      [NO STOP SEQUENCE]")
            continue

        def fmt_hhmm(mins: float) -> str:
            m = int(round(mins))
            hh = (m // 60) % 24
            mm = m % 60
            return f"{hh:02d}:{mm:02d}"

        curr_loc = veh.start_loc

        first = route.stop_sequence[0]
        first_loc = first["emp"].pickup_loc if first["type"] == "p" else first["emp"].drop_loc
        dist_to_first = get_distance(curr_loc, first_loc)
        travel_to_first = calculate_travel_time(dist_to_first, veh.speed_kmph)
        target_arrival = first["emp"].earliest_pickup
        jit_start = target_arrival - travel_to_first
        effective_start = max(float(veh.avail_from), float(jit_start))

        curr_time = effective_start
        current_load = 0

        print(f"      @ {fmt_hhmm(curr_time)}  [START] {veh.start_loc.lat:.4f}, {veh.start_loc.lng:.4f}")

        for i, stop in enumerate(route.stop_sequence):
            emp = stop["emp"]
            s_type = stop["type"]
            target = emp.pickup_loc if s_type == "p" else emp.drop_loc

            dist = get_distance(curr_loc, target)
            travel = calculate_travel_time(dist, veh.speed_kmph)
            arrival = curr_time + travel

            if current_load == 0 and s_type == "p" and i > 0:
                arrival += TURNAROUND_BUFFER_MINUTES

            if s_type == "p":
                arrival = max(arrival, emp.earliest_pickup)
                current_load += 1
                label = f"[P] {emp.id}"
            else:
                current_load -= 1
                label = f"[D] {emp.id}"

            print(f"      @ {fmt_hhmm(arrival)}  {label}  load={current_load}")

            curr_time = arrival
            curr_loc = target

    if solution.unassigned:
        print("\nUNASSIGNED:")
        for e in solution.unassigned:
            print(f"   - {e.id}")
