const { validateCanonical } = require('../validation/validateCanonical');
const { validateRunOutput } = require('./runValidator');
const { runPythonEngine } = require('./engineRunner');

function normalizeDistanceMetric(v) {
  return 'osrm';
}

function normalizePreferenceRelaxation(v) {
  const x = String(v || '').trim().toLowerCase();
  if (x === 'sharing' || x === 'vehicle' || x === 'both') return x;
  return 'none';
}

function normalizeIntensity(v) {
  const x = String(v || '').trim().toLowerCase();
  if (x === 'low' || x === 'high' || x === 'custom') return x;
  return 'medium';
}

function normalizeOsrmBaseUrl(raw) {
  let baseUrl = String(raw || '').trim();
  if (!baseUrl) return '';
  baseUrl = baseUrl.replace(/\/+$/, '');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(baseUrl)) {
    baseUrl = `http://${baseUrl}`;
  }
  return baseUrl.replace(/\/+$/, '');
}

function readOptionalPositiveNumber(raw, { integer = false } = {}) {
  if (raw === undefined || raw === null) return { provided: false, value: null, valid: true };
  const text = String(raw).trim();
  if (!text) return { provided: false, value: null, valid: true };
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return { provided: true, value: null, valid: false };
  if (integer && !Number.isInteger(n)) return { provided: true, value: null, valid: false };
  return { provided: true, value: integer ? Math.trunc(n) : n, valid: true };
}

function resolveCustomIntensityConfig({
  optimizationIntensity,
  customMaxRunSeconds,
  customGenerations,
} = {}) {
  const time = readOptionalPositiveNumber(customMaxRunSeconds);
  const generations = readOptionalPositiveNumber(customGenerations, { integer: true });
  if (!time.valid || !generations.valid) {
    const err = new Error('Custom intensity values must be positive numbers, and generations must be a whole number');
    err.statusCode = 400;
    throw err;
  }
  if (normalizeIntensity(optimizationIntensity) !== 'custom') {
    return { customMaxRunSeconds: null, customGenerations: null };
  }
  const filledCount = Number(Boolean(time.value)) + Number(Boolean(generations.value));
  if (filledCount !== 1) {
    const err = new Error('Custom intensity requires exactly one value: time in seconds or generations');
    err.statusCode = 400;
    throw err;
  }
  return { customMaxRunSeconds: time.value, customGenerations: generations.value };
}

function buildEngineArgs({
  optimizationIntensity,
  preferenceRelaxation,
  customMaxRunSeconds = null,
  customGenerations = null,
}) {
  const args = ['--intensity', optimizationIntensity, '--preference-relaxation', preferenceRelaxation, '--compute-tier', 'free'];
  if (optimizationIntensity === 'custom') {
    args.push('--early-stop-enabled', 'false');
    if (customGenerations) args.push('--generations', String(customGenerations));
    if (customMaxRunSeconds) args.push('--max-run-seconds', String(customMaxRunSeconds));
  }
  return args;
}

function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

function haversineDistanceKm(a, b) {
  const lat1 = toNumber(a?.lat);
  const lon1 = toNumber(a?.lng);
  const lat2 = toNumber(b?.lat);
  const lon2 = toNumber(b?.lng);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;

  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const q =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q)));
}

async function osrmDistanceKm(a, b, cache) {
  const lat1 = toNumber(a?.lat);
  const lon1 = toNumber(a?.lng);
  const lat2 = toNumber(b?.lat);
  const lon2 = toNumber(b?.lng);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;

  const key = `${lat1.toFixed(6)},${lon1.toFixed(6)}|${lat2.toFixed(6)},${lon2.toFixed(6)}`;
  if (cache.has(key)) return cache.get(key);

  const baseUrl =
    normalizeOsrmBaseUrl(process.env.OSRM_BASE_URL) ||
    'https://router.project-osrm.org';
  const profile = String(process.env.OSRM_PROFILE || 'driving').trim() || 'driving';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const url = `${baseUrl}/route/v1/${profile}/${lon1},${lat1};${lon2},${lat2}?overview=false&alternatives=false&steps=false`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const payload = await res.json();
    const distanceMeters = toNumber(payload?.routes?.[0]?.distance);
    const distanceKm = Number.isFinite(distanceMeters) ? distanceMeters / 1000 : null;
    cache.set(key, distanceKm);
    return distanceKm;
  } catch (_) {
    const fallback = haversineDistanceKm(a, b);
    cache.set(key, fallback);
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

async function distanceBetween(a, b, metric, cache) {
  if (metric === 'haversine') return haversineDistanceKm(a, b);
  return osrmDistanceKm(a, b, cache);
}

function buildCanonicalForRun(parsedInput, runConfig = {}) {
  const canonical = JSON.parse(JSON.stringify(parsedInput || {}));
  const metadata = (canonical.metadata && typeof canonical.metadata === 'object' && !Array.isArray(canonical.metadata))
    ? { ...canonical.metadata }
    : {};

  const distanceMetric = normalizeDistanceMetric(runConfig.distanceMetric);
  const preferenceRelaxation = normalizePreferenceRelaxation(runConfig.preferenceRelaxation);
  const allowSharingViolation = preferenceRelaxation === 'sharing' || preferenceRelaxation === 'both';
  const allowPremiumMismatch = preferenceRelaxation === 'vehicle' || preferenceRelaxation === 'both';

  metadata.distance_metric = distanceMetric;
  metadata.distance_method = distanceMetric;
  metadata.ALLOW_SHARING_VIOLATION = allowSharingViolation ? 'true' : 'false';
  metadata.ALLOW_PREMIUM_MISMATCH = allowPremiumMismatch ? 'true' : 'false';
  metadata.allow_sharing_violation = allowSharingViolation;
  metadata.allow_premium_mismatch = allowPremiumMismatch;
  metadata.preference_relaxation = preferenceRelaxation;
  canonical.metadata = metadata;
  return canonical;
}

function unwrapResultPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Array.isArray(payload.rides)) return payload;
  if (payload.results && typeof payload.results === 'object' && Array.isArray(payload.results.rides)) return payload.results;
  if (payload.result && typeof payload.result === 'object' && Array.isArray(payload.result.rides)) return payload.result;
  return null;
}

function maxSharingForPreference(value) {
  const x = String(value || '').trim().toLowerCase();
  if (x === 'single') return 1;
  if (x === 'double') return 2;
  if (x === 'triple') return 3;
  return Number.POSITIVE_INFINITY;
}

function vehicleCategoryMatchesPreference(vehicle, employee) {
  const pref = String(employee?.vehicle_preference || employee?.preferences?.vehicleType || '').trim().toLowerCase();
  if (!pref) return true;
  const category = String(vehicle?.category || vehicle?.mode || vehicle?.type || '').trim().toLowerCase();
  if (!category) return pref === 'normal';
  if (pref === 'premium') return category === 'premium';
  return category !== 'premium_only';
}

function metricTolerance(metric, expected) {
  if (!Number.isFinite(expected)) return 0.5;
  if (metric === 'osrm') return Math.max(0.35, expected * 0.18);
  return Math.max(0.1, expected * 0.08);
}

function scoreChecks(checks) {
  const passedCount = checks.filter((check) => check.passed).length;
  const score = checks.length ? Math.round((passedCount / checks.length) * 100) : 0;
  return {
    passed: checks.every((check) => check.passed),
    score,
    checks,
    message: checks.every((check) => check.passed)
      ? `Validation passed (${score}%)`
      : `Validation failed (${score}%). Review checks.`,
  };
}

function buildComparison(uploaded, ours) {
  const uploadedMetrics = uploaded?.metrics || {};
  const ourMetrics = ours?.metrics || {};
  const uploadedObjective = toNumber(uploaded?.objectiveScore, NaN);
  const ourObjective = toNumber(ours?.objectiveScore, NaN);
  const uploadedCost = toNumber(uploadedMetrics?.totalSystemCost, NaN);
  const ourCost = toNumber(ourMetrics?.totalSystemCost, NaN);
  const uploadedDistance = toNumber(uploadedMetrics?.totalDistanceKm || uploadedMetrics?.totalDistance, NaN);
  const ourDistance = toNumber(ourMetrics?.totalDistanceKm || ourMetrics?.totalDistance, NaN);
  const uploadedTime = toNumber(uploadedMetrics?.totalTimeMinutes || uploadedMetrics?.totalTime, NaN);
  const ourTime = toNumber(ourMetrics?.totalTimeMinutes || ourMetrics?.totalTime, NaN);
  const uploadedUnassigned = Array.isArray(uploaded?.unassigned) ? uploaded.unassigned.length : 0;
  const ourUnassigned = Array.isArray(ours?.unassigned) ? ours.unassigned.length : 0;

  const comparisons = [
    {
      key: 'objectiveScore',
      label: 'Objective Score',
      uploaded: Number.isFinite(uploadedObjective) ? uploadedObjective : null,
      ours: Number.isFinite(ourObjective) ? ourObjective : null,
      better: Number.isFinite(uploadedObjective) && Number.isFinite(ourObjective)
        ? (uploadedObjective < ourObjective ? 'uploaded' : uploadedObjective > ourObjective ? 'ours' : 'tie')
        : 'unknown',
    },
    {
      key: 'totalSystemCost',
      label: 'System Cost',
      uploaded: Number.isFinite(uploadedCost) ? uploadedCost : null,
      ours: Number.isFinite(ourCost) ? ourCost : null,
      better: Number.isFinite(uploadedCost) && Number.isFinite(ourCost)
        ? (uploadedCost < ourCost ? 'uploaded' : uploadedCost > ourCost ? 'ours' : 'tie')
        : 'unknown',
    },
    {
      key: 'totalDistanceKm',
      label: 'Distance (km)',
      uploaded: Number.isFinite(uploadedDistance) ? uploadedDistance : null,
      ours: Number.isFinite(ourDistance) ? ourDistance : null,
      better: Number.isFinite(uploadedDistance) && Number.isFinite(ourDistance)
        ? (uploadedDistance < ourDistance ? 'uploaded' : uploadedDistance > ourDistance ? 'ours' : 'tie')
        : 'unknown',
    },
    {
      key: 'totalTimeMinutes',
      label: 'Time (min)',
      uploaded: Number.isFinite(uploadedTime) ? uploadedTime : null,
      ours: Number.isFinite(ourTime) ? ourTime : null,
      better: Number.isFinite(uploadedTime) && Number.isFinite(ourTime)
        ? (uploadedTime < ourTime ? 'uploaded' : uploadedTime > ourTime ? 'ours' : 'tie')
        : 'unknown',
    },
    {
      key: 'unassigned',
      label: 'Unassigned Employees',
      uploaded: uploadedUnassigned,
      ours: ourUnassigned,
      better: uploadedUnassigned < ourUnassigned ? 'uploaded' : uploadedUnassigned > ourUnassigned ? 'ours' : 'tie',
    },
  ];

  return {
    structuralMatch: Boolean(uploaded?.structuralHash) && uploaded?.structuralHash === ours?.structuralHash,
    uploadedStructuralHash: uploaded?.structuralHash || null,
    ourStructuralHash: ours?.structuralHash || null,
    comparisons,
  };
}

async function validateResultAgainstCanonical({ canonical, resultPayload, distanceMetric, preferenceRelaxation }) {
  const result = unwrapResultPayload(resultPayload);
  if (!result) {
    return {
      passed: false,
      score: 0,
      message: 'Uploaded result file is not a recognized solver-output JSON payload.',
      checks: [{
        name: 'Result Payload Shape',
        passed: false,
        severity: 'Error',
        detail: 'Expected a JSON object containing rides either at root, result, or results.',
      }],
      normalizedResult: null,
    };
  }

  const engineStyle = validateRunOutput({
    status: 'Completed',
    run: { state: 'Done' },
    results: result,
    metrics: result.metrics || {},
  });

  const employees = Array.isArray(canonical?.employees) ? canonical.employees : [];
  const vehicles = Array.isArray(canonical?.vehicles) ? canonical.vehicles : [];
  const employeeMap = new Map(employees.map((employee) => [String(employee.id), employee]));
  const vehicleMap = new Map(vehicles.map((vehicle) => [String(vehicle.id), vehicle]));
  const rides = Array.isArray(result?.rides) ? result.rides : [];
  const unassigned = new Set((Array.isArray(result?.unassigned) ? result.unassigned : []).map((id) => String(id)));
  const allowSharingViolation = preferenceRelaxation === 'sharing' || preferenceRelaxation === 'both';
  const allowVehicleMismatch = preferenceRelaxation === 'vehicle' || preferenceRelaxation === 'both';
  const distanceCache = new Map();

  const missingEntities = [];
  const duplicateAssignments = [];
  const routeIssues = [];
  const metricIssues = [];
  const assignmentState = new Map();
  let rideMetricDistanceSum = 0;
  let rideMetricCostSum = 0;
  let rideMetricTimeSum = 0;

  for (const ride of rides) {
    const vehicleId = String(ride?.vehicleId || ride?.sourceVehicleId || ride?.normalizedVehicleId || '');
    const vehicle = vehicleMap.get(vehicleId);
    if (!vehicle) {
      missingEntities.push(`Unknown vehicle in ride: ${vehicleId || '(empty)'}`);
      continue;
    }

    const assignedEmployees = Array.isArray(ride?.assignedEmployees) ? ride.assignedEmployees.map((id) => String(id)) : [];
    assignedEmployees.forEach((employeeId) => {
      if (!employeeMap.has(employeeId)) {
        missingEntities.push(`Unknown employee in assignedEmployees: ${employeeId}`);
      } else if (assignmentState.has(employeeId)) {
        duplicateAssignments.push(`${employeeId} assigned to multiple rides`);
      } else {
        assignmentState.set(employeeId, { rideVehicleId: vehicleId });
      }
    });

    const path = Array.isArray(ride?.path) ? ride.path : [];
    const pickupCount = new Map();
    const dropoffCount = new Map();
    const onboard = new Set();
    let currentLoad = 0;
    let previousPoint = vehicle.start_location || null;
    let computedRideDistance = 0;

    const availabilityMinute = parseTimeToMinutes(vehicle?.available_time);
    const rideStartMinute = toNumber(ride?.startMinute);
    if (Number.isFinite(availabilityMinute) && Number.isFinite(rideStartMinute) && rideStartMinute + 0.5 < availabilityMinute) {
      routeIssues.push(`Vehicle ${vehicleId} starts before available_time`);
    }

    for (const stop of path) {
      const stopType = String(stop?.type || '').trim().toLowerCase();
      const employeeId = String(stop?.employeeId || '');
      const employee = employeeMap.get(employeeId);
      if (!employee) {
        routeIssues.push(`Vehicle ${vehicleId} contains unknown employee ${employeeId || '(empty)'}`);
        continue;
      }

      const expectedPoint = stopType === 'pickup' ? employee.pickup : employee.dropoff;
      const observedPoint = {
        lat: toNumber(stop?.lat, toNumber(expectedPoint?.lat)),
        lng: toNumber(stop?.lng, toNumber(expectedPoint?.lng)),
      };
      const coordGap = haversineDistanceKm(observedPoint, expectedPoint);
      if (Number.isFinite(coordGap) && coordGap > 0.15) {
        routeIssues.push(`Vehicle ${vehicleId} stop ${stopType}:${employeeId} does not match testcase coordinates`);
      }

      if (previousPoint) {
        const expectedDistance = await distanceBetween(previousPoint, expectedPoint, distanceMetric, distanceCache);
        const reportedDistance = toNumber(stop?.distanceFromPrevKm, NaN);
        if (Number.isFinite(expectedDistance)) {
          computedRideDistance += expectedDistance;
          if (Number.isFinite(reportedDistance) && Math.abs(reportedDistance - expectedDistance) > metricTolerance(distanceMetric, expectedDistance)) {
            routeIssues.push(
              `Vehicle ${vehicleId} segment before ${stopType}:${employeeId} reports ${reportedDistance.toFixed(3)} km; expected about ${expectedDistance.toFixed(3)} km (${distanceMetric})`
            );
          }
        }
      }
      previousPoint = expectedPoint;

      if (stopType === 'pickup') {
        pickupCount.set(employeeId, (pickupCount.get(employeeId) || 0) + 1);
        if (pickupCount.get(employeeId) > 1) routeIssues.push(`Employee ${employeeId} picked up multiple times`);
        if (onboard.has(employeeId)) routeIssues.push(`Employee ${employeeId} already onboard before pickup`);
        const earliest = parseTimeToMinutes(employee?.time_window?.start || employee?.earliest_pickup || employee?.earliestPickup);
        const serviceMinute = Math.max(toNumber(stop?.arrivalMinute, NaN), toNumber(stop?.departureMinute, NaN));
        if (Number.isFinite(earliest) && Number.isFinite(serviceMinute) && serviceMinute + 0.5 < earliest) {
          routeIssues.push(`Employee ${employeeId} picked up before time window starts`);
        }
        currentLoad += 1;
        onboard.add(employeeId);
      } else if (stopType === 'dropoff') {
        dropoffCount.set(employeeId, (dropoffCount.get(employeeId) || 0) + 1);
        if (dropoffCount.get(employeeId) > 1) routeIssues.push(`Employee ${employeeId} dropped multiple times`);
        if (!onboard.has(employeeId)) {
          routeIssues.push(`Employee ${employeeId} dropped before pickup on vehicle ${vehicleId}`);
        } else {
          onboard.delete(employeeId);
          currentLoad -= 1;
        }
        const latest = parseTimeToMinutes(employee?.time_window?.end || employee?.latest_drop || employee?.latestDrop);
        const arrivalMinute = toNumber(stop?.arrivalMinute, NaN);
        if (Number.isFinite(latest) && Number.isFinite(arrivalMinute) && arrivalMinute - 0.5 > latest) {
          routeIssues.push(`Employee ${employeeId} dropped after time window ends`);
        }
      } else {
        routeIssues.push(`Vehicle ${vehicleId} has unsupported stop type ${stopType || '(empty)'}`);
      }

      if (currentLoad > toNumber(vehicle?.capacity, 0)) {
        routeIssues.push(`Vehicle ${vehicleId} exceeds capacity (${currentLoad}/${vehicle.capacity})`);
      }
      if (currentLoad < 0) {
        routeIssues.push(`Vehicle ${vehicleId} load became negative`);
      }

      if (!allowSharingViolation) {
        for (const onboardEmployeeId of onboard) {
          const onboardEmployee = employeeMap.get(onboardEmployeeId);
          const maxShare = maxSharingForPreference(
            onboardEmployee?.sharing_preference || onboardEmployee?.preferences?.sharing
          );
          if (currentLoad > maxShare) {
            routeIssues.push(`Sharing preference broken for ${onboardEmployeeId} (${currentLoad} onboard > ${maxShare})`);
          }
        }
      }

      if (!allowVehicleMismatch && !vehicleCategoryMatchesPreference(vehicle, employee)) {
        routeIssues.push(`Vehicle preference broken for ${employeeId} on vehicle ${vehicleId}`);
      }

      const reportedLoadAfter = toNumber(stop?.loadAfter, NaN);
      if (Number.isFinite(reportedLoadAfter) && Math.abs(reportedLoadAfter - currentLoad) > 0.01) {
        routeIssues.push(`Vehicle ${vehicleId} stop ${stopType}:${employeeId} has incorrect loadAfter`);
      }
    }

    for (const employeeId of assignedEmployees) {
      if ((pickupCount.get(employeeId) || 0) !== 1) routeIssues.push(`Employee ${employeeId} must have exactly one pickup in ride ${vehicleId}`);
      if ((dropoffCount.get(employeeId) || 0) !== 1) routeIssues.push(`Employee ${employeeId} must have exactly one dropoff in ride ${vehicleId}`);
    }
    if (onboard.size > 0) {
      routeIssues.push(`Vehicle ${vehicleId} ends with passengers still onboard: ${Array.from(onboard).join(', ')}`);
    }

    const rideDistanceMetric = toNumber(ride?.metrics?.totalDistanceKm || ride?.metrics?.totalDistance, NaN);
    if (Number.isFinite(rideDistanceMetric) && Number.isFinite(computedRideDistance)) {
      if (Math.abs(rideDistanceMetric - computedRideDistance) > metricTolerance(distanceMetric, computedRideDistance) * 2) {
        metricIssues.push(`Vehicle ${vehicleId} totalDistanceKm=${rideDistanceMetric.toFixed(3)} disagrees with recomputed distance ${computedRideDistance.toFixed(3)}`);
      }
      rideMetricDistanceSum += rideDistanceMetric;
    }

    const rideCostMetric = toNumber(ride?.metrics?.cost, NaN);
    const expectedCost = Number.isFinite(computedRideDistance) ? computedRideDistance * toNumber(vehicle?.cost_per_km, 0) : NaN;
    if (Number.isFinite(rideCostMetric) && Number.isFinite(expectedCost)) {
      if (Math.abs(rideCostMetric - expectedCost) > Math.max(2, expectedCost * 0.12)) {
        metricIssues.push(`Vehicle ${vehicleId} cost=${rideCostMetric.toFixed(2)} disagrees with expected ${expectedCost.toFixed(2)}`);
      }
      rideMetricCostSum += rideCostMetric;
    }

    const rideTimeMetric = toNumber(ride?.metrics?.totalTimeMinutes || ride?.metrics?.totalTime, NaN);
    if (Number.isFinite(rideTimeMetric)) {
      rideMetricTimeSum += rideTimeMetric;
    }
  }

  const coverageIssues = [];
  employees.forEach((employee) => {
    const employeeId = String(employee.id);
    const assigned = assignmentState.has(employeeId);
    const explicitlyUnassigned = unassigned.has(employeeId);
    if (!assigned && !explicitlyUnassigned) {
      coverageIssues.push(`Employee ${employeeId} is neither assigned nor listed as unassigned`);
    }
    if (assigned && explicitlyUnassigned) {
      coverageIssues.push(`Employee ${employeeId} is both assigned and unassigned`);
    }
  });
  unassigned.forEach((employeeId) => {
    if (!employeeMap.has(employeeId)) coverageIssues.push(`Unknown employee in unassigned list: ${employeeId}`);
  });

  const topLevelMetrics = result?.metrics || {};
  const totalDistance = toNumber(topLevelMetrics?.totalDistanceKm || topLevelMetrics?.totalDistance, NaN);
  const totalCost = toNumber(topLevelMetrics?.totalSystemCost, NaN);
  const totalTime = toNumber(topLevelMetrics?.totalTimeMinutes || topLevelMetrics?.totalTime, NaN);
  if (Number.isFinite(totalDistance) && Math.abs(totalDistance - rideMetricDistanceSum) > Math.max(0.5, rideMetricDistanceSum * 0.08)) {
    metricIssues.push(`Top-level totalDistanceKm=${totalDistance.toFixed(3)} differs from ride sum ${rideMetricDistanceSum.toFixed(3)}`);
  }
  if (Number.isFinite(totalCost) && Math.abs(totalCost - rideMetricCostSum) > Math.max(2, rideMetricCostSum * 0.08)) {
    metricIssues.push(`Top-level totalSystemCost=${totalCost.toFixed(2)} differs from ride sum ${rideMetricCostSum.toFixed(2)}`);
  }
  if (Number.isFinite(totalTime) && Math.abs(totalTime - rideMetricTimeSum) > Math.max(2, rideMetricTimeSum * 0.08)) {
    metricIssues.push(`Top-level totalTimeMinutes=${totalTime.toFixed(2)} differs from ride sum ${rideMetricTimeSum.toFixed(2)}`);
  }

  const distanceIssues = routeIssues.filter((issue) => issue.includes('reports') || issue.includes('coordinates'));
  const checks = [
    ...engineStyle.checks,
    {
      name: 'Entity References',
      passed: missingEntities.length === 0,
      severity: missingEntities.length === 0 ? 'OK' : 'Error',
      detail: missingEntities.length === 0 ? 'All ride references map to testcase employees and vehicles' : missingEntities.slice(0, 12).join('; '),
    },
    {
      name: 'Assignment Coverage',
      passed: duplicateAssignments.length === 0 && coverageIssues.length === 0,
      severity: duplicateAssignments.length === 0 && coverageIssues.length === 0 ? 'OK' : 'Error',
      detail: duplicateAssignments.length === 0 && coverageIssues.length === 0
        ? 'Every testcase employee is covered exactly once or marked unassigned'
        : [...duplicateAssignments, ...coverageIssues].slice(0, 12).join('; '),
    },
    {
      name: 'Route Constraint Checks',
      passed: routeIssues.length === 0,
      severity: routeIssues.length === 0 ? 'OK' : 'Error',
      detail: routeIssues.length === 0
        ? `Capacity, pickup/dropoff order, time windows, sharing, and vehicle preference checks passed (${preferenceRelaxation} relaxation)`
        : routeIssues.slice(0, 12).join('; '),
    },
    {
      name: `Distance Verification (${distanceMetric})`,
      passed: distanceIssues.length === 0,
      severity: distanceIssues.length === 0 ? 'OK' : 'Error',
      detail: distanceIssues.length === 0
        ? `Segment distances match ${distanceMetric} within tolerance`
        : distanceIssues.slice(0, 12).join('; '),
    },
    {
      name: 'Metric Reconciliation',
      passed: metricIssues.length === 0,
      severity: metricIssues.length === 0 ? 'OK' : 'Error',
      detail: metricIssues.length === 0 ? 'Ride-level and top-level metrics reconcile' : metricIssues.slice(0, 12).join('; '),
    },
  ];

  const scored = scoreChecks(checks);
  return {
    ...scored,
    normalizedResult: result,
    checkGroups: {
      missingEntities,
      duplicateAssignments,
      coverageIssues,
      routeIssues,
      metricIssues,
    },
  };
}

async function runStandaloneValidation({
  canonical,
  uploadedResultPayload,
  distanceMetric,
  preferenceRelaxation,
  compareWithEngine = false,
  optimizationIntensity = 'medium',
  customMaxRunSeconds = null,
  customGenerations = null,
}) {
  const normalizedMetric = normalizeDistanceMetric(distanceMetric);
  const normalizedRelaxation = normalizePreferenceRelaxation(preferenceRelaxation);
  const normalizedIntensity = normalizeIntensity(optimizationIntensity);
  const customConfig = resolveCustomIntensityConfig({
    optimizationIntensity: normalizedIntensity,
    customMaxRunSeconds,
    customGenerations,
  });
  const canonicalForRun = buildCanonicalForRun(canonical, {
    distanceMetric: normalizedMetric,
    preferenceRelaxation: normalizedRelaxation,
  });
  const canonicalValidation = validateCanonical(canonicalForRun);

  const uploadedValidation = await validateResultAgainstCanonical({
    canonical: canonicalForRun,
    resultPayload: uploadedResultPayload,
    distanceMetric: normalizedMetric,
    preferenceRelaxation: normalizedRelaxation,
  });
  const { normalizedResult: uploadedNormalizedResult, ...uploadedValidationResponse } = uploadedValidation;

  const response = {
    testcase: {
      summary: {
        employees: Array.isArray(canonicalForRun?.employees) ? canonicalForRun.employees.length : 0,
        vehicles: Array.isArray(canonicalForRun?.vehicles) ? canonicalForRun.vehicles.length : 0,
      },
      canonicalValidation,
    },
    uploadedResult: uploadedValidationResponse,
    compare: null,
    config: {
      distanceMetric: normalizedMetric,
      preferenceRelaxation: normalizedRelaxation,
      optimizationIntensity: normalizedIntensity,
      customMaxRunSeconds: customConfig.customMaxRunSeconds,
      customGenerations: customConfig.customGenerations,
    },
  };

  if (compareWithEngine && canonicalValidation.ok) {
    const engineResult = await runPythonEngine(canonicalForRun, {
      args: buildEngineArgs({
        optimizationIntensity: normalizedIntensity,
        preferenceRelaxation: normalizedRelaxation,
        customMaxRunSeconds: customConfig.customMaxRunSeconds,
        customGenerations: customConfig.customGenerations,
      }),
      timeoutMs: 10 * 60 * 1000,
    });
    const engineValidation = await validateResultAgainstCanonical({
      canonical: canonicalForRun,
      resultPayload: engineResult,
      distanceMetric: normalizedMetric,
      preferenceRelaxation: normalizedRelaxation,
    });
    const { normalizedResult: engineNormalizedResult, ...engineValidationResponse } = engineValidation;

    response.compare = {
      engineResult,
      engineValidation: engineValidationResponse,
      summary: buildComparison(uploadedNormalizedResult, engineNormalizedResult),
    };
  }

  return response;
}

module.exports = {
  normalizeDistanceMetric,
  normalizePreferenceRelaxation,
  normalizeIntensity,
  runStandaloneValidation,
};
