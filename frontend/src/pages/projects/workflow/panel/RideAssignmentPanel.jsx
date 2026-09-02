import React, { useEffect, useMemo, useRef, useState } from 'react';
import { minuteToClock, parseWindow } from '../helpers';
import { readMinuteByKeys } from './timelineUtils';
import {
  ROUTE_STATE_META,
  aggregateRideStopEvents,
  buildRideTimeline,
  extractRideStopEvents,
  overlayEventSegments,
  verifyRideTimelineConsistency,
} from './timelineUtils';
import { buildGoogleMapsRouteLinks } from './googleMapsLinks';

const card = {
  borderRadius: 16,
  border: '1px solid rgba(255,255,255,0.2)',
  borderTop: '1px solid rgba(255,255,255,0.45)',
  borderBottom: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(10, 10, 10, 0.15)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
};

const mapsLinkStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 32,
  borderRadius: 999,
  border: '1px solid rgba(96,165,250,0.42)',
  background: 'rgba(37,99,235,0.18)',
  color: '#dbeafe',
  padding: '0 12px',
  fontSize: '0.78rem',
  fontWeight: 700,
  textDecoration: 'none',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
};

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toCoord = (node) => {
  if (!node || typeof node !== 'object') return null;
  const lat = toNumber(node.lat ?? node.pickupLat ?? node.startLat ?? node.latitude);
  const lng = toNumber(node.lng ?? node.pickupLng ?? node.startLng ?? node.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
};

const km = (value) => {
  if (!Number.isFinite(value)) return '-';
  return value < 1 ? `${value.toFixed(2)} km` : `${value.toFixed(1)} km`;
};

const coordLabel = (c) => (c ? `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}` : '-');

const haversineKm = (a, b) => {
  if (!a || !b) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = (Math.sin(dLat / 2) ** 2) + (Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * (Math.sin(dLng / 2) ** 2));
  return R * (2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
};

const parseWindowForEmployee = (e) => {
  const tw = e?.time_window || e?.timeWindow;
  if (tw && typeof tw === 'object' && tw.start && tw.end) return parseWindow({ start: String(tw.start), end: String(tw.end) });
  if (typeof tw === 'string') return parseWindow(tw);
  const start = e?.earliest_pickup || e?.earliestPickup;
  const end = e?.latest_drop || e?.latestDrop;
  if (start && end) return parseWindow({ start: String(start), end: String(end) });
  return null;
};

const stopType = (value) => {
  const low = String(value || '').toLowerCase();
  if (low === 'pickup') return 'pickup';
  if (low === 'dropoff' || low === 'drop') return 'dropoff';
  return 'move';
};

const isNonEmployeeStopLabel = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === 'company'
    || normalized === 'office'
    || normalized === 'hq'
    || normalized === 'head office'
    || normalized === 'head_office'
  );
};

const employeeRank = (employeeId) => {
  const id = String(employeeId || '').trim();
  const numberMatch = id.match(/(\d+)/);
  if (!numberMatch) return Number.POSITIVE_INFINITY;
  const n = Number(numberMatch[1]);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

const buildRideLegs = (path = []) => {
  if (!Array.isArray(path)) return [];
  return path.map((stop) => {
    const departure = toNumber(stop?.departureMinute);
    const arrival = toNumber(stop?.arrivalMinute);
    const distanceKm = toNumber(stop?.distanceFromPrevKm);
    const durationMinutes = Number.isFinite(departure) && Number.isFinite(arrival)
      ? Math.max(0, arrival - departure)
      : 0;
    return {
      departureMinute: departure,
      arrivalMinute: arrival,
      distanceKm: Number.isFinite(distanceKm) ? Math.max(0, distanceKm) : 0,
      durationMinutes,
    };
  }).filter((leg) => Number.isFinite(leg.departureMinute) && Number.isFinite(leg.arrivalMinute) && leg.arrivalMinute >= leg.departureMinute);
};

const computeSegmentDistanceKm = (segment, legs = []) => {
  const segStart = toNumber(segment?.startMinute);
  const segEnd = toNumber(segment?.endMinute);
  if (!Number.isFinite(segStart) || !Number.isFinite(segEnd) || segEnd <= segStart) return 0;

  let distanceKm = 0;
  legs.forEach((leg) => {
    const overlapStart = Math.max(segStart, leg.departureMinute);
    const overlapEnd = Math.min(segEnd, leg.arrivalMinute);
    const overlapMinutes = Math.max(0, overlapEnd - overlapStart);
    if (overlapMinutes <= 0 || leg.durationMinutes <= 0 || leg.distanceKm <= 0) return;
    distanceKm += leg.distanceKm * (overlapMinutes / leg.durationMinutes);
  });
  return distanceKm;
};

const overlayEmployeeText = (entry) => {
  const ids = Array.isArray(entry?.employeeIds) && entry.employeeIds.length
    ? entry.employeeIds.map((id) => String(id))
    : (entry?.employeeId ? [String(entry.employeeId)] : []);
  return ids.length ? ids.join(', ') : '-';
};

function RideAssignmentPanel({
  rides = [],
  employees = [],
  vehicles = [],
  timelineEvents = [],
  officeCenter = null,
  distanceInfo = null,
  showHeader = true,
  showControls = true,
  showSequenceTimeline = true,
  stackPanels = false,
}) {
  const [query, setQuery] = useState('');
  const [vehicleFilter, setVehicleFilter] = useState('all');
  const [timelineViewMode, setTimelineViewMode] = useState('time');
  const [isVehicleMenuOpen, setIsVehicleMenuOpen] = useState(false);
  const [overlayTooltip, setOverlayTooltip] = useState(null);
  const [selectedOverlayVehicleId, setSelectedOverlayVehicleId] = useState(null);
  const [selectedTimelineSegment, setSelectedTimelineSegment] = useState(null);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const vehicleMenuRef = useRef(null);
  const timelineScrollRef = useRef(null);
  const rightPanelsRef = useRef(null);
  const [ledgerHeight, setLedgerHeight] = useState(null);
  const office = useMemo(() => toCoord(officeCenter || {}), [officeCenter]);
  const overlayTooltipPosition = useMemo(() => {
    if (!overlayTooltip) return null;
    const tooltipWidth = 260;
    const tooltipHeight = 112;
    const pad = 12;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1366;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
    const left = Math.max(pad, Math.min(vw - tooltipWidth - pad, Number(overlayTooltip.x || 0) + 14));
    const top = Math.max(pad, Math.min(vh - tooltipHeight - pad, Number(overlayTooltip.y || 0) + 14));
    return { left, top };
  }, [overlayTooltip]);

  useEffect(() => {
    const onPointerDown = (event) => {
      const target = event.target;
      if (vehicleMenuRef.current && !vehicleMenuRef.current.contains(target)) {
        setIsVehicleMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const employeeById = useMemo(() => {
    const out = {};
    employees.forEach((e, i) => {
      const id = String(e?.id || `EMP_${i + 1}`);
      if (isNonEmployeeStopLabel(id)) return;
      out[id] = e;
    });
    return out;
  }, [employees]);

  const vehicleMeta = useMemo(() => {
    const out = {};
    vehicles.forEach((v, i) => {
      const id = String(v?.id || `VEH_${i + 1}`);
      const cap = Number(v?.capacity ?? v?.maxCapacity ?? v?.seats);
      out[id] = {
        type: String(v?.type || 'Vehicle'),
        cap: Number.isFinite(cap) ? cap : null,
        startCoord: toCoord(v?.start_location || v?.startLocation || v || {}),
      };
    });
    return out;
  }, [vehicles]);
  const shouldShowGoogleMapsLinks = useMemo(() => {
    const modes = [
      distanceInfo?.requestedMetric,
      distanceInfo?.metric,
      distanceInfo?.backend,
    ];
    return !modes.some((value) => String(value || '').trim().toLowerCase() === 'haversine');
  }, [distanceInfo]);

  const model = useMemo(() => {
    const assignmentRows = [];
    const timelineRows = [];
    const timelineSeen = new Set();
    const vehicleRows = [];
    const seenEmployees = new Set();
    const colors = ['#38bdf8', '#34d399', '#f59e0b', '#a78bfa', '#f43f5e'];

    const pushTimeline = ({ minute, vehicleId, employeeId, type, source }) => {
      const normalizedMinute = toNumber(minute);
      if (!Number.isFinite(normalizedMinute)) return;
      const normalizedVehicle = String(vehicleId || '');
      if (!normalizedVehicle) return;
      const normalizedType = stopType(type);
      const normalizedEmployee = employeeId ? String(employeeId) : '-';
      const dedupeKey = `${Math.round(normalizedMinute)}|${normalizedVehicle}|${normalizedEmployee}|${normalizedType}`;
      if (timelineSeen.has(dedupeKey)) return;
      timelineSeen.add(dedupeKey);
      const summary = normalizedEmployee === '-'
        ? `${normalizedType} event`
        : `${normalizedType} via ${normalizedVehicle}`;
      timelineRows.push({
        key: dedupeKey,
        minute: normalizedMinute,
        vehicleId: normalizedVehicle,
        employeeId: normalizedEmployee,
        type: normalizedType,
        source: source || 'solver',
        summary,
      });
    };

    rides.forEach((ride, rIdx) => {
      const vehicleId = String(ride?.vehicleId || `VEH_${rIdx + 1}`);
      const path = Array.isArray(ride?.path) ? ride.path : [];
      const byEmployee = new Map();
      let cumulativeKm = 0;
      let prev = toCoord(path[0]) || office;
      let startMinute = null;
      let endMinute = null;
      const overlay = [];
      const overlayByKey = new Map();
      let pickupCount = 0;
      let dropCount = 0;

      const pushOverlayEvent = ({ type, minute, employeeId, lat, lng, stopIndex }) => {
        if (type !== 'pickup' && type !== 'dropoff') {
          overlay.push({
            type,
            minute,
            employeeId,
            employeeIds: employeeId ? [employeeId] : [],
            lat,
            lng,
            stopIndex,
          });
          return;
        }

        const minuteKey = Number.isFinite(minute) ? Math.round(minute) : 'na';
        const latKey = Number.isFinite(lat) ? lat.toFixed(5) : 'na';
        const lngKey = Number.isFinite(lng) ? lng.toFixed(5) : 'na';
        const dedupeKey = `${type}|${minuteKey}|${latKey}|${lngKey}`;
        const existing = overlayByKey.get(dedupeKey);
        if (existing) {
          if (employeeId && !existing.employeeIds.includes(employeeId)) {
            existing.employeeIds.push(employeeId);
          }
          if (!existing.employeeId && employeeId) {
            existing.employeeId = employeeId;
          }
          return;
        }

        const next = {
          type,
          minute,
          employeeId: employeeId || '',
          employeeIds: employeeId ? [employeeId] : [],
          lat,
          lng,
          stopIndex,
        };
        overlayByKey.set(dedupeKey, next);
        overlay.push(next);
      };

      path.forEach((stop, sIdx) => {
        const pt = toCoord(stop || {});
        if (prev && pt) cumulativeKm += (haversineKm(prev, pt) || 0);
        if (pt) prev = pt;

        const minute = readMinuteByKeys(stop, [
          'arrivalMinute',
          'arrival_minute',
          'minute',
          'timeMinute',
          'timeMinutes',
          'arrivalTime',
          'time',
          'plannedPickupTime',
          'plannedDropoffTime',
          'eta',
          'timestamp',
        ]) ?? ((startMinute ?? (8 * 60)) + (sIdx * 5));
        if (startMinute == null || minute < startMinute) startMinute = minute;
        if (endMinute == null || minute > endMinute) endMinute = minute;

        const type = stopType(stop?.type);
        const rawEmployeeId = stop?.employeeId ? String(stop.employeeId) : '';
        const employeeId = isNonEmployeeStopLabel(rawEmployeeId) ? '' : rawEmployeeId;
        if (type === 'pickup') {
          pickupCount += 1;
        }
        if (type === 'dropoff') dropCount += 1;
        pushOverlayEvent({
          type,
          minute,
          employeeId,
          lat: Number.isFinite(pt?.lat) ? pt.lat : null,
          lng: Number.isFinite(pt?.lng) ? pt.lng : null,
          stopIndex: sIdx + 1,
        });

        if ((type === 'pickup' || type === 'dropoff') && employeeId) {
          seenEmployees.add(employeeId);
          const curr = byEmployee.get(employeeId) || {
            employeeId,
            pickupStopIndex: null,
            dropStopIndex: null,
            pickupMinute: null,
            dropMinute: null,
            pickupCoord: null,
            dropCoord: null,
            kmAtPickup: null,
            kmAtDrop: null
          };
          if (type === 'pickup') {
            curr.pickupStopIndex = curr.pickupStopIndex || (sIdx + 1);
            curr.pickupMinute = minute;
            curr.pickupCoord = pt || curr.pickupCoord;
            curr.kmAtPickup = cumulativeKm;
          } else {
            curr.dropStopIndex = curr.dropStopIndex || (sIdx + 1);
            curr.dropMinute = minute;
            curr.dropCoord = pt || curr.dropCoord;
            curr.kmAtDrop = cumulativeKm;
          }
          byEmployee.set(employeeId, curr);
          pushTimeline({ minute, vehicleId, employeeId, type, source: 'path' });
        }
      });

      Array.from(byEmployee.values()).forEach((row) => {
        const employee = employeeById[row.employeeId];
        const window = parseWindowForEmployee(employee);
        const minuteRef = Number.isFinite(row.pickupMinute) ? row.pickupMinute : row.dropMinute;
        const dropCoord = row.dropCoord || office || toCoord(employee || {});
        let dist = null;
        if (Number.isFinite(row.kmAtPickup) && Number.isFinite(row.kmAtDrop)) dist = Math.max(0, row.kmAtDrop - row.kmAtPickup);
        else if (row.pickupCoord && dropCoord) dist = haversineKm(row.pickupCoord, dropCoord);

        let punctuality = 'Unknown';
        let punctualityColor = '#cbd5e1';
        let onTime = false;
        let delayMinutes = null;
        let delayLabel = '-';
        if (window && Number.isFinite(minuteRef)) {
          delayMinutes = Math.max(0, minuteRef - window.end);
          delayLabel = `${delayMinutes} min`;
          if (minuteRef < window.start) {
            punctuality = `Early by ${window.start - minuteRef}m`;
            punctualityColor = '#67e8f9';
          } else if (minuteRef > window.end) {
            punctuality = `Late by ${minuteRef - window.end}m`;
            punctualityColor = '#fda4af';
          } else {
            punctuality = 'On Time';
            punctualityColor = '#6ee7b7';
            onTime = true;
          }
        }

        assignmentRows.push({
          key: `${vehicleId}-${row.employeeId}`,
          employeeId: row.employeeId,
          vehicleId,
          vehicleType: vehicleMeta[vehicleId]?.type || 'Vehicle',
          pickupStopIndex: row.pickupStopIndex,
          dropStopIndex: row.dropStopIndex,
          pickupMinute: row.pickupMinute,
          dropMinute: row.dropMinute,
          pickupLabel: minuteToClock(row.pickupMinute),
          etaLabel: minuteToClock(row.dropMinute),
          destination: coordLabel(dropCoord),
          distance: dist,
          distanceLabel: km(dist),
          feasible: ride?.feasible !== false,
          punctuality,
          punctualityColor,
          delayMinutes,
          delayLabel,
          onTime,
        });
      });

      const routeDistance = [
        ride?.metrics?.distanceKm,
        ride?.metrics?.routeDistanceKm,
        ride?.distanceKm,
      ].map(toNumber).find((x) => Number.isFinite(x)) ?? cumulativeKm;
      const duration = Number.isFinite(startMinute) && Number.isFinite(endMinute) ? Math.max(0, endMinute - startMinute) : null;
      const assignedCount = byEmployee.size;
      const cap = vehicleMeta[vehicleId]?.cap;
      const utilization = Number.isFinite(cap) && cap > 0 ? Math.min(100, Math.round((assignedCount / cap) * 100)) : null;
      const mapsLinks = shouldShowGoogleMapsLinks
        ? buildGoogleMapsRouteLinks({
          ride,
          startCoord: vehicleMeta[vehicleId]?.startCoord || null,
        })
        : [];
      vehicleRows.push({
        vehicleId,
        vehicleType: vehicleMeta[vehicleId]?.type || 'Vehicle',
        assignedCount,
        cap,
        utilization,
        routeDistance,
        duration,
        feasible: ride?.feasible !== false,
        pickupCount,
        dropCount,
        overlay,
        color: colors[rIdx % colors.length],
        mapsLinks,
      });
    });

    employees.forEach((e, idx) => {
      const id = String(e?.id || `EMP_${idx + 1}`);
      if (isNonEmployeeStopLabel(id)) return;
      if (seenEmployees.has(id)) return;
      assignmentRows.push({
        key: `unassigned-${id}`, employeeId: id, vehicleId: 'Unassigned', vehicleType: '-', pickupStopIndex: null, dropStopIndex: null, pickupMinute: null, dropMinute: null,
        pickupLabel: '-', etaLabel: '-', destination: coordLabel(office), distance: null, distanceLabel: '-', feasible: false,
        punctuality: 'Pending assignment', punctualityColor: '#fda4af', delayMinutes: null, delayLabel: '-', onTime: false,
      });
    });

    timelineEvents.forEach((ev, i) => {
      const minute = toNumber(ev?.minute);
      if (!Number.isFinite(minute)) return;
      const vehicleId = String(ev?.vehicleId || `VEH_${i + 1}`);
      const employeeId = ev?.employeeId ? String(ev.employeeId) : '-';
      const type = stopType(ev?.type);
      if (type !== 'pickup' && type !== 'dropoff') return;
      pushTimeline({ minute, vehicleId, employeeId, type, source: 'timeline' });
    });

    assignmentRows.sort((a, b) => {
      const rankDiff = employeeRank(a.employeeId) - employeeRank(b.employeeId);
      if (rankDiff !== 0) return rankDiff;
      return String(a.employeeId || '').localeCompare(String(b.employeeId || ''));
    });
    timelineRows.sort((a, b) => ((a.minute ?? 1e9) - (b.minute ?? 1e9) || String(a.vehicleId).localeCompare(String(b.vehicleId))));
    return { assignmentRows, timelineRows: timelineRows.slice(0, 220), vehicleRows };
  }, [rides, employees, timelineEvents, office, employeeById, vehicleMeta, shouldShowGoogleMapsLinks]);

  const vehicleIds = useMemo(() => Array.from(new Set(model.vehicleRows.map((v) => v.vehicleId))), [model.vehicleRows]);

  const filteredAssignments = useMemo(() => {
    const q = query.trim().toLowerCase();
    return model.assignmentRows.filter((r) => {
      if (vehicleFilter !== 'all' && r.vehicleId !== vehicleFilter) return false;
      if (!q) return true;
      return (
        String(r.employeeId).toLowerCase().includes(q)
        || String(r.vehicleId).toLowerCase().includes(q)
        || String(r.destination).toLowerCase().includes(q)
      );
    });
  }, [model.assignmentRows, query, vehicleFilter]);

  const filteredTimeline = useMemo(
    () => model.timelineRows.filter((r) => (vehicleFilter === 'all' ? true : r.vehicleId === vehicleFilter)),
    [model.timelineRows, vehicleFilter]
  );

  const timelinePresentation = useMemo(() => {
    if (timelineViewMode === 'time') {
      return { type: 'flat', items: filteredTimeline.slice(0, 220) };
    }
    const groups = new Map();
    filteredTimeline.forEach((item) => {
      const rawKey = timelineViewMode === 'employee'
        ? (item.employeeId && item.employeeId !== '-' ? item.employeeId : 'N/A')
        : item.vehicleId;
      const key = String(rawKey || 'N/A');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    const grouped = Array.from(groups.entries())
      .map(([key, events]) => ({
        key,
        events: [...events].sort((a, b) => ((a.minute ?? 1e9) - (b.minute ?? 1e9))),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return { type: 'grouped', groups: grouped };
  }, [filteredTimeline, timelineViewMode]);

  const selectedVehicleTimeline = useMemo(() => {
    const vehicleId = selectedOverlayVehicleId || null;
    if (!vehicleId) return null;
    const ride = (Array.isArray(rides) ? rides : []).find((r) => String(r?.vehicleId || '') === String(vehicleId));
    if (!ride) return null;

    const path = Array.isArray(ride?.path) ? ride.path : [];
    const events = extractRideStopEvents(ride);
    const consistency = verifyRideTimelineConsistency(ride, events);
    const availabilityMinute = readMinuteByKeys(ride, [
      'availabilityMinute',
      'availability_minute',
      'availabilityTime',
      'availability_time',
    ]);
    const startMinute = readMinuteByKeys(ride, ['startMinute', 'start_minute', 'startTime', 'start_time']);
    const fallbackStart = Number.isFinite(availabilityMinute) ? availabilityMinute : (Number.isFinite(startMinute) ? startMinute : (8 * 60));
    const baseSegments = buildRideTimeline(ride, fallbackStart);
    const hasExplicitEventSegments = baseSegments.some((seg) => seg?.state === 'pickup' || seg?.state === 'dropoff');
    const eventSegments = aggregateRideStopEvents(events).map((event) => {
      const start = Number(event?.minute);
      if (!Number.isFinite(start)) return null;
      const eventType = String(event?.eventType || '').toLowerCase();
      if (eventType !== 'pickup' && eventType !== 'dropoff') return null;
      const end = start + 0.75;
      return {
        state: eventType,
        startMinute: start,
        endMinute: end,
        employeeId: event?.employeeId ? String(event.employeeId) : null,
        employeeIds: Array.isArray(event?.employeeIds) ? event.employeeIds : [],
        employeesOnboardBefore: Array.isArray(event?.employeesOnboardBefore) ? event.employeesOnboardBefore : [],
        employeesOnboardAfter: Array.isArray(event?.employeesOnboardAfter) ? event.employeesOnboardAfter : [],
        label: event?.label || (eventType === 'pickup' ? 'Pickup' : 'Dropoff'),
        isEvent: true,
      };
    }).filter(Boolean);
    const segments = hasExplicitEventSegments || !eventSegments.length
      ? baseSegments
      : overlayEventSegments(baseSegments, eventSegments);
    const minuteCandidates = [
      ...segments.flatMap((seg) => [Number(seg?.startMinute), Number(seg?.endMinute)]),
      ...events.map((e) => Number(e?.minute)),
    ].filter(Number.isFinite);
    const rowStart = minuteCandidates.length ? Math.min(...minuteCandidates) : fallbackStart;
    const rowEndRaw = minuteCandidates.length ? Math.max(...minuteCandidates) : (rowStart + 30);
    const rowEnd = Math.max(rowStart + 5, rowEndRaw);
    const range = Math.max(1, rowEnd - rowStart);
    const stopsCount = path.length;
    const assignedCount = Array.isArray(ride?.assignedEmployees) ? ride.assignedEmployees.length : 0;
    const totalDistanceKm = path.reduce((acc, stop) => acc + (toNumber(stop?.distanceFromPrevKm) || 0), 0);
    const totalCost = toNumber(ride?.metrics?.cost ?? ride?.cost ?? ride?.totalCost ?? ride?.metrics?.totalCost);
    const legs = buildRideLegs(path);
    const costPerKm = (Number.isFinite(totalCost) && totalDistanceKm > 0) ? (totalCost / totalDistanceKm) : null;
    const mapsLinks = shouldShowGoogleMapsLinks
      ? buildGoogleMapsRouteLinks({
        ride,
        startCoord: vehicleMeta[vehicleId]?.startCoord || null,
      })
      : [];
    return {
      vehicleId,
      ride,
      segments,
      rowStart,
      rowEnd,
      range,
      consistency,
      stopsCount,
      assignedCount,
      availabilityMinute,
      totalDistanceKm,
      totalCost,
      legs,
      costPerKm,
      mapsLinks,
    };
  }, [selectedOverlayVehicleId, rides, vehicleMeta, shouldShowGoogleMapsLinks]);
  const timelineSegmentsForRender = useMemo(() => {
    if (!selectedVehicleTimeline) return [];
    const ordered = [...(Array.isArray(selectedVehicleTimeline.segments) ? selectedVehicleTimeline.segments : [])]
      .filter((seg) => Number.isFinite(Number(seg?.startMinute)) && Number.isFinite(Number(seg?.endMinute)))
      .sort((a, b) => ((Number(a.startMinute) - Number(b.startMinute)) || (Number(a.endMinute) - Number(b.endMinute))));
    return ordered.map((seg, idx) => {
      const start = Number(seg.startMinute);
      const end = Number(seg.endMinute);
      const nextStart = Number(ordered[idx + 1]?.startMinute);
      const clippedEnd = Number.isFinite(nextStart) ? Math.min(end, nextStart) : end;
      if (!(clippedEnd > start)) return null;
      return { ...seg, startMinute: start, endMinute: clippedEnd };
    }).filter(Boolean);
  }, [selectedVehicleTimeline]);

  const resetTimelineView = () => {
    setTimelineZoom(1);
    setSelectedTimelineSegment(null);
    if (timelineScrollRef.current) {
      timelineScrollRef.current.scrollLeft = 0;
    }
  };

  const openVehicleTimeline = (vehicleId) => {
    resetTimelineView();
    setSelectedOverlayVehicleId(vehicleId);
  };

  const closeVehicleTimeline = () => {
    setSelectedOverlayVehicleId(null);
    setSelectedTimelineSegment(null);
  };

  useEffect(() => {
    if (stackPanels) {
      return undefined;
    }

    const node = rightPanelsRef.current;
    if (!node) return undefined;

    const updateHeight = () => {
      const measured = Math.round(node.getBoundingClientRect().height || 0);
      if (measured > 0) {
        setLedgerHeight(measured);
      }
    };

    updateHeight();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => updateHeight());
      observer.observe(node);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, [model.vehicleRows.length, vehicleFilter, stackPanels]);

  return (
    <div style={{ display: 'grid', gap: 16, width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>
      {showHeader ? (
        <div className="glass-morphism" style={{ ...card, padding: 18 }}>
          <h2 style={{ margin: 0, fontSize: '2rem' }}>Ride Assignment</h2>
          <p style={{ margin: '8px 0 0 0', opacity: 0.84 }}>
            Detailed output view: employee assignment, timing, vehicle mapping, distance covered, sequence and route health.
          </p>
          <p style={{ margin: '6px 0 0 0', opacity: 0.72, fontSize: '0.88rem' }}>
            Distance backend: {distanceInfo?.backendLabel || distanceInfo?.metricLabel || 'Unknown'}.
          </p>
        </div>
      ) : null}

      {showControls ? (
        <div className="glass-morphism reflective-card-container" style={{ ...card, padding: 14, position: 'relative', zIndex: 220, overflow: 'visible' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search employee, vehicle, destination" style={{ height: 40, borderRadius: 10, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(10,20,44,0.45)', color: 'white', padding: '0 12px', outline: 'none' }} />
            <div
              ref={vehicleMenuRef}
              style={{
                position: 'relative',
                height: 40,
                borderRadius: 10,
              }}
            >
            <button
              type="button"
              onClick={() => setIsVehicleMenuOpen((prev) => !prev)}
              style={{
                width: '100%',
                height: '100%',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.24)',
                borderTop: '1px solid rgba(255,255,255,0.45)',
                borderBottom: '1px solid rgba(255,255,255,0.12)',
                background: 'linear-gradient(140deg, rgba(10,20,44,0.55), rgba(10,18,36,0.34))',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12), 0 6px 18px rgba(0,0,0,0.25)',
                color: '#f8fbff',
                padding: '0 38px 0 12px',
                textAlign: 'left',
                fontSize: '0.96rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {vehicleFilter === 'all' ? 'All Vehicles' : vehicleFilter}
            </button>
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                right: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'rgba(220,233,255,0.95)',
                fontSize: '0.85rem',
                pointerEvents: 'none',
              }}
            >
              {isVehicleMenuOpen ? '^' : 'v'}
            </span>
            {isVehicleMenuOpen ? (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  left: 0,
                  right: 0,
                  zIndex: 420,
                  borderRadius: 12,
                  overflow: 'hidden',
                  maxHeight: 260,
                  overflowY: 'auto',
                  background: 'linear-gradient(180deg, rgba(8,14,28,0.96), rgba(5,10,20,0.98))',
                  border: '1px solid rgba(255,255,255,0.24)',
                  borderTop: '1px solid rgba(255,255,255,0.5)',
                  boxShadow: '0 16px 30px rgba(0,0,0,0.45)',
                  backdropFilter: 'blur(16px) saturate(130%)',
                  WebkitBackdropFilter: 'blur(16px) saturate(130%)',
                }}
              >
                {['all', ...vehicleIds].map((id, idx) => {
                  const label = id === 'all' ? 'All Vehicles' : id;
                  const active = vehicleFilter === id;
                  return (
                    <button
                      key={`veh-opt-${id}`}
                      type="button"
                      onClick={() => {
                        setVehicleFilter(id);
                        setIsVehicleMenuOpen(false);
                      }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '9px 12px',
                        border: 'none',
                        background: active ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.07)',
                        color: active ? '#eaf1ff' : 'rgba(246,250,255,0.96)',
                        fontSize: '0.88rem',
                        fontWeight: active ? 700 : 500,
                        cursor: 'pointer',
                        borderBottom: idx < vehicleIds.length ? '1px solid rgba(255,255,255,0.08)' : 'none',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: stackPanels ? '1fr' : 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <div className="glass-morphism reflective-card-container" style={{ ...card, padding: 14, height: stackPanels ? 470 : (ledgerHeight || 470), display: 'grid', gridTemplateRows: 'auto 1fr' }}>
          <h3 style={{ margin: 0, marginBottom: 10, fontSize: '1.3rem' }}>Assignment Ledger</h3>
          <div style={{ overflowX: stackPanels ? 'auto' : 'hidden', overflowY: 'auto', paddingRight: 4, minHeight: 0 }}>
            <table style={{ width: '100%', minWidth: stackPanels ? 760 : undefined, borderCollapse: 'collapse', tableLayout: stackPanels ? 'auto' : 'fixed' }}>
              <thead><tr>{['Employee', 'Vehicle', 'Pickup', 'ETA/Drop', 'Distance', 'Window Fit', 'Delay', 'Route State'].map((h) => <th key={h} style={{ textAlign: 'left', padding: '10px 8px', fontSize: '0.84rem', borderBottom: '1px solid rgba(255,255,255,0.16)', color: 'rgba(210,224,255,0.92)' }}>{h}</th>)}</tr></thead>
              <tbody>
                {filteredAssignments.length ? filteredAssignments.map((r, i) => (
                  <tr key={r.key} style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.01)' }}>
                    <td style={{ padding: '10px 8px', fontWeight: 700, wordBreak: 'break-word' }}>{r.employeeId}</td>
                    <td style={{ padding: '10px 8px' }}><div>{r.vehicleId}</div><div style={{ fontSize: '0.78rem', opacity: 0.74 }}>{r.vehicleType}</div></td>
                    <td style={{ padding: '10px 8px', wordBreak: 'break-word' }}>{r.pickupLabel}</td>
                    <td style={{ padding: '10px 8px', wordBreak: 'break-word' }}>{r.etaLabel}</td>
                    <td style={{ padding: '10px 8px', fontWeight: 700 }}>{r.distanceLabel}</td>
                    <td style={{ padding: '10px 8px', color: r.punctualityColor, fontWeight: 700 }}>{r.punctuality}</td>
                    <td style={{ padding: '10px 8px', color: (r.delayMinutes || 0) > 0 ? '#fda4af' : '#cbd5e1', fontWeight: 700 }}>{r.delayLabel}</td>
                    <td style={{ padding: '10px 8px' }}><span style={{ display: 'inline-flex', borderRadius: 999, padding: '3px 10px', fontSize: '0.78rem', fontWeight: 700, border: r.feasible ? '1px solid rgba(110,231,183,0.55)' : '1px solid rgba(252,165,165,0.55)', background: r.feasible ? 'rgba(16,185,129,0.14)' : 'rgba(239,68,68,0.16)', color: r.feasible ? '#6ee7b7' : '#fca5a5' }}>{r.feasible ? 'Feasible' : 'Needs Attention'}</span></td>
                  </tr>
                )) : <tr><td colSpan={8} style={{ padding: 16, opacity: 0.78 }}>No assignment rows found for selected filters.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div ref={rightPanelsRef} style={{ display: 'grid', gap: 14 }}>
          <div className="glass-morphism reflective-card-container" style={{ ...card, padding: 14 }}>
            <h3 style={{ margin: 0, marginBottom: 12, fontSize: '1.2rem' }}>Live Route Overlays</h3>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10, opacity: 0.88, fontSize: '0.8rem' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 999, background: '#14b8a6', border: '1px solid rgba(255,255,255,0.8)' }} /> Pickup</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 999, background: '#f59e0b', border: '1px solid rgba(255,255,255,0.8)' }} /> Dropoff</span>
            </div>
            <div style={{ display: 'grid', gap: 10, maxHeight: 470, overflowY: 'auto', paddingRight: 4 }}>
              {model.vehicleRows.filter((v) => (vehicleFilter === 'all' ? true : v.vehicleId === vehicleFilter)).map((v) => (
                <div
                  key={`overlay-${v.vehicleId}`}
                  onClick={() => openVehicleTimeline(v.vehicleId)}
                  style={{ borderRadius: 12, border: `1px solid ${v.feasible ? 'rgba(110,231,183,0.35)' : 'rgba(252,165,165,0.38)'}`, background: v.feasible ? 'linear-gradient(120deg, rgba(16,185,129,0.14), rgba(13,34,52,0.22))' : 'linear-gradient(120deg, rgba(239,68,68,0.14), rgba(13,34,52,0.22))', padding: 10, overflow: 'visible', cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems: 'center' }}>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); openVehicleTimeline(v.vehicleId); }}
                      style={{
                        fontWeight: 700,
                        fontSize: '1.02rem',
                        background: 'transparent',
                        color: selectedOverlayVehicleId === v.vehicleId ? '#dbeafe' : '#f8fbff',
                        border: selectedOverlayVehicleId === v.vehicleId ? '1px solid rgba(96,165,250,0.55)' : '1px solid rgba(255,255,255,0.22)',
                        borderRadius: 8,
                        padding: '2px 8px',
                        cursor: 'pointer',
                      }}
                    >
                      {v.vehicleId}
                    </button>
                    <span style={{ opacity: 0.82, fontWeight: 700 }}>{km(v.routeDistance)}</span>
                  </div>
                  <div style={{ height: 14, borderRadius: 999, position: 'relative', overflow: 'visible' }}>
                    <div style={{ position: 'absolute', inset: 0, borderRadius: 999, background: 'rgba(2,6,23,0.5)', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.15)' }}>
                      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(148,163,184,0.38), rgba(100,116,139,0.34), rgba(71,85,105,0.32))' }} />
                    </div>
                    {v.overlay.slice(0, 20).map((s, idx) => {
                      const series = v.overlay.slice(0, 20).map((x) => x.minute).filter(Number.isFinite);
                      const minSeries = series.length ? Math.min(...series) : 0;
                      const maxSeries = series.length ? Math.max(...series) : minSeries;
                      const rangeSeries = Math.max(1, maxSeries - minSeries);
                      const hasMinute = Number.isFinite(s.minute);
                      const left = hasMinute
                        ? (((s.minute - minSeries) / rangeSeries) * 100)
                        : (v.overlay.length > 1 ? ((idx / (v.overlay.length - 1)) * 100) : 1);
                      const c = s.type === 'pickup' ? '#14b8a6' : (s.type === 'dropoff' ? '#f59e0b' : '#d1d5db');
                      const size = s.type === 'move' ? 7 : 10;
                      const overlayKey = `${v.vehicleId}-${idx}-${s.type}-${s.employeeId || '-'}`;
                      const isHovered = overlayTooltip?.key === overlayKey;
                      const typeLabel = s.type === 'pickup' ? 'Pickup' : (s.type === 'dropoff' ? 'Dropoff' : 'Move');
                      return (
                        <React.Fragment key={`${v.vehicleId}-s-${idx}`}>
                          
                          <span
                            title={`${typeLabel} ${overlayEmployeeText(s)} @ ${minuteToClock(s.minute)}`}
                            onMouseEnter={(e) => { setOverlayTooltip({ key: overlayKey, x: e.clientX, y: e.clientY, color: c, typeLabel, minute: s.minute, employeeId: overlayEmployeeText(s), stopIndex: s.stopIndex || '-', location: Number.isFinite(s.lat) && Number.isFinite(s.lng) ? `${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}` : '-' }); }}
                            onMouseMove={(e) => { setOverlayTooltip((prev) => (prev && prev.key === overlayKey ? { ...prev, x: e.clientX, y: e.clientY } : prev)); }} onMouseLeave={() => { setOverlayTooltip((prev) => (prev && prev.key === overlayKey ? null : prev)); }}
                            style={{
                              position: 'absolute',
                              top: '50%',
                              transform: 'translate(-50%, -50%)',
                              left: `${left}%`,
                              width: size,
                              height: size,
                              borderRadius: 999,
                              border: '1px solid rgba(255,255,255,0.9)',
                              background: c,
                              boxShadow: s.type === 'move' ? 'none' : (isHovered ? '0 0 0 3px rgba(255,255,255,0.22), 0 0 12px rgba(255,255,255,0.3)' : '0 0 8px rgba(255,255,255,0.25)'),
                              zIndex: isHovered ? 21 : 10,
                            }}
                          />
                        </React.Fragment>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', opacity: 0.88 }}>
                    <span>{v.pickupCount} pickups</span>
                    <span>{v.dropCount} dropoffs</span>
                    <span>{v.duration != null ? `${v.duration} mins` : 'duration -'}</span>
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {v.overlay
                      .filter((s) => s.type === 'pickup' || s.type === 'dropoff')
                      .map((s, idx) => (
                        <span
                          key={`${v.vehicleId}-chip-${idx}`}
                          style={{
                            fontSize: '0.74rem',
                            borderRadius: 999,
                            padding: '3px 8px',
                            border: s.type === 'pickup' ? '1px solid rgba(20,184,166,0.5)' : '1px solid rgba(245,158,11,0.5)',
                            background: s.type === 'pickup' ? 'rgba(20,184,166,0.14)' : 'rgba(245,158,11,0.14)',
                            color: s.type === 'pickup' ? '#99f6e4' : '#fde68a',
                          }}
                        >
                          {minuteToClock(s.minute)} {s.type === 'pickup' ? 'P' : 'D'} {overlayEmployeeText(s)}
                        </span>
                      ))}
                  </div>
                </div>
              ))}
              {!model.vehicleRows.length ? <div style={{ opacity: 0.75 }}>No route overlays yet.</div> : null}
            </div>
          </div>

          <div className="glass-morphism reflective-card-container" style={{ ...card, padding: 14 }}>
            <h3 style={{ margin: 0, marginBottom: 12, fontSize: '1.2rem' }}>Vehicle Specifics</h3>
            <div style={{ display: 'grid', gap: 10, maxHeight: 470, overflowY: 'auto', paddingRight: 4 }}>
              {model.vehicleRows.filter((v) => (vehicleFilter === 'all' ? true : v.vehicleId === vehicleFilter)).map((v) => (
                <div key={`meta-${v.vehicleId}`} style={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.04)', padding: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}><div style={{ fontWeight: 700 }}>{v.vehicleId}</div><div style={{ fontSize: '0.8rem', opacity: 0.8 }}>{v.vehicleType}</div></div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: '0.86rem' }}><div>Assigned: <strong>{v.assignedCount}</strong></div><div>Capacity: <strong>{v.cap ?? '-'}</strong></div><div>Distance: <strong>{km(v.routeDistance)}</strong></div><div>Duration: <strong>{v.duration != null ? `${v.duration}m` : '-'}</strong></div></div>
                  {v.utilization != null ? <div style={{ marginTop: 8 }}><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', opacity: 0.84 }}><span>Capacity Utilization</span><span>{v.utilization}%</span></div><div style={{ marginTop: 4, height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${v.utilization}%`, background: v.utilization > 90 ? '#f97316' : '#38bdf8' }} /></div></div> : null}
                  {shouldShowGoogleMapsLinks && v.mapsLinks.length ? (
                    <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: '0.76rem', opacity: 0.82, lineHeight: 1.4, flex: '1 1 220px', paddingTop: 4 }}>
                        {v.mapsLinks.length === 1
                          ? 'Open the full vehicle route in Google Maps.'
                          : `Route split into ${v.mapsLinks.length} Google Maps links so all stops fit.`}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', flex: '0 1 auto' }}>
                        {v.mapsLinks.map((link) => (
                          <a
                            key={`maps-${v.vehicleId}-${link.index}`}
                            href={link.href}
                            target="_blank"
                            rel="noreferrer"
                            title={link.summary}
                            style={mapsLinkStyle}
                          >
                            {link.buttonLabel}
                          </a>
                        ))}
                      </div>
                    </div>
                  ) : shouldShowGoogleMapsLinks ? (
                    <div style={{ marginTop: 10, fontSize: '0.76rem', opacity: 0.72 }}>
                      Google Maps link unavailable because this route does not have valid coordinates.
                    </div>
                  ) : null}
                </div>
              ))}
              {!model.vehicleRows.length ? <div style={{ opacity: 0.75 }}>No vehicle specifics available.</div> : null}
            </div>
          </div>
        </div>
      </div>

      {showSequenceTimeline ? (
      <div className="glass-morphism reflective-card-container" style={{ ...card, padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: '1.3rem' }}>Sequence & Timeline</h3>
          <div style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
            {[
              { key: 'time', label: 'Time Wise' },
              { key: 'employee', label: 'Employee Wise' },
              { key: 'vehicle', label: 'Vehicle Wise' },
            ].map((mode) => {
              const isActive = timelineViewMode === mode.key;
              return (
                <button
                  key={mode.key}
                  type="button"
                  onClick={() => setTimelineViewMode(mode.key)}
                  style={{
                    height: 32,
                    borderRadius: 999,
                    border: isActive ? '1px solid rgba(96,165,250,0.65)' : '1px solid rgba(255,255,255,0.2)',
                    background: isActive ? 'rgba(37,99,235,0.28)' : 'rgba(255,255,255,0.05)',
                    color: isActive ? '#dbeafe' : 'rgba(229,236,255,0.88)',
                    padding: '0 12px',
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ maxHeight: 320, overflowY: 'auto', display: 'grid', gap: 8, paddingRight: 4 }}>
          {timelinePresentation.type === 'flat' && timelinePresentation.items.length ? timelinePresentation.items.map((t, i) => {
            const color = t.type === 'pickup' ? '#14b8a6' : (t.type === 'dropoff' ? '#f59e0b' : '#93c5fd');
            return (
              <div key={t.key || `t-${i}-${t.vehicleId}-${t.employeeId}`} style={{ display: 'grid', gridTemplateColumns: '84px 92px 116px 1fr', gap: 10, alignItems: 'center', padding: '9px 10px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.03)' }}>
                <div style={{ fontWeight: 800, color }}>{minuteToClock(t.minute)}</div>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, opacity: 0.9 }}>{t.vehicleId}</div>
                <div style={{ display: 'inline-flex', justifyContent: 'center', alignItems: 'center', borderRadius: 999, padding: '3px 8px', fontSize: '0.76rem', fontWeight: 700, color, border: `1px solid ${color}66`, background: `${color}1c` }}>
                  {String(t.type || 'move').toUpperCase()}
                </div>
                <div style={{ fontSize: '0.88rem', opacity: 0.95, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontWeight: 700 }}>{t.employeeId && t.employeeId !== '-' ? t.employeeId : 'N/A'}</span>
                  <span style={{ opacity: 0.65 }}>{t.summary}</span>
                </div>
              </div>
            );
          }) : null}

          {timelinePresentation.type === 'grouped' && timelinePresentation.groups.length ? timelinePresentation.groups.map((group) => (
            <div key={`group-${group.key}`} style={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.03)', overflow: 'hidden' }}>
              <div style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.12)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.04)' }}>
                <strong style={{ fontSize: '0.9rem' }}>{group.key}</strong>
                <span style={{ fontSize: '0.75rem', opacity: 0.78 }}>{group.events.length} events</span>
              </div>
              <div style={{ padding: 8, display: 'grid', gap: 6 }}>
                {group.events.map((t, i) => {
                  const color = t.type === 'pickup' ? '#14b8a6' : (t.type === 'dropoff' ? '#f59e0b' : '#93c5fd');
                  return (
                    <div key={t.key || `ge-${group.key}-${i}`} style={{ display: 'grid', gridTemplateColumns: '78px 92px 104px 1fr', gap: 8, alignItems: 'center', padding: '7px 8px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      <div style={{ fontWeight: 700, color }}>{minuteToClock(t.minute)}</div>
                      <div style={{ fontSize: '0.78rem', fontWeight: 700, opacity: 0.9 }}>{t.vehicleId}</div>
                      <div style={{ display: 'inline-flex', justifyContent: 'center', alignItems: 'center', borderRadius: 999, padding: '2px 8px', fontSize: '0.72rem', fontWeight: 700, color, border: `1px solid ${color}66`, background: `${color}1c` }}>
                        {String(t.type || 'move').toUpperCase()}
                      </div>
                      <div style={{ fontSize: '0.82rem', opacity: 0.92 }}>
                        {t.employeeId && t.employeeId !== '-' ? t.employeeId : 'N/A'} | {t.summary}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )) : null}

          {((timelinePresentation.type === 'flat' && !timelinePresentation.items.length)
            || (timelinePresentation.type === 'grouped' && !timelinePresentation.groups.length)) ? (
              <div style={{ opacity: 0.76 }}>No timeline entries for this filter.</div>
            ) : null}
        </div>
      </div>
      ) : null}
      {selectedVehicleTimeline ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={closeVehicleTimeline}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9400,
            background: 'rgba(2,6,14,0.58)',
            display: 'grid',
            placeItems: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(1320px, 80vw)',
              maxHeight: '70vh',
              overflow: 'auto',
              borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.24)',
              background: 'linear-gradient(180deg, rgba(6,12,26,0.98), rgba(7,14,30,0.98))',
              boxShadow: '0 24px 50px rgba(0,0,0,0.5)',
              padding: 18,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 900, fontSize: '1.36rem' }}>
                {selectedVehicleTimeline.vehicleId} Route Timeline
              </div>
              <button
                type="button"
                onClick={closeVehicleTimeline}
                style={{
                  borderRadius: 9,
                  border: '1px solid rgba(255,255,255,0.25)',
                  background: 'rgba(255,255,255,0.08)',
                  color: '#eaf1ff',
                  padding: '6px 10px',
                  cursor: 'pointer',
                  fontWeight: 700,
                }}
              >
                Close
              </button>
            </div>

            <div style={{ fontSize: '1.02rem', marginBottom: 10, lineHeight: 1.5, opacity: 0.94 }}>
              Stops: {selectedVehicleTimeline.stopsCount}
              {' | '}Assigned: {selectedVehicleTimeline.assignedCount}
              {Number.isFinite(selectedVehicleTimeline.availabilityMinute) ? ` | Available: ${minuteToClock(selectedVehicleTimeline.availabilityMinute)}` : ''}
              {' | '}Route Check: {selectedVehicleTimeline.consistency?.ok ? 'OK' : 'Issue'}
              {' | '}Distance: {selectedVehicleTimeline.totalDistanceKm.toFixed(2)} km
              {Number.isFinite(selectedVehicleTimeline.totalCost) ? ` | Cost: ${selectedVehicleTimeline.totalCost.toFixed(2)}` : ''}
            </div>

            {shouldShowGoogleMapsLinks && selectedVehicleTimeline.mapsLinks.length ? (
              <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: '0.8rem', opacity: 0.78, lineHeight: 1.45, flex: '1 1 280px', paddingTop: 4 }}>
                  {selectedVehicleTimeline.mapsLinks.length === 1
                    ? 'This link opens the vehicle start and the ordered stop sequence in Google Maps.'
                    : 'Long routes are split across multiple Google Maps links because Google Maps limits directions waypoints per link.'}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', flex: '0 1 auto' }}>
                  {selectedVehicleTimeline.mapsLinks.map((link) => (
                    <a
                      key={`modal-maps-${selectedVehicleTimeline.vehicleId}-${link.index}`}
                      href={link.href}
                      target="_blank"
                      rel="noreferrer"
                      title={link.summary}
                      style={mapsLinkStyle}
                    >
                      {link.buttonLabel}
                    </a>
                  ))}
                </div>
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10, fontSize: '0.94rem', opacity: 0.96 }}>
              {['idle', 'travel', 'occupied', 'pickup', 'dropoff'].map((state) => (
                <span key={`state-modal-${state}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 999, background: ROUTE_STATE_META[state]?.color || '#64748b' }} />
                  {ROUTE_STATE_META[state]?.label || state}
                </span>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: '0.82rem', opacity: 0.86 }}>Timeline Zoom</span>
              <button
                type="button"
                onClick={() => setTimelineZoom((z) => Math.max(1, Number((z - 0.25).toFixed(2))))}
                style={{
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.22)',
                  background: 'rgba(255,255,255,0.07)',
                  color: '#eaf1ff',
                  minWidth: 34,
                  height: 30,
                  cursor: 'pointer',
                  fontWeight: 800,
                }}
                aria-label="Zoom out timeline"
              >
                -
              </button>
              <span style={{ minWidth: 44, textAlign: 'center', fontSize: '0.85rem', fontWeight: 700 }}>{timelineZoom.toFixed(2)}x</span>
              <input
                type="range"
                min="1"
                max="4"
                step="0.05"
                value={timelineZoom}
                onChange={(e) => setTimelineZoom(Number.parseFloat(e.target.value))}
                aria-label="Timeline zoom slider"
                style={{ width: 140, accentColor: '#60a5fa', cursor: 'pointer' }}
              />
              <button
                type="button"
                onClick={() => setTimelineZoom((z) => Math.min(4, Number((z + 0.25).toFixed(2))))}
                style={{
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.22)',
                  background: 'rgba(255,255,255,0.07)',
                  color: '#eaf1ff',
                  minWidth: 34,
                  height: 30,
                  cursor: 'pointer',
                  fontWeight: 800,
                }}
                aria-label="Zoom in timeline"
              >
                +
              </button>
              <button
                type="button"
                onClick={resetTimelineView}
                style={{
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.22)',
                  background: 'rgba(255,255,255,0.07)',
                  color: '#eaf1ff',
                  padding: '0 10px',
                  height: 30,
                  cursor: 'pointer',
                  fontWeight: 700,
                  fontSize: '0.78rem',
                }}
              >
                Reset
              </button>
            </div>

            <div
              ref={timelineScrollRef}
              style={{
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'rgba(4,10,22,0.75)',
                minHeight: 84,
                overflowX: 'auto',
                overflowY: 'hidden',
              }}
            >
              <div style={{ position: 'relative', width: `${Math.max(100, timelineZoom * 100)}%`, minHeight: 84 }}>
                {timelineSegmentsForRender.map((seg, idx) => {
                  const start = Number(seg?.startMinute);
                  const end = Number(seg?.endMinute);
                  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
                  const leftPct = ((start - selectedVehicleTimeline.rowStart) / selectedVehicleTimeline.range) * 100;
                  const widthPct = Math.max(0, ((end - start) / selectedVehicleTimeline.range) * 100);
                  const effectiveWidthPct = widthPct * timelineZoom;
                  const color = ROUTE_STATE_META[seg?.state]?.color || '#64748b';
                  const segmentKey = `seg-modal-${selectedVehicleTimeline.vehicleId}-${idx}-${start}-${end}-${seg?.state}`;
                  const isActive = selectedTimelineSegment?.key === segmentKey;
                  return (
                    <div
                      key={segmentKey}
                      title={`${ROUTE_STATE_META[seg?.state]?.label || seg?.state}: ${minuteToClock(start)} - ${minuteToClock(end)}`}
                      onClick={() => {
                        const distanceKm = computeSegmentDistanceKm(seg, selectedVehicleTimeline.legs || []);
                        const cost = Number.isFinite(selectedVehicleTimeline.costPerKm) ? (distanceKm * selectedVehicleTimeline.costPerKm) : 0;
                        setSelectedTimelineSegment({
                          key: segmentKey,
                          seg,
                          distanceKm,
                          cost,
                        });
                      }}
                      style={{
                        position: 'absolute',
                        left: `${Math.max(0, leftPct)}%`,
                        width: `${Math.min(100, widthPct)}%`,
                        top: 18,
                        height: 50,
                        borderRadius: 16,
                        background: color,
                        border: isActive ? '2px solid rgba(255,255,255,0.9)' : '1px solid rgba(255,255,255,0.34)',
                        overflow: 'hidden',
                        boxSizing: 'border-box',
                        cursor: 'pointer',
                        boxShadow: isActive ? '0 0 0 2px rgba(96,165,250,0.28)' : 'none',
                      }}
                    >
                      {effectiveWidthPct > 4 ? (
                        <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: '0.72rem', fontWeight: 800, opacity: 0.9 }}>{minuteToClock(start)}</span>
                      ) : null}
                      {effectiveWidthPct > 8 ? (
                        <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: '0.72rem', fontWeight: 800, opacity: 0.9 }}>{minuteToClock(end)}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: '0.92rem', opacity: 0.86 }}>
              <span>{minuteToClock(selectedVehicleTimeline.rowStart)}</span>
              <span>{minuteToClock((selectedVehicleTimeline.rowStart + selectedVehicleTimeline.rowEnd) / 2)}</span>
              <span>{minuteToClock(selectedVehicleTimeline.rowEnd)}</span>
            </div>
            {selectedTimelineSegment ? (() => {
              const seg = selectedTimelineSegment.seg || {};
              const segState = String(seg.state || 'unknown');
              const label = ROUTE_STATE_META[segState]?.label || 'State';
              const start = toNumber(seg.startMinute);
              const end = toNumber(seg.endMinute);
              const onboard = Array.isArray(seg.employeesOnboard) ? seg.employeesOnboard : [];
              const onBefore = Array.isArray(seg.employeesOnboardBefore) ? seg.employeesOnboardBefore : [];
              const onAfter = Array.isArray(seg.employeesOnboardAfter) ? seg.employeesOnboardAfter : [];
              const effectiveOnboard = segState === 'dropoff' ? [] : (onboard.length ? onboard : onAfter);
              const eventEmpIds = Array.isArray(seg.employeeIds) && seg.employeeIds.length
                ? seg.employeeIds
                : (seg.employeeId ? [seg.employeeId] : []);
              const primaryEmpIds = segState === 'pickup'
                ? (eventEmpIds.length ? eventEmpIds : onAfter)
                : segState === 'dropoff'
                  ? (onBefore.length ? onBefore : eventEmpIds)
                  : effectiveOnboard;
              return (
                <div style={{ marginTop: 12, borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(8,14,35,0.68)', padding: 12 }}>
                  <div style={{ fontWeight: 800, marginBottom: 6, color: ROUTE_STATE_META[segState]?.color || '#eaf2ff' }}>
                    {label}
                  </div>
                  <div style={{ opacity: 0.9, fontSize: '0.9rem' }}>
                    Time: {minuteToClock(start)} - {minuteToClock(end)}
                  </div>
                  {primaryEmpIds.length ? (
                    <div style={{ opacity: 0.92, fontSize: '0.9rem', marginTop: 4 }}>
                      Onboard employees ({primaryEmpIds.length}): <strong>{primaryEmpIds.join(', ')}</strong>
                    </div>
                  ) : null}
                  <div style={{ opacity: 0.9, fontSize: '0.9rem', marginTop: 4 }}>
                    Distance: {selectedTimelineSegment.distanceKm.toFixed(2)} km
                  </div>
                  <div style={{ opacity: 0.9, fontSize: '0.9rem', marginTop: 2 }}>
                    Cost: {selectedTimelineSegment.cost.toFixed(2)}
                  </div>
                </div>
              );
            })() : null}
          </div>
        </div>
      ) : null}
      {overlayTooltip && overlayTooltipPosition ? (
        <div
          style={{
            position: 'fixed',
            left: overlayTooltipPosition.left,
            top: overlayTooltipPosition.top,
            minWidth: 170,
            maxWidth: 240,
            padding: '7px 9px',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.26)',
            background: 'linear-gradient(160deg, rgba(7,12,24,0.96), rgba(10,18,36,0.96))',
            color: '#e8f1ff',
            fontSize: '0.74rem',
            lineHeight: 1.35,
            boxShadow: '0 12px 26px rgba(0,0,0,0.45)',
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        >
          <div style={{ fontWeight: 800, color: overlayTooltip.color, marginBottom: 3 }}>
            {overlayTooltip.typeLabel} | {minuteToClock(overlayTooltip.minute)}
          </div>
          <div>Employee: <strong>{overlayTooltip.employeeId}</strong></div>
          <div>Stop: <strong>#{overlayTooltip.stopIndex}</strong></div>
          <div style={{ opacity: 0.86 }}>
            Location: {overlayTooltip.location}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default RideAssignmentPanel;
