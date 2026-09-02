function formatLatLng(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return '—';
  return `${a.toFixed(3)}, ${b.toFixed(3)}`;
}

function formatWindow(win) {
  if (!win) return '—';
  if (typeof win === 'string') return win;
  if (win.start && win.end) return `${win.start}-${win.end}`;
  return '—';
}

function flattenObject(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  Object.entries(obj).forEach(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenObject(v, key, out);
    } else {
      out[key] = v;
    }
  });
  return out;
}

function toHeaderLabel(key) {
  return String(key)
    .replace(/\./g, ' / ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function isOutOfRangeCoord(v) {
  return typeof v === 'number' && (v < 0 || v > 360);
}

function toMinutes(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return (hh * 60) + mm;
}

function parseWindow(value) {
  if (!value) return null;
  if (typeof value === 'object' && value.start && value.end) {
    const start = toMinutes(String(value.start));
    const end = toMinutes(String(value.end));
    if (start == null || end == null || end <= start) return null;
    return { start, end };
  }
  if (typeof value !== 'string') return null;
  const parts = value.split('-').map((p) => p.trim());
  if (parts.length !== 2) return null;
  const start = toMinutes(parts[0]);
  const end = toMinutes(parts[1]);
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

function overlaps(a, b) {
  if (!a || !b) return false;
  return a.start < b.end && b.start < a.end;
}

function minuteToClock(minute) {
  if (!Number.isFinite(minute)) return '--:--';
  const m = Math.max(0, Math.round(minute));
  const hh = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function extractMinuteFromValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== 'string') return null;
  const match = value.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return (hh * 60) + mm;
}

function toKeyValueRows(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.map((item, idx) => ({
      key: `[${idx}]`,
      value: displayValue(item)
    }));
  }
  return Object.entries(value).map(([k, v]) => ({
    key: k,
    value: displayValue(v)
  }));
}

function pickValue(obj, keys = []) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

function tryParseJsonObject(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function extractBaselineRows(source) {
  const out = [];
  const visit = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === 'string') {
      const parsed = tryParseJsonObject(node);
      if (parsed) visit(parsed);
      return;
    }
    if (typeof node !== 'object') return;

    const cost = pickValue(node, ['baseline_cost', 'baselineCost', 'cost', 'total_cost']);
    const time = pickValue(node, ['baseline_time_min', 'baselineTimeMin', 'time_min', 'time', 'total_time_min']);
    const employeeId = pickValue(node, ['employee_id', 'employeeId', 'emp_id', 'empId', 'id']);
    if (cost != null || time != null) {
      out.push({ baselineCost: cost, baselineTimeMin: time, employeeId });
      return;
    }

    Object.values(node).forEach(visit);
  };

  visit(source);
  return out.map((r, idx) => ({ index: idx + 1, ...r }));
}

function parseNumericLike(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isValidLatitude(value) {
  const n = parseNumericLike(value);
  return n !== null && n >= -90 && n <= 90;
}

function isValidLongitude(value) {
  const n = parseNumericLike(value);
  return n !== null && n >= -180 && n <= 180;
}

function pushUniqueIssue(target, seen, text) {
  const msg = String(text || '').trim();
  if (!msg || seen.has(msg)) return;
  seen.add(msg);
  target.push(msg);
}

function findFirstNumericByKeys(source, keys) {
  if (!source || typeof source !== 'object') return null;
  const flat = flattenObject(source);
  for (const [k, v] of Object.entries(flat)) {
    const lk = k.toLowerCase();
    if (keys.every((part) => lk.includes(part))) {
      const num = parseNumericLike(v);
      if (num !== null) return num;
    }
  }
  return null;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return '—';
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

export {
  formatLatLng,
  formatWindow,
  flattenObject,
  toHeaderLabel,
  displayValue,
  isOutOfRangeCoord,
  toMinutes,
  parseWindow,
  overlaps,
  minuteToClock,
  extractMinuteFromValue,
  toKeyValueRows,
  pickValue,
  tryParseJsonObject,
  extractBaselineRows,
  parseNumericLike,
  isValidLatitude,
  isValidLongitude,
  pushUniqueIssue,
  findFirstNumericByKeys,
  formatMoney
};
