const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const schema = require('./canonicalSchema');

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);

const validate = ajv.compile(schema);

const MAX_COST_PER_KM = 50000;
const MAX_SPEED_KMPH = 150;
const MAX_CAPACITY = 100;
const LARGE_CASE_EMPLOYEE_THRESHOLD = 100;
const LARGE_CASE_VEHICLE_THRESHOLD = 25;
const LARGE_CASE_VEHICLE_EMPLOYEE_FLOOR = 70;
const LARGE_CASE_LOCATION_THRESHOLD = 240;
const HIGH_COST_PER_KM_WARNING = 1000;
const HIGH_SPEED_WARNING = 100;
const HIGH_CAPACITY_WARNING = 12;

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isFiniteCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function parseTimeToMinutes(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const m = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3] || 0);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return null;
  return hh * 60 + mm + (ss / 60);
}

function analyzeInput(input) {
  const employees = Array.isArray(input?.employees) ? input.employees : [];
  const vehicles = Array.isArray(input?.vehicles) ? input.vehicles : [];
  const metadata = (input?.metadata && typeof input.metadata === 'object') ? input.metadata : {};
  const uniqueLocations = new Set();
  return { employees, vehicles, metadata, uniqueLocations };
}

function semanticErrors(input) {
  const errors = [];
  const { employees, vehicles, metadata, uniqueLocations } = analyzeInput(input);
  const pushLoc = (loc, label) => {
    const lat = toNumber(loc?.lat);
    const lng = toNumber(loc?.lng);
    if (!isFiniteCoord(lat, lng)) {
      errors.push(`${label} must have finite lat/lng`);
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      errors.push(`${label} coordinates out of range`);
      return;
    }
    uniqueLocations.add(`${lat.toFixed(6)},${lng.toFixed(6)}`);
  };

  employees.forEach((row, idx) => {
    const label = `employees[${idx}]`;
    const id = String(row?.id || '').trim();
    if (!id) {
      errors.push(`${label}.id is required`);
    }
    pushLoc(row?.pickup, `${label}.pickup`);
    pushLoc(row?.dropoff, `${label}.dropoff`);
    const tw = row?.time_window || {};
    const start = parseTimeToMinutes(tw?.start ?? row?.earliest_pickup ?? row?.earliestPickup);
    const end = parseTimeToMinutes(tw?.end ?? row?.latest_drop ?? row?.latestDrop);
    if (start == null || end == null) {
      errors.push(`${label} must have valid time window start/end`);
    } else if (end < start) {
      errors.push(`${label} latest drop must be after earliest pickup`);
    }
  });

  vehicles.forEach((row, idx) => {
    const label = `vehicles[${idx}]`;
    const id = String(row?.id || '').trim();
    if (!id) {
      errors.push(`${label}.id is required`);
    }
    pushLoc(row?.start_location, `${label}.start_location`);
    const capacity = toNumber(row?.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
      errors.push(`${label}.capacity must be an integer between 1 and ${MAX_CAPACITY}`);
    }
    const costPerKm = toNumber(row?.cost_per_km);
    if (costPerKm == null || costPerKm < 0 || costPerKm > MAX_COST_PER_KM) {
      errors.push(`${label}.cost_per_km must be between 0 and ${MAX_COST_PER_KM}`);
    }
    const speed = toNumber(row?.avg_speed_kmph ?? metadata?.avg_speed_kmph);
    if (speed == null || speed <= 0 || speed > MAX_SPEED_KMPH) {
      errors.push(`${label}.avg_speed_kmph must be between 0 and ${MAX_SPEED_KMPH}`);
    }
    const availableTime = row?.available_time ?? row?.available_from ?? row?.avail_from;
    if (availableTime != null && String(availableTime).trim() && parseTimeToMinutes(availableTime) == null) {
      errors.push(`${label}.available_time must be a valid HH:MM or HH:MM:SS value`);
    }
  });

  const objectiveCostWeight = toNumber(
    metadata?.objective_cost_weight
    ?? metadata?.objectiveCostWeight
    ?? metadata?.cost_weight
    ?? metadata?.costWeight
    ?? metadata?.OBJECTIVE_COST_WEIGHT
  );
  const objectiveTimeWeight = toNumber(
    metadata?.objective_time_weight
    ?? metadata?.objectiveTimeWeight
    ?? metadata?.time_weight
    ?? metadata?.timeWeight
    ?? metadata?.OBJECTIVE_TIME_WEIGHT
  );
  [objectiveCostWeight, objectiveTimeWeight].forEach((weight, idx) => {
    if (weight == null) return;
    if (weight < 0 || weight > 1) {
      errors.push(`objective weight ${idx === 0 ? 'cost' : 'time'} must be between 0 and 1`);
    }
  });
  if (objectiveCostWeight != null && objectiveTimeWeight != null && (objectiveCostWeight + objectiveTimeWeight) <= 0) {
    errors.push('objective weights must sum to a positive value');
  }

  return Array.from(new Set(errors));
}

function semanticWarnings(input) {
  const warnings = [];
  const { employees, vehicles, metadata, uniqueLocations } = analyzeInput(input);
  const pushLoc = (loc) => {
    const lat = toNumber(loc?.lat);
    const lng = toNumber(loc?.lng);
    if (!isFiniteCoord(lat, lng)) return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    uniqueLocations.add(`${lat.toFixed(6)},${lng.toFixed(6)}`);
  };

  employees.forEach((row) => {
    pushLoc(row?.pickup);
    pushLoc(row?.dropoff);
  });
  vehicles.forEach((row) => {
    pushLoc(row?.start_location);
  });

  const vehiclePressureLarge = (
    vehicles.length > LARGE_CASE_VEHICLE_THRESHOLD
    && employees.length >= LARGE_CASE_VEHICLE_EMPLOYEE_FLOOR
  );
  const largeCase = (
    employees.length > LARGE_CASE_EMPLOYEE_THRESHOLD
    || vehiclePressureLarge
    || uniqueLocations.size > LARGE_CASE_LOCATION_THRESHOLD
  );

  if (largeCase) {
    warnings.push(
      `Large but valid testcase detected (${employees.length} employees, ${vehicles.length} vehicles, ${uniqueLocations.size} unique locations). It will be shown in diagnostics and may run in large-case mode with a reduced free-tier search budget.`
    );
  }

  const elevatedCostVehicles = vehicles.filter((row) => {
    const costPerKm = toNumber(row?.cost_per_km);
    return costPerKm != null && costPerKm >= HIGH_COST_PER_KM_WARNING && costPerKm <= MAX_COST_PER_KM;
  }).length;
  if (elevatedCostVehicles > 0) {
    warnings.push(
      `${elevatedCostVehicles} vehicle(s) use high but valid cost_per_km values. The testcase remains valid, but route scoring may become strongly cost-dominated.`
    );
  }

  const elevatedSpeedVehicles = vehicles.filter((row) => {
    const speed = toNumber(row?.avg_speed_kmph ?? metadata?.avg_speed_kmph);
    return speed != null && speed >= HIGH_SPEED_WARNING && speed <= MAX_SPEED_KMPH;
  }).length;
  if (elevatedSpeedVehicles > 0) {
    warnings.push(
      `${elevatedSpeedVehicles} vehicle(s) use high but valid speed values. Diagnostics will flag this so unusually optimistic travel times are visible.`
    );
  }

  const elevatedCapacityVehicles = vehicles.filter((row) => {
    const capacity = toNumber(row?.capacity);
    return Number.isInteger(capacity) && capacity >= HIGH_CAPACITY_WARNING && capacity <= MAX_CAPACITY;
  }).length;
  if (elevatedCapacityVehicles > 0) {
    warnings.push(
      `${elevatedCapacityVehicles} vehicle(s) have large but valid capacity values. Diagnostics will show this because these inputs can materially change search behavior.`
    );
  }

  const objectiveCostWeight = toNumber(
    metadata?.objective_cost_weight
    ?? metadata?.objectiveCostWeight
    ?? metadata?.cost_weight
    ?? metadata?.costWeight
    ?? metadata?.OBJECTIVE_COST_WEIGHT
  );
  const objectiveTimeWeight = toNumber(
    metadata?.objective_time_weight
    ?? metadata?.objectiveTimeWeight
    ?? metadata?.time_weight
    ?? metadata?.timeWeight
    ?? metadata?.OBJECTIVE_TIME_WEIGHT
  );
  if (objectiveCostWeight != null && objectiveCostWeight >= 0.95) {
    warnings.push('Objective cost weight is very high but still valid. Diagnostics will show that routing may strongly prioritize cost over time.');
  }
  if (objectiveTimeWeight != null && objectiveTimeWeight >= 0.95) {
    warnings.push('Objective time weight is very high but still valid. Diagnostics will show that routing may strongly prioritize time over cost.');
  }

  return Array.from(new Set(warnings));
}

function validateCanonical(input) {
  const shapeOk = validate(input);
  const semantic = shapeOk ? semanticErrors(input) : [];
  const warnings = shapeOk ? semanticWarnings(input) : [];
  const ok = shapeOk && semantic.length === 0;
  return {
    ok,
    warnings,
    errors: ok
      ? []
      : [
        ...(shapeOk ? [] : (validate.errors || []).map(e => `${e.instancePath || '(root)'} ${e.message}`)),
        ...semantic,
      ]
  };
}

module.exports = { validateCanonical };
