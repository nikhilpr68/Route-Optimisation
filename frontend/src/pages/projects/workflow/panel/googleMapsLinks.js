const GOOGLE_MAPS_MAX_WAYPOINTS = 9;
const GOOGLE_MAPS_MAX_POINTS_PER_LINK = GOOGLE_MAPS_MAX_WAYPOINTS + 2;

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const toCoord = (node) => {
  if (!node || typeof node !== 'object') return null;
  const lat = toNumber(node.lat ?? node.pickupLat ?? node.startLat ?? node.latitude);
  const lng = toNumber(node.lng ?? node.pickupLng ?? node.startLng ?? node.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
};

const stopType = (value) => {
  const low = String(value || '').trim().toLowerCase();
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

const sameCoord = (a, b) => (
  a
  && b
  && Math.abs(Number(a.lat) - Number(b.lat)) < 1e-6
  && Math.abs(Number(a.lng) - Number(b.lng)) < 1e-6
);

const formatCoordQuery = (coord) => `${Number(coord.lat)},${Number(coord.lng)}`;

const buildStopLabel = (stop, stopIndex) => {
  const type = stopType(stop?.type);
  const employeeId = String(stop?.employeeId || '').trim();
  const base = type === 'pickup' ? 'Pickup' : (type === 'dropoff' ? 'Dropoff' : 'Stop');
  if (employeeId && !isNonEmployeeStopLabel(employeeId)) return `${base} ${employeeId}`;
  return `${base} ${stopIndex}`;
};

function buildGoogleMapsRoutePointEntries({ ride, startCoord }) {
  const path = Array.isArray(ride?.path) ? ride.path : [];
  const points = [];

  const pushPoint = (coord, metadata = {}) => {
    const normalized = toCoord(coord);
    if (!normalized) return;

    const last = points[points.length - 1];
    if (last && sameCoord(last.coord, normalized)) {
      if (Number.isFinite(metadata.stopIndex) && !last.stopIndices.includes(metadata.stopIndex)) {
        last.stopIndices.push(metadata.stopIndex);
      }
      if (metadata.label && !last.labels.includes(metadata.label)) {
        last.labels.push(metadata.label);
      }
      return;
    }

    points.push({
      coord: normalized,
      labels: metadata.label ? [metadata.label] : [],
      stopIndices: Number.isFinite(metadata.stopIndex) ? [metadata.stopIndex] : [],
    });
  };

  pushPoint(startCoord, { label: 'Vehicle start' });
  path.forEach((stop, idx) => {
    pushPoint(stop, {
      label: buildStopLabel(stop, idx + 1),
      stopIndex: idx + 1,
    });
  });

  return points;
}

function splitGoogleMapsRoutePointEntries(points = []) {
  if (!Array.isArray(points) || points.length < 2) return [];

  const segments = [];
  let cursor = 0;

  while (cursor < points.length - 1) {
    const segmentPoints = points.slice(cursor, Math.min(points.length, cursor + GOOGLE_MAPS_MAX_POINTS_PER_LINK));
    if (segmentPoints.length < 2) break;

    const coverageStart = segments.length === 0 ? 0 : 1;
    const coveredStopIndices = segmentPoints
      .slice(coverageStart)
      .flatMap((point) => point.stopIndices)
      .filter(Number.isFinite);
    const uniqueCoveredStops = Array.from(new Set(coveredStopIndices)).sort((a, b) => a - b);

    segments.push({
      index: segments.length + 1,
      points: segmentPoints,
      startStopIndex: uniqueCoveredStops.length ? uniqueCoveredStops[0] : null,
      endStopIndex: uniqueCoveredStops.length ? uniqueCoveredStops[uniqueCoveredStops.length - 1] : null,
      stopCount: uniqueCoveredStops.length,
    });

    cursor += Math.max(1, segmentPoints.length - 1);
  }

  return segments;
}

function buildGoogleMapsCoordinateSegments({ ride, startCoord }) {
  const points = buildGoogleMapsRoutePointEntries({ ride, startCoord });
  return splitGoogleMapsRoutePointEntries(points).map((segment) => (
    segment.points.map((point) => point.coord)
  ));
}

function buildGoogleMapsRouteLinks({ ride, startCoord }) {
  const points = buildGoogleMapsRoutePointEntries({ ride, startCoord });

  if (!points.length) return [];

  if (points.length === 1) {
    const searchUrl = new URL('https://www.google.com/maps/search/');
    searchUrl.searchParams.set('api', '1');
    searchUrl.searchParams.set('query', formatCoordQuery(points[0].coord));
    return [{
      index: 1,
      total: 1,
      href: searchUrl.toString(),
      buttonLabel: 'Google Maps',
      summary: 'Single mapped location',
    }];
  }

  const segments = splitGoogleMapsRoutePointEntries(points);

  return segments.map((segment, idx, arr) => {
    const origin = segment.points[0];
    const destination = segment.points[segment.points.length - 1];
    const waypoints = segment.points.slice(1, -1);
    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    url.searchParams.set('origin', formatCoordQuery(origin.coord));
    url.searchParams.set('destination', formatCoordQuery(destination.coord));
    url.searchParams.set('travelmode', 'driving');
    if (waypoints.length) {
      url.searchParams.set('waypoints', waypoints.map((point) => formatCoordQuery(point.coord)).join('|'));
    }
    return {
      ...segment,
      href: url.toString(),
      total: arr.length,
      buttonLabel: arr.length === 1 ? 'Google Maps' : `Maps ${idx + 1}/${arr.length}`,
      summary: segment.startStopIndex != null
        ? `Stops ${segment.startStopIndex}-${segment.endStopIndex}`
        : 'Vehicle start to destination',
    };
  });
}

export {
  buildGoogleMapsCoordinateSegments,
  buildGoogleMapsRouteLinks,
};
