import csv
from typing import Dict, Any, Optional
from models import Employee, Vehicle, Baseline, ProblemInstance, Location

try:
    import pandas as pd  # Optional dependency in production runtime
except Exception:
    pd = None

class FileParser:
    def __init__(self, emp_file: str, veh_file: str, meta_file: str, base_file: str):
        self.emp_file = emp_file
        self.veh_file = veh_file
        self.meta_file = meta_file
        self.base_file = base_file

    def _parse_time(self, time_str: str) -> int:
        if time_str is None:
            return 0
        if pd is not None:
            try:
                if pd.isna(time_str):
                    return 0
            except Exception:
                pass
        time_str = str(time_str).strip()
        if not time_str or time_str.lower() in ("nan", "nat", "none", "null"):
            return 0
        try:
            parts = list(map(int, time_str.split(':')))
            if len(parts) == 3:
                h, m, s = parts
            elif len(parts) == 2:
                h, m = parts
                s = 0
            else:
                return 0
            return int(h * 60 + m + (s / 60))
        except:
            return 0 

    def _read_csv_rows(self, file_path: str):
        """
        Read CSV rows with or without pandas.
        Returns list[dict] with stripped column names.
        """
        if pd is not None:
            df = pd.read_csv(file_path)
            df.columns = [str(c).strip() for c in df.columns]
            return [dict(row) for _, row in df.iterrows()]

        rows = []
        with open(file_path, 'r', newline='', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            if not reader.fieldnames:
                return rows
            reader.fieldnames = [str(c).strip() for c in reader.fieldnames]
            for row in reader:
                clean = {}
                for k, v in row.items():
                    key = str(k).strip() if k is not None else ""
                    clean[key] = v
                rows.append(clean)
        return rows

    def _duplicate_id_counts(self, rows, key_name: str):
        counts = {}
        for row in rows or []:
            row_id = str((row or {}).get(key_name) or "").strip()
            if not row_id:
                continue
            counts[row_id] = counts.get(row_id, 0) + 1
        return counts

    def _normalize_duplicate_id(self, raw_id: str, counts, seen):
        original_id = str(raw_id or "").strip()
        if not original_id:
            return "", "", ""
        occurrence = int(seen.get(original_id, 0)) + 1
        seen[original_id] = occurrence
        if int(counts.get(original_id, 0)) <= 1:
            return original_id, original_id, original_id
        return f"{original_id}__dup{occurrence}", original_id, f"{original_id} #{occurrence}"

    def load_data(self) -> ProblemInstance:
        print(f"Loading data from: {self.emp_file}, {self.veh_file}...")

        meta_rows = self._read_csv_rows(self.meta_file)
        metadata = {}
        for row in meta_rows:
            k = str(row.get('key', '')).strip()
            v = row.get('value', '')
            if k:
                metadata[k] = v

        emp_rows = self._read_csv_rows(self.emp_file)
        emp_duplicate_counts = self._duplicate_id_counts(emp_rows, 'employee_id')
        emp_seen = {}
        employee_groups = {}
        employee_id_map = {}
        employee_display_map = {}
        employees = []
        for row in emp_rows:
            normalized_emp_id, original_emp_id, display_emp_id = self._normalize_duplicate_id(
                row.get('employee_id'),
                emp_duplicate_counts,
                emp_seen,
            )
            employee_groups.setdefault(original_emp_id, []).append(normalized_emp_id)
            employee_id_map[normalized_emp_id] = original_emp_id
            employee_display_map[normalized_emp_id] = display_emp_id
            emp = Employee(
                id=normalized_emp_id,
                priority=int(row['priority']),
                pickup_loc=Location(float(row['pickup_lat']), float(row['pickup_lng'])),
                drop_loc=Location(float(row['drop_lat']), float(row['drop_lng'])),
                earliest_pickup=self._parse_time(row['earliest_pickup']),
                latest_drop=self._parse_time(row['latest_drop']),
                vehicle_pref=str(row['vehicle_preference']).strip().lower(),
                sharing_pref=str(row['sharing_preference']).strip().lower(),
                original_id=original_emp_id,
                display_id=display_emp_id,
            )
            employees.append(emp)

        veh_rows = self._read_csv_rows(self.veh_file)
        veh_duplicate_counts = self._duplicate_id_counts(veh_rows, 'vehicle_id')
        veh_seen = {}
        vehicle_id_map = {}
        vehicle_display_map = {}
        vehicles = []
        for row in veh_rows:
            normalized_veh_id, original_veh_id, display_veh_id = self._normalize_duplicate_id(
                row.get('vehicle_id'),
                veh_duplicate_counts,
                veh_seen,
            )
            vehicle_id_map[normalized_veh_id] = original_veh_id
            vehicle_display_map[normalized_veh_id] = display_veh_id
            veh = Vehicle(
                id=normalized_veh_id,
                fuel_type=str(row['fuel_type']),
                capacity=int(row['capacity']),
                cost_per_km=float(row['cost_per_km']),
                speed_kmph=float(row['avg_speed_kmph']),
                start_loc=Location(float(row['current_lat']), float(row['current_lng'])),
                avail_from=self._parse_time(row['available_from']),
                category=str(row['category']).strip().lower(),
                original_id=original_veh_id,
                display_id=display_veh_id,
            )
            vehicles.append(veh)

        base_rows = self._read_csv_rows(self.base_file)
        baseline = {}
        for row in base_rows:
            source_emp_id = str(row['employee_id']).strip()
            for emp_id in employee_groups.get(source_emp_id, [source_emp_id]):
                baseline[emp_id] = Baseline(
                    emp_id=emp_id,
                    cost=float(row['baseline_cost']),
                    time=float(row['baseline_time_min'])
                )

        metadata["normalized_employee_id_map"] = employee_id_map
        metadata["normalized_employee_display_map"] = employee_display_map
        metadata["normalized_vehicle_id_map"] = vehicle_id_map
        metadata["normalized_vehicle_display_map"] = vehicle_display_map

        return ProblemInstance(employees, vehicles, metadata, baseline)


class JsonParser:
    """
    Converts the canonical JSON produced by the LLM parser into a ProblemInstance.

    Expected canonical JSON shape (from your llmParser + canonicalSchema):
      {
        "schema_version": "...",
        "problem_type": "...",
        "metadata": { ... },
        "depot": { lat, lng, ... },
        "employees": [
          { "id": "...", "pickup": {lat,lng}, "dropoff": {lat,lng}, "time_window": {...}, "priority": ... }
        ],
        "vehicles": [
          { "id": "...", "capacity": ..., "cost_per_km": ..., "start_location": {lat,lng}, "available_time": ... }
        ],
        "baseline": { ... } OR baseline list-like, we handle both
      }
    """

    def __init__(self):
        # reuse FileParser's robust time parsing
        self._fp = FileParser("", "", "", "")

    def _duplicate_id_counts(self, rows):
        counts: Dict[str, int] = {}
        for row in rows or []:
            row_id = str((row or {}).get("id") or "").strip()
            if not row_id:
                continue
            counts[row_id] = counts.get(row_id, 0) + 1
        return counts

    def _normalize_duplicate_id(self, raw_id: str, counts: Dict[str, int], seen: Dict[str, int]):
        original_id = str(raw_id or "").strip()
        if not original_id:
            return "", "", ""

        occurrence = int(seen.get(original_id, 0)) + 1
        seen[original_id] = occurrence
        duplicate_total = int(counts.get(original_id, 0))
        if duplicate_total <= 1:
            return original_id, original_id, original_id

        normalized_id = f"{original_id}__dup{occurrence}"
        display_id = f"{original_id} #{occurrence}"
        return normalized_id, original_id, display_id

    def _to_float(self, x: Any, default: float = 0.0) -> float:
        try:
            if x is None: 
                return default
            return float(x)
        except:
            return default

    def _to_int(self, x: Any, default: int = 0) -> int:
        try:
            if x is None:
                return default
            return int(float(x))
        except:
            return default

    def _priority(self, p: Any) -> int:
        """
        Normalize priority for the engine.
        Convention:
          1 = Highest ... 5 = Lowest
        If numeric is outside range, clamp into {1..5}.
        """
        if p is None:
            return 2

        # numeric priorities
        if isinstance(p, (int, float)):
            v = int(p)
            if v <= 1:
                return 1
            if v >= 5:
                return 5
            return v

        # string priorities
        s = str(p).strip().lower()
        if s == "high":
            return 1
        if s == "medium":
            return 2
        if s == "low":
            return 3

        # fallback numeric parse
        try:
            v = int(float(s))
            if v <= 1:
                return 1
            if v >= 5:
                return 5
            return v
        except Exception:
            return 2

    def load_from_canonical(self, canonical: Dict[str, Any]) -> ProblemInstance:
        meta = dict(canonical.get("metadata") or {})
        employee_duplicate_counts = self._duplicate_id_counts(canonical.get("employees") or [])
        vehicle_duplicate_counts = self._duplicate_id_counts(canonical.get("vehicles") or [])
        employee_seen: Dict[str, int] = {}
        vehicle_seen: Dict[str, int] = {}
        employee_id_map: Dict[str, str] = {}
        employee_display_map: Dict[str, str] = {}
        employee_groups: Dict[str, list] = {}
        vehicle_id_map: Dict[str, str] = {}
        vehicle_display_map: Dict[str, str] = {}

        # employees
        employees = []
        for row in (canonical.get("employees") or []):
            raw_emp_id = str(row.get("id") or "").strip()
            normalized_emp_id, original_emp_id, display_emp_id = self._normalize_duplicate_id(
                raw_emp_id,
                employee_duplicate_counts,
                employee_seen,
            )
            if not normalized_emp_id:
                continue
            employee_id_map[normalized_emp_id] = original_emp_id
            employee_display_map[normalized_emp_id] = display_emp_id
            employee_groups.setdefault(original_emp_id, []).append(normalized_emp_id)

            pickup = row.get("pickup") or {}
            dropoff = row.get("dropoff") or {}

            # If your LLM schema allows nulls, Node should block run when missing.
            # Here we default to 0.0 to avoid crashing if something slips through.
            pickup_loc = Location(
                self._to_float(pickup.get("lat"), 0.0),
                self._to_float(pickup.get("lng"), 0.0),
            )
            drop_loc = Location(
                self._to_float(dropoff.get("lat"), 0.0),
                self._to_float(dropoff.get("lng"), 0.0),
            )

            # Time windows can come as:
            #  (a) time_window: { start, end }
            #  (b) earliest_pickup / latest_drop
            tw = row.get("time_window") or {}
            start_str = tw.get("start") if isinstance(tw, dict) else None
            end_str   = tw.get("end") if isinstance(tw, dict) else None

            if not start_str:
                start_str = row.get("earliest_pickup") or row.get("earliestPickup")
            if not end_str:
                end_str = row.get("latest_drop") or row.get("latestDrop")

            earliest = self._fp._parse_time(start_str) if start_str else 0
            latest   = self._fp._parse_time(end_str) if end_str else 0

            # vehicle/sharing preferences are optional; keep blank if missing
            vehicle_pref = (row.get("vehicle_preference") or row.get("vehicle_pref") or "").strip().lower()
            sharing_pref = (row.get("sharing_preference") or row.get("sharing_pref") or "").strip().lower()

            employees.append(Employee(
                id=normalized_emp_id,
                priority=self._priority(row.get("priority")),
                pickup_loc=pickup_loc,
                drop_loc=drop_loc,
                earliest_pickup=earliest,
                latest_drop=latest,
                vehicle_pref=vehicle_pref,
                sharing_pref=sharing_pref,
                original_id=original_emp_id,
                display_id=display_emp_id,
            ))

        # vehicles
        vehicles = []
        default_speed = self._to_float(meta.get("avg_speed_kmph"), 25.0)

        for row in (canonical.get("vehicles") or []):
            raw_veh_id = str(row.get("id") or "").strip()
            normalized_veh_id, original_veh_id, display_veh_id = self._normalize_duplicate_id(
                raw_veh_id,
                vehicle_duplicate_counts,
                vehicle_seen,
            )
            if not normalized_veh_id:
                continue
            vehicle_id_map[normalized_veh_id] = original_veh_id
            vehicle_display_map[normalized_veh_id] = display_veh_id

            start_location = row.get("start_location") or {}
            start_loc = Location(
                self._to_float(start_location.get("lat"), 0.0),
                self._to_float(start_location.get("lng"), 0.0)
            )

            speed = row.get("avg_speed_kmph")
            speed_kmph = self._to_float(speed, default_speed)

            avail_str = row.get("available_time") or row.get("available_from") or row.get("avail_from")
            avail_from = self._fp._parse_time(avail_str) if avail_str else 0

            vehicles.append(Vehicle(
                id=normalized_veh_id,
                fuel_type=str(row.get("fuel_type") or "petrol"),
                capacity=self._to_int(row.get("capacity"), 0),
                cost_per_km=self._to_float(row.get("cost_per_km"), 0.0),
                speed_kmph=speed_kmph,
                start_loc=start_loc,
                avail_from=avail_from,
                # Constraint semantics depend on explicit vehicle category only.
                category=str(row.get("category") or "normal").strip().lower(),
                original_id=original_veh_id,
                display_id=display_veh_id,
            ))

        # baseline
        baseline_raw = canonical.get("baseline") or {}
        baseline: Dict[str, Baseline] = {}

        # baseline may be dict keyed by emp_id
        if isinstance(baseline_raw, dict):
            for emp_id, b in baseline_raw.items():
                if b is None:
                    continue
                source_emp_id = str(emp_id).strip()
                cost = self._to_float(
                    b.get("cost") or b.get("baseline_cost"), 0.0
                ) if isinstance(b, dict) else 0.0
                time = self._to_float(
                    b.get("time") or b.get("baseline_time_min") or b.get("baseline_time"), 0.0
                ) if isinstance(b, dict) else 0.0
                for normalized_emp_id in employee_groups.get(source_emp_id, [source_emp_id]):
                    baseline[str(normalized_emp_id)] = Baseline(
                        emp_id=str(normalized_emp_id),
                        cost=cost,
                        time=time,
                    )

        # or baseline may be list of entries
        if isinstance(baseline_raw, list):
            for b in baseline_raw:
                if not isinstance(b, dict):
                    continue
                emp_id = str(b.get("employee_id") or b.get("emp_id") or "").strip()
                if not emp_id:
                    continue
                cost = self._to_float(b.get("baseline_cost") or b.get("cost"), 0.0)
                time = self._to_float(b.get("baseline_time_min") or b.get("time"), 0.0)
                for normalized_emp_id in employee_groups.get(emp_id, [emp_id]):
                    baseline[normalized_emp_id] = Baseline(
                        emp_id=normalized_emp_id,
                        cost=cost,
                        time=time,
                    )

        meta["normalized_employee_id_map"] = employee_id_map
        meta["normalized_employee_display_map"] = employee_display_map
        meta["normalized_vehicle_id_map"] = vehicle_id_map
        meta["normalized_vehicle_display_map"] = vehicle_display_map

        return ProblemInstance(employees, vehicles, meta, baseline)
