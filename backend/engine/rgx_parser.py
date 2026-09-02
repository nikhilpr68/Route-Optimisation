import json
import re
import sys
from copy import deepcopy

CANONICAL_TEMPLATE = {
    "schema_version": "1.0",
    "problem_type": "employee_transport_many_to_one",
    "metadata": {
        "project_name": None,
        "date": None,
        "avg_speed_kmph": None,
        "distance_metric": "osrm",
    },
    "depot": {"lat": None, "lng": None, "name": "Office"},
    "employees": [],
    "vehicles": [],
    "baseline": {},
}


def normalize_key(raw):
    s = str(raw or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"^_+|_+$", "", s)
    return s


def is_blank(v):
    return v is None or (isinstance(v, str) and not v.strip())


def text_value(v):
    if v is None:
        return ""
    return str(v).strip()


def parse_number(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        if isinstance(v, bool):
            return None
        return float(v)
    s = str(v).strip().replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except Exception:
        return None


def parse_time_string(v):
    if v is None:
        return None

    if isinstance(v, (int, float)) and not isinstance(v, bool):
        n = float(v)
        if 0 <= n < 1:
            total_minutes = int(round(n * 24 * 60))
            hh = (total_minutes // 60) % 24
            mm = total_minutes % 60
            return f"{hh:02d}:{mm:02d}"
        if 0 <= n < (24 * 60):
            total_minutes = int(round(n))
            hh = total_minutes // 60
            mm = total_minutes % 60
            return f"{hh:02d}:{mm:02d}"

    s = str(v).strip()
    if not s:
        return None
    m = re.search(r"(\d{1,2}):(\d{2})(?::\d{2})?", s)
    if not m:
        return None
    hh = int(m.group(1))
    mm = int(m.group(2))
    if 0 <= hh <= 23 and 0 <= mm <= 59:
        return f"{hh:02d}:{mm:02d}"
    return None


def match_any(norm_key, regex_list):
    return any(r.search(norm_key) for r in regex_list)


def pick_value(row, regex_list):
    if not isinstance(row, dict):
        return None
    for k, v in row.items():
        nk = normalize_key(k)
        if match_any(nk, regex_list) and not is_blank(v):
            return v
    return None


def assign_stable_ids(items, prefix):
    out = []
    used = set()
    seq = 1
    for item in items:
        item2 = dict(item)
        raw_id = text_value(item2.get("id"))
        if not raw_id:
            while f"{prefix}{seq:03d}" in used:
                seq += 1
            raw_id = f"{prefix}{seq:03d}"
            seq += 1
        if raw_id in used:
            i = 2
            candidate = f"{raw_id}_{i}"
            while candidate in used:
                i += 1
                candidate = f"{raw_id}_{i}"
            raw_id = candidate
        used.add(raw_id)
        item2["id"] = raw_id
        out.append(item2)
    return out


EMPLOYEE_ID_KEYS = [
    re.compile(r"^employee_id$"),
    re.compile(r"^emp_id$"),
    re.compile(r"^employee$"),
    re.compile(r"^emp$"),
    re.compile(r"^id$"),
]
EMPLOYEE_NAME_KEYS = [
    re.compile(r"^employee_name$"),
    re.compile(r"^name$"),
    re.compile(r"^full_name$"),
]
EMPLOYEE_PRIORITY_KEYS = [
    re.compile(r"^priority$"),
    re.compile(r"^priority_level$"),
    re.compile(r"^tier$"),
]
PICKUP_LAT_KEYS = [
    re.compile(r"pickup.*lat"),
    re.compile(r"source.*lat"),
    re.compile(r"from.*lat"),
]
PICKUP_LNG_KEYS = [
    re.compile(r"pickup.*(lng|lon|longitude)"),
    re.compile(r"source.*(lng|lon|longitude)"),
    re.compile(r"from.*(lng|lon|longitude)"),
]
DROPOFF_LAT_KEYS = [
    re.compile(r"drop.*lat"),
    re.compile(r"dropoff.*lat"),
    re.compile(r"office.*lat"),
    re.compile(r"destination.*lat"),
    re.compile(r"to.*lat"),
]
DROPOFF_LNG_KEYS = [
    re.compile(r"drop.*(lng|lon|longitude)"),
    re.compile(r"dropoff.*(lng|lon|longitude)"),
    re.compile(r"office.*(lng|lon|longitude)"),
    re.compile(r"destination.*(lng|lon|longitude)"),
    re.compile(r"to.*(lng|lon|longitude)"),
]
EARLIEST_KEYS = [
    re.compile(r"earliest.*pick"),
    re.compile(r"pickup.*start"),
    re.compile(r"^start_time$"),
    re.compile(r"window.*start"),
    re.compile(r"time_from"),
]
LATEST_KEYS = [
    re.compile(r"latest.*drop"),
    re.compile(r"drop.*end"),
    re.compile(r"^end_time$"),
    re.compile(r"window.*end"),
    re.compile(r"time_to"),
]
VEHICLE_PREF_KEYS = [
    re.compile(r"vehicle.*pref"),
    re.compile(r"preferred_vehicle"),
]
SHARING_PREF_KEYS = [
    re.compile(r"sharing.*pref"),
    re.compile(r"share_pref"),
]

VEHICLE_ID_KEYS = [
    re.compile(r"^vehicle_id$"),
    re.compile(r"^veh_id$"),
    re.compile(r"^vehicle$"),
    re.compile(r"^veh$"),
    re.compile(r"^id$"),
]
VEHICLE_CAPACITY_KEYS = [
    re.compile(r"^capacity$"),
    re.compile(r"vehicle_capacity"),
    re.compile(r"seats?"),
]
VEHICLE_COST_KEYS = [
    re.compile(r"cost.*(km|kilometer)"),
    re.compile(r"^cost_per_km$"),
]
VEHICLE_SPEED_KEYS = [
    re.compile(r"avg.*speed"),
    re.compile(r"^speed$"),
    re.compile(r"kmph"),
    re.compile(r"kph"),
]
VEHICLE_START_LAT_KEYS = [
    re.compile(r"current.*lat"),
    re.compile(r"start.*lat"),
    re.compile(r"depot.*lat"),
    re.compile(r"origin.*lat"),
]
VEHICLE_START_LNG_KEYS = [
    re.compile(r"current.*(lng|lon|longitude)"),
    re.compile(r"start.*(lng|lon|longitude)"),
    re.compile(r"depot.*(lng|lon|longitude)"),
    re.compile(r"origin.*(lng|lon|longitude)"),
]
VEHICLE_AVAILABLE_KEYS = [
    re.compile(r"available.*from"),
    re.compile(r"available.*time"),
    re.compile(r"^available_time$"),
    re.compile(r"^start_time$"),
    re.compile(r"^avail_from$"),
]
VEHICLE_CATEGORY_KEYS = [
    re.compile(r"^category$"),
]
VEHICLE_MODE_KEYS = [
    re.compile(r"^mode$"),
    re.compile(r"vehicle_type"),
]
VEHICLE_FUEL_KEYS = [re.compile(r"fuel")]

BASELINE_EMP_ID_KEYS = [
    re.compile(r"^employee_id$"),
    re.compile(r"^emp_id$"),
    re.compile(r"^employee$"),
    re.compile(r"^id$"),
]
BASELINE_COST_KEYS = [re.compile(r"baseline.*cost"), re.compile(r"^cost$")]
BASELINE_TIME_KEYS = [re.compile(r"baseline.*time"), re.compile(r"time.*min"), re.compile(r"^time$")]


def table_header_stats(row):
    keys = [normalize_key(k) for k in (row or {}).keys()]
    employee_hits = 0
    vehicle_hits = 0
    baseline_hits = 0
    metadata_hits = 0
    for k in keys:
        if (
            match_any(k, EMPLOYEE_ID_KEYS)
            or match_any(k, PICKUP_LAT_KEYS)
            or match_any(k, PICKUP_LNG_KEYS)
            or match_any(k, DROPOFF_LAT_KEYS)
            or match_any(k, DROPOFF_LNG_KEYS)
        ):
            employee_hits += 1
        if (
            match_any(k, VEHICLE_ID_KEYS)
            or match_any(k, VEHICLE_CAPACITY_KEYS)
            or match_any(k, VEHICLE_COST_KEYS)
            or match_any(k, VEHICLE_START_LAT_KEYS)
            or match_any(k, VEHICLE_START_LNG_KEYS)
        ):
            vehicle_hits += 1
        if match_any(k, BASELINE_EMP_ID_KEYS) or match_any(k, BASELINE_COST_KEYS) or match_any(k, BASELINE_TIME_KEYS):
            baseline_hits += 1
        if k in ("key", "value") or "meta" in k:
            metadata_hits += 1
    return {
        "employee_hits": employee_hits,
        "vehicle_hits": vehicle_hits,
        "baseline_hits": baseline_hits,
        "metadata_hits": metadata_hits,
    }


def detect_table_type(table):
    rows = table.get("rows") or []
    sample = {}
    for r in rows:
        if isinstance(r, dict):
            sample = r
            break
    stats = table_header_stats(sample)
    name_hint = normalize_key(f"{table.get('artifactName') or ''}_{table.get('sheetName') or ''}")
    employee_score = stats["employee_hits"]
    vehicle_score = stats["vehicle_hits"]
    baseline_score = stats["baseline_hits"]
    metadata_score = stats["metadata_hits"]
    if "employee" in name_hint or "emp" in name_hint:
        employee_score += 3
    if "vehicle" in name_hint or "veh" in name_hint:
        vehicle_score += 3
    if "baseline" in name_hint or "base" in name_hint:
        baseline_score += 3
    if "meta" in name_hint:
        metadata_score += 3
    scores = [
        ("employees", employee_score),
        ("vehicles", vehicle_score),
        ("baseline", baseline_score),
        ("metadata", metadata_score),
    ]
    scores.sort(key=lambda x: x[1], reverse=True)
    top_type, top_score = scores[0]
    return top_type if top_score >= 2 else "unknown"


def parse_metadata(metadata_tables, text_artifacts):
    metadata = {
        "project_name": None,
        "date": None,
        "avg_speed_kmph": None,
        "distance_metric": "osrm",
        "objective_cost_weight": None,
        "objective_time_weight": None,
    }
    depot_lat = None
    depot_lng = None
    for table in metadata_tables:
        for row in table.get("rows") or []:
            if not isinstance(row, dict):
                continue
            key_raw = pick_value(row, [re.compile(r"^key$"), re.compile(r"^meta_key$")])
            if key_raw is None and row:
                key_raw = list(row.keys())[0]
            val_raw = pick_value(row, [re.compile(r"^value$"), re.compile(r"^meta_value$")])
            if val_raw is None and row:
                vals = list(row.values())
                if len(vals) > 1:
                    val_raw = vals[1]
            key = normalize_key(key_raw)
            val = text_value(val_raw)
            if not key or not val:
                continue
            if "project" in key and "name" in key:
                metadata["project_name"] = val
            if key == "date" or "run_date" in key:
                metadata["date"] = val
            if "avg_speed" in key or key == "speed_kmph":
                metadata["avg_speed_kmph"] = parse_number(val)
            if "distance_metric" in key:
                metadata["distance_metric"] = val
            if (("objective" in key and "cost" in key and "weight" in key) or key == "cost_weight"):
                metadata["objective_cost_weight"] = parse_number(val)
            if (("objective" in key and "time" in key and "weight" in key) or key == "time_weight"):
                metadata["objective_time_weight"] = parse_number(val)
            if "depot" in key and "lat" in key:
                depot_lat = parse_number(val)
            if "depot" in key and ("lng" in key or "lon" in key):
                depot_lng = parse_number(val)
    for txt in text_artifacts:
        s = text_value(txt)
        if not s:
            continue
        if metadata["avg_speed_kmph"] is None:
            m = re.search(r"avg[_\s-]*speed[_\s-]*kmph\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)", s, flags=re.I)
            if m:
                metadata["avg_speed_kmph"] = parse_number(m.group(1))
        if metadata["project_name"] is None:
            m = re.search(r"project[_\s-]*name\s*[:=]\s*([^\n\r]+)", s, flags=re.I)
            if m:
                metadata["project_name"] = text_value(m.group(1))
        if metadata["objective_cost_weight"] is None:
            m = re.search(r"objective[_\s-]*cost[_\s-]*weight\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)", s, flags=re.I)
            if m:
                metadata["objective_cost_weight"] = parse_number(m.group(1))
        if metadata["objective_time_weight"] is None:
            m = re.search(r"objective[_\s-]*time[_\s-]*weight\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)", s, flags=re.I)
            if m:
                metadata["objective_time_weight"] = parse_number(m.group(1))
    return metadata, depot_lat, depot_lng


def parse_employees(employee_tables):
    out = []
    for table in employee_tables:
        for row in table.get("rows") or []:
            if not isinstance(row, dict):
                continue
            emp_id = text_value(pick_value(row, EMPLOYEE_ID_KEYS))
            pickup_lat = parse_number(pick_value(row, PICKUP_LAT_KEYS))
            pickup_lng = parse_number(pick_value(row, PICKUP_LNG_KEYS))
            drop_lat = parse_number(pick_value(row, DROPOFF_LAT_KEYS))
            drop_lng = parse_number(pick_value(row, DROPOFF_LNG_KEYS))
            has_content = bool(emp_id) or pickup_lat is not None or pickup_lng is not None or drop_lat is not None or drop_lng is not None
            if not has_content:
                continue
            out.append(
                {
                    "id": emp_id,
                    "name": text_value(pick_value(row, EMPLOYEE_NAME_KEYS)) or None,
                    "priority": text_value(pick_value(row, EMPLOYEE_PRIORITY_KEYS)) or None,
                    "pickup": {"lat": pickup_lat, "lng": pickup_lng, "address": None},
                    "dropoff": {"lat": drop_lat, "lng": drop_lng, "address": None},
                    "time_window": {
                        "start": parse_time_string(pick_value(row, EARLIEST_KEYS)),
                        "end": parse_time_string(pick_value(row, LATEST_KEYS)),
                    },
                    "vehicle_preference": text_value(pick_value(row, VEHICLE_PREF_KEYS)) or "",
                    "sharing_preference": text_value(pick_value(row, SHARING_PREF_KEYS)) or "",
                }
            )
    return assign_stable_ids(out, "EMP")


def parse_vehicles(vehicle_tables, default_speed):
    out = []
    for table in vehicle_tables:
        for row in table.get("rows") or []:
            if not isinstance(row, dict):
                continue
            veh_id = text_value(pick_value(row, VEHICLE_ID_KEYS))
            start_lat = parse_number(pick_value(row, VEHICLE_START_LAT_KEYS))
            start_lng = parse_number(pick_value(row, VEHICLE_START_LNG_KEYS))
            has_content = bool(veh_id) or start_lat is not None or start_lng is not None or pick_value(row, VEHICLE_CAPACITY_KEYS) is not None
            if not has_content:
                continue
            speed = parse_number(pick_value(row, VEHICLE_SPEED_KEYS))
            out.append(
                {
                    "id": veh_id,
                    "mode": text_value(pick_value(row, VEHICLE_MODE_KEYS)) or text_value(pick_value(row, VEHICLE_FUEL_KEYS)) or "normal",
                    "category": text_value(pick_value(row, VEHICLE_CATEGORY_KEYS)) or "normal",
                    "capacity": parse_number(pick_value(row, VEHICLE_CAPACITY_KEYS)),
                    "cost_per_km": parse_number(pick_value(row, VEHICLE_COST_KEYS)),
                    "avg_speed_kmph": speed if speed is not None else default_speed,
                    "start_location": {"lat": start_lat, "lng": start_lng, "address": None},
                    "available_time": parse_time_string(pick_value(row, VEHICLE_AVAILABLE_KEYS)),
                }
            )
    return assign_stable_ids(out, "VEH")


def parse_baseline(baseline_tables):
    baseline = {}
    for table in baseline_tables:
        for row in table.get("rows") or []:
            if not isinstance(row, dict):
                continue
            emp_id = text_value(pick_value(row, BASELINE_EMP_ID_KEYS))
            if not emp_id:
                continue
            baseline[emp_id] = {
                "cost": parse_number(pick_value(row, BASELINE_COST_KEYS)) or 0,
                "time": parse_number(pick_value(row, BASELINE_TIME_KEYS)) or 0,
            }
    return baseline


def is_invalid_coord(lat, lng):
    if lat is None or lng is None:
        return False
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        return True
    return lat < -90 or lat > 90 or lng < -180 or lng > 180


def build_missing_required(canonical):
    missing = []

    def add_missing(k):
        if k not in missing and len(missing) < 80:
            missing.append(k)

    employees = canonical.get("employees") or []
    vehicles = canonical.get("vehicles") or []

    if not employees:
        add_missing("employees")
    if not vehicles:
        add_missing("vehicles")

    for i, e in enumerate(employees):
        if not e.get("id"):
            add_missing(f"employees[{i}].id")
        if e.get("pickup", {}).get("lat") is None:
            add_missing(f"employees[{i}].pickup.lat")
        if e.get("pickup", {}).get("lng") is None:
            add_missing(f"employees[{i}].pickup.lng")
        if e.get("dropoff", {}).get("lat") is None:
            add_missing(f"employees[{i}].dropoff.lat")
        if e.get("dropoff", {}).get("lng") is None:
            add_missing(f"employees[{i}].dropoff.lng")

    for i, v in enumerate(vehicles):
        if not v.get("id"):
            add_missing(f"vehicles[{i}].id")
        if v.get("capacity") is None:
            add_missing(f"vehicles[{i}].capacity")
        if v.get("cost_per_km") is None:
            add_missing(f"vehicles[{i}].cost_per_km")
        if v.get("start_location", {}).get("lat") is None:
            add_missing(f"vehicles[{i}].start_location.lat")
        if v.get("start_location", {}).get("lng") is None:
            add_missing(f"vehicles[{i}].start_location.lng")
    return missing


def build_sanity_checks(canonical):
    employees = canonical.get("employees") or []
    vehicles = canonical.get("vehicles") or []

    emp_ids = [e.get("id") for e in employees if e.get("id")]
    veh_ids = [v.get("id") for v in vehicles if v.get("id")]
    dup_emp = max(0, len(emp_ids) - len(set(emp_ids)))
    dup_veh = max(0, len(veh_ids) - len(set(veh_ids)))

    invalid_emp_coords = sum(
        1
        for e in employees
        if is_invalid_coord(e.get("pickup", {}).get("lat"), e.get("pickup", {}).get("lng"))
        or is_invalid_coord(e.get("dropoff", {}).get("lat"), e.get("dropoff", {}).get("lng"))
    )
    invalid_veh_coords = sum(
        1
        for v in vehicles
        if is_invalid_coord(v.get("start_location", {}).get("lat"), v.get("start_location", {}).get("lng"))
    )

    invalid_tw = 0
    for e in employees:
        start = (e.get("time_window") or {}).get("start")
        end = (e.get("time_window") or {}).get("end")
        if start and end and start >= end:
            invalid_tw += 1

    missing_capacity = 0
    for v in vehicles:
        cap = v.get("capacity")
        if not isinstance(cap, (int, float)) or cap <= 0:
            missing_capacity += 1

    return {
        "invalid_coordinates": invalid_emp_coords + invalid_veh_coords,
        "duplicate_ids": dup_emp + dup_veh,
        "invalid_time_windows": invalid_tw,
        "missing_capacity": missing_capacity,
        "notes": [],
    }


def compute_confidence(canonical, missing_required):
    e = canonical.get("employees") or []
    v = canonical.get("vehicles") or []
    if not e and not v:
        return 0.0
    total_slots = (len(e) * 5) + (len(v) * 5) + 4
    score = 1 - (len(missing_required) / max(1, total_slots))
    score = max(0.15, min(1.0, score))
    return round(score, 3)


def parse_payload(payload):
    tables = payload.get("tables") if isinstance(payload, dict) else []
    text_artifacts = payload.get("text_artifacts") if isinstance(payload, dict) else []
    if not isinstance(tables, list):
        tables = []
    if not isinstance(text_artifacts, list):
        text_artifacts = []

    if not tables:
        return {
            "status": "failed",
            "confidence": 0,
            "missing_required": ["artifacts(csv/xlsx)"],
            "assumptions": [],
            "warnings": ["No CSV/XLSX tables supplied to python RGX parser"],
            "sanity_checks": {
                "invalid_coordinates": 0,
                "duplicate_ids": 0,
                "invalid_time_windows": 0,
                "missing_capacity": 0,
                "notes": ["No tabular input"],
            },
            "canonical": None,
            "modelUsed": "python-rgx",
        }

    typed = []
    for t in tables:
        if not isinstance(t, dict):
            continue
        t2 = dict(t)
        t2["type"] = detect_table_type(t2)
        typed.append(t2)

    employee_tables = [t for t in typed if t.get("type") == "employees"]
    vehicle_tables = [t for t in typed if t.get("type") == "vehicles"]
    baseline_tables = [t for t in typed if t.get("type") == "baseline"]
    metadata_tables = [t for t in typed if t.get("type") == "metadata"]
    unknown_tables = [t for t in typed if t.get("type") == "unknown"]

    metadata, depot_lat, depot_lng = parse_metadata(metadata_tables, text_artifacts)
    employees = parse_employees(employee_tables)
    vehicles = parse_vehicles(vehicle_tables, metadata.get("avg_speed_kmph"))
    baseline = parse_baseline(baseline_tables)

    canonical = deepcopy(CANONICAL_TEMPLATE)
    canonical["metadata"] = {**canonical["metadata"], **metadata}
    canonical["employees"] = employees
    canonical["vehicles"] = vehicles
    canonical["baseline"] = baseline

    dlat = depot_lat
    dlng = depot_lng
    if dlat is None or dlng is None:
        for e in employees:
            drop = e.get("dropoff") or {}
            if drop.get("lat") is not None and drop.get("lng") is not None:
                dlat = drop.get("lat")
                dlng = drop.get("lng")
                break
    if (dlat is None or dlng is None) and vehicles:
        for v in vehicles:
            s = v.get("start_location") or {}
            if s.get("lat") is not None and s.get("lng") is not None:
                dlat = s.get("lat")
                dlng = s.get("lng")
                break
    canonical["depot"]["lat"] = dlat
    canonical["depot"]["lng"] = dlng

    missing_required = build_missing_required(canonical)
    sanity_checks = build_sanity_checks(canonical)
    warnings = []
    if unknown_tables:
        details = []
        for t in unknown_tables:
            details.append(f"{text_value(t.get('artifactName'))}/{text_value(t.get('sheetName'))}")
        warnings.append(f"Unclassified sheets ignored: {', '.join(details)}")
    if not employee_tables:
        warnings.append("No employee table detected")
    if not vehicle_tables:
        warnings.append("No vehicle table detected")

    has_data = bool(canonical["employees"]) or bool(canonical["vehicles"])
    status = "failed" if not has_data else ("needs_review" if missing_required else "success")
    confidence = compute_confidence(canonical, missing_required)

    return {
        "status": status,
        "confidence": confidence,
        "missing_required": missing_required,
        "assumptions": [
            "Parsed from CSV/XLSX tabular rows using Python regex mapping",
            "Unknown columns were ignored",
        ],
        "warnings": warnings,
        "sanity_checks": sanity_checks,
        "canonical": canonical if has_data else None,
        "modelUsed": "python-rgx",
    }


def main():
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""
    raw = (raw or "").strip()
    payload = {}
    if raw:
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {}
    result = parse_payload(payload)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
