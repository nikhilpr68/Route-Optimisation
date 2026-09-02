const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const CANONICAL_TEMPLATE = {
  schema_version: '1.0',
  problem_type: 'employee_transport_many_to_one',
  metadata: { project_name: null, date: null, avg_speed_kmph: null, distance_metric: 'osrm' },
  depot: { lat: null, lng: null, name: 'Office' },
  employees: [],
  vehicles: [],
  baseline: {}
};

function isExcel(mime = '', name = '') {
  return (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel' ||
    /\.(xlsx|xls)$/i.test(name)
  );
}

function isCsv(mime = '', name = '') {
  return mime === 'text/csv' || /\.csv$/i.test(name);
}

function isTabularArtifact(artifact) {
  if (!artifact || artifact.kind !== 'file') return false;
  return isExcel(artifact.mimeType || '', artifact.originalName || '') || isCsv(artifact.mimeType || '', artifact.originalName || '');
}

function normalizeKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && !v.trim()) return true;
  return false;
}

function textValue(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim().replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseTimeString(v) {
  if (v === null || v === undefined || v === '') return null;

  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v >= 0 && v < 1) {
      const totalMinutes = Math.round(v * 24 * 60);
      const hh = Math.floor(totalMinutes / 60) % 24;
      const mm = totalMinutes % 60;
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
    const rounded = Math.round(v);
    if (rounded >= 0 && rounded < 24 * 60) {
      const hh = Math.floor(rounded / 60);
      const mm = rounded % 60;
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
  }

  const s = String(v).trim();
  if (!s) return null;

  const hms = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (hms) {
    const hh = Number(hms[1]);
    const mm = Number(hms[2]);
    if (Number.isFinite(hh) && Number.isFinite(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
  }
  return null;
}

function matchesAny(normalizedKey, regexList) {
  return regexList.some((re) => re.test(normalizedKey));
}

function pickValue(row, regexList) {
  if (!row || typeof row !== 'object') return null;
  for (const [rawKey, value] of Object.entries(row)) {
    const nk = normalizeKey(rawKey);
    if (matchesAny(nk, regexList) && !isBlank(value)) return value;
  }
  return null;
}

function firstNonNull(values) {
  for (const v of values) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

const EMPLOYEE_ID_KEYS = [/^employee_id$/, /^emp_id$/, /^employee$/, /^emp$/, /^id$/];
const EMPLOYEE_NAME_KEYS = [/^employee_name$/, /^name$/, /^full_name$/];
const EMPLOYEE_PRIORITY_KEYS = [/^priority$/, /^priority_level$/, /^tier$/];
const PICKUP_LAT_KEYS = [/pickup.*lat/, /source.*lat/, /from.*lat/, /^pickup_lat$/, /^pickuplatitude$/];
const PICKUP_LNG_KEYS = [/pickup.*(lng|lon|longitude)/, /source.*(lng|lon|longitude)/, /from.*(lng|lon|longitude)/, /^pickup_lng$/, /^pickuplon$/];
const DROPOFF_LAT_KEYS = [/drop.*lat/, /dropoff.*lat/, /office.*lat/, /destination.*lat/, /to.*lat/];
const DROPOFF_LNG_KEYS = [/drop.*(lng|lon|longitude)/, /dropoff.*(lng|lon|longitude)/, /office.*(lng|lon|longitude)/, /destination.*(lng|lon|longitude)/, /to.*(lng|lon|longitude)/];
const EARLIEST_KEYS = [/earliest.*pick/, /pickup.*start/, /^start_time$/, /window.*start/, /time_from/];
const LATEST_KEYS = [/latest.*drop/, /drop.*end/, /^end_time$/, /window.*end/, /time_to/];
const VEHICLE_PREF_KEYS = [/vehicle.*pref/, /vehicle_preference/, /preferred_vehicle/, /vehicle_type_pref/];
const SHARING_PREF_KEYS = [/sharing.*pref/, /sharing_preference/, /share_pref/, /ride_share/];

const VEHICLE_ID_KEYS = [/^vehicle_id$/, /^veh_id$/, /^vehicle$/, /^veh$/, /^id$/];
const VEHICLE_CAPACITY_KEYS = [/^capacity$/, /vehicle_capacity/, /seats?/];
const VEHICLE_COST_KEYS = [/cost.*(km|kilometer)/, /^cost_per_km$/, /fare.*km/];
const VEHICLE_SPEED_KEYS = [/avg.*speed/, /^speed$/, /kmph/, /kph/];
const VEHICLE_START_LAT_KEYS = [/current.*lat/, /start.*lat/, /depot.*lat/, /origin.*lat/, /^lat$/];
const VEHICLE_START_LNG_KEYS = [/current.*(lng|lon|longitude)/, /start.*(lng|lon|longitude)/, /depot.*(lng|lon|longitude)/, /origin.*(lng|lon|longitude)/, /^(lng|lon|longitude)$/];
const VEHICLE_AVAILABLE_KEYS = [/available.*from/, /available.*time/, /^available_time$/, /^start_time$/, /^avail_from$/];
const VEHICLE_CATEGORY_KEYS = [/^category$/];
const VEHICLE_MODE_KEYS = [/^mode$/, /vehicle_type/];
const VEHICLE_FUEL_KEYS = [/fuel/];

const BASELINE_EMP_ID_KEYS = [/^employee_id$/, /^emp_id$/, /^employee$/, /^id$/];
const BASELINE_COST_KEYS = [/baseline.*cost/, /^cost$/];
const BASELINE_TIME_KEYS = [/baseline.*time/, /time.*min/, /^time$/];

function tableHeaderStats(row) {
  const keys = Object.keys(row || {}).map(normalizeKey).filter(Boolean);
  return {
    employeeHits: keys.filter((k) => (
      matchesAny(k, EMPLOYEE_ID_KEYS) ||
      matchesAny(k, PICKUP_LAT_KEYS) ||
      matchesAny(k, PICKUP_LNG_KEYS) ||
      matchesAny(k, DROPOFF_LAT_KEYS) ||
      matchesAny(k, DROPOFF_LNG_KEYS)
    )).length,
    vehicleHits: keys.filter((k) => (
      matchesAny(k, VEHICLE_ID_KEYS) ||
      matchesAny(k, VEHICLE_CAPACITY_KEYS) ||
      matchesAny(k, VEHICLE_COST_KEYS) ||
      matchesAny(k, VEHICLE_START_LAT_KEYS) ||
      matchesAny(k, VEHICLE_START_LNG_KEYS)
    )).length,
    baselineHits: keys.filter((k) => (
      matchesAny(k, BASELINE_EMP_ID_KEYS) ||
      matchesAny(k, BASELINE_COST_KEYS) ||
      matchesAny(k, BASELINE_TIME_KEYS)
    )).length,
    metadataHits: keys.filter((k) => k === 'key' || k === 'value' || k.includes('meta')).length
  };
}

function detectTableType(table) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const sample = rows.find((r) => r && typeof r === 'object') || {};
  const stats = tableHeaderStats(sample);
  const sheet = normalizeKey(table?.sheetName || '');

  let employeeScore = stats.employeeHits;
  let vehicleScore = stats.vehicleHits;
  let baselineScore = stats.baselineHits;
  let metadataScore = stats.metadataHits;

  if (sheet.includes('employee') || sheet.includes('emp')) employeeScore += 3;
  if (sheet.includes('vehicle') || sheet.includes('veh')) vehicleScore += 3;
  if (sheet.includes('baseline') || sheet.includes('base')) baselineScore += 3;
  if (sheet.includes('meta')) metadataScore += 3;

  const scores = [
    ['employees', employeeScore],
    ['vehicles', vehicleScore],
    ['baseline', baselineScore],
    ['metadata', metadataScore]
  ].sort((a, b) => b[1] - a[1]);

  const [type, score] = scores[0];
  return score >= 2 ? type : 'unknown';
}

function rowsFromSheet(ws) {
  return xlsx.utils.sheet_to_json(ws, { defval: null, raw: false, blankrows: false });
}

function readArtifactTables(artifact) {
  const filePath = artifact.storagePath;
  if (!filePath || !fs.existsSync(filePath)) return [];

  const wb = xlsx.readFile(filePath, { cellDates: false });
  const tables = [];
  for (const sheetName of wb.SheetNames || []) {
    const ws = wb.Sheets[sheetName];
    const rows = rowsFromSheet(ws);
    if (!rows.length) continue;
    tables.push({
      artifactName: artifact.originalName || path.basename(filePath),
      sheetName,
      rows
    });
  }
  return tables;
}

function assignStableIds(items, prefix) {
  const used = new Set();
  let next = 1;
  return items.map((item) => {
    let id = textValue(item.id);
    if (!id) {
      while (used.has(`${prefix}${String(next).padStart(3, '0')}`)) next += 1;
      id = `${prefix}${String(next).padStart(3, '0')}`;
      next += 1;
    }
    if (used.has(id)) {
      let suffix = 2;
      let candidate = `${id}_${suffix}`;
      while (used.has(candidate)) {
        suffix += 1;
        candidate = `${id}_${suffix}`;
      }
      id = candidate;
    }
    used.add(id);
    return { ...item, id };
  });
}

function parseMetadataFromTables(metadataTables, textArtifacts) {
  const metadata = {
    project_name: null,
    date: null,
    avg_speed_kmph: null,
    distance_metric: 'osrm'
  };
  let depotLat = null;
  let depotLng = null;

  for (const table of metadataTables) {
    for (const row of table.rows) {
      const keyRaw = firstNonNull([
        pickValue(row, [/^key$/]),
        pickValue(row, [/^meta_key$/]),
        Object.keys(row || {})[0] || null
      ]);
      const valRaw = firstNonNull([
        pickValue(row, [/^value$/]),
        pickValue(row, [/^meta_value$/]),
        Object.values(row || [])[1] || null
      ]);

      const key = normalizeKey(keyRaw);
      const value = textValue(valRaw);
      if (!key || !value) continue;

      if (key.includes('project') && key.includes('name')) metadata.project_name = value;
      if (key === 'date' || key.includes('run_date')) metadata.date = value;
      if (key.includes('avg_speed') || key === 'speed_kmph') metadata.avg_speed_kmph = parseNumber(value);
      if (key.includes('distance_metric')) metadata.distance_metric = value;
      if (key.includes('depot') && key.includes('lat')) depotLat = parseNumber(value);
      if (key.includes('depot') && (key.includes('lng') || key.includes('lon'))) depotLng = parseNumber(value);
    }
  }

  for (const txt of textArtifacts) {
    const s = textValue(txt);
    if (!s) continue;
    if (metadata.avg_speed_kmph === null) {
      const m = s.match(/avg[_\s-]*speed[_\s-]*kmph\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (m) metadata.avg_speed_kmph = parseNumber(m[1]);
    }
    if (!metadata.project_name) {
      const m = s.match(/project[_\s-]*name\s*[:=]\s*([^\n\r]+)/i);
      if (m) metadata.project_name = textValue(m[1]);
    }
  }

  return { metadata, depotLat, depotLng };
}

function parseEmployees(employeeTables) {
  const out = [];
  for (const table of employeeTables) {
    for (const row of table.rows) {
      if (!row || typeof row !== 'object') continue;
      const id = textValue(pickValue(row, EMPLOYEE_ID_KEYS));
      const pickupLat = parseNumber(pickValue(row, PICKUP_LAT_KEYS));
      const pickupLng = parseNumber(pickValue(row, PICKUP_LNG_KEYS));
      const dropLat = parseNumber(pickValue(row, DROPOFF_LAT_KEYS));
      const dropLng = parseNumber(pickValue(row, DROPOFF_LNG_KEYS));
      const hasContent = id || pickupLat !== null || pickupLng !== null || dropLat !== null || dropLng !== null;
      if (!hasContent) continue;

      out.push({
        id,
        name: textValue(pickValue(row, EMPLOYEE_NAME_KEYS)) || null,
        priority: textValue(pickValue(row, EMPLOYEE_PRIORITY_KEYS)) || null,
        pickup: { lat: pickupLat, lng: pickupLng, address: null },
        dropoff: { lat: dropLat, lng: dropLng, address: null },
        time_window: {
          start: parseTimeString(pickValue(row, EARLIEST_KEYS)),
          end: parseTimeString(pickValue(row, LATEST_KEYS))
        },
        vehicle_preference: textValue(pickValue(row, VEHICLE_PREF_KEYS)) || '',
        sharing_preference: textValue(pickValue(row, SHARING_PREF_KEYS)) || ''
      });
    }
  }
  return assignStableIds(out, 'EMP');
}

function parseVehicles(vehicleTables, defaultSpeedKmph) {
  const out = [];
  for (const table of vehicleTables) {
    for (const row of table.rows) {
      if (!row || typeof row !== 'object') continue;
      const id = textValue(pickValue(row, VEHICLE_ID_KEYS));
      const startLat = parseNumber(pickValue(row, VEHICLE_START_LAT_KEYS));
      const startLng = parseNumber(pickValue(row, VEHICLE_START_LNG_KEYS));
      const hasContent = id || startLat !== null || startLng !== null || pickValue(row, VEHICLE_CAPACITY_KEYS) !== null;
      if (!hasContent) continue;

      const speedCandidate = parseNumber(pickValue(row, VEHICLE_SPEED_KEYS));
      out.push({
        id,
        mode: textValue(pickValue(row, VEHICLE_MODE_KEYS)) || textValue(pickValue(row, VEHICLE_FUEL_KEYS)) || 'normal',
        category: textValue(pickValue(row, VEHICLE_CATEGORY_KEYS)) || 'normal',
        capacity: parseNumber(pickValue(row, VEHICLE_CAPACITY_KEYS)),
        cost_per_km: parseNumber(pickValue(row, VEHICLE_COST_KEYS)),
        avg_speed_kmph: speedCandidate !== null ? speedCandidate : defaultSpeedKmph,
        start_location: { lat: startLat, lng: startLng, address: null },
        available_time: parseTimeString(pickValue(row, VEHICLE_AVAILABLE_KEYS))
      });
    }
  }
  return assignStableIds(out, 'VEH');
}

function parseBaseline(baselineTables) {
  const baseline = {};
  for (const table of baselineTables) {
    for (const row of table.rows) {
      const empIdRaw = pickValue(row, BASELINE_EMP_ID_KEYS);
      const empId = textValue(empIdRaw);
      if (!empId) continue;
      baseline[empId] = {
        cost: parseNumber(pickValue(row, BASELINE_COST_KEYS)) ?? 0,
        time: parseNumber(pickValue(row, BASELINE_TIME_KEYS)) ?? 0
      };
    }
  }
  return baseline;
}

function isInvalidCoord(lat, lng) {
  if (lat === null || lng === null) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
  return lat < -90 || lat > 90 || lng < -180 || lng > 180;
}

function buildMissingRequired(canonical) {
  const missing = [];
  const addMissing = (key) => {
    if (!missing.includes(key) && missing.length < 80) missing.push(key);
  };

  if (!Array.isArray(canonical.employees) || !canonical.employees.length) addMissing('employees');
  if (!Array.isArray(canonical.vehicles) || !canonical.vehicles.length) addMissing('vehicles');

  (canonical.employees || []).forEach((e, idx) => {
    if (!e.id) addMissing(`employees[${idx}].id`);
    if (e.pickup?.lat === null) addMissing(`employees[${idx}].pickup.lat`);
    if (e.pickup?.lng === null) addMissing(`employees[${idx}].pickup.lng`);
    if (e.dropoff?.lat === null) addMissing(`employees[${idx}].dropoff.lat`);
    if (e.dropoff?.lng === null) addMissing(`employees[${idx}].dropoff.lng`);
  });

  (canonical.vehicles || []).forEach((v, idx) => {
    if (!v.id) addMissing(`vehicles[${idx}].id`);
    if (v.capacity === null) addMissing(`vehicles[${idx}].capacity`);
    if (v.cost_per_km === null) addMissing(`vehicles[${idx}].cost_per_km`);
    if (v.start_location?.lat === null) addMissing(`vehicles[${idx}].start_location.lat`);
    if (v.start_location?.lng === null) addMissing(`vehicles[${idx}].start_location.lng`);
  });

  return missing;
}

function buildSanityChecks(canonical) {
  const empIds = (canonical.employees || []).map((e) => e.id).filter(Boolean);
  const vehIds = (canonical.vehicles || []).map((v) => v.id).filter(Boolean);
  const dupEmp = Math.max(0, empIds.length - new Set(empIds).size);
  const dupVeh = Math.max(0, vehIds.length - new Set(vehIds).size);
  const invalidEmployeeCoords = (canonical.employees || []).filter((e) => (
    isInvalidCoord(e.pickup?.lat, e.pickup?.lng) || isInvalidCoord(e.dropoff?.lat, e.dropoff?.lng)
  )).length;
  const invalidVehicleCoords = (canonical.vehicles || []).filter((v) => (
    isInvalidCoord(v.start_location?.lat, v.start_location?.lng)
  )).length;
  const invalidTimeWindows = (canonical.employees || []).filter((e) => {
    if (!e.time_window?.start || !e.time_window?.end) return false;
    return e.time_window.start >= e.time_window.end;
  }).length;
  const missingCapacity = (canonical.vehicles || []).filter((v) => (
    !Number.isFinite(v.capacity) || Number(v.capacity) <= 0
  )).length;

  return {
    invalid_coordinates: invalidEmployeeCoords + invalidVehicleCoords,
    duplicate_ids: dupEmp + dupVeh,
    invalid_time_windows: invalidTimeWindows,
    missing_capacity: missingCapacity,
    notes: []
  };
}

function computeConfidence(canonical, missingRequired) {
  const e = canonical.employees || [];
  const v = canonical.vehicles || [];
  if (!e.length && !v.length) return 0;
  const totalSlots = (e.length * 5) + (v.length * 5) + 4;
  const missingPenalty = missingRequired.length;
  const score = Math.max(0.15, 1 - (missingPenalty / Math.max(1, totalSlots)));
  return Number(score.toFixed(3));
}

async function parseWithRgx({ artifacts }) {
  const tabularArtifacts = (Array.isArray(artifacts) ? artifacts : []).filter(isTabularArtifact);
  const textArtifacts = (Array.isArray(artifacts) ? artifacts : [])
    .filter((a) => a?.kind === 'text')
    .map((a) => a?.text || '');

  if (!tabularArtifacts.length) {
    return {
      status: 'failed',
      confidence: 0,
      missing_required: ['artifacts(csv/xlsx)'],
      assumptions: [],
      warnings: ['RGX parser supports CSV/XLSX artifacts only'],
      sanity_checks: {
        invalid_coordinates: 0,
        duplicate_ids: 0,
        invalid_time_windows: 0,
        missing_capacity: 0,
        notes: ['No tabular artifacts found']
      },
      canonical: null,
      modelUsed: 'rgx'
    };
  }

  const tables = tabularArtifacts.flatMap(readArtifactTables);
  const typed = tables.map((t) => ({ ...t, type: detectTableType(t) }));
  const employeeTables = typed.filter((t) => t.type === 'employees');
  const vehicleTables = typed.filter((t) => t.type === 'vehicles');
  const baselineTables = typed.filter((t) => t.type === 'baseline');
  const metadataTables = typed.filter((t) => t.type === 'metadata');
  const unknownTables = typed.filter((t) => t.type === 'unknown');

  const { metadata, depotLat, depotLng } = parseMetadataFromTables(metadataTables, textArtifacts);
  const employees = parseEmployees(employeeTables);
  const vehicles = parseVehicles(vehicleTables, metadata.avg_speed_kmph ?? null);
  const baseline = parseBaseline(baselineTables);

  const canonical = JSON.parse(JSON.stringify(CANONICAL_TEMPLATE));
  canonical.metadata = { ...canonical.metadata, ...metadata };
  canonical.employees = employees;
  canonical.vehicles = vehicles;
  canonical.baseline = baseline;

  let depotCandidateLat = depotLat;
  let depotCandidateLng = depotLng;
  if (depotCandidateLat === null || depotCandidateLng === null) {
    const drop = employees.find((e) => Number.isFinite(e.dropoff?.lat) && Number.isFinite(e.dropoff?.lng));
    if (drop) {
      depotCandidateLat = drop.dropoff.lat;
      depotCandidateLng = drop.dropoff.lng;
    }
  }
  if ((depotCandidateLat === null || depotCandidateLng === null) && vehicles.length) {
    const v0 = vehicles.find((v) => Number.isFinite(v.start_location?.lat) && Number.isFinite(v.start_location?.lng));
    if (v0) {
      depotCandidateLat = v0.start_location.lat;
      depotCandidateLng = v0.start_location.lng;
    }
  }
  canonical.depot.lat = depotCandidateLat;
  canonical.depot.lng = depotCandidateLng;

  const missing_required = buildMissingRequired(canonical);
  const sanity_checks = buildSanityChecks(canonical);
  const warnings = [];
  if (unknownTables.length) {
    warnings.push(`Unclassified sheets ignored: ${unknownTables.map((t) => `${t.artifactName}/${t.sheetName}`).join(', ')}`);
  }
  if (!employeeTables.length) warnings.push('No employee table detected');
  if (!vehicleTables.length) warnings.push('No vehicle table detected');

  const confidence = computeConfidence(canonical, missing_required);
  const hasCanonicalData = canonical.employees.length > 0 || canonical.vehicles.length > 0;
  const status = !hasCanonicalData
    ? 'failed'
    : (missing_required.length ? 'needs_review' : 'success');

  return {
    status,
    confidence,
    missing_required,
    assumptions: [
      'Parsed from tabular headers using regex mapping',
      'Unknown columns were ignored'
    ],
    warnings,
    sanity_checks,
    canonical: hasCanonicalData ? canonical : null,
    modelUsed: 'rgx'
  };
}

module.exports = {
  parseWithRgx,
  isTabularArtifact
};
