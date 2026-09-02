import React, { useEffect, useRef, useState } from "react";
import { ingestArtifacts, parseAndRun, createProject } from "../../../api/api";
import CustomIntensityModal from "../../../components/CustomIntensityModal";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toYmd(dateObj) {
  return `${dateObj.getFullYear()}-${pad2(dateObj.getMonth() + 1)}-${pad2(dateObj.getDate())}`;
}

function parseYmd(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function prettyDate(ymd) {
  const d = parseYmd(ymd);
  if (!d) return "Select Date";
  const day = pad2(d.getDate());
  const month = MONTH_NAMES[d.getMonth()].slice(0, 3);
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

function normalizePreferenceRelaxationChoice(v) {
  const x = String(v || "").trim().toLowerCase();
  if (x === "sharing" || x === "vehicle" || x === "both") return x;
  return "none";
}

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

function CustomCalendarPicker({ value, onChange, disabled }) {
  const wrapperRef = useRef(null);
  const selectedDate = parseYmd(value);
  const today = new Date();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(
    selectedDate ? new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1) : new Date(today.getFullYear(), today.getMonth(), 1)
  );

  useEffect(() => {
    const onDocDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, []);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div ref={wrapperRef} style={{ position: "relative", width: 130 }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        style={{
          width: "100%",
          height: 34,
          borderRadius: 12,
          border: "1px solid rgba(163,191,227,0.34)",
          background: "linear-gradient(180deg, rgba(28,33,44,0.58), rgba(10,12,18,0.54))",
          color: "rgba(234,243,255,0.96)",
          fontSize: "0.72rem",
          fontWeight: 700,
          padding: "0 8px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "6px",
          cursor: disabled ? "not-allowed" : "pointer",
          boxShadow: "0 10px 24px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.12)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "1" }}>{prettyDate(value)}</span>
        <span style={{ opacity: 0.9, flex: "0 0 auto" }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: 48,
            left: 0,
            width: 280,
            borderRadius: 14,
            border: "1px solid rgba(163,191,227,0.3)",
            background: "linear-gradient(180deg, rgba(24,29,39,0.92), rgba(10,12,18,0.9))",
            boxShadow: "0 18px 42px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08)",
            padding: 12,
            zIndex: 20,
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => setCursor(new Date(year, month - 1, 1))}
              style={{ background: "transparent", border: "none", color: "white", cursor: "pointer", fontSize: "1rem" }}
            >
              &#8249;
            </button>
            <div style={{ color: "white", fontWeight: 700, fontSize: "0.9rem" }}>{MONTH_NAMES[month]} {year}</div>
            <button
              type="button"
              onClick={() => setCursor(new Date(year, month + 1, 1))}
              style={{ background: "transparent", border: "none", color: "white", cursor: "pointer", fontSize: "1rem" }}
            >
              &#8250;
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
            {WEEKDAY_SHORT.map((w) => (
              <div key={w} style={{ textAlign: "center", fontSize: "0.72rem", color: "rgba(220,230,255,0.75)", fontWeight: 700 }}>
                {w}
              </div>
            ))}
            {cells.map((d, idx) => {
              if (!d) return <div key={`e-${idx}`} style={{ height: 30 }} />;
              const ymd = toYmd(d);
              const isSelected = value === ymd;
              const isToday = toYmd(today) === ymd;
              return (
                <button
                  key={ymd}
                  type="button"
                  onClick={() => {
                    onChange(ymd);
                    setOpen(false);
                  }}
                  style={{
                    height: 30,
                    borderRadius: 8,
                    border: isToday ? "1px solid rgba(96,165,250,0.95)" : "1px solid transparent",
                    background: isSelected ? "rgba(96,165,250,0.92)" : "rgba(255,255,255,0.04)",
                    color: "white",
                    cursor: "pointer",
                    fontSize: "0.8rem",
                    fontWeight: isSelected ? 800 : 600,
                  }}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const DragDrop = ({ projectId, onCompleted, onProjectCreated, onRunStarted }) => {
  const inputRef = useRef(null);
  const [localProjectId, setLocalProjectId] = useState(projectId || null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [hasUploadedArtifacts, setHasUploadedArtifacts] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [optimizationIntensity, setOptimizationIntensity] = useState(() => {
    return normalizeIntensityChoice(localStorage.getItem("optimizationIntensity") || "medium");
  });
  const [customMaxRunSeconds, setCustomMaxRunSeconds] = useState(() => readStoredCustomNumber("customMaxRunSeconds"));
  const [customGenerations, setCustomGenerations] = useState(() => readStoredCustomNumber("customGenerations", true));
  const [showCustomIntensityModal, setShowCustomIntensityModal] = useState(false);
  const [lastNonCustomIntensity, setLastNonCustomIntensity] = useState(() =>
    normalizeIntensityChoice(localStorage.getItem("optimizationIntensity") || "medium") === "custom" ? "medium" : normalizeIntensityChoice(localStorage.getItem("optimizationIntensity") || "medium")
  );
  const distanceMetric = "osrm";
  const [preferenceRelaxation, setPreferenceRelaxation] = useState(() =>
    normalizePreferenceRelaxationChoice(localStorage.getItem("preferenceRelaxation") || "none")
  );
  const [runDate, setRunDate] = useState(() => toYmd(new Date()));

  useEffect(() => {
    if (projectId) {
      setLocalProjectId(projectId);
      setHasUploadedArtifacts(false);
    }
  }, [projectId]);

  const handleIntensityChange = (newIntensity) => {
    const normalized = normalizeIntensityChoice(newIntensity);
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

  const handlePreferenceRelaxationChange = (newMode) => {
    const normalized = normalizePreferenceRelaxationChoice(newMode);
    setPreferenceRelaxation(normalized);
    localStorage.setItem("preferenceRelaxation", normalized);
  };

  async function handleFilesUpload(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    let pid = localProjectId || projectId;

    // Auto-create a project if none selected
    if (!pid) {
      setBusy(true);
      setMsg("Creating project...");
      try {
        const fileName = files[0]?.name?.replace(/\.[^.]+$/, "") || "Untitled";
        const newProj = await createProject(fileName);
        pid = newProj._id || newProj.id;
        setLocalProjectId(pid);
        if (onProjectCreated) onProjectCreated(pid);
      } catch (e) {
        setMsg("Failed to create project: " + (e.response?.data?.message || e.message));
        setBusy(false);
        return;
      }
    }

    setBusy(true);
    setHasUploadedArtifacts(false);
    setMsg("Uploading...");
    try {
      await ingestArtifacts(pid, files, "");
      setHasUploadedArtifacts(true);
      setMsg("Files uploaded. Starting optimization...");
      await handleRunSolver(pid, true);
    } catch (e) {
      setHasUploadedArtifacts(false);
      setMsg("Failed: " + (e.response?.data?.message || e.response?.data?.error || e.message || "Failed"));
      setBusy(false);
    }
  }

  async function handleRunSolver(overrideProjectId = null, skipUploadCheck = false) {
    const pid = overrideProjectId || localProjectId || projectId;
    if (!pid) {
      setMsg("Please upload files first.");
      return;
    }
    if (!skipUploadCheck && !hasUploadedArtifacts) {
      setMsg("Upload files before running the solver.");
      return;
    }

    setBusy(true);
    setMsg("Running optimization...");
    try {
      const runPromise = parseAndRun(pid, {
        optimizationIntensity,
        customMaxRunSeconds: optimizationIntensity === "custom" ? customMaxRunSeconds : null,
        customGenerations: optimizationIntensity === "custom" ? customGenerations : null,
        distanceMetric,
        preferenceRelaxation,
        runDate: runDate || null,
      });
      if (onRunStarted) onRunStarted(pid);
      const response = await runPromise;
      const parseStatus = String(response?.parseReport?.status || "").trim().toLowerCase();
      const responseMessage = String(response?.message || "").trim().toLowerCase();
      const needsReview = parseStatus === "needs_review" || responseMessage.includes("needs review");

      if (needsReview) {
        setMsg(
          "Input parsed, but it needs review before the solver can run. Open the project and fix the missing or invalid fields."
        );
        return;
      }

      setMsg(
        `Completed! Intensity: ${optimizationIntensity.toUpperCase()} • Preference Override: ${preferenceRelaxation.toUpperCase()}`
      );
      setHasUploadedArtifacts(false);
      if (onCompleted) onCompleted(pid);
    } catch (e) {
      setMsg("Failed: " + (e.response?.data?.message || e.response?.data?.error || e.message || "Unknown error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 18,
          background:
            dragActive || hovered
              ? "radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0) 58%)"
              : "radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0) 58%)",
          pointerEvents: "none",
          transition: "all 0.2s ease",
        }}
      />
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          cursor: busy ? "not-allowed" : "pointer",
          border: "1px solid rgba(128, 151, 193, 0.24)",
          borderRadius: 18,
          opacity: busy ? 0.7 : 1,
          padding: 18,
          position: "relative",
          zIndex: 1,
          background:
            dragActive || hovered
              ? "rgba(18, 18, 24, 0.26)"
              : "var(--glass-surface, rgba(10, 10, 10, 0.15))",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          boxShadow:
            dragActive || hovered
              ? "inset 0 1px 0 rgba(255,255,255,0.24), 0 0 0 1px rgba(255,255,255,0.22), 0 10px 30px rgba(0,0,0,0.36)"
              : "inset 0 1px 0 rgba(255,255,255,0.14), 0 8px 28px rgba(0,0,0,0.30)",
          transition: "background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease",
          borderColor:
            dragActive
              ? "rgba(96, 165, 250, 0.95)"
              : hovered
                ? "rgba(255, 255, 255, 0.45)"
                : "rgba(255, 255, 255, 0.24)",
        }}
        onClick={() => {
          if (busy || !inputRef.current) return;
          inputRef.current.value = "";
          inputRef.current.click();
        }}
        onMouseEnter={() => !busy && setHovered(true)}
        onMouseLeave={() => !busy && setHovered(false)}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragActive(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!busy) setDragActive(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragActive(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          setHovered(false);
          if (busy) return;
          handleFilesUpload(e.dataTransfer.files);
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            zIndex: 3,
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            gap: 6,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 9,
            padding: "6px 8px",
            minWidth: 212,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: "0.68rem", color: "rgba(225,235,255,0.85)", fontWeight: 700 }}>
              Intensity
            </span>
            <select
              value={optimizationIntensity}
              disabled={busy}
              onChange={(e) => handleIntensityChange(e.target.value)}
              style={{
                background: "linear-gradient(180deg, rgba(28,33,44,0.58), rgba(10,12,18,0.54))",
                color: "rgba(234,243,255,0.96)",
                border: "1px solid rgba(163,191,227,0.34)",
                borderRadius: 9,
                fontSize: "0.72rem",
                fontWeight: 700,
                padding: "3px 7px",
                outline: "none",
                cursor: busy ? "not-allowed" : "pointer",
                minWidth: 110,
                boxShadow: "0 8px 18px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.12)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
              }}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {optimizationIntensity === "custom" ? (
            <button
              type="button"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                setShowCustomIntensityModal(true);
              }}
              style={{
                marginTop: -2,
                border: "1px solid rgba(96,165,250,0.28)",
                background: "rgba(59,130,246,0.1)",
                color: "rgba(214,230,255,0.96)",
                borderRadius: 9,
                padding: "7px 10px",
                fontSize: "0.68rem",
                textAlign: "left",
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              {customGenerations
                ? `Custom generations: ${customGenerations}`
                : customMaxRunSeconds
                  ? `Custom time: ${customMaxRunSeconds}s`
                  : "Set custom intensity"}
            </button>
          ) : null}

          <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: "0.68rem", color: "rgba(225,235,255,0.85)", fontWeight: 700 }}>
              Preferences
            </span>
            <select
              value={preferenceRelaxation}
              disabled={busy}
              onChange={(e) => handlePreferenceRelaxationChange(e.target.value)}
              style={{
                background: "linear-gradient(180deg, rgba(28,33,44,0.58), rgba(10,12,18,0.54))",
                color: "rgba(234,243,255,0.96)",
                border: "1px solid rgba(163,191,227,0.34)",
                borderRadius: 9,
                fontSize: "0.72rem",
                fontWeight: 700,
                padding: "3px 7px",
                outline: "none",
                cursor: busy ? "not-allowed" : "pointer",
                minWidth: 110,
                boxShadow: "0 8px 18px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.12)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
              }}
            >
              <option value="none">Enforce All</option>
              <option value="sharing">Break Sharing</option>
              <option value="vehicle">Break Vehicle</option>
              <option value="both">Break Both</option>
            </select>
          </label>

        </div>

        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            zIndex: 3,
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "linear-gradient(180deg, rgba(255,255,255,0.09), rgba(255,255,255,0.03))",
            border: "1px solid rgba(255,255,255,0.22)",
            borderTop: "1px solid rgba(255,255,255,0.35)",
            borderRadius: 9,
            padding: "5px 7px",
            boxShadow: "0 8px 18px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.08)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}
          onClick={(e) => e.stopPropagation()}
          title="Schedules routes for future runs"
        >
          <span
            style={{
              width: 14,
              height: 14,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "rgba(210,224,255,0.9)",
              opacity: 0.9,
            }}
            aria-hidden="true"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <span
            style={{
              fontSize: "0.68rem",
              color: "rgba(230,238,255,0.92)",
              fontWeight: 700,
              letterSpacing: "0.2px",
              minWidth: 70,
            }}
          >
            Schedule Run
          </span>
          <CustomCalendarPicker value={runDate} onChange={setRunDate} disabled={busy} />
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".xlsx,.xls,.csv"
          style={{ display: "none" }}
          onChange={(e) => {
            const { files } = e.target;
            handleFilesUpload(files);
            e.target.value = "";
          }}
        />

        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(210, 220, 245, 0.95)",
            marginBottom: 8,
          }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4" />
            <path d="m7 9 5-5 5 5" />
            <rect x="4" y="16" width="16" height="4.5" rx="1.5" />
          </svg>
        </div>

        <h3 style={{ margin: 0, color: "#f5f7ff", fontSize: "1.1rem", fontWeight: 700 }}>
          {busy ? "Processing your files..." : "Drop your dataset here"}
        </h3>

        <p style={{ marginTop: 6, opacity: 0.72, color: "#c5cfe5", textAlign: "center", fontSize: "0.88rem" }}>
          Supports CSV and Excel (.csv, .xls, .xlsx)
        </p>
        {!!msg && <p style={{ marginTop: 8, opacity: 0.9, color: "#dbe6ff", fontSize: "0.82rem" }}>{msg}</p>}
      </div>
      <CustomIntensityModal
        open={showCustomIntensityModal}
        title="Custom Engine Intensity"
        initialMaxRunSeconds={customMaxRunSeconds}
        initialGenerations={customGenerations}
        onCancel={handleCustomIntensityCancel}
        onSave={handleCustomIntensitySave}
      />
    </div>
  );
};

export default DragDrop;
