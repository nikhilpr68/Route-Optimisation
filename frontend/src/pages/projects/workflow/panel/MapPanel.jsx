import React, { useCallback, useEffect, useRef, useState } from 'react';
import ProjectMap from '../../components/ProjectMap';
import { mapButtonStyle, mapControlStyle, timelineBtnStyle, timelinePlayStyle } from '../constants';
import { minuteToClock } from '../helpers';
import LegendItem from './LegendItem';
import { buildGoogleMapsRouteLinks } from './googleMapsLinks';
import './MapPanel.css';

function getDistinctRouteColor(index) {
  const normalized = Number.isFinite(index) ? Math.max(0, Number(index)) : 0;
  const hue = Math.round((normalized * 137.508) % 360);
  return `hsl(${hue} 72% 58%)`;
}
const TIMELINE_TICK_STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const mapsLinkStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 30,
  borderRadius: 999,
  border: '1px solid rgba(96,165,250,0.42)',
  background: 'rgba(37,99,235,0.18)',
  color: '#dbeafe',
  padding: '0 10px',
  fontSize: '0.74rem',
  fontWeight: 700,
  textDecoration: 'none',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
};

function MapPanel({
  projectId = '',
  employees,
  vehicles,
  rides = [],
  officeCenter,
  timelineEvents = [],
  distanceInfo = null,
  loading = false,
  hasParsedInput = false,
  hasResults = false,
}) {
  const SEEK_STEP_MINUTES = 1;
  const PLAYBACK_INTERVAL_MS = 100;
  const MINUTES_PER_TICK_AT_1X = 0.05;
  const [visibleLayers, setVisibleLayers] = useState({
    employees: true,
    routes: true,
    vehicles: true,
  });
  const [vehicleFilter, setVehicleFilter] = useState('all');
  const [employeeFilter, setEmployeeFilter] = useState('all');
  const withTime = timelineEvents.filter((e) => Number.isFinite(e.minute));
  const hasTimelineEvents = withTime.length > 0;
  const minMinute = hasTimelineEvents ? Math.min(...withTime.map((e) => e.minute)) : 0;
  const maxMinute = hasTimelineEvents ? Math.max(...withTime.map((e) => e.minute)) : 0;
  const [mapSlider, setMapSlider] = useState(minMinute);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [fitToBoundsToken, setFitToBoundsToken] = useState(0);
  const timelineTrackRef = useRef(null);
  const mapTimelineFullscreenRef = useRef(null);
  const vehicleDropdownRef = useRef(null);
  const employeeDropdownRef = useRef(null);
  const [isDraggingTimeline, setIsDraggingTimeline] = useState(false);
  const [isMapTimelineFullscreen, setIsMapTimelineFullscreen] = useState(false);
  const [isVehicleDropdownOpen, setIsVehicleDropdownOpen] = useState(false);
  const [isEmployeeDropdownOpen, setIsEmployeeDropdownOpen] = useState(false);
  const [isMapDarkMode, setIsMapDarkMode] = useState(true);
  const hasMapEntities = employees.length > 0 || vehicles.length > 0;
  const showLoadingState = loading && !hasMapEntities;
  const emptyStateMessage = hasResults
    ? 'This run does not contain plottable map data.'
    : hasParsedInput
      ? 'No valid map coordinates were found for this testcase.'
      : 'Parse testcase first to view map data.';

  useEffect(() => {
    setMapSlider(minMinute);
  }, [minMinute]);

  useEffect(() => {
    if (!isPlaying) return undefined;
    const ceiling = Math.max(minMinute, maxMinute);
    const timer = setInterval(() => {
      setMapSlider((prev) => {
        if (prev >= ceiling) {
          setIsPlaying(false);
          return ceiling;
        }
        const delta = playbackSpeed * MINUTES_PER_TICK_AT_1X;
        return Math.min(ceiling, prev + delta);
      });
    }, PLAYBACK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isPlaying, minMinute, maxMinute, playbackSpeed]);

  function toggleLayer(key) {
    setVisibleLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handlePlayback() {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (mapSlider >= maxMinute) setMapSlider(minMinute);
    setIsPlaying(true);
  }
  const pausePlaybackOnMapInteraction = useCallback(() => {
    setIsPlaying((prev) => (prev ? false : prev));
  }, []);
  const clampMinute = useCallback(
    (value) => Math.max(minMinute, Math.min(maxMinute, value)),
    [minMinute, maxMinute],
  );
  const seekBy = useCallback(
    (delta) => setMapSlider((prev) => clampMinute(prev + delta)),
    [clampMinute],
  );
  const speedToSlider = useCallback((speed) => {
    if (speed <= 1) return ((speed - 0.25) / 0.75) * 50;
    return 50 + ((speed - 1) / 1) * 50;
  }, []);
  const sliderToSpeed = useCallback((slider) => {
    const n = Number(slider);
    if (n <= 50) return 0.25 + ((n / 50) * 0.75);
    return 1 + (((n - 50) / 50) * 1);
  }, []);
  const speedSliderValue = speedToSlider(playbackSpeed);
  const speedLabel = `${playbackSpeed.toFixed(2)}x`;
  const toggleMapFullscreen = useCallback(async () => {
    const target = mapTimelineFullscreenRef.current;
    if (!target || typeof document === 'undefined') return;
    try {
      if (document.fullscreenElement === target) {
        await document.exitFullscreen();
      } else if (!document.fullscreenElement) {
        await target.requestFullscreen();
      }
    } catch {
      // Ignore fullscreen API failures triggered by browser policy.
    }
  }, []);
  function jumpToStart() {
    setMapSlider(minMinute);
    setIsPlaying(false);
  }
  const minuteFromPointer = useCallback((clientX) => {
    const track = timelineTrackRef.current;
    if (!track) return mapSlider;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.round(minMinute + (ratio * (maxMinute - minMinute)));
  }, [mapSlider, minMinute, maxMinute]);
  function handleTimelinePointerDown(e) {
    e.preventDefault();
    setIsDraggingTimeline(true);
    setMapSlider(clampMinute(minuteFromPointer(e.clientX)));
  }

  useEffect(() => {
    if (!isDraggingTimeline) return undefined;
    const previousUserSelect = document.body.style.userSelect;
    const previousWebkitUserSelect = document.body.style.webkitUserSelect;
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    const onMove = (e) => setMapSlider(clampMinute(minuteFromPointer(e.clientX)));
    const onUp = () => setIsDraggingTimeline(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.webkitUserSelect = previousWebkitUserSelect;
    };
  }, [clampMinute, isDraggingTimeline, minuteFromPointer]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const target = mapTimelineFullscreenRef.current;
      const fullscreenEl = document.fullscreenElement;
      setIsMapTimelineFullscreen(Boolean(target && fullscreenEl && target.contains(fullscreenEl)));
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      const target = e.target;
      const isEditableTarget = target instanceof HTMLElement && (
        target.isContentEditable
        || target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
      );
      if (isEditableTarget || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        seekBy(SEEK_STEP_MINUTES);
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seekBy(-SEEK_STEP_MINUTES);
      }
      if (String(e.key || '').toLowerCase() === 'f' && !e.repeat) {
        e.preventDefault();
        toggleMapFullscreen();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [seekBy, toggleMapFullscreen]);

  useEffect(() => {
    const onPointerDown = (e) => {
      const target = e.target;
      if (vehicleDropdownRef.current && !vehicleDropdownRef.current.contains(target)) {
        setIsVehicleDropdownOpen(false);
      }
      if (employeeDropdownRef.current && !employeeDropdownRef.current.contains(target)) {
        setIsEmployeeDropdownOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const filteredEmployees = employees.filter((e) => {
    const byVehicle = vehicleFilter === 'all' ? true : String(e?.vehicleId) === vehicleFilter;
    const byEmployee = employeeFilter === 'all' ? true : String(e?.id) === employeeFilter;
    return byVehicle && byEmployee;
  });
  const selectedEmployee = employeeFilter === 'all'
    ? null
    : employees.find((e) => String(e?.id) === employeeFilter);
  const filteredVehicles = vehicles.filter((v) => {
    const byVehicle = vehicleFilter === 'all' ? true : String(v?.id) === vehicleFilter;
    const byEmployee = employeeFilter === 'all'
      ? true
      : String(v?.id) === String(selectedEmployee?.vehicleId || '');
    return byVehicle && byEmployee;
  });

  const unassignedCount = filteredEmployees.filter((e) => !e?.vehicleId).length;
  const shouldShowVehicleLegend = visibleLayers.vehicles || visibleLayers.routes;
  const vehicleColorById = vehicles.reduce((acc, v, idx) => {
    const id = String(v?.id || '');
    if (id) acc[id] = getDistinctRouteColor(idx);
    return acc;
  }, {});
  const vehicleLegendEntries = filteredVehicles
    .map((v, idx) => {
      const vehicleId = String(v?.id || '');
      if (!vehicleId) return null;
      const assignedCount = filteredEmployees.filter((e) => String(e?.vehicleId) === vehicleId).length;
      const hasRoute = rides.some((ride) => (
        String(ride?.vehicleId || '') === vehicleId
        && Array.isArray(ride?.path)
        && ride.path.length >= 2
      ));
      const hasVehicleMarker = Number.isFinite(Number(v?.startLat)) && Number.isFinite(Number(v?.startLng));
      const isVisibleInLegend = (visibleLayers.routes && hasRoute) || (visibleLayers.vehicles && hasVehicleMarker);
      if (!isVisibleInLegend) return null;
      return {
        id: vehicleId,
        color: vehicleColorById[vehicleId] || getDistinctRouteColor(idx),
        assignedCount,
      };
    })
    .filter(Boolean);
  const googleMapsRouteEntries = filteredVehicles
    .map((vehicle, idx) => {
      const vehicleId = String(vehicle?.id || '');
      if (!vehicleId) return null;
      const ride = rides.find((item) => String(item?.vehicleId || '') === vehicleId);
      if (!ride || !Array.isArray(ride?.path) || ride.path.length === 0) return null;
      const mapsLinks = buildGoogleMapsRouteLinks({
        ride,
        startCoord: {
          lat: Number(vehicle?.startLat ?? officeCenter?.lat),
          lng: Number(vehicle?.startLng ?? officeCenter?.lng),
        },
      });
      if (!mapsLinks.length) return null;
      return {
        id: vehicleId,
        color: vehicleColorById[vehicleId] || getDistinctRouteColor(idx),
        mapsLinks,
      };
    })
    .filter(Boolean);
  const timelineDuration = Math.max(1, maxMinute - minMinute);
  const maxTickCount = isMapTimelineFullscreen ? 12 : 9;
  const tickStep = TIMELINE_TICK_STEPS.find((step) => ((Math.ceil(timelineDuration / step) + 1) <= maxTickCount))
    || TIMELINE_TICK_STEPS[TIMELINE_TICK_STEPS.length - 1];
  const timeTickSet = new Set([Math.round(minMinute), Math.round(maxMinute)]);
  const firstAlignedTick = Math.ceil(minMinute / tickStep) * tickStep;
  for (let t = firstAlignedTick; t < maxMinute; t += tickStep) {
    timeTickSet.add(Math.round(t));
  }
  const timeTicks = Array.from(timeTickSet).sort((a, b) => a - b);
  const nearestTickForMinute = (minute) => {
    if (!timeTicks.length) return Math.round(minMinute);
    let nearestTick = timeTicks[0];
    let nearestDiff = Math.abs(minute - nearestTick);
    for (let idx = 1; idx < timeTicks.length; idx += 1) {
      const tick = timeTicks[idx];
      const diff = Math.abs(minute - tick);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearestTick = tick;
      }
    }
    return nearestTick;
  };
  const minuteTypes = timelineEvents.reduce((acc, ev) => {
    const m = Number(ev?.minute);
    if (!Number.isFinite(m)) return acc;
    const key = nearestTickForMinute(m);
    const type = String(ev?.type || '').toLowerCase();
    if (type === 'pickup') acc[key] = 'pickup';
    if ((type === 'dropoff' || type === 'drop') && acc[key] !== 'pickup') acc[key] = 'dropoff';
    return acc;
  }, {});
  const layerThemeByKey = {
    employees: {
      rowBg: 'rgba(16,185,129,0.16)',
      rowBorder: '1px solid rgba(16,185,129,0.36)',
      btnBg: 'rgba(16,185,129,0.22)',
      btnBorder: '1px solid rgba(16,185,129,0.55)',
      btnColor: '#d1fae5',
    },
    routes: {
      rowBg: 'rgba(14,165,233,0.16)',
      rowBorder: '1px solid rgba(14,165,233,0.36)',
      btnBg: 'rgba(14,165,233,0.2)',
      btnBorder: '1px solid rgba(14,165,233,0.5)',
      btnColor: '#dbeafe',
    },
    vehicles: {
      rowBg: 'rgba(37,99,235,0.18)',
      rowBorder: '1px solid rgba(59,130,246,0.4)',
      btnBg: 'rgba(37,99,235,0.28)',
      btnBorder: '1px solid rgba(59,130,246,0.65)',
      btnColor: '#dbeafe',
    },
  };
  const timelineTextColor = isMapDarkMode ? 'rgba(226,232,240,0.95)' : '#0f172a';
  const timeLabelBg = isMapTimelineFullscreen
    ? (isMapDarkMode ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.82)')
    : (isMapDarkMode ? 'rgba(8,14,35,0.48)' : 'rgba(255,255,255,0.72)');
  const timelineFrameBg = isMapDarkMode
    ? 'linear-gradient(180deg, rgba(7,14,30,0.58), rgba(10,18,36,0.46))'
    : 'linear-gradient(180deg, rgba(15,23,42,0.84), rgba(15,23,42,0.72))';
  const timelineFrameBorder = isMapDarkMode ? '1px solid rgba(255,255,255,0.14)' : '1px solid rgba(15,23,42,0.55)';
  const timelineTrackHitBg = isMapDarkMode ? 'rgba(255,255,255,0.02)' : 'rgba(148,163,184,0.2)';
  const timelineTrackBg = isMapDarkMode ? 'rgba(255,255,255,0.14)' : 'rgba(15,23,42,0.3)';
  const defaultTickColor = isMapDarkMode ? '#d5d8de' : '#e2e8f0';
  const tickRingColor = isMapDarkMode ? 'rgba(255,255,255,0.85)' : 'rgba(15,23,42,0.65)';
  const tickLabelDefaultColor = isMapDarkMode ? '#e5e7eb' : '#e2e8f0';
  const timelineControlButtonBase = isMapDarkMode
    ? timelineBtnStyle
    : {
      ...timelineBtnStyle,
      background: 'rgba(255,255,255,0.9)',
      border: '1px solid rgba(15,23,42,0.3)',
      color: '#0f172a',
      boxShadow: '0 4px 12px rgba(15,23,42,0.16)',
    };
  const timelineControlPlayBase = isMapDarkMode
    ? timelinePlayStyle
    : {
      ...timelinePlayStyle,
      background: 'linear-gradient(180deg, #1d4ed8, #1e40af)',
      border: '1px solid rgba(30,64,175,0.9)',
      color: '#eff6ff',
      boxShadow: '0 6px 16px rgba(30,64,175,0.35)',
    };
  const timelineSpeedCardBg = isMapDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.92)';
  const timelineSpeedCardBorder = isMapDarkMode ? '1px solid rgba(255,255,255,0.2)' : '1px solid rgba(15,23,42,0.24)';
  const timelineSpeedTextColor = isMapDarkMode ? 'rgba(226,232,240,0.95)' : '#0f172a';
  const selectedVehicleLabel = vehicleFilter === 'all' ? 'All Vehicles' : vehicleFilter;
  const selectedVehicleColor = vehicleFilter === 'all' ? '#dbeafe' : (vehicleColorById[vehicleFilter] || '#dbeafe');
  const selectedEmployeeLabel = employeeFilter === 'all' ? 'All Employees' : employeeFilter;
  const selectedEmployeeColor = employeeFilter === 'all'
    ? '#d1fae5'
    : (vehicleColorById[String(selectedEmployee?.vehicleId || '')] || '#d1fae5');
  const shouldShowGoogleMapsRoutes = ![
    distanceInfo?.requestedMetric,
    distanceInfo?.metric,
    distanceInfo?.backend,
  ].some((value) => String(value || '').trim().toLowerCase() === 'haversine');

  return (
    <div className="glass-morphism reflective-card-container" style={{ padding: 18, position: 'relative' }}>
      <div
        style={{
          position: 'relative',
          zIndex: 70,
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', position: 'relative' }}>
          <div ref={vehicleDropdownRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => {
                setIsVehicleDropdownOpen((prev) => !prev);
                setIsEmployeeDropdownOpen(false);
              }}
              aria-haspopup="listbox"
              aria-expanded={isVehicleDropdownOpen}
              style={{
                ...mapControlStyle,
                cursor: 'pointer',
                background: 'rgba(15,23,42,0.45)',
                border: '1px solid rgba(148,163,184,0.32)',
                minWidth: 170,
                color: '#e2e8f0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                paddingRight: 12,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 999, background: selectedVehicleColor }} />
                <span>{selectedVehicleLabel}</span>
              </span>
              <span style={{ fontSize: 12, opacity: 0.9 }}>{isVehicleDropdownOpen ? '\u25B2' : '\u25BC'}</span>
            </button>
            {isVehicleDropdownOpen ? (
              <div
                role="listbox"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: 0,
                  minWidth: 220,
                  maxHeight: 260,
                  overflowY: 'auto',
                  background: 'rgba(2,6,23,0.84)',
                  border: '1px solid rgba(148,163,184,0.32)',
                  borderRadius: 12,
                  padding: 8,
                  zIndex: 80,
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  boxShadow: '0 12px 30px rgba(2,6,23,0.42)',
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setVehicleFilter('all');
                    setIsVehicleDropdownOpen(false);
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    borderRadius: 8,
                    border: vehicleFilter === 'all' ? '1px solid rgba(226,232,240,0.42)' : '1px solid rgba(148,163,184,0.3)',
                    background: vehicleFilter === 'all' ? 'rgba(226,232,240,0.12)' : 'rgba(255,255,255,0.04)',
                    color: '#e2e8f0',
                    padding: '8px 10px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                    marginBottom: 6,
                  }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 999, background: '#dbeafe' }} />
                  All Vehicles
                </button>
                {vehicles.map((v) => {
                  const id = String(v?.id || '');
                  if (!id) return null;
                  const color = vehicleColorById[id] || '#dbeafe';
                  const isActive = vehicleFilter === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setVehicleFilter(id);
                        setIsVehicleDropdownOpen(false);
                      }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        borderRadius: 8,
                        border: isActive ? '1px solid rgba(226,232,240,0.42)' : '1px solid rgba(148,163,184,0.28)',
                        background: isActive ? 'rgba(226,232,240,0.12)' : 'rgba(255,255,255,0.04)',
                        color: '#e2e8f0',
                        padding: '8px 10px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        cursor: 'pointer',
                        marginBottom: 6,
                      }}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: 999, background: color }} />
                      {id}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div ref={employeeDropdownRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => {
                setIsEmployeeDropdownOpen((prev) => !prev);
                setIsVehicleDropdownOpen(false);
              }}
              aria-haspopup="listbox"
              aria-expanded={isEmployeeDropdownOpen}
              style={{
                ...mapControlStyle,
                cursor: 'pointer',
                background: 'rgba(15,23,42,0.45)',
                border: '1px solid rgba(148,163,184,0.32)',
                minWidth: 190,
                color: '#e2e8f0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                paddingRight: 12,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 999, background: selectedEmployeeColor }} />
                <span>{selectedEmployeeLabel}</span>
              </span>
              <span style={{ fontSize: 12, opacity: 0.9 }}>{isEmployeeDropdownOpen ? '\u25B2' : '\u25BC'}</span>
            </button>
            {isEmployeeDropdownOpen ? (
              <div
                role="listbox"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: 0,
                  minWidth: 230,
                  maxHeight: 260,
                  overflowY: 'auto',
                  background: 'rgba(2,6,23,0.84)',
                  border: '1px solid rgba(148,163,184,0.32)',
                  borderRadius: 12,
                  padding: 8,
                  zIndex: 80,
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  boxShadow: '0 12px 30px rgba(2,6,23,0.42)',
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setEmployeeFilter('all');
                    setIsEmployeeDropdownOpen(false);
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    borderRadius: 8,
                    border: employeeFilter === 'all' ? '1px solid rgba(226,232,240,0.42)' : '1px solid rgba(148,163,184,0.3)',
                    background: employeeFilter === 'all' ? 'rgba(226,232,240,0.12)' : 'rgba(255,255,255,0.04)',
                    color: '#e2e8f0',
                    padding: '8px 10px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                    marginBottom: 6,
                  }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 999, background: '#10b981' }} />
                  All Employees
                </button>
                {employees.map((emp) => {
                  const id = String(emp?.id || '');
                  if (!id) return null;
                  const empColor = vehicleColorById[String(emp?.vehicleId || '')] || '#10b981';
                  const isActive = employeeFilter === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setEmployeeFilter(id);
                        setIsEmployeeDropdownOpen(false);
                      }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        borderRadius: 8,
                        border: isActive ? '1px solid rgba(226,232,240,0.42)' : '1px solid rgba(148,163,184,0.28)',
                        background: isActive ? 'rgba(226,232,240,0.12)' : 'rgba(255,255,255,0.04)',
                        color: '#e2e8f0',
                        padding: '8px 10px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        cursor: 'pointer',
                        marginBottom: 6,
                      }}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: 999, background: empColor }} />
                      {id}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
        <button type="button" style={mapButtonStyle} onClick={() => setFitToBoundsToken((x) => x + 1)}>Fit to bounds</button>
        <button type="button" style={mapButtonStyle} onClick={handlePlayback}>{isPlaying ? 'Pause' : 'Playback'}</button>
      </div>

      <div className="map-panel-layout">
        <div
          className="map-panel-main"
          ref={mapTimelineFullscreenRef}
          style={isMapTimelineFullscreen
            ? {
              position: 'relative',
              display: 'grid',
              height: '100%',
              boxSizing: 'border-box',
              padding: 12,
              background: 'radial-gradient(circle at 35% 15%, rgba(40,60,110,0.35), rgba(3,6,14,0.98) 60%)',
            }
            : { display: 'grid', gap: 10, minWidth: 0 }}
        >
          <div
            style={{
              borderRadius: 18,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'radial-gradient(circle at 68% 80%, rgba(50,80,130,0.25), rgba(4,8,20,0.9) 62%)',
              padding: 14,
              width: '100%',
              boxSizing: 'border-box',
              minWidth: 0,
              overflow: 'hidden',
              minHeight: isMapTimelineFullscreen ? 0 : 510,
              height: isMapTimelineFullscreen ? 'calc(100vh - 24px)' : 510,
            }}
          >
            {showLoadingState ? (
              <div
                style={{
                  height: '100%',
                  display: 'grid',
                  placeItems: 'center',
                  color: 'rgba(226,236,255,0.84)',
                  textAlign: 'center',
                  gap: 10,
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: '50%',
                    border: '2px solid rgba(148,163,184,0.28)',
                    borderTopColor: '#60a5fa',
                    animation: 'map-panel-spin 0.9s linear infinite',
                  }}
                />
                <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>
                  Loading map data...
                </div>
              </div>
            ) : hasMapEntities ? (
              <ProjectMap
                projectId={projectId}
                employees={filteredEmployees}
                vehicles={filteredVehicles}
                rides={rides}
                officeCenter={officeCenter}
                timelineEvents={timelineEvents}
                currentMinute={mapSlider}
                visibleLayers={visibleLayers}
                fitBoundsNonce={fitToBoundsToken}
                vehicleColorById={vehicleColorById}
                fullscreenTargetRef={mapTimelineFullscreenRef}
                distanceInfo={distanceInfo}
                onThemeModeChange={setIsMapDarkMode}
                onMapInteraction={pausePlaybackOnMapInteraction}
              />
            ) : (
              <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'rgba(226,236,255,0.8)', textAlign: 'center', padding: '0 24px' }}>
                {emptyStateMessage}
              </div>
            )}
          </div>

          <div
            style={{
              position: isMapTimelineFullscreen ? 'absolute' : 'relative',
              top: isMapTimelineFullscreen ? 'auto' : undefined,
              left: isMapTimelineFullscreen ? '50%' : undefined,
              right: isMapTimelineFullscreen ? 'auto' : undefined,
              bottom: isMapTimelineFullscreen ? 24 : undefined,
              transform: isMapTimelineFullscreen ? 'translateX(-50%)' : undefined,
              width: isMapTimelineFullscreen ? 'min(960px, calc(100vw - 120px))' : '100%',
              maxWidth: isMapTimelineFullscreen ? '100%' : undefined,
              zIndex: isMapTimelineFullscreen ? 40 : undefined,
              padding: isMapTimelineFullscreen ? '6px 10px 6px' : '16px 18px 14px',
              borderRadius: 16,
              border: isMapTimelineFullscreen
                ? '1px solid rgba(255,255,255,0.07)'
                : '1px solid rgba(148,163,184,0.28)',
              background: 'transparent',
              backdropFilter: undefined,
              WebkitBackdropFilter: undefined,
              boxShadow: 'none',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: isMapTimelineFullscreen ? 6 : 10, fontWeight: 700, color: timelineTextColor }}>
              <span style={{ opacity: 0.9, background: timeLabelBg, borderRadius: 999, padding: '4px 10px' }}>{minuteToClock(minMinute)}</span>
              <span style={{ fontSize: isMapTimelineFullscreen ? '1.2rem' : '1.55rem', lineHeight: 1, background: timeLabelBg, borderRadius: 999, padding: isMapTimelineFullscreen ? '4px 12px' : '5px 14px' }}>{minuteToClock(mapSlider)}</span>
              <span style={{ opacity: 0.9, background: timeLabelBg, borderRadius: 999, padding: '4px 10px' }}>{minuteToClock(maxMinute)}</span>
            </div>

            <div
              style={{
                position: 'relative',
                paddingTop: isMapTimelineFullscreen ? 2 : 6,
                paddingBottom: isMapTimelineFullscreen ? 4 : 8,
                borderRadius: 12,
                background: timelineFrameBg,
                border: timelineFrameBorder,
                paddingLeft: 8,
                paddingRight: 8,
                backdropFilter: 'blur(10px) saturate(120%)',
                WebkitBackdropFilter: 'blur(10px) saturate(120%)',
              }}
            >
              <div
                ref={timelineTrackRef}
                onPointerDown={handleTimelinePointerDown}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: 28,
                  height: 14,
                  borderRadius: 999,
                  background: timelineTrackHitBg,
                  cursor: 'pointer',
                  zIndex: 4
                }}
              />
              <div style={{ position: 'absolute', left: 0, right: 0, top: 32, height: 6, borderRadius: 999, background: timelineTrackBg }} />
              <div style={{
                position: 'absolute',
                left: 0,
                top: 32,
                height: 6,
                borderRadius: 999,
                width: `${((mapSlider - minMinute) / Math.max(1, (maxMinute - minMinute))) * 100}%`,
                background: 'linear-gradient(90deg, #0fd3a7, #3b82f6)'
              }} />
              <div style={{
                position: 'absolute',
                top: 26,
                left: `calc(${((mapSlider - minMinute) / Math.max(1, (maxMinute - minMinute))) * 100}% - 8px)`,
                width: 18,
                height: 18,
                borderRadius: 999,
                background: '#dbeafe',
                border: '2px solid #3b82f6',
                boxShadow: '0 0 0 6px rgba(59,130,246,0.18)',
                zIndex: 5,
                pointerEvents: 'none',
              }} />
              <div
                style={{
                  position: 'relative',
                  zIndex: 6,
                  overflow: 'hidden',
                  paddingBottom: 6,
                }}
              >
                <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8, whiteSpace: 'nowrap' }}>
                  {timeTicks.map((tick) => {
                    const type = minuteTypes[tick];
                    const dotColor = type === 'pickup' ? '#14d3a7' : type === 'dropoff' ? '#f0b63f' : defaultTickColor;
                    const tickLabelColor = type ? dotColor : tickLabelDefaultColor;
                    return (
                      <div key={`tick-${tick}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <div
                          style={{
                            width: 14,
                            height: 14,
                            borderRadius: 999,
                            background: isMapTimelineFullscreen ? 'rgba(0,0,0,0)' : 'transparent',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <div style={{ width: 9, height: 9, borderRadius: 999, background: dotColor, border: `2px solid ${tickRingColor}` }} />
                        </div>
                        <div style={{ fontSize: '0.78rem', color: tickLabelColor }}>{minuteToClock(tick)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{ height: isMapTimelineFullscreen ? 6 : 16 }} />
            </div>

            <div style={{ marginTop: isMapTimelineFullscreen ? 8 : 14, display: 'flex', justifyContent: 'center', gap: isMapTimelineFullscreen ? 8 : 10 }}>
              <button
                type="button"
                style={isMapTimelineFullscreen
                  ? { ...timelineControlButtonBase, height: 34, minWidth: 44, padding: '0 8px', fontSize: '0.9rem' }
                  : timelineControlButtonBase}
                onClick={jumpToStart}
              >
                {'\u23EE'}
              </button>
              <button
                type="button"
                style={isMapTimelineFullscreen
                  ? { ...timelineControlButtonBase, height: 34, minWidth: 44, padding: '0 8px', fontSize: '0.9rem' }
                  : timelineControlButtonBase}
                onClick={() => seekBy(-SEEK_STEP_MINUTES)}
              >
                {'|\u25C0'}
              </button>
              <button
                type="button"
                style={isMapTimelineFullscreen
                  ? {
                    ...timelineControlPlayBase,
                    height: 30,
                    minWidth: 46,
                    padding: '0 8px',
                    fontSize: '0.9rem',
                    background: isMapDarkMode ? 'transparent' : timelineControlPlayBase.background,
                    border: isMapDarkMode ? '1px solid rgba(96,165,250,0.3)' : timelineControlPlayBase.border,
                    boxShadow: isMapDarkMode ? 'none' : timelineControlPlayBase.boxShadow,
                  }
                  : timelineControlPlayBase}
                onClick={handlePlayback}
              >
                {isPlaying ? '||' : '\u25B6'}
              </button>
              <button
                type="button"
                style={isMapTimelineFullscreen
                  ? { ...timelineControlButtonBase, height: 34, minWidth: 44, padding: '0 8px', fontSize: '0.9rem' }
                  : timelineControlButtonBase}
                onClick={() => seekBy(SEEK_STEP_MINUTES)}
              >
                {'\u25B6|'}
              </button>
              <div
                style={{
                  width: isMapTimelineFullscreen ? 180 : 210,
                  padding: isMapTimelineFullscreen ? '4px 8px' : '6px 10px',
                  borderRadius: 12,
                  border: timelineSpeedCardBorder,
                  background: timelineSpeedCardBg,
                  color: timelineSpeedTextColor,
                  display: 'grid',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', opacity: 0.85 }}>
                  <span>0.25x</span>
                  <span>{speedLabel}</span>
                  <span>2x</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="0.1"
                  value={speedSliderValue}
                  onInput={(e) => setPlaybackSpeed(sliderToSpeed(e.target.value))}
                  style={{ width: '100%', accentColor: '#3b82f6', cursor: 'pointer' }}
                  aria-label="Playback speed"
                />
              </div>
            </div>

          </div>
        </div>

        <div className="map-panel-side">
          <div className="glass-morphism reflective-card-container" style={{ padding: 16 }}>
            <h3 style={{ margin: 0, fontSize: '1.75rem', marginBottom: 10 }}>Layer Visibility</h3>
            {[
              ['employees', 'Employees'],
              ['routes', 'Colored Routes'],
              ['vehicles', 'Vehicles'],
            ].map(([key, label]) => (
              <div
                key={key}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8,
                  borderRadius: 10,
                  padding: '8px 10px',
                  background: layerThemeByKey[key]?.rowBg,
                  border: layerThemeByKey[key]?.rowBorder,
                }}
              >
                <span style={{ opacity: 0.92 }}>{label}</span>
                <button
                  type="button"
                  style={{
                    ...mapButtonStyle,
                    height: 32,
                    borderRadius: 9,
                    fontSize: '0.82rem',
                    padding: '0 10px',
                    minWidth: 68,
                    background: visibleLayers[key] ? layerThemeByKey[key]?.btnBg : 'rgba(148,163,184,0.14)',
                    border: visibleLayers[key] ? layerThemeByKey[key]?.btnBorder : '1px solid rgba(148,163,184,0.35)',
                    color: visibleLayers[key] ? layerThemeByKey[key]?.btnColor : '#cbd5e1',
                  }}
                  onClick={() => toggleLayer(key)}
                >
                  {visibleLayers[key] ? `Hide` : `Show`}
                </button>
              </div>
            ))}
          </div>

          <div className="glass-morphism reflective-card-container" style={{ padding: 16 }}>
            <h3 style={{ margin: 0, fontSize: '1.75rem', marginBottom: 12 }}>Legend</h3>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {shouldShowVehicleLegend && vehicleLegendEntries.length ? vehicleLegendEntries.map((entry) => {
                return (
                  <LegendItem
                    key={entry.id}
                    color={entry.color}
                    label={`${entry.id} (${entry.assignedCount})`}
                  />
                );
              }) : (
                <span style={{ opacity: 0.72 }}>
                  {shouldShowVehicleLegend ? 'No visible route or vehicle data available' : 'Routes and vehicles are hidden'}
                </span>
              )}
              {visibleLayers.employees && unassignedCount > 0 ? <LegendItem color="#ef4444" label={`Unassigned (${unassignedCount})`} /> : null}
            </div>
          </div>

          {shouldShowGoogleMapsRoutes ? (
            <div className="glass-morphism reflective-card-container" style={{ padding: 16 }}>
              <h3 style={{ margin: 0, fontSize: '1.75rem', marginBottom: 12 }}>Google Maps Routes</h3>
              <div
                style={{
                  display: 'grid',
                  gap: 10,
                  maxHeight: googleMapsRouteEntries.length > 2 ? 290 : undefined,
                  overflowY: googleMapsRouteEntries.length > 2 ? 'auto' : 'visible',
                  paddingRight: googleMapsRouteEntries.length > 2 ? 4 : 0,
                }}
              >
                {googleMapsRouteEntries.length ? googleMapsRouteEntries.map((entry) => (
                  <div
                    key={`maps-route-${entry.id}`}
                    style={{
                      borderRadius: 12,
                      border: '1px solid rgba(255,255,255,0.12)',
                      background: 'rgba(255,255,255,0.04)',
                      padding: 10,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: '1.1rem' }}>
                        <span style={{ width: 10, height: 10, borderRadius: 999, background: entry.color }} />
                        {entry.id}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', flex: '0 1 auto' }}>
                        {entry.mapsLinks.map((link) => (
                          <a
                            key={`map-route-link-${entry.id}-${link.index}`}
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
                  </div>
                )) : (
                  <div style={{ opacity: 0.72, lineHeight: 1.5 }}>
                    No route links available for the current filters. Select a vehicle with route stops to open it in Google Maps.
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default MapPanel;
