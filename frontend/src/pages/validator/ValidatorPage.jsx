import React, { useEffect, useMemo, useRef, useState } from "react";

import { runStandaloneValidator } from "../../api/api";
import CustomIntensityModal from "../../components/CustomIntensityModal";
import RideAssignmentPanel from "../projects/workflow/panel/RideAssignmentPanel";
import "./ValidatorPage.css";

const surfaceStyle = {
  borderRadius: 16,
  border: "1px solid rgba(255,255,255,0.18)",
  borderTop: "1px solid rgba(255,255,255,0.3)",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
  background:
    "linear-gradient(160deg, rgba(17,20,29,0.62) 0%, rgba(7,10,16,0.74) 100%)",
  boxShadow:
    "0 12px 28px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.1)",
  backdropFilter: "blur(20px) saturate(125%)",
  WebkitBackdropFilter: "blur(20px) saturate(125%)",
};

const headCell = {
  textAlign: "left",
  padding: "14px 16px",
  fontSize: "0.8rem",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "rgba(184,200,230,0.95)",
  fontWeight: 700,
};

const cell = {
  padding: "14px 16px",
  borderTop: "1px solid rgba(255,255,255,0.08)",
  verticalAlign: "top",
  color: "rgba(236,243,255,0.95)",
};

const fieldLabel = {
  display: "grid",
  gap: 9,
  fontSize: "0.93rem",
  fontWeight: 700,
};

const selectTriggerStyle = {
  width: "100%",
  height: 48,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.16)",
  background:
    "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03))",
  color: "#eef4ff",
  padding: "0 14px",
  outline: "none",
  fontSize: "0.95rem",
  fontWeight: 700,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  cursor: "pointer",
};

const selectMenuStyle = {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  right: 0,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.16)",
  background:
    "linear-gradient(180deg, rgba(18,22,32,0.98), rgba(9,12,18,0.98))",
  boxShadow: "0 18px 34px rgba(0,0,0,0.42)",
  overflow: "hidden",
  zIndex: 40,
};

const sectionCardStyle = {
  ...surfaceStyle,
  padding: "clamp(10px, 1.2vw, 16px) clamp(10px, 1.3vw, 18px)",
};

const sectionHeadStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  marginBottom: 12,
};

const sectionTitleStyle = {
  margin: 0,
  fontSize: "clamp(1.1rem, 1.65vw, 1.9rem)",
  lineHeight: 1.15,
  letterSpacing: "-0.01em",
  fontWeight: 800,
};

const sectionMetaStyle = {
  color: "rgba(170, 184, 205, 0.86)",
  fontSize: "clamp(0.74rem, 0.85vw, 0.95rem)",
  fontWeight: 600,
};

const infoChipStyle = {
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 12,
  background: "rgba(255,255,255,0.05)",
  padding: "12px 14px",
};

const tableShellStyle = {
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 14,
  overflowX: "auto",
  background: "rgba(4,9,20,0.44)",
};

function normalizeIntensityChoice(v) {
  const x = String(v || "").trim().toLowerCase();
  if (x === "low" || x === "high" || x === "custom") return x;
  return "medium";
}

function readStoredCustomNumber(key, integer = false) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return integer ? Math.trunc(value) : value;
}

function CustomSelect({ value, onChange, options, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [hoveredValue, setHoveredValue] = useState(null);
  const rootRef = useRef(null);
  const selected = options.find((opt) => opt.value === value) || options[0];
  const menuHeight = Math.min((options.length * 46) + 2, 260);
  const isOpen = open && !disabled;

  useEffect(() => {
    const handleOutside = (event) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        zIndex: isOpen ? 240 : 1,
        marginBottom: isOpen ? menuHeight + 8 : 0,
        transition: "margin-bottom 0.18s ease",
      }}
    >
      <button
        type="button"
        style={{
          ...selectTriggerStyle,
          opacity: disabled ? 0.62 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
        disabled={disabled}
        aria-expanded={isOpen}
      >
        <span>{selected?.label || ""}</span>
        <span style={{ opacity: 0.85 }}>{isOpen ? "▴" : "▾"}</span>
      </button>
      {isOpen ? (
        <div
          style={{
            ...selectMenuStyle,
            maxHeight: menuHeight,
            overflowY: "auto",
            zIndex: 260,
          }}
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            const isHovered = hoveredValue === opt.value;
            const isActive = hoveredValue ? isHovered : isSelected;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                onMouseEnter={() => setHoveredValue(opt.value)}
                onMouseLeave={() => setHoveredValue(null)}
                style={{
                  width: "100%",
                  border: "none",
                  textAlign: "left",
                  padding: "11px 14px",
                  fontSize: "1rem",
                  fontWeight: isActive ? 800 : 600,
                  color: "#eaf2ff",
                  cursor: "pointer",
                  background: isHovered
                    ? "rgba(255,255,255,0.08)"
                    : isSelected
                      ? "rgba(148,163,184,0.18)"
                      : "rgba(255,255,255,0.03)",
                  borderTop: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function formatValue(value) {
  if (value === null || value === undefined) return "N/A";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatCurrency(value) {
  const n = toFiniteNumber(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "N/A";
}

function formatMinutes(value) {
  const n = toFiniteNumber(value);
  return Number.isFinite(n) ? `${n.toFixed(1)} min` : "N/A";
}

function formatClockTime(value) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n)) return "N/A";
  const total = Math.max(0, Math.floor(n));
  const hh24 = Math.floor(total / 60) % 24;
  const mm = total % 60;
  const meridiem = hh24 >= 12 ? "pm" : "am";
  const hh12 = (hh24 % 12) || 12;
  return `${hh12}:${String(mm).padStart(2, "0")} ${meridiem}`;
}

function extractJsonFromText(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Empty JSON payload");
  try {
    return JSON.parse(text);
  } catch {
    // Fall through and try line-delimited JSON payloads.
  }

  let lastObject = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lastObject = JSON.parse(trimmed);
    } catch {
      // Ignore non-JSON lines while scanning for a valid payload.
    }
  }
  if (lastObject && typeof lastObject === "object") return lastObject;
  throw new Error("File does not contain valid JSON");
}

function unwrapResultPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (Array.isArray(payload.rides)) return payload;
  if (payload.results && typeof payload.results === "object" && Array.isArray(payload.results.rides)) return payload.results;
  if (payload.result && typeof payload.result === "object" && Array.isArray(payload.result.rides)) return payload.result;
  return null;
}

function readStopMinute(stop) {
  const keys = [
    "arrivalMinute",
    "arrival_minute",
    "minute",
    "timeMinute",
    "timeMinutes",
    "arrivalTime",
    "time",
    "plannedPickupTime",
    "plannedDropoffTime",
    "eta",
    "timestamp",
  ];
  for (const key of keys) {
    const n = toFiniteNumber(stop?.[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function buildRideAssignmentView(payload) {
  const result = unwrapResultPayload(payload);
  if (!result) return null;

  const rides = Array.isArray(result.rides) ? result.rides : [];
  const metrics = result?.metrics && typeof result.metrics === "object" ? result.metrics : {};
  const assignmentMap = new Map();
  const overlayRows = [];
  const vehicleRows = [];

  rides.forEach((ride, rideIdx) => {
    const vehicleId = String(ride?.vehicleId || ride?.sourceVehicleId || ride?.normalizedVehicleId || `VEH_${rideIdx + 1}`);
    const assignedEmployees = Array.isArray(ride?.assignedEmployees) ? ride.assignedEmployees.map((id) => String(id)) : [];
    const path = Array.isArray(ride?.path) ? ride.path : [];
    const perEmployee = new Map();

    assignedEmployees.forEach((employeeId) => {
      if (!assignmentMap.has(employeeId)) {
        assignmentMap.set(employeeId, {
          employeeId,
          vehicleId,
          pickupStop: "-",
          dropStop: "-",
          pickupMinute: null,
          dropMinute: null,
          status: ride?.feasible === false ? "Issue" : "Assigned",
          source: "assignedEmployees",
        });
      }
    });

    path.forEach((stop, stopIdx) => {
      const stopType = String(stop?.type || "").trim().toLowerCase();
      const employeeId = stop?.employeeId ? String(stop.employeeId) : "-";
      const minute = readStopMinute(stop);
      overlayRows.push({
        key: `${vehicleId}-${stopIdx + 1}-${employeeId}-${stopType}`,
        vehicleId,
        stopIndex: stopIdx + 1,
        stopType: stopType || "move",
        employeeId,
        minute,
        loadAfter: toFiniteNumber(stop?.loadAfter),
      });

      if ((stopType === "pickup" || stopType === "dropoff") && employeeId !== "-") {
        const curr = perEmployee.get(employeeId) || {
          employeeId,
          vehicleId,
          pickupStop: "-",
          dropStop: "-",
          pickupMinute: null,
          dropMinute: null,
          status: ride?.feasible === false ? "Issue" : "Assigned",
          source: "path",
        };
        if (stopType === "pickup") {
          curr.pickupStop = stopIdx + 1;
          curr.pickupMinute = minute;
        } else {
          curr.dropStop = stopIdx + 1;
          curr.dropMinute = minute;
        }
        perEmployee.set(employeeId, curr);
      }
    });

    perEmployee.forEach((row, employeeId) => {
      const existing = assignmentMap.get(employeeId) || {};
      assignmentMap.set(employeeId, { ...existing, ...row, vehicleId });
    });

    const rideMetrics = ride?.metrics && typeof ride.metrics === "object" ? ride.metrics : {};
    vehicleRows.push({
      vehicleId,
      assignedCount: assignedEmployees.length,
      stops: path.length,
      distanceKm: toFiniteNumber(rideMetrics.totalDistanceKm ?? rideMetrics.routeDistanceKm ?? ride?.distanceKm),
      cost: toFiniteNumber(rideMetrics.cost ?? ride?.cost ?? ride?.totalCost),
      timeMinutes: toFiniteNumber(rideMetrics.totalTimeMinutes ?? rideMetrics.totalTime),
      delayMinutes: toFiniteNumber(rideMetrics.totalDelayMinutes ?? rideMetrics.delayMinutes ?? ride?.delayMinutes),
      feasible: ride?.feasible !== false,
    });
  });

  const directAssignments = Array.isArray(payload?.employeeVehicleAssignments) ? payload.employeeVehicleAssignments : [];
  directAssignments.forEach((row) => {
    const employeeId = String(row?.employeeId || "").trim();
    if (!employeeId) return;
    const current = assignmentMap.get(employeeId) || {
      employeeId,
      vehicleId: "-",
      pickupStop: "-",
      dropStop: "-",
      pickupMinute: null,
      dropMinute: null,
      status: "Assigned",
      source: "employeeVehicleAssignments",
    };
    assignmentMap.set(employeeId, {
      ...current,
      vehicleId: String(row?.vehicleId || current.vehicleId || "-"),
      source: String(row?.source || current.source || "employeeVehicleAssignments"),
    });
  });

  const sortByNumericId = (a, b) => {
    const ax = String(a || "");
    const bx = String(b || "");
    const am = ax.match(/\d+/);
    const bm = bx.match(/\d+/);
    const an = am ? Number(am[0]) : Number.POSITIVE_INFINITY;
    const bn = bm ? Number(bm[0]) : Number.POSITIVE_INFINITY;
    if (an !== bn) return an - bn;
    return ax.localeCompare(bx);
  };

  const employeeRows = Array.from(assignmentMap.values()).sort((a, b) => sortByNumericId(a.employeeId, b.employeeId));
  overlayRows.sort((a, b) => (a.minute ?? Number.POSITIVE_INFINITY) - (b.minute ?? Number.POSITIVE_INFINITY));
  vehicleRows.sort((a, b) => String(a.vehicleId).localeCompare(String(b.vehicleId)));

  return {
    objective: toFiniteNumber(result?.objectiveScore),
    cost: toFiniteNumber(metrics?.totalSystemCost ?? result?.totalSystemCost),
    totalTime: toFiniteNumber(metrics?.totalTimeMinutes ?? metrics?.totalTime ?? result?.totalTimeMinutes),
    delay: toFiniteNumber(metrics?.totalDelayMinutes ?? metrics?.delayMinutes ?? result?.totalDelayMinutes),
    employeeRows,
    overlayRows,
    vehicleRows,
  };
}

function buildRidePanelData(resultPayload, canonicalPayload, report) {
  const result = unwrapResultPayload(resultPayload);
  const canonical = canonicalPayload && typeof canonicalPayload === "object" ? canonicalPayload : {};
  const metadata = canonical?.metadata && typeof canonical.metadata === "object" ? canonical.metadata : {};
  const officeCenter = metadata.office_location || metadata.officeLocation || metadata.office_center || null;

  return {
    rides: Array.isArray(result?.rides) ? result.rides : [],
    employees: Array.isArray(canonical?.employees) ? canonical.employees : [],
    vehicles: Array.isArray(canonical?.vehicles) ? canonical.vehicles : [],
    timelineEvents: Array.isArray(result?.timelineEvents) ? result.timelineEvents : [],
    officeCenter,
    distanceInfo: {
      backendLabel: resultPayload?.summary?.distanceBackendLabel || (report?.config?.distanceMetric ? String(report.config.distanceMetric).toUpperCase() : "Unknown"),
    },
  };
}

function toneForCheck(check) {
  return check?.passed
    ? { text: "#6ee7b7", bg: "rgba(52,211,153,0.12)", border: "rgba(52,211,153,0.28)" }
    : { text: "#fca5a5", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.28)" };
}

function uniqueChecks(checks) {
  const seen = new Set();
  const out = [];
  (Array.isArray(checks) ? checks : []).forEach((check) => {
    const key = `${String(check?.name || "")}::${String(check?.detail || "")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(check);
  });
  return out;
}

function uniqueMessages(messages) {
  const seen = new Set();
  const out = [];
  (Array.isArray(messages) ? messages : []).forEach((msg) => {
    const key = String(msg || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  });
  return out;
}

function UploadField({ label, accept, file, onChange, helper }) {
  const [dragActive, setDragActive] = useState(false);
  const acceptedExtensions = String(accept || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  const matchesAcceptedType = (f) => {
    if (!f || !acceptedExtensions.length) return true;
    const name = String(f.name || "").toLowerCase();
    return acceptedExtensions.some((ext) => name.endsWith(ext));
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragActive(false);
    const dropped = event.dataTransfer?.files?.[0];
    if (dropped && matchesAcceptedType(dropped)) {
      onChange(dropped);
    }
  };

  return (
    <label
      className="glass-morphism reflective-card-container validator-upload-field"
      style={surfaceStyle}
    >
      <div className="validator-upload-head">
        <div>
          <div className="validator-upload-title">{label}</div>
          <div className="validator-upload-helper">{helper}</div>
        </div>
        <div className="validator-upload-cta">
          <span>Upload File</span>
        </div>
      </div>
      <div
        className={`validator-upload-dropzone${dragActive ? " is-active" : ""}${file ? " has-file" : ""}`}
        style={{
          flex: 1,
          color: file ? "white" : "rgba(255,255,255,0.56)",
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        {file ? (
          file.name
        ) : (
          <div className="validator-upload-placeholder">
            <div className="validator-upload-placeholder-title">Drag and drop</div>
            <div style={{ marginTop: 4 }}>No file selected</div>
          </div>
        )}
      </div>
      <input
        type="file"
        accept={accept}
        onChange={(event) => onChange(event.target.files?.[0] || null)}
        style={{ display: "none" }}
      />
    </label>
  );
}

function SummaryCard({ label, value, accent, onClick, isActive }) {
  return (
    <div
      className={`glass-morphism reflective-card-container validator-summary-card${onClick ? " interactive" : ""}`}
      style={{
        ...surfaceStyle,
        padding: "clamp(12px, 1.4vw, 18px) clamp(12px, 1.5vw, 20px)",
        position: "relative",
        cursor: onClick ? "pointer" : "default",
        zIndex: isActive ? 80 : "auto",
      }}
      onClick={onClick}
    >
      <div className="validator-summary-label">{label}</div>
      <div style={{ fontSize: "2rem", fontWeight: 900, marginTop: 8, color: accent || "white" }}>{value}</div>
    </div>
  );
}

function ValidationReportSection({ title, report }) {
  if (!report) return null;
  const checks = uniqueChecks(report?.checks);
  const failedChecks = checks.filter((check) => !check?.passed);
  const groups = report?.checkGroups && typeof report.checkGroups === "object" ? report.checkGroups : {};
  const groupEntries = Object.entries(groups);
  const issueBuckets = groupEntries.map(([groupName, issues]) => ({
    groupName,
    list: uniqueMessages(issues),
  }));
  const issueBucketsWithIssues = issueBuckets.filter((entry) => entry.list.length > 0);
  const passedChecks = checks.filter((check) => check?.passed).length;
  const warningChecks = checks.filter((check) => String(check?.severity || "").trim().toLowerCase() === "warning").length;
  const failedCount = failedChecks.length;
  const overallStatus = report?.passed ? "Passed" : failedCount ? "Failed" : "Review";
  const overallStatusColor = report?.passed ? "#6ee7b7" : failedCount ? "#fca5a5" : "#fde68a";
  const score = Math.max(0, Math.min(100, Number(report?.score) || 0));
  const scoreGradient = score >= 80
    ? "linear-gradient(90deg, #6ee7b7, #34d399)"
    : score >= 60
      ? "linear-gradient(90deg, #fde68a, #fbbf24)"
      : "linear-gradient(90deg, #fca5a5, #f87171)";
  const noViolations = failedCount === 0 && issueBucketsWithIssues.length === 0;
  const issueSummaryText = noViolations
    ? "All constraints satisfied"
    : failedCount
      ? `${failedCount} violated constraint(s)`
      : `${issueBucketsWithIssues.length} issue bucket(s)`;

  return (
    <section
      className="glass-morphism reflective-card-container validator-section-card validator-report-card"
      style={{ ...sectionCardStyle, display: "grid", gap: 22 }}
    >
      <div className="validator-report-header">
        <div>
          <h3 style={sectionTitleStyle}>{title}</h3>
          <div className="validator-report-message">{report?.message || ""}</div>
        </div>
      </div>

      <div className="validator-report-kpi-grid">
        <div className="validator-report-kpi">
          <div className="validator-report-kpi-label">Overall Status</div>
          <div className="validator-report-kpi-value" style={{ color: overallStatusColor }}>
            {overallStatus}
          </div>
        </div>
        <div className="validator-report-kpi">
          <div className="validator-report-kpi-label">Passed</div>
          <div className="validator-report-kpi-value" style={{ color: "#6ee7b7" }}>
            {passedChecks}
          </div>
        </div>
        <div className="validator-report-kpi">
          <div className="validator-report-kpi-label">Warnings</div>
          <div className="validator-report-kpi-value" style={{ color: "#fde68a" }}>
            {warningChecks}
          </div>
        </div>
        <div className="validator-report-kpi">
          <div className="validator-report-kpi-label">Failed</div>
          <div className="validator-report-kpi-value" style={{ color: "#fca5a5" }}>
            {failedCount}
          </div>
        </div>
      </div>

      {noViolations ? (
        <div className="validator-report-success-banner">
          <div className="validator-report-success-icon">OK</div>
          <div className="validator-report-success-title">No Violations Found</div>
          <div className="validator-report-success-copy">
            All routes satisfy the constraints and are feasible.
          </div>
        </div>
      ) : null}

      <div className="validator-report-score-block">
        <div className="validator-report-score-head">
          <div>
            <h4 className="validator-report-block-title">Validation Score</h4>
            <div className="validator-report-score-copy">{report?.message || ""}</div>
          </div>
          <div className="validator-report-score-value" style={{ color: score >= 80 ? "#6ee7b7" : score >= 60 ? "#fde68a" : "#fca5a5" }}>
            {score}%
          </div>
        </div>
        <div className="validator-report-score-track">
          <div
            className="validator-report-score-fill"
            style={{ width: `${score}%`, background: scoreGradient }}
          />
        </div>
      </div>

      <div className="validator-report-block">
        <h4 className="validator-report-block-title">Validation Checks</h4>
        <div style={tableShellStyle}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead>
              <tr style={{ background: "rgba(255,255,255,0.04)" }}>
                <th style={headCell}>Check</th>
                <th style={headCell}>Status</th>
                <th style={headCell}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {checks.length ? checks.map((check, index) => {
                const tone = toneForCheck(check);
                return (
                  <tr key={`${check.name}-${index}`} style={{ background: index % 2 ? "rgba(255,255,255,0.02)" : "transparent" }}>
                    <td style={cell}>{check.name}</td>
                    <td style={cell}>
                      <span
                        style={{
                          display: "inline-flex",
                          padding: "6px 12px",
                          borderRadius: 999,
                          background: tone.bg,
                          border: `1px solid ${tone.border}`,
                          color: tone.text,
                          fontWeight: 800,
                          fontSize: "0.82rem",
                        }}
                      >
                        {check.passed ? "Pass" : "Fail"}
                      </span>
                    </td>
                    <td style={{ ...cell, opacity: 0.86 }}>{check.detail}</td>
                  </tr>
                );
              }) : (
                <tr>
                  <td style={cell} colSpan={3}>No validation checks available.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!noViolations ? (
        <div className="validator-report-block" style={{ display: "grid", gap: 14 }}>
          <div className="validator-report-block-head">
            <h4 className="validator-report-block-title">Constraints & Violations</h4>
            <div className="validator-report-block-meta" style={{ color: failedCount ? "#fca5a5" : "#fde68a" }}>
              {issueSummaryText}
            </div>
          </div>

          <div style={tableShellStyle}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 780 }}>
            <thead>
              <tr style={{ background: "rgba(255,255,255,0.04)" }}>
                <th style={headCell}>Constraint Type</th>
                <th style={headCell}>Status</th>
                <th style={headCell}>Severity</th>
                <th style={headCell}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {failedChecks.length ? failedChecks.map((check, index) => (
                <tr key={`${check?.name || "check"}-${index}`} style={{ background: index % 2 ? "rgba(255,255,255,0.02)" : "transparent" }}>
                  <td style={cell}>{check?.name || "Unknown"}</td>
                  <td style={{ ...cell, color: "#fca5a5", fontWeight: 800 }}>Fail</td>
                  <td style={cell}>{check?.severity || "-"}</td>
                  <td style={{ ...cell, opacity: 0.9 }}>{check?.detail || "-"}</td>
                </tr>
              )) : (
                <tr>
                  <td style={cell} colSpan={4}>No violated constraints.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

          <div style={{ display: "grid", gap: 12 }}>
            {issueBuckets.length ? issueBuckets.map(({ groupName, list }) => {
              const hasIssues = list.length > 0;
              if (!hasIssues) return null;
              return (
                <div key={groupName} style={{ ...infoChipStyle, padding: "12px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                    <strong style={{ textTransform: "capitalize" }}>{groupName}</strong>
                    <span style={{ color: "#fca5a5", fontWeight: 800 }}>
                      {`${list.length} issue(s)`}
                    </span>
                  </div>
                  <ul style={{ margin: "10px 0 0 16px", padding: 0, display: "grid", gap: 6 }}>
                    {list.map((msg, index) => (
                      <li key={`${groupName}-${index}`} style={{ color: "rgba(236,243,255,0.92)", lineHeight: 1.35 }}>
                        {String(msg)}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            }).filter(Boolean) : (
              <div style={infoChipStyle}>No violation buckets available.</div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ComparisonSection({ compare }) {
  if (!compare) return null;
  const rows = Array.isArray(compare?.summary?.comparisons) ? compare.summary.comparisons : [];

  return (
    <section
      className="glass-morphism reflective-card-container validator-section-card"
      style={{ ...sectionCardStyle, display: "grid", gap: 16 }}
    >
      <div style={sectionHeadStyle}>
        <div>
          <h3 style={sectionTitleStyle}>Compare With Our Engine</h3>
        </div>
      </div>
      <div style={tableShellStyle}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
          <thead>
            <tr style={{ background: "rgba(255,255,255,0.04)" }}>
              <th style={headCell}>Metric</th>
              <th style={headCell}>Uploaded</th>
              <th style={headCell}>Our Engine</th>
              <th style={headCell}>Better</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key} style={{ background: index % 2 ? "rgba(255,255,255,0.02)" : "transparent" }}>
                <td style={cell}>{row.label}</td>
                <td style={cell}>{formatValue(row.uploaded)}</td>
                <td style={cell}>{formatValue(row.ours)}</td>
                <td style={cell}>
                  {row.better === "uploaded" ? "Uploaded" : row.better === "ours" ? "Ours" : row.better === "tie" ? "Tie" : "Unknown"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ResultMetricCard({ label, value, accent }) {
  return (
    <div className="validator-report-kpi">
      <div className="validator-report-kpi-label">{label}</div>
      <div className="validator-report-kpi-value" style={{ color: accent || "white", fontSize: "1.7rem" }}>
        {value}
      </div>
    </div>
  );
}

function ResultComparisonColumn({
  title,
  description,
  rideView,
  panelData,
  validationTitle,
  validationReport,
}) {
  return (
    <div style={{ display: "grid", gap: 18, alignContent: "start", minWidth: 0 }}>
      <section
        className="glass-morphism reflective-card-container validator-section-card"
        style={{ ...sectionCardStyle, display: "grid", gap: 16 }}
      >
        <div style={sectionHeadStyle}>
          <div>
            <h3 style={sectionTitleStyle}>{title}</h3>
            <div style={{ ...sectionMetaStyle, marginTop: 6 }}>{description}</div>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 14,
          }}
        >
          <ResultMetricCard label="Objective" value={formatValue(rideView?.objective)} />
          <ResultMetricCard label="Cost" value={formatCurrency(rideView?.cost)} accent="#67e8f9" />
          <ResultMetricCard label="Total Time" value={formatMinutes(rideView?.totalTime)} />
          <ResultMetricCard
            label="Delay"
            value={formatMinutes(rideView?.delay)}
            accent={toFiniteNumber(rideView?.delay) > 0 ? "#fca5a5" : "#6ee7b7"}
          />
        </div>
      </section>

      {panelData?.rides?.length ? (
        <RideAssignmentPanel
          rides={panelData.rides}
          employees={panelData.employees}
          vehicles={panelData.vehicles}
          timelineEvents={panelData.timelineEvents}
          officeCenter={panelData.officeCenter}
          distanceInfo={panelData.distanceInfo}
          showHeader={false}
          showControls={false}
          showSequenceTimeline={false}
          stackPanels
        />
      ) : null}

      <ValidationReportSection
        title={validationTitle}
        report={validationReport}
      />
    </div>
  );
}

function ValidatorPage() {
  const [testcaseFile, setTestcaseFile] = useState(null);
  const [resultFile, setResultFile] = useState(null);
  const distanceMetric = "osrm";
  const preferenceRelaxation = "none";
  const [optimizationIntensity, setOptimizationIntensity] = useState(() =>
    normalizeIntensityChoice(localStorage.getItem("optimizationIntensity") || "medium")
  );
  const [customMaxRunSeconds, setCustomMaxRunSeconds] = useState(() => readStoredCustomNumber("customMaxRunSeconds"));
  const [customGenerations, setCustomGenerations] = useState(() => readStoredCustomNumber("customGenerations", true));
  const [showCustomIntensityModal, setShowCustomIntensityModal] = useState(false);
  const [lastNonCustomIntensity, setLastNonCustomIntensity] = useState(() =>
    normalizeIntensityChoice(localStorage.getItem("optimizationIntensity") || "medium") === "custom" ? "medium" : normalizeIntensityChoice(localStorage.getItem("optimizationIntensity") || "medium")
  );
  const [compareWithEngine, setCompareWithEngine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState(null);
  const [resultPreviewPayload, setResultPreviewPayload] = useState(null);
  const [testcasePreviewPayload, setTestcasePreviewPayload] = useState(null);
  const [activeCardList, setActiveCardList] = useState(null);

  useEffect(() => {
    let alive = true;
    if (!resultFile) {
      setResultPreviewPayload(null);
      return () => { alive = false; };
    }
    resultFile.text()
      .then((raw) => {
        if (!alive) return;
        try {
          const parsed = extractJsonFromText(raw);
          setResultPreviewPayload(parsed);
        } catch {
          setResultPreviewPayload(null);
        }
      })
      .catch(() => {
        if (alive) setResultPreviewPayload(null);
      });
    return () => { alive = false; };
  }, [resultFile]);

  useEffect(() => {
    let alive = true;
    if (!testcaseFile) {
      setTestcasePreviewPayload(null);
      return () => { alive = false; };
    }
    testcaseFile.text()
      .then((raw) => {
        if (!alive) return;
        try {
          const parsed = extractJsonFromText(raw);
          setTestcasePreviewPayload(parsed);
        } catch {
          setTestcasePreviewPayload(null);
        }
      })
      .catch(() => {
        if (alive) setTestcasePreviewPayload(null);
      });
    return () => { alive = false; };
  }, [testcaseFile]);

  const uploadedRideView = useMemo(() => buildRideAssignmentView(resultPreviewPayload), [resultPreviewPayload]);
  const uploadedRidePanelData = useMemo(
    () => buildRidePanelData(resultPreviewPayload, testcasePreviewPayload, report),
    [resultPreviewPayload, testcasePreviewPayload, report],
  );
  const engineResultPayload = report?.compare?.engineResult || null;
  const engineRideView = useMemo(() => buildRideAssignmentView(engineResultPayload), [engineResultPayload]);
  const engineRidePanelData = useMemo(
    () => buildRidePanelData(engineResultPayload, testcasePreviewPayload, report),
    [engineResultPayload, testcasePreviewPayload, report],
  );
  const hasSideBySideComparison = Boolean(report?.compare?.engineResult);

  const handleIntensityChange = (nextValue) => {
    const normalized = normalizeIntensityChoice(nextValue);
    if (normalized === "custom") {
      if (optimizationIntensity !== "custom") {
        setLastNonCustomIntensity(optimizationIntensity);
      }
      setOptimizationIntensity("custom");
      localStorage.setItem("optimizationIntensity", "custom");
      setShowCustomIntensityModal(true);
      return;
    }
    setOptimizationIntensity(normalized);
    localStorage.setItem("optimizationIntensity", normalized);
    setLastNonCustomIntensity(normalized);
  };

  const handleCustomIntensitySave = ({ customMaxRunSeconds: nextTime, customGenerations: nextGenerations }) => {
    setCustomMaxRunSeconds(nextTime);
    setCustomGenerations(nextGenerations);
    if (nextTime === null) {
      localStorage.removeItem("customMaxRunSeconds");
    } else {
      localStorage.setItem("customMaxRunSeconds", String(nextTime));
    }
    if (nextGenerations === null) {
      localStorage.removeItem("customGenerations");
    } else {
      localStorage.setItem("customGenerations", String(nextGenerations));
    }
    setOptimizationIntensity("custom");
    localStorage.setItem("optimizationIntensity", "custom");
    setShowCustomIntensityModal(false);
  };

  const handleCustomIntensityCancel = () => {
    setShowCustomIntensityModal(false);
    if (!customMaxRunSeconds && !customGenerations) {
      setOptimizationIntensity(lastNonCustomIntensity || "medium");
      localStorage.setItem("optimizationIntensity", lastNonCustomIntensity || "medium");
    }
  };

  const handleSubmit = async () => {
    if (!testcaseFile || !resultFile) {
      setError("Upload both testcase and testcase result.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      localStorage.setItem("optimizationIntensity", normalizeIntensityChoice(optimizationIntensity));
      const data = await runStandaloneValidator({
        testcaseFile,
        resultFile,
        distanceMetric,
        preferenceRelaxation,
        optimizationIntensity: normalizeIntensityChoice(optimizationIntensity),
        customMaxRunSeconds: optimizationIntensity === "custom" ? customMaxRunSeconds : null,
        customGenerations: optimizationIntensity === "custom" ? customGenerations : null,
        compareWithEngine,
      });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Validation failed");
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="validator-page">
      <div className="validator-shell">
        <div className="validator-header">
          <div className="validator-title-group">
            <h1 className="validator-title">Validator</h1>
            <div className="validator-intro-popover">
              Validate uploaded solver outputs for feasibility, consistency, and side-by-side engine comparison.
            </div>
          </div>
        </div>

        <section className="validator-upload-grid">
          <UploadField
            label="Testcase"
            helper="Upload JSON or CSV/XLS/XLSX testcase"
            accept=".json,.txt,.csv,.xlsx,.xls"
            file={testcaseFile}
            onChange={setTestcaseFile}
          />
          <UploadField
            label="Testcase Result"
            helper="Upload solver output JSON from another engine or run."
            accept=".json,.txt"
            file={resultFile}
            onChange={setResultFile}
          />
          <div
            className="glass-morphism reflective-card-container validator-options-card"
            style={surfaceStyle}
          >
            <div className="validator-options-header">
              <div className="validator-upload-title">Validation Options</div>
            </div>
            <div className="validator-options-group">
              <label className="validator-checkbox validator-checkbox-panel">
                <input type="checkbox" checked={compareWithEngine} disabled={busy} onChange={(e) => setCompareWithEngine(e.target.checked)} />
                <div className="validator-checkbox-copy">
                  <span className="validator-checkbox-title">Compare uploaded result with our engine output</span>
                  <span className="validator-checkbox-subtitle">Run the same testcase through our solver and compare both outputs side by side.</span>
                </div>
              </label>
              <label
                className={`validator-intensity-field ${compareWithEngine ? "is-active" : "is-muted"}`}
                style={fieldLabel}
              >
                <span>Our engine intensity</span>
                <CustomSelect
                  key={`engine-intensity-${busy ? "busy" : "idle"}`}
                  value={optimizationIntensity}
                  onChange={handleIntensityChange}
                  disabled={busy || !compareWithEngine}
                  options={[
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                    { value: "custom", label: "Custom" },
                  ]}
                />
                {optimizationIntensity === "custom" ? (
                  <button
                    type="button"
                    disabled={busy || !compareWithEngine}
                    onClick={() => setShowCustomIntensityModal(true)}
                    style={{
                      height: 40,
                      borderRadius: 12,
                      border: "1px solid rgba(96,165,250,0.24)",
                      background: "rgba(59,130,246,0.08)",
                      color: "#dbeafe",
                      fontWeight: 700,
                      cursor: busy || !compareWithEngine ? "not-allowed" : "pointer",
                    }}
                  >
                    {customGenerations
                      ? `Custom generations: ${customGenerations}`
                      : customMaxRunSeconds
                        ? `Custom time: ${customMaxRunSeconds}s`
                        : "Set custom intensity"}
                  </button>
                ) : null}
              </label>
            </div>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={busy}
              className="validator-primary-button validator-primary-button-tight"
            >
              {busy ? "Running validation..." : "Run Validation"}
            </button>
          </div>
        </section>

        {error ? (
          <section
            className="glass-morphism reflective-card-container validator-error-banner"
            style={{ ...surfaceStyle, padding: 18 }}
          >
            {error}
          </section>
        ) : null}

        {report ? (
          <>
            {!hasSideBySideComparison ? (
              <div className="validator-summary-wrap">
                <section
                  className="validator-summary-grid"
                >
                  <SummaryCard
                    label="Employees"
                    value={report?.testcase?.summary?.employees ?? 0}
                    onClick={() => setActiveCardList((prev) => (prev === "employees" ? null : "employees"))}
                    isActive={activeCardList === "employees"}
                  />
                  <SummaryCard
                    label="Vehicles"
                    value={report?.testcase?.summary?.vehicles ?? 0}
                    onClick={() => setActiveCardList((prev) => (prev === "vehicles" ? null : "vehicles"))}
                    isActive={activeCardList === "vehicles"}
                  />
                  <SummaryCard label="Objective" value={formatValue(uploadedRideView?.objective)} />
                  <SummaryCard label="Cost" value={formatCurrency(uploadedRideView?.cost)} accent="#67e8f9" />
                  <SummaryCard label="Total Time" value={formatMinutes(uploadedRideView?.totalTime)} />
                  <SummaryCard label="Delay" value={formatMinutes(uploadedRideView?.delay)} accent={toFiniteNumber(uploadedRideView?.delay) > 0 ? "#fca5a5" : "#6ee7b7"} />
                </section>
              </div>
            ) : null}

            {!hasSideBySideComparison && uploadedRideView && (activeCardList === "employees" || activeCardList === "vehicles") ? (
              <div
                onClick={() => setActiveCardList(null)}
                className="validator-modal-backdrop"
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="validator-modal"
                >
                  <div style={sectionHeadStyle}>
                    <h3 style={sectionTitleStyle}>{activeCardList === "employees" ? "Employees List" : "Vehicles List"}</h3>
                  </div>
                  <div style={{ ...tableShellStyle, maxHeight: 560, overflowY: "auto" }}>
                    {activeCardList === "employees" ? (
                      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1200 }}>
                        <thead>
                          <tr style={{ background: "rgba(255,255,255,0.04)" }}>
                            <th style={headCell}>Employee</th>
                            <th style={headCell}>Vehicle</th>
                            <th style={headCell}>Pickup Stop</th>
                            <th style={headCell}>Drop Stop</th>
                            <th style={headCell}>Pickup Time</th>
                            <th style={headCell}>Drop Time</th>
                            <th style={headCell}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {uploadedRideView.employeeRows.map((row, index) => (
                            <tr key={`panel-emp-${row.employeeId}-${index}`} style={{ background: index % 2 ? "rgba(255,255,255,0.02)" : "transparent" }}>
                              <td style={cell}>{row.employeeId}</td>
                              <td style={cell}>{row.vehicleId}</td>
                              <td style={cell}>{row.pickupStop}</td>
                              <td style={cell}>{row.dropStop}</td>
                              <td style={cell}>{formatClockTime(row.pickupMinute)}</td>
                              <td style={cell}>{formatClockTime(row.dropMinute)}</td>
                              <td style={cell}>{row.status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1200 }}>
                        <thead>
                          <tr style={{ background: "rgba(255,255,255,0.04)" }}>
                            <th style={headCell}>Vehicle</th>
                            <th style={headCell}>Assigned</th>
                            <th style={headCell}>Stops</th>
                            <th style={headCell}>Distance</th>
                            <th style={headCell}>Cost</th>
                            <th style={headCell}>Total Time</th>
                            <th style={headCell}>Delay</th>
                            <th style={headCell}>Feasible</th>
                          </tr>
                        </thead>
                        <tbody>
                          {uploadedRideView.vehicleRows.map((row, index) => (
                            <tr key={`panel-veh-${row.vehicleId}-${index}`} style={{ background: index % 2 ? "rgba(255,255,255,0.02)" : "transparent" }}>
                              <td style={cell}>{row.vehicleId}</td>
                              <td style={cell}>{row.assignedCount}</td>
                              <td style={cell}>{row.stops}</td>
                              <td style={cell}>{toFiniteNumber(row.distanceKm) !== null ? `${row.distanceKm.toFixed(2)} km` : "N/A"}</td>
                              <td style={cell}>{formatCurrency(row.cost)}</td>
                              <td style={cell}>{formatMinutes(row.timeMinutes)}</td>
                              <td style={cell}>{formatMinutes(row.delayMinutes)}</td>
                              <td style={{ ...cell, color: row.feasible ? "#6ee7b7" : "#fca5a5", fontWeight: 800 }}>{row.feasible ? "Yes" : "No"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {hasSideBySideComparison ? (
              <>
                <section
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(520px, 1fr))",
                    gap: 22,
                    alignItems: "start",
                  }}
                >
                  <ResultComparisonColumn
                    title="Uploaded Result"
                    description="Uploaded solver output shown on the left for direct comparison."
                    rideView={uploadedRideView}
                    panelData={uploadedRidePanelData}
                    validationTitle="Uploaded Result Validation"
                    validationReport={report?.uploadedResult}
                  />
                  <ResultComparisonColumn
                    title="Our Engine Result"
                    description="Our generated engine output shown on the right using the same testcase."
                    rideView={engineRideView}
                    panelData={engineRidePanelData}
                    validationTitle="Our Engine Validation"
                    validationReport={report?.compare?.engineValidation}
                  />
                </section>
                <ComparisonSection compare={report.compare} />
              </>
            ) : (
              <>
                {uploadedRidePanelData.rides.length ? (
                  <RideAssignmentPanel
                    rides={uploadedRidePanelData.rides}
                    employees={uploadedRidePanelData.employees}
                    vehicles={uploadedRidePanelData.vehicles}
                    timelineEvents={uploadedRidePanelData.timelineEvents}
                    officeCenter={uploadedRidePanelData.officeCenter}
                    distanceInfo={uploadedRidePanelData.distanceInfo}
                    showHeader={false}
                    showControls={false}
                    showSequenceTimeline={false}
                  />
                ) : null}

                <ValidationReportSection
                  title="Uploaded Result Validation"
                  report={report?.uploadedResult}
                />
                <ComparisonSection compare={report.compare} />
                <ValidationReportSection
                  title="Our Engine Validation"
                  report={report?.compare?.engineValidation}
                />
              </>
            )}
          </>
        ) : null}
      </div>
      <CustomIntensityModal
        open={showCustomIntensityModal}
        title="Custom Validation Intensity"
        initialMaxRunSeconds={customMaxRunSeconds}
        initialGenerations={customGenerations}
        onCancel={handleCustomIntensityCancel}
        onSave={handleCustomIntensitySave}
      />
    </div>
  );
}

export default ValidatorPage;
