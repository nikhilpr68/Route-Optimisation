import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { GoogleMap, Marker, OverlayView, useGoogleMap, useJsApiLoader } from '@react-google-maps/api';
import { GOOGLE_MAPS_API_KEY, MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM } from '../../../config';
import { readMinuteByKeys } from '../workflow/panel/timelineUtils';
import { buildGoogleMapsCoordinateSegments } from '../workflow/panel/googleMapsLinks';

const containerStyle = {
  width: '100%',
  height: '100%'
};

// Dark map style
const darkMapStyle = [
  { elementType: "geometry", stylers: [{ color: "#0f172a" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#64748b" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0f172a" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#1e293b" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#334155" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#334155" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0c1929" }] },
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] }
];

// Light map style
const lightMapStyle = [
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] }
];

function getDistinctRouteColor(index) {
  const normalized = Number.isFinite(index) ? Math.max(0, Number(index)) : 0;
  const hue = Math.round((normalized * 137.508) % 360);
  return `hsl(${hue} 72% 58%)`;
}

const MINUTE_EPSILON = 1e-6;
const RIDE_START_MINUTE_KEYS = [
  'availabilityMinute',
  'availability_minute',
  'availabilityTime',
  'availability_time',
  'startMinute',
  'start_minute',
  'startTime',
  'start_time',
];

const normalizeEmployeeIds = (values) => {
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
};

const normalizePathPoints = (points = []) => {
  const out = [];
  points.forEach((pt) => {
    const lat = Number(pt?.lat);
    const lng = Number(pt?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const curr = { lat, lng };
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.lat - curr.lat) < 1e-8 && Math.abs(prev.lng - curr.lng) < 1e-8) return;
    out.push(curr);
  });
  return out;
};

const normalizePathPointsStrict = (points = []) => points
  .map((pt) => ({ lat: Number(pt?.lat), lng: Number(pt?.lng) }))
  .filter((pt) => Number.isFinite(pt.lat) && Number.isFinite(pt.lng));

const buildFitSignature = ({ officeLocation, employees = [], vehicles = [] }) => {
  const encodePoint = (point, prefix = '') => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return `${prefix}:na`;
    return `${prefix}:${lat.toFixed(6)},${lng.toFixed(6)}`;
  };

  return [
    encodePoint(officeLocation, 'office'),
    ...employees.map((employee, index) => (
      encodePoint(
        { lat: employee?.lat, lng: employee?.lng },
        `emp-${String(employee?.id || index)}`
      )
    )),
    ...vehicles.map((vehicle, index) => (
      encodePoint(
        { lat: vehicle?.startLat, lng: vehicle?.startLng },
        `veh-${String(vehicle?.id || index)}`
      )
    )),
  ].join('|');
};

const normalizeStopType = (value) => {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'pickup') return 'pickup';
  if (type === 'dropoff' || type === 'drop') return 'dropoff';
  return 'stop';
};

const stopTypeLabel = (value) => {
  const type = normalizeStopType(value);
  if (type === 'pickup') return 'Pickup';
  if (type === 'dropoff') return 'Dropoff';
  return 'Stop';
};

const toSvgUrl = (svg) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;

const createTileIcon = ({ glyphSvg, size = 56 }) => ({
  url: toSvgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 56 56">
      ${glyphSvg}
    </svg>`
  ),
  scaledSize: (typeof window !== 'undefined' && window.google?.maps) ? new window.google.maps.Size(size, size) : undefined,
  anchor: (typeof window !== 'undefined' && window.google?.maps) ? new window.google.maps.Point(size / 2, size / 2) : undefined,
});

// Icon set matched to requested style
const createEmployeeIcon = (color = '#60a5fa') => {
  const pinColor = color || '#60a5fa';
  return createTileIcon({
    glyphSvg: `
      <path d="M28 14c-6 0-10 4.5-10 10 0 7.5 10 18 10 18s10-10.5 10-18c0-5.5-4-10-10-10z" 
            fill="${pinColor}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="28" cy="24" r="5" fill="#fff"/>
    `,
    size: 54,
  });
};

const createVehicleIcon = (color = '#22b8ff', headingDeg = 0, iconStyle = 'car') => {
  // Car orientation is always horizontal (no rotation)
  
  if (iconStyle === 'arrow') {
    // Navigation arrow style with rotation
    const angle = Number.isFinite(headingDeg) ? headingDeg : 0;
    return createTileIcon({
      glyphSvg: `
        <g transform="rotate(${angle} 28 28)">
          <path d="M28 12 L40 38 L28 34 L16 38 Z" 
                fill="${color}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
        </g>
      `,
      size: 58,
    });
  }
  
  // Side-view car style (always horizontal, no rotation)
  return createTileIcon({
    glyphSvg: `
      <ellipse cx="28" cy="38" rx="16" ry="3" fill="rgba(0,0,0,0.15)"/>
      <path d="M16 30 L18 24 L22 20 L34 20 L38 24 L40 30 L40 34 C40 35 39.5 36 38.5 36 L37.5 36 C37.5 36 37.5 35 37.5 34.5 L18.5 34.5 C18.5 35 18.5 36 18.5 36 L17.5 36 C16.5 36 16 35 16 34 Z" 
            fill="${color}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
      <path d="M22 20 L24 24 L34 24 L36 20" fill="${color}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
      <rect x="23" y="21.5" width="5" height="3" rx="0.5" fill="rgba(100,180,255,0.6)" stroke="#fff" stroke-width="0.8"/>
      <rect x="30" y="21.5" width="5" height="3" rx="0.5" fill="rgba(100,180,255,0.6)" stroke="#fff" stroke-width="0.8"/>
      <circle cx="22" cy="35" r="3" fill="#2d3748" stroke="#fff" stroke-width="1.5"/>
      <circle cx="36" cy="35" r="3" fill="#2d3748" stroke="#fff" stroke-width="1.5"/>
      <circle cx="22" cy="35" r="1.5" fill="#64748b"/>
      <circle cx="36" cy="35" r="1.5" fill="#64748b"/>
      <circle cx="18" cy="28" r="1.2" fill="#fff" opacity="0.9"/>
      <circle cx="40" cy="28" r="1.2" fill="#fff" opacity="0.9"/>
    `,
    size: 64,
  });
};

const createOfficeIcon = () => createTileIcon({
  glyphSvg: `
    <defs>
      <linearGradient id="buildingGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style="stop-color:#3b82f6;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#1e40af;stop-opacity:1" />
      </linearGradient>
    </defs>
    <rect x="8" y="48" width="40" height="2" fill="#1e293b"/>
    <rect x="12" y="10" width="32" height="38" rx="2" fill="url(#buildingGrad)" stroke="#fff" stroke-width="2.5"/>
    <rect x="16" y="14" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="22" y="14" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="28" y="14" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="34" y="14" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="16" y="20" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="22" y="20" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="28" y="20" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="34" y="20" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="16" y="26" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="22" y="26" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="28" y="26" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="34" y="26" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="16" y="32" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="22" y="32" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="28" y="32" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="34" y="32" width="4" height="4" rx="0.5" fill="#dbeafe" opacity="0.9"/>
    <rect x="22" y="38" width="12" height="10" rx="1" fill="#1e3a8a"/>
    <rect x="24" y="40" width="3.5" height="8" fill="#93c5fd" opacity="0.7"/>
    <rect x="28.5" y="40" width="3.5" height="8" fill="#93c5fd" opacity="0.7"/>
    <line x1="28" y1="40" x2="28" y2="48" stroke="#1e3a8a" stroke-width="1.5"/>
  `,
  size: 72,
});

// Custom styled InfoWindow (dark themed)
const CustomInfoWindow = ({ employee, onClose }) => (
  <OverlayView
    position={{ lat: employee.lat, lng: employee.lng }}
    mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
  >
    <div style={{
      transform: 'translate(-50%, -130%)',
      background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
      borderRadius: '12px',
      padding: '14px 16px',
      minWidth: '160px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      border: '1px solid rgba(255,255,255,0.1)',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      {/* Close button */}
      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: '8px',
          right: '8px',
          background: 'none',
          border: 'none',
          color: '#64748b',
          cursor: 'pointer',
          fontSize: '16px',
          padding: '4px'
        }}
      >x</button>

      {/* Employee ID */}
      <div style={{ fontSize: '16px', fontWeight: '700', color: '#fff', marginBottom: '8px' }}>
        {employee.id}
      </div>

      {/* Status badge */}
      <span style={{
        display: 'inline-block',
        padding: '4px 10px',
        borderRadius: '6px',
        fontSize: '11px',
        fontWeight: '600',
        background: employee.status === 'Onboard' || employee.status === 'Picked Up'
          ? 'rgba(16, 185, 129, 0.2)'
          : 'rgba(245, 158, 11, 0.2)',
        color: employee.status === 'Onboard' || employee.status === 'Picked Up'
          ? '#10b981'
          : '#f59e0b',
        marginBottom: '10px'
      }}>
        {employee.status}
      </span>

      {/* Details */}
      <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
          <span>Pickup</span>
          <span style={{ color: '#fff', fontWeight: '600' }}>{employee.pickupTime}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
          <span>Vehicle</span>
          <span style={{ color: '#fff', fontWeight: '600' }}>{employee.vehicleId}</span>
        </div>
        {employee.delay > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Delay</span>
            <span style={{ color: '#ef4444', fontWeight: '600' }}>+{employee.delay}m</span>
          </div>
        )}
      </div>

      {/* Arrow pointer */}
      <div style={{
        position: 'absolute',
        bottom: '-8px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 0,
        height: 0,
        borderLeft: '8px solid transparent',
        borderRight: '8px solid transparent',
        borderTop: '8px solid #0f172a'
      }} />
    </div>
  </OverlayView>
);

const VehicleInfoWindow = ({ vehicle, onClose }) => (
  <OverlayView
    position={{ lat: vehicle.lat, lng: vehicle.lng }}
    mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
  >
    <div style={{
      transform: 'translate(-50%, -130%)',
      background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
      borderRadius: '12px',
      padding: '14px 16px',
      minWidth: '190px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      border: '1px solid rgba(255,255,255,0.1)',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: '8px',
          right: '8px',
          background: 'none',
          border: 'none',
          color: '#64748b',
          cursor: 'pointer',
          fontSize: '16px',
          padding: '4px'
        }}
      >
        x
      </button>

      <div style={{ fontSize: '16px', fontWeight: '700', color: '#fff', marginBottom: '8px' }}>
        {vehicle.id}
      </div>

      <span style={{
        display: 'inline-block',
        padding: '4px 10px',
        borderRadius: '6px',
        fontSize: '11px',
        fontWeight: '600',
        background: 'rgba(59,130,246,0.2)',
        color: '#93c5fd',
        marginBottom: '10px'
      }}>
        {vehicle.type}
      </span>

      <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
          <span>Assigned</span>
          <span style={{ color: '#fff', fontWeight: '600' }}>{vehicle.assignedCount}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
          <span>Currently onboard</span>
          <span style={{ color: '#fff', fontWeight: '600' }}>{vehicle.onboardCount}</span>
        </div>
        <div style={{ marginBottom: '4px' }}>
          <span>Onboard IDs</span>
          <div style={{ color: '#fff', fontWeight: '600', marginTop: 2, wordBreak: 'break-word' }}>
            {vehicle.onboardEmployeeIds.length ? vehicle.onboardEmployeeIds.join(', ') : '-'}
          </div>
        </div>
        <div>
          <span>Heading to</span>
          <div style={{ color: '#fff', fontWeight: '600', marginTop: 2, wordBreak: 'break-word' }}>
            {vehicle.nextTargetLabel}
          </div>
        </div>
      </div>

      <div style={{
        position: 'absolute',
        bottom: '-8px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 0,
        height: 0,
        borderLeft: '8px solid transparent',
        borderRight: '8px solid transparent',
        borderTop: '8px solid #0f172a'
      }} />
    </div>
  </OverlayView>
);

const clearVehicleSelection = (setSelectedVehicleId, setSelectedRoute) => {
  setSelectedVehicleId(null);
  setSelectedRoute(null);
};

// Stats overlay - Small pills at bottom-right
const MapStats = ({ employees }) => {
  const onboard = employees.filter(e => e.status === 'Onboard' || e.status === 'Picked Up').length;
  const delayed = employees.filter(e => e.delay > 0).length;

  return (
    <div style={{
      position: 'absolute',
      bottom: '12px',
      left: '12px',
      display: 'flex',
      gap: '6px',
      zIndex: 3
    }}>
      <div style={{
        background: 'rgba(16, 185, 129, 0.15)',
        backdropFilter: 'blur(8px)',
        borderRadius: '20px',
        padding: '6px 12px',
        border: '1px solid rgba(16, 185, 129, 0.3)',
        display: 'flex',
        alignItems: 'center',
        gap: '6px'
      }}>
        <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981' }} />
        <span style={{ fontSize: '11px', fontWeight: '600', color: '#10b981' }}>{onboard}/{employees.length}</span>
      </div>
      {delayed > 0 && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.15)',
          backdropFilter: 'blur(8px)',
          borderRadius: '20px',
          padding: '6px 12px',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}>
          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ef4444' }} />
          <span style={{ fontSize: '11px', fontWeight: '600', color: '#ef4444' }}>{delayed} late</span>
        </div>
      )}
    </div>
  );
};

const controlButtonStyle = {
  width: '40px',
  height: '40px',
  borderRadius: '10px',
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.98) 0%, rgba(15, 23, 42, 0.98) 100%)',
  backdropFilter: 'blur(12px)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#fff',
  transition: 'all 0.2s ease',
  boxShadow: '0 4px 16px rgba(0,0,0,0.2)'
};

const ZoomControls = ({ onZoomIn, onZoomOut }) => (
  <div style={{
    position: 'absolute',
    bottom: '20px',
    right: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    zIndex: 3
  }}>
    <button
      onClick={onZoomIn}
      style={{
        ...controlButtonStyle,
        fontSize: '20px',
        fontWeight: '700',
      }}
      title="Zoom in"
    >
      +
    </button>

    <button
      onClick={onZoomOut}
      style={{
        ...controlButtonStyle,
        fontSize: '20px',
        fontWeight: '700',
      }}
      title="Zoom out"
    >
      -
    </button>
  </div>
);

const MapControls = ({ isDarkMode, onToggleTheme, onFullscreen, isFullscreen, vehicleIconStyle, onToggleVehicleIcon }) => {
  const [showMenu, setShowMenu] = React.useState(false);
  
  return (
    <div style={{
      position: 'absolute',
      top: '12px',
      right: '12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      zIndex: 3
    }}>
      {/* Three-dot menu button */}
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setShowMenu(!showMenu)}
          style={{
            ...controlButtonStyle,
          }}
          title="Map Settings"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="1" fill="currentColor" />
            <circle cx="12" cy="5" r="1" fill="currentColor" />
            <circle cx="12" cy="19" r="1" fill="currentColor" />
          </svg>
        </button>

        {/* Dropdown menu */}
        {showMenu && (
          <div style={{
            position: 'absolute',
            top: '0',
            right: '52px',
            backgroundColor: 'rgba(30, 30, 40, 0.98)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '8px',
            padding: '8px',
            minWidth: '200px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            backdropFilter: 'blur(10px)',
          }}>
            {/* Theme toggle option */}
            <button
              onClick={() => {
                onToggleTheme();
                setShowMenu(false);
              }}
              style={{
                width: '100%',
                padding: '10px 12px',
                backgroundColor: 'transparent',
                border: 'none',
                color: '#e5e7eb',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                fontSize: '14px',
                borderRadius: '6px',
                transition: 'background-color 0.2s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              {isDarkMode ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2" />
                  <path d="M12 20v2" />
                  <path d="M4.93 4.93l1.41 1.41" />
                  <path d="M17.66 17.66l1.41 1.41" />
                  <path d="M2 12h2" />
                  <path d="M20 12h2" />
                  <path d="M6.34 17.66l-1.41 1.41" />
                  <path d="M19.07 4.93l-1.41 1.41" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                </svg>
              )}
              <span>{isDarkMode ? 'Light Mode' : 'Dark Mode'}</span>
            </button>

            {/* Divider */}
            <div style={{
              height: '1px',
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              margin: '8px 0',
            }} />

            {/* Vehicle icon toggle option */}
            <button
              onClick={() => {
                onToggleVehicleIcon();
                setShowMenu(false);
              }}
              style={{
                width: '100%',
                padding: '10px 12px',
                backgroundColor: 'transparent',
                border: 'none',
                color: '#e5e7eb',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                fontSize: '14px',
                borderRadius: '6px',
                transition: 'background-color 0.2s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              {vehicleIconStyle === 'car' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 19h20L12 2z" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 17h14v-4l-2-3H7l-2 3v4z" />
                  <circle cx="7" cy="17" r="2" />
                  <circle cx="17" cy="17" r="2" />
                </svg>
              )}
              <span>{vehicleIconStyle === 'car' ? 'Arrow Icons' : 'Car Icons'}</span>
            </button>
          </div>
        )}
      </div>

      {/* Fullscreen button */}
      <button
        onClick={onFullscreen}
        style={{
          ...controlButtonStyle,
        }}
        title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
      >
        {isFullscreen ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
            <path d="M10 3V9H4" />
            <path d="M14 3V9H20" />
            <path d="M10 21V15H4" />
            <path d="M14 21V15H20" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
            <path d="M3 9V3H9" />
            <path d="M15 3H21V9" />
            <path d="M3 15V21H9" />
            <path d="M15 21H21V15" />
          </svg>
        )}
      </button>
    </div>
  );
};

const isValidLatLng = (p) => (
  p &&
  typeof p.lat === 'number' &&
  Number.isFinite(p.lat) &&
  typeof p.lng === 'number' &&
  Number.isFinite(p.lng)
);

const interpolatePoint = (a, b, t) => ({
  lat: a.lat + ((b.lat - a.lat) * t),
  lng: a.lng + ((b.lng - a.lng) * t),
});

const computeHeadingDegrees = (from, to) => {
  if (!from || !to) return 0;
  const dLat = Number(to.lat) - Number(from.lat);
  const dLng = Number(to.lng) - Number(from.lng);
  if (!Number.isFinite(dLat) || !Number.isFinite(dLng) || (Math.abs(dLat) < 1e-9 && Math.abs(dLng) < 1e-9)) return 0;
  return ((Math.atan2(dLng, dLat) * 180) / Math.PI + 360) % 360;
};

const pointDistance = (a, b) => {
  if (!a || !b) return 0;
  const dLat = Number(b.lat) - Number(a.lat);
  const dLng = Number(b.lng) - Number(a.lng);
  if (!Number.isFinite(dLat) || !Number.isFinite(dLng)) return 0;
  return Math.hypot(dLat, dLng);
};

const firstFiniteNumber = (...values) => {
  for (const value of values) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) return numericValue;
  }
  return null;
};

const isMeaningfulMovementSegment = (fromPoint, toPoint, segmentStart, segmentEnd) => (
  isValidLatLng(fromPoint)
  && isValidLatLng(toPoint)
  && Number.isFinite(segmentStart)
  && Number.isFinite(segmentEnd)
  && segmentEnd > (segmentStart + MINUTE_EPSILON)
  && pointDistance(fromPoint, toPoint) > 1e-8
);

const interpolateOnPolyline = (path, t) => {
  if (!Array.isArray(path) || path.length === 0) return null;
  if (path.length === 1) return { point: path[0], headingDeg: 0 };

  const clamped = Math.max(0, Math.min(1, Number(t) || 0));
  const segmentLengths = [];
  let total = 0;
  for (let idx = 1; idx < path.length; idx += 1) {
    const len = pointDistance(path[idx - 1], path[idx]);
    segmentLengths.push(len);
    total += len;
  }

  if (!(total > 0)) {
    const a = path[0];
    const b = path[path.length - 1];
    return { point: interpolatePoint(a, b, clamped), headingDeg: computeHeadingDegrees(a, b) };
  }

  const target = total * clamped;
  let traversed = 0;
  for (let idx = 1; idx < path.length; idx += 1) {
    const segLen = segmentLengths[idx - 1];
    if (!(segLen > 0)) continue;
    const nextTraversed = traversed + segLen;
    if (target <= nextTraversed || idx === path.length - 1) {
      const localT = (target - traversed) / segLen;
      const a = path[idx - 1];
      const b = path[idx];
      return { point: interpolatePoint(a, b, localT), headingDeg: computeHeadingDegrees(a, b) };
    }
    traversed = nextTraversed;
  }

  const last = path[path.length - 1];
  const prev = path[path.length - 2];
  return { point: last, headingDeg: computeHeadingDegrees(prev, last) };
};

const trimPolylineFromProgress = (path, progress) => {
  if (!Array.isArray(path) || path.length < 2) return [];
  const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
  if (clamped <= 0) return path;
  if (clamped >= 1) return [];

  const segmentLengths = [];
  let total = 0;
  for (let idx = 1; idx < path.length; idx += 1) {
    const len = pointDistance(path[idx - 1], path[idx]);
    segmentLengths.push(len);
    total += len;
  }

  if (!(total > 0)) {
    const sample = interpolateOnPolyline(path, clamped);
    return sample?.point ? [sample.point, path[path.length - 1]] : path;
  }

  const target = total * clamped;
  let traversed = 0;
  for (let idx = 1; idx < path.length; idx += 1) {
    const segLen = segmentLengths[idx - 1];
    const nextTraversed = traversed + segLen;
    if (target <= nextTraversed || idx === path.length - 1) {
      const localT = segLen > 0 ? (target - traversed) / segLen : 0;
      const startPoint = interpolatePoint(path[idx - 1], path[idx], Math.max(0, Math.min(1, localT)));
      return [startPoint, ...path.slice(idx)];
    }
    traversed = nextTraversed;
  }

  return [path[path.length - 1]];
};

const hasRenderablePath = (path) => Array.isArray(path) && path.length >= 2;

const getPlaybackSegmentPath = (segment, usesHaversineRoutes) => {
  if (hasRenderablePath(segment?.polyline)) return segment.polyline;
  if (!usesHaversineRoutes) return [];
  return normalizePathPoints([segment?.fromPoint, segment?.toPoint]);
};

const buildRemainingRoutePath = (segments, currentPath = null, usesHaversineRoutes = false) => {
  const points = [];
  if (hasRenderablePath(currentPath)) appendUniquePathPoints(points, currentPath);
  segments.forEach((segment) => {
    const path = getPlaybackSegmentPath(segment, usesHaversineRoutes);
    if (hasRenderablePath(path)) appendUniquePathPoints(points, path);
  });
  return normalizePathPoints(points);
};

const normalizeOverviewPath = (overviewPath) => {
  if (!Array.isArray(overviewPath)) return [];
  return overviewPath
    .map((pt) => ({
      lat: typeof pt.lat === 'function' ? pt.lat() : pt.lat,
      lng: typeof pt.lng === 'function' ? pt.lng() : pt.lng,
    }))
    .filter((pt) => Number.isFinite(pt.lat) && Number.isFinite(pt.lng));
};

const toLatLngLiteral = (point) => {
  if (!point) return null;
  const latValue = typeof point.lat === 'function' ? point.lat() : point.lat;
  const lngValue = typeof point.lng === 'function' ? point.lng() : point.lng;
  const lat = Number(latValue);
  const lng = Number(lngValue);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
};

const normalizeDirectionsPath = (path) => {
  if (!path) return [];
  if (typeof path.getArray === 'function') return normalizeDirectionsPath(path.getArray());
  if (!Array.isArray(path)) return [];
  return normalizePathPoints(path.map((pt) => toLatLngLiteral(pt)).filter(Boolean));
};

const appendUniquePathPoints = (target, source) => {
  source.forEach((point) => {
    const prev = target[target.length - 1];
    if (
      prev
      && Math.abs(prev.lat - point.lat) < 1e-8
      && Math.abs(prev.lng - point.lng) < 1e-8
    ) {
      return;
    }
    target.push(point);
  });
};

const buildLegPolyline = (leg, fallbackFrom, fallbackTo) => {
  const fallbackPath = normalizePathPoints([fallbackFrom, fallbackTo]);
  if (!leg) return fallbackPath;

  const points = [];
  const legStart = toLatLngLiteral(leg.start_location);
  const legEnd = toLatLngLiteral(leg.end_location);
  if (isValidLatLng(fallbackFrom)) appendUniquePathPoints(points, [fallbackFrom]);
  if (isValidLatLng(legStart)) appendUniquePathPoints(points, [legStart]);

  const steps = Array.isArray(leg.steps) ? leg.steps : [];
  steps.forEach((step) => {
    const stepPath = normalizeDirectionsPath(step?.path);
    if (stepPath.length) {
      appendUniquePathPoints(points, stepPath);
      return;
    }
    const stepFallback = normalizePathPoints([
      toLatLngLiteral(step?.start_location),
      toLatLngLiteral(step?.end_location),
    ]);
    appendUniquePathPoints(points, stepFallback);
  });

  if (isValidLatLng(legEnd)) appendUniquePathPoints(points, [legEnd]);
  if (isValidLatLng(fallbackTo)) appendUniquePathPoints(points, [fallbackTo]);
  if (points.length >= 2) return points;
  return fallbackPath;
};

const RoutePolyline = ({ path = [], options = {} }) => {
  const map = useGoogleMap();
  const polylineRef = useRef(null);

  useEffect(() => {
    if (!map || !window.google) return undefined;
    if (!polylineRef.current) polylineRef.current = new window.google.maps.Polyline();
    return () => {
      if (polylineRef.current) {
        polylineRef.current.setMap(null);
        polylineRef.current = null;
      }
    };
  }, [map]);

  useEffect(() => {
    const polyline = polylineRef.current;
    if (!polyline || !map) return;

    const shouldShow = hasRenderablePath(path) && options?.visible !== false;
    polyline.setOptions(options);
    if (shouldShow) {
      polyline.setPath(path);
      polyline.setMap(map);
      return;
    }

    polyline.setPath([]);
    polyline.setMap(null);
  }, [map, options, path]);

  return null;
};

const ProjectMap = ({
  projectId = '',
  vehicles,
  employees,
  rides = [],
  officeCenter,
  timelineEvents = [],
  currentMinute = null,
  visibleLayers = { employees: true, routes: true, vehicles: true },
  fitBoundsNonce = 0,
  vehicleColorById = {},
  fullscreenTargetRef = null,
  onThemeModeChange = null,
  distanceInfo = null,
  onMapInteraction = null,
}) => {
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState(null);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [vehicleIconStyle, setVehicleIconStyle] = useState('car'); // 'car' or 'arrow'
  const [directions, setDirections] = useState({});
  const [mapLoaded, setMapLoaded] = useState(false);
  const { isLoaded: isMapsReady, loadError } = useJsApiLoader({
    id: 'route-optimization-google-map-script',
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
  });
  const mapRef = useRef(null);
  const mapWrapperRef = useRef(null);
  const lastFitSignatureRef = useRef('');
  const hasInitialFitRef = useRef(false);
  const showEmployees = visibleLayers?.employees !== false;
  const showRoutes = visibleLayers?.routes !== false;
  const showVehicles = visibleLayers?.vehicles !== false;
  const selectedRouteId = selectedRoute == null ? null : String(selectedRoute);
  const hasRouteFilter = selectedRouteId !== null && (showRoutes || showVehicles);
  const officeLocation = isValidLatLng(officeCenter) ? officeCenter : MAP_DEFAULT_CENTER;
  const fitSignature = useMemo(
    () => buildFitSignature({ officeLocation, employees, vehicles }),
    [officeLocation, employees, vehicles]
  );

  useEffect(() => {
    hasInitialFitRef.current = false;
    lastFitSignatureRef.current = '';
  }, [projectId]);
  const timeDrivenMode = Number.isFinite(currentMinute) && Array.isArray(timelineEvents) && timelineEvents.length > 0;
  useEffect(() => {
    if (typeof onThemeModeChange === 'function') onThemeModeChange(isDarkMode);
  }, [isDarkMode, onThemeModeChange]);
  const requestedDistanceMetric = String(distanceInfo?.requestedMetric || '').trim().toLowerCase();
  const usesHaversineRoutes = requestedDistanceMetric === 'haversine';
  const getColorForVehicle = useCallback((vehicleId, fallbackIndex = 0) => {
    const id = String(vehicleId || '');
    return vehicleColorById[id] || getDistinctRouteColor(fallbackIndex);
  }, [vehicleColorById]);

  const processedTimeline = useMemo(() => {
    if (!Array.isArray(timelineEvents)) return [];
    return timelineEvents
      .filter((e) => Number.isFinite(e?.minute))
      .map((e) => ({
        minute: Number(e.minute),
        vehicleId: e.vehicleId ? String(e.vehicleId) : '',
        employeeId: e.employeeId ? String(e.employeeId) : '',
        type: String(e.type || '').toLowerCase(),
        lat: Number(e.lat),
        lng: Number(e.lng),
      }))
      .sort((a, b) => a.minute - b.minute);
  }, [timelineEvents]);

  const ridePathByVehicle = useMemo(() => {
    const out = {};
    (Array.isArray(rides) ? rides : []).forEach((ride) => {
      const vehicleId = String(ride?.vehicleId || '').trim();
      if (!vehicleId) return;
      const path = Array.isArray(ride?.path) ? ride.path : [];
      if (!path.length) return;

      const startMinute = readMinuteByKeys(ride, RIDE_START_MINUTE_KEYS);
      let cursorMinute = Number.isFinite(startMinute) ? Number(startMinute) : (8 * 60);

      const stops = path.map((stop, idx) => {
        const arrivalMinuteRaw = readMinuteByKeys(stop, [
          'arrivalMinute',
          'arrival_minute',
          'arrivalTime',
          'timeMinute',
          'timeMinutes',
          'minute',
          'time',
          'plannedPickupTime',
          'plannedDropoffTime',
          'eta',
          'timestamp',
        ]);
        if (Number.isFinite(arrivalMinuteRaw)) {
          cursorMinute = Math.max(cursorMinute, Number(arrivalMinuteRaw));
        } else if (idx > 0) {
          cursorMinute += 5;
        }

        const arrivalMinute = Number.isFinite(arrivalMinuteRaw) ? Number(arrivalMinuteRaw) : cursorMinute;
        const departureMinuteRaw = readMinuteByKeys(stop, [
          'departureMinute',
          'departure_minute',
          'departureTime',
          'departure_time',
        ]);
        const departureMinute = Number.isFinite(departureMinuteRaw)
          ? Number(departureMinuteRaw)
          : arrivalMinute;

        return {
          index: idx,
          type: normalizeStopType(stop?.type),
          employeeId: stop?.employeeId ? String(stop.employeeId) : '',
          lat: Number(stop?.lat),
          lng: Number(stop?.lng),
          arrivalMinute,
          departureMinute,
          travelMinutesFromPrev: Number(stop?.travelMinutesFromPrev),
          employeesOnboardAfter: normalizeEmployeeIds(stop?.employeesOnboardAfter || stop?.onboardAfter || []),
        };
      }).filter((stop) => Number.isFinite(stop.arrivalMinute));

      out[vehicleId] = stops;
    });
    return out;
  }, [rides]);

  const rideStartMinuteByVehicle = useMemo(() => {
    const out = {};
    (Array.isArray(rides) ? rides : []).forEach((ride) => {
      const vehicleId = String(ride?.vehicleId || '').trim();
      if (!vehicleId) return;
      const startMinute = readMinuteByKeys(ride, RIDE_START_MINUTE_KEYS);
      if (Number.isFinite(startMinute)) out[vehicleId] = Number(startMinute);
    });
    return out;
  }, [rides]);

  const rideStateTimelineByVehicle = useMemo(() => {
    const out = {};
    (Array.isArray(rides) ? rides : []).forEach((ride) => {
      const vehicleId = String(ride?.vehicleId || '').trim();
      if (!vehicleId) return;
      const segments = (Array.isArray(ride?.stateTimeline) ? ride.stateTimeline : [])
        .map((segment) => ({
          state: String(segment?.state || '').trim().toLowerCase(),
          startMinute: Number(segment?.startMinute),
          endMinute: Number(segment?.endMinute),
          employeesOnboard: normalizeEmployeeIds(segment?.employeesOnboard || []),
        }))
        .filter((segment) => (
          Number.isFinite(segment.startMinute)
          && Number.isFinite(segment.endMinute)
          && segment.endMinute > (segment.startMinute + MINUTE_EPSILON)
        ));
      if (segments.length) out[vehicleId] = segments;
    });
    return out;
  }, [rides]);

  const rideRoutePathByVehicle = useMemo(() => {
    const out = {};
    vehicles.forEach((vehicle) => {
      const vehicleId = String(vehicle?.id || '').trim();
      if (!vehicleId) return;
      const stops = ridePathByVehicle[vehicleId] || [];
      if (!stops.length) return;

      const points = normalizePathPointsStrict([
        { lat: Number(vehicle?.startLat), lng: Number(vehicle?.startLng) },
        ...stops.map((stop) => ({ lat: Number(stop?.lat), lng: Number(stop?.lng) })),
      ]);
      if (points.length >= 2) out[vehicleId] = points;
    });
    return out;
  }, [vehicles, ridePathByVehicle]);

  const routeRequestSegmentsByVehicle = useMemo(() => {
    const out = {};
    const vehicleById = vehicles.reduce((acc, vehicle) => {
      const vehicleId = String(vehicle?.id || '').trim();
      if (vehicleId) acc[vehicleId] = vehicle;
      return acc;
    }, {});

    (Array.isArray(rides) ? rides : []).forEach((ride) => {
      const vehicleId = String(ride?.vehicleId || '').trim();
      if (!vehicleId) return;
      const vehicle = vehicleById[vehicleId];
      const startCoord = {
        lat: Number(vehicle?.startLat),
        lng: Number(vehicle?.startLng),
      };
      const segments = buildGoogleMapsCoordinateSegments({ ride, startCoord });
      if (segments.length) out[vehicleId] = segments;
    });

    return out;
  }, [rides, vehicles]);

  const routeLegPathByVehicle = useMemo(() => {
    const out = {};
    Object.entries(rideRoutePathByVehicle).forEach(([vehicleId, points]) => {
      if (!Array.isArray(points) || points.length < 2) return;
      const legs = Array.isArray(directions?.[vehicleId]?.legs) ? directions[vehicleId].legs : [];

      const segmentPolylines = [];
      let legCursor = 0;
      for (let idx = 0; idx < points.length - 1; idx += 1) {
        const fromPoint = points[idx];
        const toPoint = points[idx + 1];
        if (usesHaversineRoutes) {
          segmentPolylines.push(normalizePathPoints([fromPoint, toPoint]));
          continue;
        }
        if (pointDistance(fromPoint, toPoint) <= 1e-8) {
          segmentPolylines.push([]);
          continue;
        }
        const leg = legs[legCursor] || null;
        legCursor += 1;
        const polyline = leg ? buildLegPolyline(leg, fromPoint, toPoint) : [];
        segmentPolylines.push(hasRenderablePath(polyline) ? polyline : []);
      }
      out[vehicleId] = segmentPolylines;
    });
    return out;
  }, [directions, rideRoutePathByVehicle, usesHaversineRoutes]);

  const renderedRoutePathByVehicle = useMemo(() => {
    const out = {};
    Object.entries(rideRoutePathByVehicle).forEach(([vehicleId, directPath]) => {
      const segmentPolylines = routeLegPathByVehicle[vehicleId] || [];
      const flattened = [];
      segmentPolylines.forEach((segment) => appendUniquePathPoints(flattened, normalizePathPoints(segment)));
      if (flattened.length >= 2) {
        out[vehicleId] = flattened;
        return;
      }

      const route = normalizeOverviewPath(directions?.[vehicleId]?.overviewPath);
      if (!usesHaversineRoutes) {
        if (route.length >= 2) out[vehicleId] = route;
        return;
      }

      const fallback = flattened.length >= 2 ? flattened : normalizePathPoints(directPath);
      if (fallback.length >= 2) out[vehicleId] = fallback;
    });
    return out;
  }, [directions, rideRoutePathByVehicle, routeLegPathByVehicle, usesHaversineRoutes]);

  const movementSegmentsByVehicle = useMemo(() => {
    const out = {};
    vehicles.forEach((vehicle) => {
      const vehicleId = String(vehicle?.id || '').trim();
      if (!vehicleId) return;

      const routeStops = ridePathByVehicle[vehicleId] || [];
      if (!routeStops.length) return;

      const startPoint = {
        lat: Number(vehicle?.startLat),
        lng: Number(vehicle?.startLng),
      };
      const legPolylines = routeLegPathByVehicle[vehicleId] || [];
      const routeStartMinute = firstFiniteNumber(
        rideStartMinuteByVehicle[vehicleId],
        readMinuteByKeys(vehicle, RIDE_START_MINUTE_KEYS),
      );

      let movementSegments = routeStops.map((toStop, idx) => {
        const fromStop = idx > 0 ? routeStops[idx - 1] : null;
        const fromPoint = idx === 0
          ? startPoint
          : { lat: Number(fromStop?.lat), lng: Number(fromStop?.lng) };
        const toPoint = { lat: Number(toStop?.lat), lng: Number(toStop?.lng) };
        const arrivalMinute = Number(toStop?.arrivalMinute);
        const departureMinute = Number(toStop?.departureMinute);
        const travelMinutesFromPrev = Number(toStop?.travelMinutesFromPrev);
        const derivedStartFromTravel = Number.isFinite(arrivalMinute) && Number.isFinite(travelMinutesFromPrev)
          ? (arrivalMinute - travelMinutesFromPrev)
          : null;
        const fallbackStart = idx === 0
          ? routeStartMinute
          : Number(fromStop?.arrivalMinute);
        const segmentStart = firstFiniteNumber(
          departureMinute,
          derivedStartFromTravel,
          fallbackStart,
          arrivalMinute,
        );
        const segmentEnd = firstFiniteNumber(
          Number.isFinite(segmentStart) && Number.isFinite(travelMinutesFromPrev)
            ? (segmentStart + Math.max(0, travelMinutesFromPrev))
            : null,
          arrivalMinute,
        );

        return {
          fromPoint,
          toPoint,
          segmentStart,
          segmentEnd,
          polyline: Array.isArray(legPolylines[idx]) ? legPolylines[idx] : [],
        };
      }).filter((segment) => (
        isMeaningfulMovementSegment(
          segment.fromPoint,
          segment.toPoint,
          Number(segment.segmentStart),
          Number(segment.segmentEnd),
        )
      ));

      const stateTimeline = (rideStateTimelineByVehicle[vehicleId] || [])
        .filter((segment) => segment.state !== 'idle');
      if (stateTimeline.length === movementSegments.length) {
        movementSegments = movementSegments.map((segment, idx) => ({
          ...segment,
          segmentStart: Number(stateTimeline[idx].startMinute),
          segmentEnd: Number(stateTimeline[idx].endMinute),
          state: stateTimeline[idx].state,
        }));
      }

      out[vehicleId] = movementSegments;
    });
    return out;
  }, [
    vehicles,
    ridePathByVehicle,
    rideStartMinuteByVehicle,
    rideStateTimelineByVehicle,
    routeLegPathByVehicle,
  ]);

  const fitMapToData = useCallback((map, padding = 70, { force = false } = {}) => {
    if (!map || !window.google) return;
    if (!force && hasInitialFitRef.current && lastFitSignatureRef.current === fitSignature) return;

    if (employees.length === 0 && vehicles.length === 0) {
      map.setCenter(officeLocation);
      map.setZoom(MAP_DEFAULT_ZOOM);
      lastFitSignatureRef.current = fitSignature;
      hasInitialFitRef.current = true;
      return;
    }
    const bounds = new window.google.maps.LatLngBounds();
    employees.forEach((emp) => bounds.extend({ lat: emp.lat, lng: emp.lng }));
    vehicles.forEach((v) => bounds.extend({ lat: v.startLat, lng: v.startLng }));
    map.fitBounds(bounds, { padding });
    lastFitSignatureRef.current = fitSignature;
    hasInitialFitRef.current = true;
  }, [employees, vehicles, officeLocation, fitSignature]);

  const vehicleMotionById = useMemo(() => {
    const out = {};
    vehicles.forEach((v) => {
      out[v.id] = {
        position: { lat: Number(v.startLat), lng: Number(v.startLng) },
        progress: 0,
        headingDeg: 0,
        onboardEmployeeIds: [],
        nextTarget: null,
        remainingRoutePath: null,
      };
    });
    if (!timeDrivenMode) return out;

    vehicles.forEach((v) => {
      const vehicleId = String(v?.id || '');
      if (!vehicleId) return;
      const minute = Number(currentMinute);
      const routeStops = ridePathByVehicle[vehicleId] || [];

      if (routeStops.length) {
        const startPoint = { lat: Number(v?.startLat), lng: Number(v?.startLng) };
        let position = isValidLatLng(startPoint)
          ? startPoint
          : MAP_DEFAULT_CENTER;
        let headingDeg = 0;
        let remainingRoutePath = null;
        const travelSegments = movementSegmentsByVehicle[vehicleId] || [];
        const canUseRoadLegPlaybackPath = usesHaversineRoutes || travelSegments.every((segment) => hasRenderablePath(segment.polyline));

        if (travelSegments.length) {
          let matchedSegment = false;
          for (let idx = 0; idx < travelSegments.length; idx += 1) {
            const segment = travelSegments[idx];
            const segmentStart = Number(segment.segmentStart);
            const segmentEnd = Number(segment.segmentEnd);
            const travelPath = getPlaybackSegmentPath(segment, usesHaversineRoutes);

            if (Number.isFinite(segmentStart) && minute < (segmentStart - MINUTE_EPSILON)) {
              if (isValidLatLng(segment.fromPoint)) position = segment.fromPoint;
              if (hasRenderablePath(travelPath)) {
                const startSample = interpolateOnPolyline(travelPath, 0);
                if (startSample?.point) {
                  position = startSample.point;
                  headingDeg = startSample.headingDeg;
                }
              } else {
                headingDeg = computeHeadingDegrees(segment.fromPoint, segment.toPoint);
              }
              if (canUseRoadLegPlaybackPath) {
                remainingRoutePath = buildRemainingRoutePath(
                  travelSegments.slice(idx),
                  null,
                  usesHaversineRoutes,
                );
              }
              matchedSegment = true;
              break;
            }

            if (
              Number.isFinite(segmentStart)
              && Number.isFinite(segmentEnd)
              && segmentEnd >= segmentStart
              && minute <= (segmentEnd + MINUTE_EPSILON)
            ) {
              const segmentDuration = Math.max(MINUTE_EPSILON, segmentEnd - segmentStart);
              const localT = Math.max(0, Math.min(1, (minute - segmentStart) / segmentDuration));
              const sample = hasRenderablePath(travelPath) ? interpolateOnPolyline(travelPath, localT) : null;
              if (canUseRoadLegPlaybackPath && hasRenderablePath(travelPath)) {
                const currentRemainingPath = trimPolylineFromProgress(travelPath, localT);
                remainingRoutePath = buildRemainingRoutePath(
                  travelSegments.slice(idx + 1),
                  currentRemainingPath,
                  usesHaversineRoutes,
                );
              }
              if (sample?.point) {
                position = sample.point;
                headingDeg = sample.headingDeg;
              } else if (isValidLatLng(segment.fromPoint) && isValidLatLng(segment.toPoint)) {
                position = interpolatePoint(segment.fromPoint, segment.toPoint, localT);
                headingDeg = computeHeadingDegrees(segment.fromPoint, segment.toPoint);
              } else if (isValidLatLng(segment.toPoint)) {
                position = segment.toPoint;
              }
              matchedSegment = true;
              break;
            }

            if (hasRenderablePath(travelPath)) {
              const endSample = interpolateOnPolyline(travelPath, 1);
              if (endSample?.point) {
                position = endSample.point;
                headingDeg = endSample.headingDeg;
              }
            } else if (isValidLatLng(segment.toPoint)) {
              position = segment.toPoint;
              headingDeg = computeHeadingDegrees(segment.fromPoint, segment.toPoint);
            }
          }

          if (!matchedSegment) {
            const lastSegment = travelSegments[travelSegments.length - 1];
            if (lastSegment?.polyline?.length >= 2) {
              const endSample = interpolateOnPolyline(lastSegment.polyline, 1);
              if (endSample?.point) {
                position = endSample.point;
                headingDeg = endSample.headingDeg;
              }
            } else if (isValidLatLng(lastSegment?.toPoint)) {
              position = lastSegment.toPoint;
            }
            remainingRoutePath = canUseRoadLegPlaybackPath ? [] : null;
          }
        } else {
          const firstStop = routeStops[0];
          const firstStopPoint = { lat: Number(firstStop?.lat), lng: Number(firstStop?.lng) };
          if (isValidLatLng(firstStopPoint)) position = firstStopPoint;
        }

        const completedStop = [...routeStops]
          .reverse()
          .find((stop) => Number(stop?.arrivalMinute) <= (minute + MINUTE_EPSILON));
        const onboardEmployeeIds = normalizeEmployeeIds(completedStop?.employeesOnboardAfter || []);
        const nextStop = routeStops.find((stop) => Number(stop?.arrivalMinute) > (minute + MINUTE_EPSILON));
        const nextTarget = nextStop
          ? {
            typeLabel: stopTypeLabel(nextStop.type),
            employeeId: nextStop.employeeId || '-',
          }
          : null;

        const routeStartMinute = Number(
          Number.isFinite(travelSegments?.[0]?.segmentStart)
            ? travelSegments[0].segmentStart
            : routeStops[0]?.departureMinute
        );
        const routeEndMinute = Number(
          Number.isFinite(travelSegments?.[travelSegments.length - 1]?.segmentEnd)
            ? travelSegments[travelSegments.length - 1].segmentEnd
            : routeStops[routeStops.length - 1]?.arrivalMinute
        );
        const progress = Number.isFinite(routeStartMinute) && Number.isFinite(routeEndMinute) && routeEndMinute > routeStartMinute
          ? Math.max(0, Math.min(1, (minute - routeStartMinute) / (routeEndMinute - routeStartMinute)))
          : 0;

        out[vehicleId] = {
          position,
          progress,
          headingDeg,
          onboardEmployeeIds,
          nextTarget,
          remainingRoutePath,
        };
        return;
      }

      const events = processedTimeline.filter((ev) => ev.vehicleId === vehicleId);
      if (!events.length) return;
      const firstMinute = events[0].minute;
      const lastMinute = events[events.length - 1].minute;
      const clampedMinute = Math.max(firstMinute, Math.min(lastMinute, minute));
      const progress = lastMinute > firstMinute ? ((clampedMinute - firstMinute) / (lastMinute - firstMinute)) : 1;
      let position = { lat: Number(v?.startLat), lng: Number(v?.startLng) };
      let headingDeg = 0;

      if (minute < firstMinute) {
        position = { lat: Number(v?.startLat), lng: Number(v?.startLng) };
      } else {
        const prev = [...events].reverse().find((ev) => ev.minute <= minute && Number.isFinite(ev.lat) && Number.isFinite(ev.lng));
        const next = events.find((ev) => ev.minute > minute && Number.isFinite(ev.lat) && Number.isFinite(ev.lng));
        if (prev && next && next.minute > prev.minute) {
          const localT = (minute - prev.minute) / Math.max(MINUTE_EPSILON, (next.minute - prev.minute));
          position = interpolatePoint({ lat: prev.lat, lng: prev.lng }, { lat: next.lat, lng: next.lng }, localT);
          headingDeg = computeHeadingDegrees({ lat: prev.lat, lng: prev.lng }, { lat: next.lat, lng: next.lng });
        } else if (prev) {
          position = { lat: prev.lat, lng: prev.lng };
        } else if (next) {
          position = { lat: next.lat, lng: next.lng };
        }
      }

      const onboardSet = new Set();
      events.forEach((ev) => {
        if (ev.minute > (minute + MINUTE_EPSILON) || !ev.employeeId) return;
        if (ev.type === 'pickup') onboardSet.add(ev.employeeId);
        if (ev.type === 'dropoff' || ev.type === 'drop') onboardSet.delete(ev.employeeId);
      });
      const nextEvent = events.find((ev) => ev.minute > (minute + MINUTE_EPSILON));

      out[vehicleId] = {
        position,
        progress,
        headingDeg,
        onboardEmployeeIds: [...onboardSet],
        nextTarget: nextEvent
          ? {
            typeLabel: stopTypeLabel(nextEvent.type),
            employeeId: nextEvent.employeeId || '-',
          }
          : null,
        remainingRoutePath: null,
      };
    });

    return out;
  }, [vehicles, ridePathByVehicle, movementSegmentsByVehicle, processedTimeline, timeDrivenMode, currentMinute, usesHaversineRoutes]);

  const employeeStateById = useMemo(() => {
    const state = {};
    if (!timeDrivenMode) return state;
    const currentMinuteWithTolerance = Number(currentMinute) + MINUTE_EPSILON;
    employees.forEach((e) => { state[e.id] = 'Waiting'; });
    processedTimeline.forEach((ev) => {
      if (ev.minute > currentMinuteWithTolerance || !ev.employeeId) return;
      if (ev.type === 'pickup') state[ev.employeeId] = 'Picked Up';
      if (ev.type === 'dropoff' || ev.type === 'drop') state[ev.employeeId] = 'Dropped';
    });
    return state;
  }, [employees, processedTimeline, timeDrivenMode, currentMinute]);

  const vehicleStatsById = useMemo(() => {
    const out = {};
    vehicles.forEach((v) => {
      const assigned = employees.filter((e) => String(e.vehicleId) === String(v.id));
      const onboardFallback = assigned.filter((e) => {
        const status = employeeStateById[e.id] || e.status;
        return status === 'Picked Up' || status === 'Onboard';
      });
      const runtimeOnboard = vehicleMotionById[v.id]?.onboardEmployeeIds;
      const onboardCount = Array.isArray(runtimeOnboard) ? runtimeOnboard.length : onboardFallback.length;
      out[v.id] = {
        assignedCount: assigned.length,
        onboardCount,
      };
    });
    return out;
  }, [vehicles, employees, employeeStateById, vehicleMotionById]);

  // Fetch directions for all vehicles when map is loaded
  useEffect(() => {
    if (!mapLoaded || !window.google) return;
    if (usesHaversineRoutes) return;

    const directionsService = new window.google.maps.DirectionsService();
    let isActive = true;

    vehicles.forEach((vehicle) => {
      const vehicleId = String(vehicle?.id || '');
      if (!vehicleId) return;
      const routeSegments = routeRequestSegmentsByVehicle[vehicleId] || [];

      if (!routeSegments.length) {
        setDirections((prev) => {
          if (!prev[vehicleId]) return prev;
          const next = { ...prev };
          delete next[vehicleId];
          return next;
        });
        return;
      }

      Promise.all(routeSegments.map((orderedPoints) => (
        new Promise((resolve) => {
          const origin = orderedPoints[0];
          const destination = orderedPoints[orderedPoints.length - 1];
          const waypoints = orderedPoints.slice(1, -1).map((point) => ({
            location: point,
            stopover: true,
          }));

          directionsService.route(
            {
              origin,
              destination,
              waypoints,
              travelMode: window.google.maps.TravelMode.DRIVING,
              optimizeWaypoints: false,
            },
            (result, status) => {
              resolve({
                ok: status === 'OK',
                result: status === 'OK' ? result : null,
              });
            }
          );
        })
      ))).then((segmentResults) => {
        if (!isActive) return;
        if (!segmentResults.every((entry) => entry.ok && entry.result)) {
          setDirections((prev) => {
            if (!prev[vehicleId]) return prev;
            const next = { ...prev };
            delete next[vehicleId];
            return next;
          });
          return;
        }

        const flatLegs = [];
        const overviewPath = [];
        segmentResults.forEach((entry) => {
          const route = entry.result?.routes?.[0];
          if (Array.isArray(route?.legs)) {
            flatLegs.push(...route.legs);
          }
          appendUniquePathPoints(overviewPath, normalizeOverviewPath(route?.overview_path));
        });

        setDirections((prev) => ({
          ...prev,
          [vehicleId]: {
            legs: flatLegs,
            overviewPath,
          },
        }));
      });
    });
    return () => {
      isActive = false;
    };
  }, [mapLoaded, vehicles, routeRequestSegmentsByVehicle, usesHaversineRoutes]);

  const onMapLoad = useCallback((map) => {
    mapRef.current = map;
    setMapLoaded(true);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google) return;
    fitMapToData(map, 70);
  }, [fitMapToData]);

  useEffect(() => {
    if (!fitBoundsNonce) return;
    const map = mapRef.current;
    if (!map || !window.google) return;
    fitMapToData(map, 70, { force: true });
  }, [fitBoundsNonce, fitMapToData]);

  useEffect(() => {
    const map = mapRef.current;
    const wrapper = mapWrapperRef.current;
    if (!map || !wrapper || !window.google) return undefined;

    let rafId = null;
    let timeoutId = null;
    const syncMapSize = () => {
      if (rafId != null) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        if (timeoutId != null) window.clearTimeout(timeoutId);
        const rect = wrapper.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        timeoutId = window.setTimeout(() => {
          window.google.maps.event.trigger(map, 'resize');
          if (!hasInitialFitRef.current) {
            fitMapToData(map, 70, { force: true });
          }
        }, 120);
      });
    };

    syncMapSize();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(syncMapSize);
    observer.observe(wrapper);

    return () => {
      observer.disconnect();
      if (rafId != null) window.cancelAnimationFrame(rafId);
      if (timeoutId != null) window.clearTimeout(timeoutId);
    };
  }, [fitMapToData, isFullscreen]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google) return;
    window.google.maps.event.trigger(map, 'resize');
  }, [showEmployees, showRoutes, showVehicles, vehicles.length, employees.length]);

  useEffect(() => {
    const onWindowResize = () => {
      const map = mapRef.current;
      if (!map || !window.google) return;
      window.google.maps.event.trigger(map, 'resize');
    };
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      const fullscreenHost = fullscreenTargetRef?.current || mapWrapperRef.current;
      setIsFullscreen(Boolean(fullscreenHost && document.fullscreenElement === fullscreenHost));
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [fullscreenTargetRef]);

  const handleFullscreen = async () => {
    const fullscreenHost = fullscreenTargetRef?.current || mapWrapperRef.current;
    if (!fullscreenHost) return;

    try {
      if (document.fullscreenElement === fullscreenHost) {
        await document.exitFullscreen();
      } else if (!document.fullscreenElement) {
        await fullscreenHost.requestFullscreen();
      }
    } catch {
      // Fallback for environments where Fullscreen API is blocked.
      setIsFullscreen(prev => !prev);
    }
  };
  const handleZoomIn = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const currentZoom = Number(map.getZoom?.() ?? MAP_DEFAULT_ZOOM);
    map.setZoom(Math.min(21, currentZoom + 1));
  }, []);

  const handleZoomOut = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const currentZoom = Number(map.getZoom?.() ?? MAP_DEFAULT_ZOOM);
    map.setZoom(Math.max(3, currentZoom - 1));
  }, []);
  const notifyMapInteraction = useCallback(() => {
    if (typeof onMapInteraction === 'function') onMapInteraction();
  }, [onMapInteraction]);

  const selectedVehicle = useMemo(() => {
    if (!selectedVehicleId) return null;
    const vehicle = vehicles.find((v) => String(v?.id) === String(selectedVehicleId));
    if (!vehicle) return null;

    const motion = vehicleMotionById[selectedVehicleId] || {};
    const position = motion.position || { lat: Number(vehicle.startLat), lng: Number(vehicle.startLng) };
    const stats = vehicleStatsById[selectedVehicleId] || { assignedCount: 0, onboardCount: 0 };
    const onboardEmployeeIds = normalizeEmployeeIds(motion.onboardEmployeeIds || []);
    const nextTarget = motion.nextTarget || null;
    const nextTargetLabel = nextTarget
      ? `${nextTarget.typeLabel} ${nextTarget.employeeId || '-'}`
      : 'Route complete';

    return {
      id: String(vehicle.id),
      type: String(vehicle.type || 'Vehicle'),
      lat: Number(position.lat),
      lng: Number(position.lng),
      assignedCount: stats.assignedCount,
      onboardCount: onboardEmployeeIds.length,
      onboardEmployeeIds,
      nextTargetLabel,
    };
  }, [selectedVehicleId, vehicles, vehicleMotionById, vehicleStatsById]);

  const shouldUseInternalFullscreenStyle = !fullscreenTargetRef;
  const mapWrapperStyle = (isFullscreen && shouldUseInternalFullscreenStyle) ? {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    background: '#0f172a'
  } : {
    width: '100%',
    height: '100%',
    position: 'relative'
  };

  if (loadError) {
    return (
      <div ref={mapWrapperRef} style={mapWrapperStyle}>
        <div
          className="glass-morphism reflective-card-container"
          style={{ height: '100%', display: 'grid', placeItems: 'center', borderRadius: 16, color: 'rgba(255,255,255,0.85)' }}
        >
          Unable to load map right now.
        </div>
      </div>
    );
  }

  if (!isMapsReady) {
    return (
      <div ref={mapWrapperRef} style={mapWrapperStyle}>
        <div
          className="glass-morphism reflective-card-container"
          style={{ height: '100%', display: 'grid', placeItems: 'center', borderRadius: 16, color: 'rgba(255,255,255,0.85)' }}
        >
          Preparing live map...
        </div>
      </div>
    );
  }

  return (
    <div ref={mapWrapperRef} style={mapWrapperStyle}>
      <GoogleMap
        mapContainerStyle={containerStyle}
        center={officeLocation}
        zoom={MAP_DEFAULT_ZOOM}
        onLoad={onMapLoad}
        onClick={notifyMapInteraction}
        options={{
          styles: isDarkMode ? darkMapStyle : lightMapStyle,
          disableDefaultUI: true,
          zoomControl: false,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          keyboardShortcuts: false,
        }}
      >
          {/* Map Stats */}
          {showEmployees && <MapStats employees={employees} />}

          {/* Zoom Controls */}
          <ZoomControls
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
          />

          {/* Map Controls */}
          <MapControls
            isDarkMode={isDarkMode}
            onToggleTheme={() => setIsDarkMode(!isDarkMode)}
            onFullscreen={handleFullscreen}
            isFullscreen={isFullscreen}
            vehicleIconStyle={vehicleIconStyle}
            onToggleVehicleIcon={() => setVehicleIconStyle(prev => prev === 'car' ? 'arrow' : 'car')}
          />

          {/* Office Marker */}
          {(showRoutes || showVehicles) && (
            <Marker
              position={officeLocation}
              icon={createOfficeIcon()}
              title="Office (Drop Location)"
            />
          )}

          {/* Routes */}
          {showRoutes && vehicles.map((v, idx) => {
            const isSelected = selectedRouteId === String(v.id);
            const isDimmed = hasRouteFilter && !isSelected;
            const color = getColorForVehicle(v.id, idx);
            const vehicleId = String(v.id);
            const route = renderedRoutePathByVehicle[vehicleId] || [];
            const displayedRoute = timeDrivenMode
              ? (hasRenderablePath(vehicleMotionById[vehicleId]?.remainingRoutePath)
                  ? vehicleMotionById[vehicleId].remainingRoutePath
                  : [])
              : route;
            const isRouteVisible = hasRenderablePath(displayedRoute);
            const polylinePath = isRouteVisible
              ? displayedRoute
              : (hasRenderablePath(route) ? route : []);
            if (!hasRenderablePath(polylinePath)) return null;
            return (
              <RoutePolyline
                key={`route-${v.id}`}
                path={polylinePath}
                options={{
                  strokeColor: color,
                  strokeOpacity: isDimmed ? 0.1 : (isSelected ? 1 : 0.85),
                  strokeWeight: isSelected ? 4 : 2.6,
                  geodesic: usesHaversineRoutes,
                  visible: isRouteVisible,
                }}
              />
            );
          })}

          {/* Employee Markers */}
          {showEmployees && employees.map((emp) => {
            const vehicleIdx = vehicles.findIndex(v => v.id === emp.vehicleId);
            const color = getColorForVehicle(emp.vehicleId, vehicleIdx >= 0 ? vehicleIdx : 0) || '#64748b';
            const isDimmed = hasRouteFilter && String(emp.vehicleId) !== selectedRouteId;
            const timelineStatus = employeeStateById[emp.id] || emp.status;
            const shouldHide = timeDrivenMode && (timelineStatus === 'Picked Up' || timelineStatus === 'Dropped');
            
            // Hide employees at office location
            const isAtOffice = Math.abs(emp.lat - officeLocation.lat) < 0.0001 && 
                               Math.abs(emp.lng - officeLocation.lng) < 0.0001;
            
            if (shouldHide || isAtOffice) return null;

            return (
              <Marker
                key={emp.id}
                position={{ lat: emp.lat, lng: emp.lng }}
                onClick={() => {
                  notifyMapInteraction();
                  setSelectedVehicleId(null);
                  setSelectedEmployee((prev) => (
                    prev?.id === emp.id ? null : { ...emp, status: timelineStatus }
                  ));
                }}
                icon={createEmployeeIcon(color)}
                opacity={isDimmed ? 0.25 : (timelineStatus === 'Dropped' ? 0.45 : 1)}
              />
            );
          })}

          {/* Vehicle Start Markers */}
          {showVehicles && vehicles.map((v, idx) => {
            const isDimmed = hasRouteFilter && selectedRouteId !== String(v.id);
            const motion = vehicleMotionById[v.id] || {};
            const currentPos = motion.position || { lat: v.startLat, lng: v.startLng };
            const headingDeg = Number(motion.headingDeg) || 0;
            const color = getColorForVehicle(v.id, idx);

            return (
              <Marker
                key={`vehicle-${v.id}`}
                position={currentPos}
                onClick={() => {
                  notifyMapInteraction();
                  setSelectedEmployee(null);
                  setSelectedRoute((prev) => (String(prev || '') === String(v.id) ? null : String(v.id)));
                  setSelectedVehicleId((prev) => (String(prev || '') === String(v.id) ? null : String(v.id)));
                }}
                icon={createVehicleIcon(color, headingDeg, vehicleIconStyle)}
                title={`${v.id} - ${v.type}`}
                opacity={isDimmed ? 0.25 : 1}
              />
            );
          })}

          {/* Custom Dark-themed InfoWindow */}
          {showEmployees && selectedEmployee && (
            <CustomInfoWindow
              employee={selectedEmployee}
              onClose={() => setSelectedEmployee(null)}
            />
          )}
          {showVehicles && selectedVehicle && (
            <VehicleInfoWindow
              vehicle={selectedVehicle}
              onClose={() => clearVehicleSelection(setSelectedVehicleId, setSelectedRoute)}
            />
          )}
      </GoogleMap>
    </div>
  );
};

export default ProjectMap;
