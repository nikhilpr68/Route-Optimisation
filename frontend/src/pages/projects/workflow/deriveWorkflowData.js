import {
  displayValue,
  extractBaselineRows,
  findFirstNumericByKeys,
  flattenObject,
  formatMoney,
  isOutOfRangeCoord,
  isValidLatitude,
  isValidLongitude,
  parseNumericLike,
  parseWindow,
  pushUniqueIssue,
  toKeyValueRows,
  toMinutes,
} from './helpers';
import { readMinuteByKeys } from './panel/timelineUtils';

function deriveWorkflowData({
  projectRunConfig,
  parsedInput,
  parseReport,
  resultMetrics,
  resultPayload,
  employeeQuery,
}) {
  const formatObjectiveValue = (value) => {
    if (!Number.isFinite(value)) return '—';
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
  };

  const normalizeDistanceMode = (value) => {
    const text = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (!text) return '';
    if (['osrm', 'osm', 'openstreetmap', 'road', 'road_distance', 'mapcn', 'mapcn_dev'].includes(text)) return 'osrm';
    if (['haversine', 'geo', 'straight_line', 'great_circle'].includes(text)) return 'haversine';
    if (['google', 'google_maps', 'googlemaps'].includes(text)) return 'google_maps';
    return text;
  };

  const distanceModeLabel = (value) => {
    const normalized = normalizeDistanceMode(value);
    if (normalized === 'osrm') return 'OSRM (Road)';
    if (normalized === 'haversine') return 'Haversine (Geo)';
    if (normalized === 'google_maps') return 'Google Maps';
    if (!normalized) return 'Default';
    return String(value || normalized);
  };

  const employees = Array.isArray(parsedInput?.employees) ? parsedInput.employees : [];
  const vehicles = Array.isArray(parsedInput?.vehicles) ? parsedInput.vehicles : [];
  const attachDisplayIds = (rows, kind) => {
    const totals = {};
    rows.forEach((row) => {
      const rawId = String(row?.id || '').trim();
      if (!rawId) return;
      totals[rawId] = (totals[rawId] || 0) + 1;
    });

    const seen = {};
    return rows.map((row, idx) => {
      const rawId = String(row?.id || '').trim();
      if (!rawId) {
        return {
          ...row,
          originalId: '',
          displayId: `${kind.toUpperCase()}_${idx + 1}`,
          normalizedId: `${kind.toUpperCase()}_${idx + 1}`,
        };
      }
      seen[rawId] = (seen[rawId] || 0) + 1;
      const occurrence = seen[rawId];
      const duplicateTotal = totals[rawId] || 0;
      const isDuplicate = duplicateTotal > 1;
      return {
        ...row,
        originalId: row?.originalId || rawId,
        displayId: row?.displayId || (isDuplicate ? `${rawId} #${occurrence}` : rawId),
        normalizedId: row?.normalizedId || (isDuplicate ? `${rawId}__dup${occurrence}` : rawId),
      };
    });
  };

  const employeesWithDisplayIds = attachDisplayIds(employees, 'emp');
  const vehiclesWithDisplayIds = attachDisplayIds(vehicles, 'veh');
  const flattenedEmployees = employeesWithDisplayIds.map((e) => flattenObject(e));
  const flattenedVehicles = vehiclesWithDisplayIds.map((v) => flattenObject(v));

  const employeeColumns = Array.from(
    flattenedEmployees.reduce((set, row) => {
      Object.keys(row || {}).forEach((k) => set.add(k));
      return set;
    }, new Set(['id']))
  ).filter((col) => {
    // Keep column if at least one row has a non-empty value
    return flattenedEmployees.some((row) => {
      const val = row?.[col];
      return val !== null && val !== undefined && val !== '';
    });
  });
  const vehicleColumns = Array.from(
    flattenedVehicles.reduce((set, row) => {
      Object.keys(row || {}).forEach((k) => set.add(k));
      return set;
    }, new Set(['id']))
  ).filter((col) => {
    // Keep column if at least one row has a non-empty value
    return flattenedVehicles.some((row) => {
      const val = row?.[col];
      return val !== null && val !== undefined && val !== '';
    });
  }).sort((a, b) => {
    const priority = [
      'id',
      'mode',
      'category',
      'capacity',
      'cost_per_km',
      'avg_speed_kmph',
      'start_location.lat',
      'start_location.lng',
      'available_time',
      'available_from',
    ];
    const aIdx = priority.indexOf(a);
    const bIdx = priority.indexOf(b);
    if (aIdx !== -1 || bIdx !== -1) {
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    }
    return a.localeCompare(b);
  });

  const filteredEmployees = flattenedEmployees.filter((row) => {
    const q = String(employeeQuery || '').trim().toLowerCase();
    if (!q) return true;
    return employeeColumns.some((col) => displayValue(row?.[col]).toLowerCase().includes(q));
  });

  const invalidEmployeeCoordinatesCount = employees.filter((e) => (
    isOutOfRangeCoord(e?.pickupLat) ||
    isOutOfRangeCoord(e?.pickupLng) ||
    isOutOfRangeCoord(e?.officeLat) ||
    isOutOfRangeCoord(e?.officeLng)
  )).length;

  const invalidVehicleCoordinatesCount = vehicles.filter((v) => (
    isOutOfRangeCoord(v?.start_location?.lat) ||
    isOutOfRangeCoord(v?.start_location?.lng) ||
    isOutOfRangeCoord(v?.startLocation?.lat) ||
    isOutOfRangeCoord(v?.startLocation?.lng)
  )).length;

  const invalidCoordinatesCount = invalidEmployeeCoordinatesCount + invalidVehicleCoordinatesCount;

  const vehicleAvailableMinutes = vehicles
    .map((v) => {
      const raw = v?.available_time ?? v?.availableTime ?? v?.available_from ?? v?.availabilityStart;
      if (!raw) return null;
      return toMinutes(String(raw));
    })
    .filter((n) => n !== null);

  const invalidTimeWindowCount = employees.filter((e) => {
    const tw = e?.time_window || e?.timeWindow || null;
    const startRaw = tw?.start ?? e?.earliest_pickup ?? e?.earliestPickup;
    const endRaw = tw?.end ?? e?.latest_drop ?? e?.latestDrop;
    const start = startRaw ? toMinutes(String(startRaw)) : null;
    const end = endRaw ? toMinutes(String(endRaw)) : null;
    if (start == null || end == null) return true;
    if (end <= start) return true;
    // Check if latest drop time is earlier than earliest vehicle start time
    if (vehicleAvailableMinutes.length > 0) {
      const earliestVehicleStart = Math.min(...vehicleAvailableMinutes);
      if (end < earliestVehicleStart) return true;
    }
    return false;
  }).length;

  const infeasibleVehicleAvailabilityCount = employees.filter((e) => {
    if (!vehicleAvailableMinutes.length) return false;
    const tw = e?.time_window || e?.timeWindow || null;
    const endRaw = tw?.end ?? e?.latest_drop ?? e?.latestDrop;
    const latestDrop = endRaw ? toMinutes(String(endRaw)) : null;
    if (latestDrop == null) return false;
    return !vehicleAvailableMinutes.some((availableAt) => availableAt <= latestDrop);
  }).length;

  const employeeIds = employees.map((e) => e?.id).filter(Boolean);
  const duplicateEmployeeIdsCount = Math.max(0, employeeIds.length - new Set(employeeIds).size);

  const vehicleIds = vehicles.map((v) => v?.id).filter(Boolean);
  const duplicateVehicleIdsCount = Math.max(0, vehicleIds.length - new Set(vehicleIds).size);

  const duplicateIdsCount = duplicateEmployeeIdsCount + duplicateVehicleIdsCount;

  const missingCapacityCount = vehicles.filter((v) => {
    const capacity = Number(v?.capacity);
    return !Number.isFinite(capacity) || capacity <= 0;
  }).length;

  const uniqueLocationCount = (() => {
    const seen = new Set();
    const pushLoc = (lat, lng) => {
      const latNum = Number(lat);
      const lngNum = Number(lng);
      if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return;
      if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) return;
      seen.add(`${latNum.toFixed(6)},${lngNum.toFixed(6)}`);
    };
    employees.forEach((e) => {
      pushLoc(e?.pickup?.lat ?? e?.pickupLat ?? e?.pickup_lat, e?.pickup?.lng ?? e?.pickupLng ?? e?.pickup_lng);
      pushLoc(e?.dropoff?.lat ?? e?.dropLat ?? e?.drop_lat, e?.dropoff?.lng ?? e?.dropLng ?? e?.drop_lng);
    });
    vehicles.forEach((v) => {
      pushLoc(
        v?.start_location?.lat ?? v?.startLocation?.lat ?? v?.startLat ?? v?.start_lat ?? v?.current_lat,
        v?.start_location?.lng ?? v?.startLocation?.lng ?? v?.startLng ?? v?.start_lng ?? v?.current_lng,
      );
    });
    return seen.size;
  })();

  const highButValidCostCount = vehicles.filter((v) => {
    const cost = parseNumericLike(v?.cost_per_km ?? v?.costPerKm);
    return cost !== null && cost >= 1000 && cost <= 10000;
  }).length;
  const highButValidSpeedCount = vehicles.filter((v) => {
    const speed = parseNumericLike(v?.avg_speed_kmph ?? v?.avgSpeedKmph ?? parsedInput?.metadata?.avg_speed_kmph);
    return speed !== null && speed >= 100 && speed <= 150;
  }).length;
  const highButValidCapacityCount = vehicles.filter((v) => {
    const capacity = parseNumericLike(v?.capacity);
    return capacity !== null && capacity >= 12 && capacity <= 100;
  }).length;
  const diagnosticObjectiveCostWeight = findFirstNumericByKeys(parsedInput?.metadata, [
    'objective_cost_weight',
    'objectiveCostWeight',
    'cost_weight',
    'costWeight',
    'OBJECTIVE_COST_WEIGHT',
  ]);
  const diagnosticObjectiveTimeWeight = findFirstNumericByKeys(parsedInput?.metadata, [
    'objective_time_weight',
    'objectiveTimeWeight',
    'time_weight',
    'timeWeight',
    'OBJECTIVE_TIME_WEIGHT',
  ]);

  const missingRequiredItems = (() => {
    const src = parseReport?.missingRequired
      || parseReport?.missing_required
      || parseReport?.diagnostics?.missingRequired
      || parseReport?.diagnostics?.missing_required
      || parseReport?.validation?.missingRequired
      || [];
    return Array.isArray(src) ? src : [];
  })();

  const reportWarnings = Array.isArray(parseReport?.warnings) ? parseReport.warnings : [];
  const parserNotesSource = parseReport?.sanityChecks || parseReport?.sanity_checks || null;
  const parserNotes = (Array.isArray(parserNotesSource?.notes) ? parserNotesSource.notes : []).filter(Boolean);

  const diagnosticsErrors = [];
  const diagnosticsWarnings = [];
  const seenErrors = new Set();
  const seenWarnings = new Set();
  const detailLimitPerType = 8;
  const detailCount = {};
  const pushDetail = (bucket, seen, key, message) => {
    detailCount[key] = detailCount[key] || 0;
    if (detailCount[key] >= detailLimitPerType) return;
    detailCount[key] += 1;
    pushUniqueIssue(bucket, seen, message);
  };

  if (!parsedInput || typeof parsedInput !== 'object') {
    pushUniqueIssue(diagnosticsErrors, seenErrors, 'Parsed input is empty. Upload testcase and parse again.');
  }
  if (!employees.length) {
    pushUniqueIssue(diagnosticsErrors, seenErrors, 'No employees found in parsed input.');
  }
  if (!vehicles.length) {
    pushUniqueIssue(diagnosticsErrors, seenErrors, 'No vehicles found in parsed input.');
  }
  if (invalidCoordinatesCount > 0) {
    const details = [];
    if (invalidEmployeeCoordinatesCount > 0) {
      details.push(`${invalidEmployeeCoordinatesCount} employee(s)`);
    }
    if (invalidVehicleCoordinatesCount > 0) {
      details.push(`${invalidVehicleCoordinatesCount} vehicle(s)`);
    }
    pushUniqueIssue(diagnosticsErrors, seenErrors, `${invalidCoordinatesCount} coordinates are invalid or out of range (${details.join(', ')}).`);
  }
  if (duplicateIdsCount > 0) {
    const details = [];
    if (duplicateEmployeeIdsCount > 0) {
      details.push(`${duplicateEmployeeIdsCount} employee(s)`);
    }
    if (duplicateVehicleIdsCount > 0) {
      details.push(`${duplicateVehicleIdsCount} vehicle(s)`);
    }
    pushUniqueIssue(diagnosticsErrors, seenErrors, `${duplicateIdsCount} duplicate ID entries found (${details.join(', ')}).`);
    pushUniqueIssue(
      diagnosticsWarnings,
      seenWarnings,
      'Duplicate IDs are renumbered internally for solving. Source IDs should still be corrected in the testcase.'
    );
  }
  if (missingCapacityCount > 0) {
    pushUniqueIssue(diagnosticsErrors, seenErrors, `${missingCapacityCount} vehicles have missing/invalid capacity.`);
  }
  if (invalidTimeWindowCount > 0) {
    pushUniqueIssue(diagnosticsWarnings, seenWarnings, `${invalidTimeWindowCount} employees have invalid time window format/range (earliest pickup/latest drop).`);
  }
  if (infeasibleVehicleAvailabilityCount > 0) {
    pushUniqueIssue(diagnosticsWarnings, seenWarnings, `${infeasibleVehicleAvailabilityCount} employees cannot be served before latest drop with current vehicle availability.`);
  }
  if (
    employees.length > 100
    || uniqueLocationCount > 240
    || (vehicles.length > 25 && employees.length >= 70)
  ) {
    pushUniqueIssue(
      diagnosticsWarnings,
      seenWarnings,
      `Large but valid testcase detected (${employees.length} employees, ${vehicles.length} vehicles, ${uniqueLocationCount} unique locations). It will be shown in diagnostics and may run in large-case mode with a reduced free-tier search budget.`
    );
  }
  if (highButValidCostCount > 0) {
    pushUniqueIssue(
      diagnosticsWarnings,
      seenWarnings,
      `${highButValidCostCount} vehicle(s) use high but valid cost_per_km values. The testcase remains valid, but route scoring may become strongly cost-dominated.`
    );
  }
  if (highButValidSpeedCount > 0) {
    pushUniqueIssue(
      diagnosticsWarnings,
      seenWarnings,
      `${highButValidSpeedCount} vehicle(s) use high but valid speed values. Diagnostics will flag this so unusually optimistic travel times are visible.`
    );
  }
  if (highButValidCapacityCount > 0) {
    pushUniqueIssue(
      diagnosticsWarnings,
      seenWarnings,
      `${highButValidCapacityCount} vehicle(s) have large but valid capacity values. Diagnostics will show this because these inputs can materially change search behavior.`
    );
  }
  if (diagnosticObjectiveCostWeight !== null && diagnosticObjectiveCostWeight >= 0.95) {
    pushUniqueIssue(
      diagnosticsWarnings,
      seenWarnings,
      'Objective cost weight is very high but still valid. Diagnostics will show that routing may strongly prioritize cost over time.'
    );
  }
  if (diagnosticObjectiveTimeWeight !== null && diagnosticObjectiveTimeWeight >= 0.95) {
    pushUniqueIssue(
      diagnosticsWarnings,
      seenWarnings,
      'Objective time weight is very high but still valid. Diagnostics will show that routing may strongly prioritize time over cost.'
    );
  }

  employees.forEach((e, idx) => {
    const rowId = String(e?.id || e?.employee_id || `row-${idx + 1}`);
    const pickupLat = e?.pickup?.lat ?? e?.pickupLat ?? e?.pickup_lat;
    const pickupLng = e?.pickup?.lng ?? e?.pickupLng ?? e?.pickup_lng;
    const dropLat = e?.dropoff?.lat ?? e?.dropLat ?? e?.drop_lat;
    const dropLng = e?.dropoff?.lng ?? e?.dropLng ?? e?.drop_lng;
    const tw = e?.time_window || e?.timeWindow || null;
    const start = tw?.start ?? e?.earliest_pickup ?? e?.earliestPickup;
    const end = tw?.end ?? e?.latest_drop ?? e?.latestDrop;

    if (!String(e?.id || '').trim()) {
      pushDetail(diagnosticsErrors, seenErrors, 'emp-missing-id', `Employee row ${idx + 1} is missing id.`);
    }
    if (!isValidLatitude(pickupLat) || !isValidLongitude(pickupLng)) {
      pushDetail(diagnosticsErrors, seenErrors, 'emp-pickup-coord', `Employee ${rowId}: invalid pickup coordinates.`);
    }
    if (!isValidLatitude(dropLat) || !isValidLongitude(dropLng)) {
      pushDetail(diagnosticsErrors, seenErrors, 'emp-drop-coord', `Employee ${rowId}: invalid drop coordinates.`);
    }
    if (!start || !end) {
      pushDetail(diagnosticsWarnings, seenWarnings, 'emp-time-missing', `Employee ${rowId}: missing time window start/end.`);
    } else if (!parseWindow({ start: String(start), end: String(end) })) {
      pushDetail(diagnosticsErrors, seenErrors, 'emp-time-invalid', `Employee ${rowId}: invalid time window (${start}-${end}).`);
    }
  });

  vehicles.forEach((v, idx) => {
    const rowId = String(v?.id || v?.vehicle_id || `row-${idx + 1}`);
    const startLat = v?.start_location?.lat ?? v?.startLat ?? v?.start_lat ?? v?.current_lat ?? v?.lat;
    const startLng = v?.start_location?.lng ?? v?.startLng ?? v?.start_lng ?? v?.current_lng ?? v?.lng;
    const avail = v?.available_time ?? v?.availableTime ?? v?.available_from;
    const capacity = parseNumericLike(v?.capacity);

    if (!String(v?.id || '').trim()) {
      pushDetail(diagnosticsErrors, seenErrors, 'veh-missing-id', `Vehicle row ${idx + 1} is missing id.`);
    }
    if (!isValidLatitude(startLat) || !isValidLongitude(startLng)) {
      pushDetail(diagnosticsErrors, seenErrors, 'veh-start-coord', `Vehicle ${rowId}: invalid start location coordinates.`);
    }
    if (capacity === null || capacity <= 0) {
      pushDetail(diagnosticsErrors, seenErrors, 'veh-capacity', `Vehicle ${rowId}: capacity must be greater than 0.`);
    }
    if (avail && toMinutes(String(avail)) == null) {
      pushDetail(diagnosticsWarnings, seenWarnings, 'veh-available-time', `Vehicle ${rowId}: invalid available time (${avail}).`);
    }
  });

  missingRequiredItems.forEach((item) => {
    pushUniqueIssue(diagnosticsErrors, seenErrors, `Missing required: ${String(item)}`);
  });
  reportWarnings.forEach((item) => {
    pushUniqueIssue(diagnosticsWarnings, seenWarnings, String(item));
  });
  parserNotes.forEach((item) => {
    pushUniqueIssue(diagnosticsWarnings, seenWarnings, String(item));
  });

  const baselineObj = parsedInput?.baseline || parsedInput?.baseLine || parsedInput?.baselines || null;
  const baselineRows = toKeyValueRows(parsedInput?.baseline || parsedInput?.baseLine || parsedInput?.baselines);
  const baselineArrayRows = extractBaselineRows(baselineObj).map((row, idx) => ({
    ...row,
    employeeId: row.employeeId || employees[idx]?.id || `EMP_${idx + 1}`,
  }));

  if (baselineArrayRows.length && employees.length) {
    const baselineIds = new Set(
      baselineArrayRows
        .map((r) => String(r?.employeeId || '').trim())
        .filter(Boolean)
    );
    employees.forEach((e) => {
      const idVal = String(e?.id || '').trim();
      if (idVal && !baselineIds.has(idVal)) {
        pushDetail(diagnosticsWarnings, seenWarnings, 'baseline-missing-emp', `Baseline missing for employee ${idVal}.`);
      }
    });

    baselineArrayRows.forEach((r) => {
      const rowId = String(r?.employeeId || `row-${r.index}`);
      const cost = parseNumericLike(r?.baselineCost);
      const time = parseNumericLike(r?.baselineTimeMin);
      if (cost === null || time === null) {
        pushDetail(diagnosticsWarnings, seenWarnings, 'baseline-missing-values', `Baseline ${rowId}: missing cost/time.`);
      } else {
        if (cost < 0) pushDetail(diagnosticsErrors, seenErrors, 'baseline-negative-cost', `Baseline ${rowId}: cost cannot be negative.`);
        if (time < 0) pushDetail(diagnosticsErrors, seenErrors, 'baseline-negative-time', `Baseline ${rowId}: time cannot be negative.`);
      }
    });
  }

  const baselineCostTotal = baselineArrayRows.reduce((sum, row) => sum + (parseNumericLike(row.baselineCost) ?? 0), 0);
  const baselineTimeTotal = baselineArrayRows.reduce((sum, row) => sum + (parseNumericLike(row.baselineTimeMin) ?? 0), 0);
  const baselineCost = baselineArrayRows.length
    ? baselineCostTotal
    : (findFirstNumericByKeys(baselineObj, ['cost']) ?? parseNumericLike(resultMetrics?.baselineCost) ?? null);
  const baselineTimeMins = baselineArrayRows.length
    ? baselineTimeTotal
    : (findFirstNumericByKeys(baselineObj, ['time']) ?? parseNumericLike(resultMetrics?.baselineTimeMinutes) ?? null);

  const rides = Array.isArray(resultPayload?.rides) ? resultPayload.rides : [];

  const officeCenter = (() => {
    const depot = parsedInput?.depot;
    if (depot && typeof depot.lat === 'number' && typeof depot.lng === 'number') {
      return { lat: depot.lat, lng: depot.lng };
    }
    const payloadDepot = resultPayload?.depot;
    if (payloadDepot && typeof payloadDepot.lat === 'number' && typeof payloadDepot.lng === 'number') {
      return { lat: payloadDepot.lat, lng: payloadDepot.lng };
    }
    const fromRides = rides.find((r) => Array.isArray(r?.path) && r.path.length)?.path?.slice(-1)?.[0];
    if (fromRides && Number.isFinite(Number(fromRides.lat)) && Number.isFinite(Number(fromRides.lng))) {
      return { lat: Number(fromRides.lat), lng: Number(fromRides.lng) };
    }
    const firstOffice = employees.find((e) => typeof e?.officeLat === 'number' && typeof e?.officeLng === 'number');
    if (firstOffice) return { lat: firstOffice.officeLat, lng: firstOffice.officeLng };
    return null;
  })();

  const mapVehiclesFromParsed = vehiclesWithDisplayIds.map((v, idx) => {
    const startLat = Number(
      v?.start_location?.lat
      ?? v?.startLocation?.lat
      ?? v?.startLat
      ?? v?.start_lat
      ?? v?.lat
    );
    const startLng = Number(
      v?.start_location?.lng
      ?? v?.startLocation?.lng
      ?? v?.startLng
      ?? v?.start_lng
      ?? v?.lng
    );
    return {
      id: String(v?.displayId || v?.id || `VEH_${idx + 1}`),
      type: String(v?.displayId || v?.type || 'Vehicle'),
      startLat,
      startLng,
    };
  }).filter((v) => Number.isFinite(v.startLat) && Number.isFinite(v.startLng));

  const mapVehiclesFromResults = rides.map((ride, idx) => {
    const start = Array.isArray(ride?.path) && ride.path.length ? ride.path[0] : null;
    const startLat = Number(start?.lat ?? officeCenter?.lat ?? 0);
    const startLng = Number(start?.lng ?? officeCenter?.lng ?? 0);
    return {
      id: String(ride?.vehicleId || `VEH_${idx + 1}`),
      type: String(ride?.vehicleId || 'Vehicle'),
      startLat,
      startLng,
    };
  }).filter((v) => Number.isFinite(v.startLat) && Number.isFinite(v.startLng));

  const mapVehicles = (mapVehiclesFromParsed.length ? mapVehiclesFromParsed : mapVehiclesFromResults)
    .map((v) => ({
      ...v,
      startLat: Number.isFinite(v.startLat) ? v.startLat : Number(officeCenter?.lat),
      startLng: Number.isFinite(v.startLng) ? v.startLng : Number(officeCenter?.lng),
    }))
    .filter((v) => Number.isFinite(v.startLat) && Number.isFinite(v.startLng));

  const employeeVehicleIdFromResults = rides.reduce((acc, ride) => {
    const vehicleId = String(ride?.vehicleId || '').trim();
    if (!vehicleId) return acc;

    const assignedEmployees = Array.isArray(ride?.assignedEmployees) ? ride.assignedEmployees : [];
    assignedEmployees.forEach((employeeId) => {
      const id = String(employeeId || '').trim();
      if (id) acc[id] = vehicleId;
    });

    const path = Array.isArray(ride?.path) ? ride.path : [];
    path.forEach((stop) => {
      if (String(stop?.type || '').toLowerCase() !== 'pickup') return;
      const employeeId = String(stop?.employeeId || '').trim();
      if (employeeId) acc[employeeId] = vehicleId;
    });

    return acc;
  }, {});

  const fallbackVehicleId = mapVehicles[0]?.id || 'VEH_01';
  const mapEmployeesFromParsed = employeesWithDisplayIds.map((e, idx) => {
    const lat = Number(
      e?.pickup?.lat
      ?? e?.pickupLat
      ?? e?.pickup_lat
      ?? e?.lat
    );
    const lng = Number(
      e?.pickup?.lng
      ?? e?.pickupLng
      ?? e?.pickup_lng
      ?? e?.lng
    );
    const pickupTimeValue = (
      e?.time_window?.start
      ?? e?.timeWindow?.start
      ?? e?.earliest_pickup
      ?? e?.earliestPickup
      ?? e?.pickupTime
    );
    const resolvedVehicleId = (
      employeeVehicleIdFromResults[String(e?.id || '').trim()]
      ?? e?.assignedVehicle
      ?? e?.assigned_vehicle
      ?? e?.vehicleId
      ?? null
    );
    const vehicleId = resolvedVehicleId ? String(resolvedVehicleId) : fallbackVehicleId;
    return {
      id: String(e?.displayId || e?.id || `EMP_${idx + 1}`),
      lat,
      lng,
      vehicleId,
      pickupTime: pickupTimeValue ? String(pickupTimeValue) : '',
      delay: 0,
      status: resolvedVehicleId ? 'Assigned' : 'Unassigned',
    };
  }).filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng));

  const mapEmployeesFromResults = rides.flatMap((ride) => (
    (Array.isArray(ride?.path) ? ride.path : [])
      .filter((stop) => stop?.type === 'pickup')
      .map((stop, idx) => ({
        id: String(stop?.employeeId || `${ride?.vehicleId || 'VEH'}_EMP_${idx + 1}`),
        lat: Number(stop?.lat),
        lng: Number(stop?.lng),
        vehicleId: String(ride?.vehicleId || fallbackVehicleId),
        pickupTime: String(stop?.plannedPickupTime || stop?.time || ''),
        delay: 0,
        status: ride?.feasible ? 'Assigned' : 'Issue',
      }))
  )).filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng));

  const mapEmployees = mapEmployeesFromParsed.length ? mapEmployeesFromParsed : mapEmployeesFromResults;

  const timelineEvents = rides.flatMap((ride) => {
    const vehicleId = String(ride?.vehicleId || 'VEH');
    const path = Array.isArray(ride?.path) ? ride.path : [];
    const availabilityMinute = readMinuteByKeys(ride, [
      'availabilityMinute',
      'availability_minute',
      'availabilityTime',
      'availability_time',
      'availableMinute',
      'available_minute',
      'availableTime',
      'startMinute',
      'start_minute',
      'startTime',
      'start_time',
    ]);
    const fallbackMinute = Number.isFinite(availabilityMinute) ? availabilityMinute : (8 * 60);
    let cursorMinute = fallbackMinute;

    return path.map((stop, idx) => {
      const explicitMinute = readMinuteByKeys(stop, [
        'arrivalMinute',
        'arrival_minute',
        'minute',
        'minutes',
        'timeMinute',
        'timeMinutes',
        'arrivalTime',
        'time',
        'plannedPickupTime',
        'plannedDropoffTime',
        'eta',
        'timestamp',
      ]);
      if (Number.isFinite(explicitMinute)) {
        cursorMinute = Math.max(cursorMinute, explicitMinute);
      } else if (idx === 0) {
        cursorMinute = fallbackMinute;
      } else {
        cursorMinute += 5;
      }

      const type = String(stop?.type || '').toLowerCase();
      const employeeId = stop?.employeeId ? String(stop.employeeId) : null;
      const label = type === 'pickup'
        ? 'Picked up'
        : (type === 'dropoff' || type === 'drop' ? 'Dropped' : 'Moved');
      return {
        vehicleId,
        employeeId,
        type,
        label,
        minute: cursorMinute,
        lat: Number(stop?.lat),
        lng: Number(stop?.lng),
      };
    });
  }).sort((a, b) => (a.minute ?? 1e9) - (b.minute ?? 1e9));

  const metadata = (parsedInput?.metadata && typeof parsedInput.metadata === 'object') ? parsedInput.metadata : {};
  const resolveObjectiveWeights = (meta = {}) => {
    const costRaw = parseNumericLike(
      meta.objective_cost_weight
      ?? meta.objectiveCostWeight
      ?? meta.cost_weight
      ?? meta.costWeight
      ?? meta.OBJECTIVE_COST_WEIGHT
      ?? meta.OBJECTIVECOSTWEIGHT
      ?? null
    );
    const timeRaw = parseNumericLike(
      meta.objective_time_weight
      ?? meta.objectiveTimeWeight
      ?? meta.time_weight
      ?? meta.timeWeight
      ?? meta.OBJECTIVE_TIME_WEIGHT
      ?? meta.OBJECTIVETIMEWEIGHT
      ?? null
    );

    const clampNonNegative = (v) => (Number.isFinite(v) ? Math.max(0, v) : null);
    const cost = clampNonNegative(costRaw);
    const time = clampNonNegative(timeRaw);

    if (cost !== null && time !== null) {
      const sum = cost + time;
      if (sum > 0) return { cost: cost / sum, time: time / sum };
      return { cost: 0.5, time: 0.5 };
    }
    if (cost !== null) {
      const c = Math.min(1, cost);
      return { cost: c, time: 1 - c };
    }
    if (time !== null) {
      const t = Math.min(1, time);
      return { cost: 1 - t, time: t };
    }
    return { cost: 0.5, time: 0.5 };
  };
  const objectiveWeightsFromResult = (
    resultPayload?.objectiveWeights && typeof resultPayload.objectiveWeights === 'object'
  )
    ? {
      objective_cost_weight: resultPayload.objectiveWeights.cost,
      objective_time_weight: resultPayload.objectiveWeights.time,
    }
    : null;
  const objectiveWeightSources = [
    objectiveWeightsFromResult,
    resultPayload?.solverConfig,
    metadata,
  ];
  let objectiveWeights = { cost: 0.5, time: 0.5 };
  for (const source of objectiveWeightSources) {
    if (!source || typeof source !== 'object') continue;
    const resolved = resolveObjectiveWeights(source);
    if (Number.isFinite(resolved.cost) && Number.isFinite(resolved.time)) {
      objectiveWeights = resolved;
      const hasExplicit = (
        source.objective_cost_weight != null
        || source.objectiveCostWeight != null
        || source.cost_weight != null
        || source.costWeight != null
        || source.OBJECTIVE_COST_WEIGHT != null
        || source.OBJECTIVECOSTWEIGHT != null
        || source.objective_time_weight != null
        || source.objectiveTimeWeight != null
        || source.time_weight != null
        || source.timeWeight != null
        || source.OBJECTIVE_TIME_WEIGHT != null
        || source.OBJECTIVETIMEWEIGHT != null
      );
      if (hasExplicit) break;
    }
  }
  const resultDistanceMode = (resultPayload?.distance && typeof resultPayload.distance === 'object')
    ? resultPayload.distance
    : {};
  const requestedDistanceRaw = (
    projectRunConfig?.distanceMetric
    ?? projectRunConfig?.distance_metric
    ?? resultPayload?.solverConfig?.distanceMetric
    ?? resultPayload?.solverConfig?.distance_metric
    ?? metadata.distance_metric
    ?? metadata.distanceMetric
    ?? metadata.distance_method
    ?? metadata.distanceMethod
  );
  const requestedDistanceMetric = normalizeDistanceMode(requestedDistanceRaw);
  const resultDistanceMetric = normalizeDistanceMode(
    resultDistanceMode.metric
    ?? resultDistanceMode.method
  );
  const resultDistanceBackend = normalizeDistanceMode(resultDistanceMode.backend);
  const resolvedDistanceMetric = resultDistanceMetric || resultDistanceBackend || requestedDistanceMetric || 'osrm';
  const resolvedDistanceBackend = resultDistanceBackend || resultDistanceMetric || requestedDistanceMetric || 'osrm';
  const distanceSource = (resultDistanceMetric || resultDistanceBackend)
    ? 'engine_result'
    : (requestedDistanceMetric ? 'parsed_metadata' : 'default');
  const strictRoad = typeof resultDistanceMode.strictRoad === 'boolean'
    ? resultDistanceMode.strictRoad
    : null;
  const osrmBaseUrl = typeof resultDistanceMode.osrmBaseUrl === 'string' && resultDistanceMode.osrmBaseUrl.trim()
    ? resultDistanceMode.osrmBaseUrl.trim()
    : null;
  const osrmProfile = typeof resultDistanceMode.osrmProfile === 'string' && resultDistanceMode.osrmProfile.trim()
    ? resultDistanceMode.osrmProfile.trim()
    : null;
  const distanceInfo = {
    requestedMetric: requestedDistanceMetric || null,
    requestedLabel: requestedDistanceMetric ? distanceModeLabel(requestedDistanceMetric) : 'Default',
    metric: resolvedDistanceMetric,
    metricLabel: distanceModeLabel(resolvedDistanceMetric),
    backend: resolvedDistanceBackend,
    backendLabel: distanceModeLabel(resolvedDistanceBackend),
    source: distanceSource,
    strictRoad,
    osrmBaseUrl,
    osrmProfile,
    usesRoadDistance: resolvedDistanceMetric === 'osrm' || resolvedDistanceBackend === 'osrm',
  };

  const objectiveCostWeight = objectiveWeights.cost;
  const objectiveTimeWeight = objectiveWeights.time;

  const delayMinutesByEmployee = rides.reduce((acc, ride) => {
    const m = ride?.metrics?.employeeDelayMinutes;
    if (m && typeof m === 'object') {
      Object.entries(m).forEach(([empId, val]) => {
        const n = Number(val);
        if (!Number.isFinite(n)) return;
        acc[empId] = (acc[empId] || 0) + Math.max(0, n);
      });
    }
    return acc;
  }, {});

  const delayMinutesValues = Object.values(delayMinutesByEmployee).filter((n) => Number.isFinite(n));
  const derivedTotalDelayMinutes = delayMinutesValues.reduce((s, n) => s + n, 0);
  const totalDelayMinutes = (() => {
    const candidates = [
      resultMetrics?.totalDelayMinutes,
      resultMetrics?.delayMinutes,
      resultMetrics?.delayTimeMinutes,
      resultPayload?.metrics?.totalDelayMinutes,
      resultPayload?.metrics?.delayMinutes,
    ];
    for (const c of candidates) {
      const n = parseNumericLike(c);
      if (n !== null) return n;
    }
    return derivedTotalDelayMinutes;
  })();
  const delayCostPerMinute = parseNumericLike(resultMetrics?.delayCostPerMinute) ?? 1;

  const delayCost = (() => {
    const candidates = [
      resultMetrics?.delayCost,
      resultMetrics?.delayPenalty,
      resultMetrics?.totalDelayCost,
    ];
    for (const c of candidates) {
      const n = parseNumericLike(c);
      if (n !== null) return n;
    }
    return totalDelayMinutes * delayCostPerMinute;
  })();

  const totalTimeMinutes = (() => {
    const candidates = [
      resultMetrics?.totalTimeMinutes,
      resultMetrics?.timeMinutes,
      resultMetrics?.totalTime,
      resultPayload?.metrics?.totalTimeMinutes,
      resultPayload?.metrics?.timeMinutes,
      resultPayload?.metrics?.totalTime,
    ];
    for (const c of candidates) {
      const n = parseNumericLike(c);
      if (n !== null) return n;
    }
    const rideTotal = rides.reduce((sum, ride) => {
      const n = parseNumericLike(ride?.metrics?.totalTimeMinutes ?? ride?.metrics?.totalTime ?? ride?.totalTimeMinutes ?? ride?.totalTime);
      return sum + (n || 0);
    }, 0);
    return rideTotal;
  })();

  const vehicleUsageCost = (() => {
    const candidates = [
      resultMetrics?.vehicleUsageCost,
      resultMetrics?.fixedVehicleCost,
      resultMetrics?.usageCost,
    ];
    for (const c of candidates) {
      const n = parseNumericLike(c);
      if (n !== null) return n;
    }
    return mapVehicles.length * 50;
  })();

  const weightedCostBase = (() => {
    const candidates = [
      resultMetrics?.totalSystemCost,
      resultMetrics?.totalCost,
      resultPayload?.metrics?.totalSystemCost,
      resultPayload?.metrics?.totalCost,
      resultMetrics?.operationalCost,
      resultMetrics?.travelCost,
      resultMetrics?.fuelCost,
    ];
    for (const c of candidates) {
      const n = parseNumericLike(c);
      if (n !== null) return n;
    }
    return 0;
  })();

  const operationalCost = (() => {
    const candidates = [
      resultMetrics?.operationalCost,
      resultMetrics?.travelCost,
      resultMetrics?.fuelCost,
    ];
    for (const c of candidates) {
      const n = parseNumericLike(c);
      if (n !== null) return n;
    }
    return weightedCostBase;
  })();

  const finalObjective = (() => {
    const payloadObjective = parseNumericLike(resultPayload?.objectiveScore);
    if (payloadObjective !== null) return payloadObjective;
    return (
      (weightedCostBase * objectiveCostWeight)
      + (totalTimeMinutes * objectiveTimeWeight)
    );
  })();

  const rideCostRows = rides.map((ride, idx) => {
    const total = parseNumericLike(ride?.metrics?.cost) ?? parseNumericLike(ride?.cost) ?? 0;
    const delayMinForRide = Object.values(ride?.metrics?.employeeDelayMinutes || {}).reduce((s, n) => s + (Number(n) || 0), 0);
    const rideDelayCost = Math.max(0, delayMinForRide * delayCostPerMinute);
    const rideUsage = Math.max(0, vehicleUsageCost / Math.max(1, rides.length || mapVehicles.length || 1));
    const rideOperational = Math.max(0, total ? (total - rideDelayCost - rideUsage) : (operationalCost / Math.max(1, rides.length || mapVehicles.length || 1)));
    const rideTimeMinutes = parseNumericLike(ride?.metrics?.totalTimeMinutes ?? ride?.metrics?.totalTime ?? ride?.totalTimeMinutes ?? ride?.totalTime) ?? 0;
    const rideObjective = (
      (rideOperational * objectiveCostWeight)
      + (rideTimeMinutes * objectiveTimeWeight)
    );
    const rideTotal = total || (rideOperational + rideDelayCost + rideUsage);
    const opPct = Math.max(5, Math.round((rideOperational / Math.max(1, rideTotal)) * 100));
    const delayPct = Math.max(0, Math.round((rideDelayCost / Math.max(1, rideTotal)) * 100));
    const usagePct = Math.max(0, Math.min(100, 100 - opPct - delayPct));
    return {
      id: String(ride?.vehicleId || mapVehicles[idx]?.id || `VEH_${idx + 1}`),
      totalValue: Math.max(0, rideObjective),
      totalLabel: formatMoney(rideTotal),
      opValue: rideOperational,
      totalTimeMinutesValue: rideTimeMinutes,
      delayMinutesValue: Math.max(0, delayMinForRide),
      delayCostValue: Math.max(0, rideDelayCost),
      op: opPct,
      delay: delayPct,
      usage: usagePct,
    };
  });

  const vehicleStacks = rideCostRows.length ? rideCostRows : mapVehicles.map((v, idx) => {
    const share = Math.max(1, finalObjective / Math.max(1, mapVehicles.length));
    return {
      id: v.id || `VEH_${idx + 1}`,
      totalValue: share,
      totalLabel: formatMoney(share),
      opValue: share * 0.7,
      totalTimeMinutesValue: Math.max(0, totalTimeMinutes / Math.max(1, mapVehicles.length)),
      delayMinutesValue: Math.max(0, totalDelayMinutes / Math.max(1, mapVehicles.length)),
      delayCostValue: share * 0.2,
      op: 70,
      delay: 20,
      usage: 10,
    };
  });

  const vehicleObjectiveRows = vehicleStacks
    .map((row) => ({
      id: row.id,
      objectiveValue: Number(row.totalValue) || 0,
      objectiveLabel: formatObjectiveValue(Number(row.totalValue) || 0),
    }))
    .sort((a, b) => b.objectiveValue - a.objectiveValue);

  const vehicleOperationalRows = vehicleStacks
    .map((row) => ({
      id: row.id,
      operationalValue: Number(row.opValue) || 0,
      operationalLabel: formatMoney(Number(row.opValue) || 0),
    }))
    .sort((a, b) => b.operationalValue - a.operationalValue);

  const vehicleDelayTimeRows = vehicleStacks
    .map((row) => ({
      id: row.id,
      delayMinutesValue: Number(row.delayMinutesValue) || 0,
      delayTimeLabel: `${Math.round(Number(row.delayMinutesValue) || 0).toLocaleString('en-US')} min`,
    }))
    .sort((a, b) => b.delayMinutesValue - a.delayMinutesValue);

  const vehicleDelayCostRows = vehicleStacks
    .map((row) => ({
      id: row.id,
      delayCostValue: Number(row.delayCostValue) || 0,
      delayCostLabel: formatMoney(Number(row.delayCostValue) || 0),
    }))
    .sort((a, b) => b.delayCostValue - a.delayCostValue);

  const vehicleTotalTimeRows = vehicleStacks
    .map((row) => ({
      id: row.id,
      totalTimeMinutesValue: Number(row.totalTimeMinutesValue) || 0,
      totalTimeLabel: `${Math.round(Number(row.totalTimeMinutesValue) || 0).toLocaleString('en-US')} min`,
    }))
    .sort((a, b) => b.totalTimeMinutesValue - a.totalTimeMinutesValue);

  const bucketLimits = [5, 10, 20, 30, 45, Number.POSITIVE_INFINITY];
  const histogramRaw = [0, 0, 0, 0, 0, 0];
  delayMinutesValues.forEach((min) => {
    const idx = bucketLimits.findIndex((b) => min <= b);
    histogramRaw[idx === -1 ? histogramRaw.length - 1 : idx] += 1;
  });
  const maxBucket = Math.max(1, ...histogramRaw);
  const histogram = histogramRaw.map((count) => Math.max(count ? Math.round((count / maxBucket) * 100) : 0, count ? 20 : 12));
  const maxVehicleDelayMinutes = Math.max(1, ...vehicleStacks.map((row) => Number(row.delayMinutesValue) || 0));
  const delayByVehicleGraph = vehicleStacks
    .map((row) => {
      const delayMinutes = Number(row.delayMinutesValue) || 0;
      return {
        id: String(row.id || 'VEH'),
        delayMinutes,
        heightPct: delayMinutes > 0 ? Math.round((delayMinutes / maxVehicleDelayMinutes) * 100) : 0,
      };
    })
    .sort((a, b) => b.delayMinutes - a.delayMinutes);

  // Create delay distribution for employees (include all employees, default 0 min)
  const employeeDelayArray = Array.from(
    new Set(
      (employees || [])
        .map((emp, idx) => String(emp?.id || `EMP_${idx + 1}`))
        .filter((id) => id && id.toLowerCase() !== 'company')
    )
  ).map((empId) => ({
    id: empId,
    delayMinutes: Number(delayMinutesByEmployee[empId]) || 0,
  }));
  const maxEmployeeDelayMinutes = employeeDelayArray.length
    ? Math.max(0, ...employeeDelayArray.map((row) => row.delayMinutes))
    : 0;
  const delayByEmployeeGraph = employeeDelayArray
    .map((row) => ({
      id: String(row.id || 'EMP'),
      delayMinutes: row.delayMinutes,
      heightPct: maxEmployeeDelayMinutes > 0
        ? Math.round((row.delayMinutes / maxEmployeeDelayMinutes) * 100)
        : 0,
    }))
    .sort((a, b) => b.delayMinutes - a.delayMinutes);

  const pareto = vehicleObjectiveRows
    .filter((row) => row.objectiveValue > 0)
    .slice(0, 3)
    .map((row) => ({
      id: row.id,
      pct: Math.max(1, Math.round((row.objectiveValue / Math.max(1, finalObjective)) * 100)),
    }));
  const finalPareto = pareto.length ? pareto : [{ id: 'N/A', pct: 0 }];

  // Compute per-employee contribution using trip-level cost allocation:
  // for each trip within a vehicle route, take trip cost from the vehicle start/
  // current empty state until the route returns to empty load, then divide that
  // trip cost equally among employees involved in that trip.
  const employeeIdsOrdered = employeesWithDisplayIds.map((e, idx) => String(e?.displayId || e?.id || `EMP_${idx + 1}`));
  const employeeContribution = {};
  employeeIdsOrdered.forEach((id) => { employeeContribution[id] = 0; });

  rides.forEach((ride) => {
    const path = Array.isArray(ride?.path) ? ride.path : [];
    if (!path.length) return;

    const routeCost = parseNumericLike(ride?.metrics?.cost ?? ride?.cost);
    const routeDistance = parseNumericLike(
      ride?.metrics?.totalDistanceKm
      ?? ride?.metrics?.totalDistance
      ?? ride?.totalDistanceKm
      ?? ride?.totalDistance
    );

    const trips = [];
    let onboard = new Set();
    let tripEmployees = new Set();
    let tripDistance = 0;
    let inTrip = false;

    const flushTrip = () => {
      if (!inTrip) return;
      const employeeIds = Array.from(tripEmployees).filter(Boolean);
      if (employeeIds.length) {
        trips.push({
          employeeIds,
          distanceKm: Math.max(0, tripDistance),
        });
      }
      onboard = new Set();
      tripEmployees = new Set();
      tripDistance = 0;
      inTrip = false;
    };

    path.forEach((stop) => {
      const type = String(stop?.type || '').trim().toLowerCase();
      const employeeId = String(stop?.employeeId || '').trim();
      const distanceFromPrev = Math.max(
        0,
        parseNumericLike(
          stop?.distanceFromPrevKm
          ?? stop?.distanceFromPrev
          ?? stop?.distanceKm
          ?? 0
        ) ?? 0
      );

      if (type === 'pickup') {
        if (!inTrip) inTrip = true;
        tripDistance += distanceFromPrev;
        if (employeeId) {
          onboard.add(employeeId);
          tripEmployees.add(employeeId);
        }
        return;
      }

      if (type === 'dropoff' || type === 'drop') {
        if (!inTrip) inTrip = true;
        tripDistance += distanceFromPrev;
        if (employeeId) {
          tripEmployees.add(employeeId);
          onboard.delete(employeeId);
        }
        if (onboard.size === 0) {
          flushTrip();
        }
        return;
      }

      if (inTrip) {
        tripDistance += distanceFromPrev;
      }
    });

    flushTrip();
    if (!trips.length) return;

    const totalTripDistance = trips.reduce((sum, trip) => sum + (Number(trip.distanceKm) || 0), 0);
    trips.forEach((trip) => {
      let tripCost;
      if (Number.isFinite(routeCost)) {
        tripCost = totalTripDistance > 0
          ? (routeCost * (trip.distanceKm / totalTripDistance))
          : (routeCost / Math.max(1, trips.length));
      } else if (Number.isFinite(routeDistance) && routeDistance > 0) {
        tripCost = trip.distanceKm / routeDistance;
      } else {
        tripCost = trip.distanceKm;
      }

      const share = (Number(tripCost) || 0) / Math.max(1, trip.employeeIds.length);
      trip.employeeIds.forEach((id) => {
        if (!employeeContribution[id]) employeeContribution[id] = 0;
        employeeContribution[id] += share;
      });
    });
  });

  const employeeObjectiveRows = Object.entries(employeeContribution)
    .map(([id, objectiveValue]) => ({
      id,
      objectiveValue: Number(objectiveValue) || 0,
      objectiveLabel: formatObjectiveValue(Number(objectiveValue) || 0),
    }))
    .sort((a, b) => b.objectiveValue - a.objectiveValue);

  const totalEmployeeContribution = employeeObjectiveRows.reduce(
    (sum, row) => sum + (Number(row.objectiveValue) || 0),
    0
  );

  const paretoEmployees = (() => {
    const allEmployeeIds = Array.from(
      new Set(
        (employees || [])
          .map((emp) => String(emp?.id || '').trim())
          .filter((id) => id && id.toLowerCase() !== 'company')
      )
    );

    const contributionById = new Map(
      employeeObjectiveRows.map((row) => [String(row.id), Number(row.objectiveValue) || 0])
    );

    const rows = (allEmployeeIds.length ? allEmployeeIds : employeeObjectiveRows.map((row) => row.id))
      .map((id) => ({
        id,
        objectiveValue: contributionById.get(id) || 0,
      }))
      .sort((a, b) => b.objectiveValue - a.objectiveValue);

    if (!rows.length) return [{ id: 'N/A', costValue: 0, costLabel: formatMoney(0), widthPct: 0 }];

    const objectiveValues = rows.map((row) => Number(row.objectiveValue) || 0);
    const maxObjectiveValue = objectiveValues.reduce((max, v) => Math.max(max, v), 0);
    const minObjectiveValue = objectiveValues.reduce((min, v) => Math.min(min, v), Number.POSITIVE_INFINITY);
    const hasRange = Number.isFinite(minObjectiveValue) && maxObjectiveValue > minObjectiveValue;
    return rows.map((row) => {
      const objectiveValue = Number(row.objectiveValue) || 0;
      let widthPct = 20;
      if (rows.length === 1) {
        widthPct = 100;
      } else if (hasRange) {
        const normalized = (objectiveValue - minObjectiveValue) / (maxObjectiveValue - minObjectiveValue);
        widthPct = Math.round(20 + (normalized * 80));
      } else if (maxObjectiveValue > 0) {
        widthPct = 100;
      }
      return {
        id: row.id,
        costValue: objectiveValue,
        costLabel: formatMoney(objectiveValue),
        widthPct,
      };
    });
  })();

  const costBreakdownData = {
    totalObjectiveLabel: formatObjectiveValue(finalObjective),
    totalObjectiveValue: Number.isFinite(finalObjective) ? finalObjective : null,
    operationalCostLabel: formatMoney(operationalCost),
    delayTimeLabel: Number.isFinite(totalDelayMinutes) ? `${Math.round(totalDelayMinutes).toLocaleString('en-US')} min` : '—',
    totalTimeLabel: Number.isFinite(totalTimeMinutes) ? `${Math.round(totalTimeMinutes).toLocaleString('en-US')} min` : '—',
    vehicleUsageCostLabel: formatMoney(vehicleUsageCost),
    topVehicleObjectives: vehicleObjectiveRows.slice(0, 3),
    vehicleObjectiveCount: vehicleObjectiveRows.length,
    topVehicleOperationalCosts: vehicleOperationalRows.slice(0, 3),
    vehicleOperationalCount: vehicleOperationalRows.length,
    topVehicleDelayTimes: vehicleDelayTimeRows.slice(0, 3),
    vehicleDelayTimeCount: vehicleDelayTimeRows.length,
    topVehicleDelayCosts: vehicleDelayCostRows.slice(0, 3),
    vehicleDelayCostCount: vehicleDelayCostRows.length,
    topVehicleTotalTimes: vehicleTotalTimeRows.slice(0, 3),
    vehicleTotalTimeCount: vehicleTotalTimeRows.length,
    vehicleStacks,
    delayByVehicleGraph,
    delayByEmployeeGraph,
    delayByEmployeeMaxMinutes: maxEmployeeDelayMinutes,
    histogram,
    pareto: finalPareto,
    paretoEmployees,
  };

  return {
    employees,
    vehicles,
    flattenedVehicles,
    employeeColumns,
    vehicleColumns,
    filteredEmployees,
    invalidCoordinatesCount,
    duplicateIdsCount,
    invalidTimeWindowCount,
    missingCapacityCount,
    baselineRows,
    baselineArrayRows,
    baselineCostTotal,
    baselineTimeTotal,
    baselineCost,
    baselineTimeMins,
    rides,
    officeCenter,
    mapVehicles,
    mapEmployees,
    timelineEvents,
    distanceInfo,
    diagnosticsErrors,
    diagnosticsWarnings,
    costBreakdownData,
  };
}

export { deriveWorkflowData };
