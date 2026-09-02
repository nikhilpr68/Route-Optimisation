import { extractMinuteFromValue, parseNumericLike } from '../helpers';

const ROUTE_STATE_META = {
  idle: { label: 'Idle', color: '#64748b' },
  travel: { label: 'Travel', color: '#3b82f6' },
  occupied: { label: 'Occupied', color: '#7c3aed' },
  pickup: { label: 'Pickup', color: '#16a34a' },
  dropoff: { label: 'Dropoff', color: '#f97316' },
  unknown: { label: 'Unknown', color: '#64748b' },
};

const ROUTE_STATE_ORDER = ['idle', 'travel', 'occupied', 'pickup', 'dropoff', 'unknown'];

function normalizeEmployeeIds(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  values.forEach((value) => {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

function diffEmployeeIds(source = [], minus = []) {
  const sourceIds = normalizeEmployeeIds(source);
  const minusSet = new Set(normalizeEmployeeIds(minus));
  return sourceIds.filter((id) => !minusSet.has(id));
}

function normalizeVehicleState(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (raw.includes('pick')) return 'pickup';
  if (raw.includes('drop')) return 'dropoff';
  if (raw.includes('idle') || raw.includes('wait') || raw.includes('park')) return 'idle';
  if (
    raw.includes('occup')
    || raw.includes('board')
    || raw.includes('passenger')
    || raw.includes('service')
  ) return 'occupied';
  if (
    raw.includes('travel')
    || raw.includes('drive')
    || raw.includes('move')
    || raw.includes('route')
    || raw.includes('transit')
    || raw.includes('enroute')
    || raw.includes('en_route')
  ) return 'travel';
  return 'unknown';
}

function valueToMinute(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 10_000_000_000) {
      const asDate = new Date(value);
      if (!Number.isNaN(asDate.getTime())) return (asDate.getHours() * 60) + asDate.getMinutes();
    }
    if (value > 1_000_000_000) {
      const asDate = new Date(value * 1000);
      if (!Number.isNaN(asDate.getTime())) return (asDate.getHours() * 60) + asDate.getMinutes();
    }
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value.trim());
    if (value.trim() && Number.isFinite(numeric)) return valueToMinute(numeric);
    return extractMinuteFromValue(value);
  }
  return null;
}

function readMinuteByKeys(source, keys = []) {
  for (const key of keys) {
    const value = key.includes('.')
      ? key.split('.').reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), source)
      : source?.[key];
    const minute = valueToMinute(value);
    if (minute !== null) return minute;
  }
  return null;
}

function mergeTimelineSegments(segments = []) {
  const cleaned = (Array.isArray(segments) ? segments : [])
    .map((seg) => ({
      ...seg,
      state: normalizeVehicleState(seg?.state),
      startMinute: Number(seg?.startMinute),
      endMinute: Number(seg?.endMinute),
      employeeId: seg?.employeeId ? String(seg.employeeId) : null,
      employeesOnboard: normalizeEmployeeIds(seg?.employeesOnboard),
      employeesOnboardBefore: normalizeEmployeeIds(seg?.employeesOnboardBefore),
      employeesOnboardAfter: normalizeEmployeeIds(seg?.employeesOnboardAfter),
      isEvent: Boolean(seg?.isEvent),
    }))
    .filter((seg) => Number.isFinite(seg.startMinute) && Number.isFinite(seg.endMinute) && seg.endMinute > seg.startMinute)
    .sort((a, b) => a.startMinute - b.startMinute);

  const merged = [];
  cleaned.forEach((seg) => {
    const last = merged[merged.length - 1];
    const sameOnboard = JSON.stringify(last?.employeesOnboard || []) === JSON.stringify(seg.employeesOnboard || []);
    if (
      last
      && !seg.isEvent
      && !last.isEvent
      && last.state === seg.state
      && sameOnboard
      && seg.startMinute <= (last.endMinute + 1)
    ) {
      last.endMinute = Math.max(last.endMinute, seg.endMinute);
      return;
    }
    merged.push({ ...seg, label: seg.label || ROUTE_STATE_META[seg.state]?.label || 'State' });
  });
  return merged;
}

function sortTimelineSegments(segments = []) {
  return [...segments].sort((a, b) => (
    (Number(a?.startMinute) - Number(b?.startMinute))
    || ((a?.isEvent === b?.isEvent) ? 0 : (a?.isEvent ? -1 : 1))
    || (Number(a?.endMinute) - Number(b?.endMinute))
  ));
}

function ensureNonOverlappingSegments(segments = []) {
  const ordered = sortTimelineSegments(segments)
    .filter((seg) => Number.isFinite(seg?.startMinute) && Number.isFinite(seg?.endMinute));
  const output = [];
  ordered.forEach((seg) => {
    const startMinute = Number(seg.startMinute);
    const endMinute = Number(seg.endMinute);
    if (!(endMinute > startMinute)) return;
    const previous = output[output.length - 1];
    if (!previous) {
      output.push({ ...seg, startMinute, endMinute });
      return;
    }
    const clippedStart = Math.max(startMinute, Number(previous.endMinute));
    if (!(endMinute > clippedStart)) return;
    output.push({ ...seg, startMinute: clippedStart, endMinute });
  });
  return output;
}

function overlayEventSegments(baseSegments = [], eventSegments = []) {
  let working = ensureNonOverlappingSegments(mergeTimelineSegments(baseSegments));
  const sortedEvents = sortTimelineSegments(
    (Array.isArray(eventSegments) ? eventSegments : []).filter(
      (event) => Number.isFinite(event?.startMinute) && Number.isFinite(event?.endMinute) && event.endMinute > event.startMinute
    )
  );

  sortedEvents.forEach((event, idx) => {
    const nextEvent = sortedEvents[idx + 1];
    const eventStart = Number(event.startMinute);
    let eventEnd = Number(event.endMinute);
    if (Number.isFinite(nextEvent?.startMinute)) {
      eventEnd = Math.min(eventEnd, Number(nextEvent.startMinute));
    }
    if (!(eventEnd > eventStart)) return;

    const split = [];
    working.forEach((seg) => {
      const segStart = Number(seg.startMinute);
      const segEnd = Number(seg.endMinute);
      if (segEnd <= eventStart || segStart >= eventEnd) {
        split.push(seg);
        return;
      }
      if (segStart < eventStart) {
        split.push({ ...seg, endMinute: eventStart });
      }
      if (segEnd > eventEnd) {
        split.push({ ...seg, startMinute: eventEnd });
      }
    });
    split.push({
      ...event,
      startMinute: eventStart,
      endMinute: eventEnd,
      isEvent: true,
    });
    working = ensureNonOverlappingSegments(mergeTimelineSegments(split));
  });

  return working;
}

function timelineFromBackendStates(rawTimeline = []) {
  const segments = (Array.isArray(rawTimeline) ? rawTimeline : []).map((entry) => {
    const startMinute = readMinuteByKeys(entry, [
      'startMinute',
      'fromMinute',
      'start',
      'from',
      'startTime',
      'fromTime',
      'start_time',
      'from_time',
    ]);
    const endMinute = readMinuteByKeys(entry, [
      'endMinute',
      'toMinute',
      'end',
      'to',
      'endTime',
      'toTime',
      'end_time',
      'to_time',
    ]);
    if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute) || endMinute <= startMinute) return null;
    const state = normalizeVehicleState(entry?.state || entry?.status || entry?.phase || entry?.type || entry?.mode);
    const employeeId = entry?.employeeId ? String(entry.employeeId) : null;
    const employeesOnboard = normalizeEmployeeIds(
      entry?.employeesOnboard
      || entry?.onboardEmployees
      || entry?.employees
      || []
    );
    const employeesOnboardBefore = normalizeEmployeeIds(
      entry?.employeesOnboardBefore
      || entry?.onboardBefore
      || (state === 'dropoff' ? employeesOnboard : [])
    );
    const employeesOnboardAfter = normalizeEmployeeIds(
      entry?.employeesOnboardAfter
      || entry?.onboardAfter
      || (state === 'dropoff' ? [] : employeesOnboard)
    );
    const employeeIds = normalizeEmployeeIds(
      entry?.employeeIds
      || entry?.affectedEmployees
      || (state === 'dropoff'
        ? employeesOnboardBefore
        : (employeeId ? [employeeId] : []))
    );
    const effectiveEmployeeIds = state === 'dropoff'
      ? (employeesOnboardBefore.length ? employeesOnboardBefore : employeeIds)
      : employeeIds;
    const defaultLabel = ROUTE_STATE_META[state]?.label || 'State';
    const label = (state === 'pickup' || state === 'dropoff') && effectiveEmployeeIds.length
      ? `${defaultLabel}${effectiveEmployeeIds.length > 1 ? ` x${effectiveEmployeeIds.length}` : ` ${effectiveEmployeeIds[0]}`}`
      : defaultLabel;
    return {
      state,
      employeeId: effectiveEmployeeIds.length === 1 ? effectiveEmployeeIds[0] : null,
      employeeIds: effectiveEmployeeIds,
      employeesOnboard: state === 'dropoff' ? [] : employeesOnboard,
      employeesOnboardBefore,
      employeesOnboardAfter,
      startMinute,
      endMinute,
      label: String(entry?.label || label),
    };
  }).filter(Boolean);
  return mergeTimelineSegments(segments);
}

function extractRideStopEvents(ride) {
  const path = Array.isArray(ride?.path) ? ride.path : [];
  return path.map((stop, idx) => {
    const t = String(stop?.type || '').toLowerCase();
    const isPickup = t === 'pickup';
    const isDropoff = t === 'dropoff' || t === 'drop';
    if (!isPickup && !isDropoff) return null;
    const minute = readMinuteByKeys(stop, [
      'arrivalMinute',
      'arrival_minute',
      'timeMinute',
      'timeMinutes',
      'minute',
      'minutes',
      'arrivalTime',
      'time',
      'plannedPickupTime',
      'plannedDropoffTime',
      'eta',
      'timestamp',
    ]);
    if (!Number.isFinite(minute)) return null;
    const employeeId = stop?.employeeId ? String(stop.employeeId) : '';
    const eventType = isPickup ? 'pickup' : 'dropoff';
    const employeesOnboardBefore = normalizeEmployeeIds(
      stop?.employeesOnboardBefore
      || stop?.onboardBefore
      || []
    );
    const employeesOnboardAfter = normalizeEmployeeIds(
      stop?.employeesOnboardAfter
      || stop?.onboardAfter
      || []
    );
    const stopIndex = Number(stop?.index ?? (idx + 1));
    return {
      key: `${stopIndex}-${eventType}-${employeeId || 'NA'}-${minute}`,
      stopIndex: Number.isFinite(stopIndex) ? stopIndex : (idx + 1),
      minute,
      employeeId,
      employeeIds: employeeId ? [employeeId] : [],
      eventType,
      employeesOnboardBefore,
      employeesOnboardAfter,
      label: `${eventType === 'pickup' ? 'Pickup' : 'Dropoff'}${employeeId ? ` ${employeeId}` : ''}`,
    };
  }).filter(Boolean).sort((a, b) => a.stopIndex - b.stopIndex);
}

function aggregateRideStopEvents(events = []) {
  const ordered = (Array.isArray(events) ? [...events] : [])
    .filter((event) => Number.isFinite(event?.minute))
    .sort((a, b) => (Number(a.stopIndex) - Number(b.stopIndex)));
  const aggregated = [];

  ordered.forEach((event) => {
    const eventType = String(event?.eventType || '').toLowerCase();
    if (eventType !== 'pickup' && eventType !== 'dropoff') return;
    const minute = Number(event.minute);
    const employeeIds = normalizeEmployeeIds(
      Array.isArray(event.employeeIds) && event.employeeIds.length
        ? event.employeeIds
        : [event.employeeId]
    );
    const last = aggregated[aggregated.length - 1];
    const canMerge = Boolean(
      last
      && last.eventType === eventType
      && Math.abs(Number(last.minute) - minute) < 1e-6
    );
    if (!canMerge) {
      const baseBefore = normalizeEmployeeIds(event.employeesOnboardBefore);
      const isDropoff = eventType === 'dropoff';
      const normalizedEmployeeIds = isDropoff
        ? (baseBefore.length ? baseBefore : employeeIds)
        : employeeIds;
      aggregated.push({
        ...event,
        minute,
        employeeIds: normalizedEmployeeIds,
        employeeId: normalizedEmployeeIds.length === 1 ? normalizedEmployeeIds[0] : null,
        employeesOnboardAfter: isDropoff
          ? []
          : normalizeEmployeeIds(event.employeesOnboardAfter),
        label: eventType === 'pickup'
          ? `Pickup${normalizedEmployeeIds.length > 1 ? ` x${normalizedEmployeeIds.length}` : ''}`
          : `Dropoff${normalizedEmployeeIds.length > 1 ? ` x${normalizedEmployeeIds.length}` : ''}`,
      });
      return;
    }

    const mergedEmployeeIds = normalizeEmployeeIds([
      ...(Array.isArray(last.employeeIds) ? last.employeeIds : []),
      ...employeeIds,
    ]);
    const mergedBefore = normalizeEmployeeIds([
      ...(Array.isArray(last.employeesOnboardBefore) ? last.employeesOnboardBefore : []),
      ...(Array.isArray(event.employeesOnboardBefore) ? event.employeesOnboardBefore : []),
    ]);
    const finalEmployeeIds = eventType === 'dropoff'
      ? (mergedBefore.length ? mergedBefore : mergedEmployeeIds)
      : mergedEmployeeIds;
    last.employeeIds = finalEmployeeIds;
    last.employeeId = finalEmployeeIds.length === 1 ? finalEmployeeIds[0] : null;
    if (eventType === 'dropoff') {
      last.employeesOnboardBefore = mergedBefore.length ? mergedBefore : last.employeesOnboardBefore;
      last.employeesOnboardAfter = [];
    }
    last.stopIndex = Number.isFinite(event.stopIndex) ? event.stopIndex : last.stopIndex;
    if (eventType !== 'dropoff' && Array.isArray(event.employeesOnboardAfter) && event.employeesOnboardAfter.length) {
      last.employeesOnboardAfter = normalizeEmployeeIds(event.employeesOnboardAfter);
    }
    last.key = `${last.stopIndex}-${eventType}-${finalEmployeeIds.join('|') || 'NA'}-${minute}`;
    last.label = eventType === 'pickup'
      ? `Pickup${finalEmployeeIds.length > 1 ? ` x${finalEmployeeIds.length}` : ''}`
      : `Dropoff${finalEmployeeIds.length > 1 ? ` x${finalEmployeeIds.length}` : ''}`;
  });

  return aggregated;
}

function verifyRideTimelineConsistency(ride, events = []) {
  const errors = [];
  const path = Array.isArray(ride?.path) ? ride.path : [];
  if (!path.length) {
    return { ok: false, errors: ['no_route_path'] };
  }

  const assigned = new Set(
    (Array.isArray(ride?.assignedEmployees) ? ride.assignedEmployees : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );
  const picked = new Set();
  let prevMinute = null;

  path.forEach((stop, idx) => {
    const typ = String(stop?.type || '').toLowerCase();
    const employeeId = String(stop?.employeeId || '').trim();
    if (!employeeId) {
      errors.push(`missing_employee_id_at_${idx + 1}`);
      return;
    }
    if (assigned.size && !assigned.has(employeeId)) {
      errors.push(`employee_not_in_assigned:${employeeId}`);
    }
    const minute = readMinuteByKeys(stop, ['arrivalMinute', 'arrival_minute', 'arrivalTime', 'time', 'minute']);
    if (Number.isFinite(minute)) {
      if (prevMinute !== null && minute < prevMinute - 1e-6) {
        errors.push(`non_monotonic_time_at_${idx + 1}`);
      }
      prevMinute = minute;
    }
    if (typ === 'pickup') {
      picked.add(employeeId);
      return;
    }
    if (typ === 'dropoff' || typ === 'drop') {
      if (!picked.has(employeeId)) {
        errors.push(`dropoff_before_pickup:${employeeId}`);
      }
      return;
    }
    errors.push(`unknown_stop_type_at_${idx + 1}`);
  });

  const pathEventCount = path.filter((stop) => {
    const t = String(stop?.type || '').toLowerCase();
    return t === 'pickup' || t === 'dropoff' || t === 'drop';
  }).length;
  if (events.length !== pathEventCount) {
    errors.push('event_count_mismatch_with_path');
  }

  const pathEventsInOrder = path
    .map((stop, idx) => ({ stop, idx }))
    .filter(({ stop }) => {
      const t = String(stop?.type || '').toLowerCase();
      return t === 'pickup' || t === 'dropoff' || t === 'drop';
    });
  pathEventsInOrder.forEach(({ stop, idx }, i) => {
    const event = events[i];
    if (!event) {
      errors.push(`missing_event_for_path_stop:${idx + 1}`);
      return;
    }
    const stopType = String(stop?.type || '').toLowerCase();
    const stopEventType = stopType === 'pickup' ? 'pickup' : 'dropoff';
    const stopEmployee = String(stop?.employeeId || '').trim();
    if (String(event.eventType || '') !== stopEventType) {
      errors.push(`event_type_mismatch_at_${idx + 1}`);
    }
    if (String(event.employeeId || '').trim() !== stopEmployee) {
      errors.push(`event_employee_mismatch_at_${idx + 1}`);
    }
  });

  const backendVerification = ride?.timelineVerification || {};
  if (backendVerification?.isConsistent === false) {
    const backendErrors = Array.isArray(backendVerification?.errors) ? backendVerification.errors : ['backend_consistency_failed'];
    backendErrors.forEach((e) => errors.push(`backend:${String(e)}`));
  }

  return { ok: errors.length === 0, errors };
}

function timelineFromPath(ride, fallbackStartMinute = 8 * 60) {
  const path = Array.isArray(ride?.path) ? ride.path : [];
  if (!path.length) return [];

  const totalRideMinutes = parseNumericLike(
    ride?.metrics?.totalTimeMinutes
    ?? ride?.metrics?.totalTime
    ?? ride?.totalTimeMinutes
    ?? ride?.totalTime
  );
  const defaultStepMinutes = Number.isFinite(totalRideMinutes) && path.length > 1
    ? Math.max(3, Math.round(totalRideMinutes / (path.length - 1)))
    : 8;
  const routeStart = readMinuteByKeys(ride, [
    'startMinute',
    'startTime',
    'start_time',
    'departureMinute',
    'departureTime',
  ]) ?? fallbackStartMinute;

  let cursorMinute = routeStart;
  const stops = path.map((stop, idx) => {
    const explicitMinute = readMinuteByKeys(stop, [
      'minute',
      'minutes',
      'timeMinute',
      'timeMinutes',
      'arrivalMinute',
      'etaMinute',
      'timestampMinute',
      'time',
      'plannedPickupTime',
      'plannedDropoffTime',
      'eta',
      'timestamp',
      'arrivalTime',
    ]);
    if (Number.isFinite(explicitMinute)) {
      cursorMinute = Math.max(cursorMinute, explicitMinute);
    } else if (idx === 0) {
      cursorMinute = routeStart;
    } else {
      cursorMinute += defaultStepMinutes;
    }
    const stopType = String(stop?.type || '').toLowerCase();
    const employeeId = stop?.employeeId ? String(stop.employeeId) : null;
    return { stopType, minute: cursorMinute, employeeId };
  });

  const serviceMinutes = Math.max(2, Math.min(6, Math.round(defaultStepMinutes * 0.35)));
  const onboardEmployeeIds = [];
  const segments = [];

  if (stops[0].minute > routeStart) {
    segments.push({
      state: 'idle',
      startMinute: routeStart,
      endMinute: stops[0].minute,
      employeesOnboard: [],
      label: ROUTE_STATE_META.idle.label,
    });
  }

  stops.forEach((stop, idx) => {
    const isPickup = stop.stopType === 'pickup';
    const isDropoff = stop.stopType === 'dropoff' || stop.stopType === 'drop';
    const currentMinute = stop.minute;
    const nextMinute = idx < (stops.length - 1)
      ? Math.max(currentMinute + 1, stops[idx + 1].minute)
      : currentMinute + defaultStepMinutes;
    const serviceEndMinute = Math.min(nextMinute, currentMinute + serviceMinutes);
    const employeesOnboardBefore = normalizeEmployeeIds(onboardEmployeeIds);

    let eventState = 'travel';
    if (isPickup) eventState = 'pickup';
    if (isDropoff) eventState = 'dropoff';
    if (isPickup && stop.employeeId && !onboardEmployeeIds.includes(stop.employeeId)) {
      onboardEmployeeIds.push(stop.employeeId);
    }
    if (isDropoff && stop.employeeId) {
      onboardEmployeeIds.splice(0, onboardEmployeeIds.length);
    }
    const employeesOnboardAfter = normalizeEmployeeIds(onboardEmployeeIds);
    const eventEmployeeIds = isDropoff
      ? (employeesOnboardBefore.length ? employeesOnboardBefore : (stop.employeeId ? [stop.employeeId] : []))
      : (stop.employeeId ? [stop.employeeId] : []);
    const eventLabel = stop.employeeId && (eventState === 'pickup' || eventState === 'dropoff')
      ? `${ROUTE_STATE_META[eventState]?.label || 'State'} ${stop.employeeId}`
      : (ROUTE_STATE_META[eventState]?.label || 'State');
    segments.push({
      state: eventState,
      startMinute: currentMinute,
      endMinute: serviceEndMinute,
      employeeId: eventEmployeeIds.length === 1 ? eventEmployeeIds[0] : null,
      employeeIds: eventEmployeeIds,
      employeesOnboard: isDropoff ? [] : employeesOnboardAfter,
      employeesOnboardBefore,
      employeesOnboardAfter: isDropoff ? [] : employeesOnboardAfter,
      isEvent: true,
      label: isDropoff
        ? `Dropoff${eventEmployeeIds.length > 1 ? ` x${eventEmployeeIds.length}` : ''}`
        : eventLabel,
    });

    if (serviceEndMinute < nextMinute) {
      const betweenState = onboardEmployeeIds.length > 0 ? 'occupied' : 'travel';
      segments.push({
        state: betweenState,
        startMinute: serviceEndMinute,
        endMinute: nextMinute,
        employeesOnboard: normalizeEmployeeIds(onboardEmployeeIds),
        label: ROUTE_STATE_META[betweenState]?.label || 'State',
      });
    }
  });

  const finalEnd = segments.length ? segments[segments.length - 1].endMinute : routeStart;
  segments.push({
    state: onboardEmployeeIds.length > 0 ? 'occupied' : 'idle',
    startMinute: finalEnd,
    endMinute: finalEnd + Math.max(3, Math.round(defaultStepMinutes * 0.7)),
    employeesOnboard: normalizeEmployeeIds(onboardEmployeeIds),
    label: onboardEmployeeIds.length > 0 ? ROUTE_STATE_META.occupied.label : ROUTE_STATE_META.idle.label,
  });

  return mergeTimelineSegments(segments);
}

function buildRideTimeline(ride, fallbackStartMinute) {
  const timelineCandidates = [
    ride?.vehicleTimeline,
    ride?.stateTimeline,
    ride?.routeTimeline,
    ride?.timeline,
    ride?.states,
    ride?.metrics?.stateTimeline,
    ride?.metrics?.timeline,
  ];

  const directTimeline = timelineCandidates.find((candidate) => Array.isArray(candidate) && candidate.length > 0);
  if (directTimeline) {
    const segments = timelineFromBackendStates(directTimeline);
    if (segments.length) return segments;
  }
  return timelineFromPath(ride, fallbackStartMinute);
}

export {
  ROUTE_STATE_META,
  ROUTE_STATE_ORDER,
  normalizeEmployeeIds,
  diffEmployeeIds,
  normalizeVehicleState,
  valueToMinute,
  readMinuteByKeys,
  mergeTimelineSegments,
  sortTimelineSegments,
  ensureNonOverlappingSegments,
  overlayEventSegments,
  timelineFromBackendStates,
  extractRideStopEvents,
  aggregateRideStopEvents,
  verifyRideTimelineConsistency,
  timelineFromPath,
  buildRideTimeline,
};
