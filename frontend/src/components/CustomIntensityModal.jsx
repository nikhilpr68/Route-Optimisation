import React, { useEffect, useState } from "react";

const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(3, 6, 12, 0.68)",
  backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 18,
  zIndex: 1200,
};

const shellStyle = {
  width: "min(100%, 460px)",
  borderRadius: 20,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "linear-gradient(180deg, rgba(20,25,35,0.98), rgba(8,11,17,0.98))",
  boxShadow: "0 30px 70px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08)",
  color: "rgba(235,243,255,0.96)",
  padding: 22,
};

const inputStyle = {
  width: "100%",
  height: 46,
  borderRadius: 12,
  border: "1px solid rgba(163,191,227,0.28)",
  background: "rgba(255,255,255,0.05)",
  color: "rgba(235,243,255,0.96)",
  fontSize: "0.95rem",
  padding: "0 14px",
  outline: "none",
};

const buttonStyle = {
  height: 42,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.14)",
  padding: "0 16px",
  fontWeight: 700,
  cursor: "pointer",
};

function CustomIntensityModal({
  open,
  title = "Custom Intensity",
  initialMaxRunSeconds = "",
  initialGenerations = "",
  onCancel,
  onSave,
}) {
  const [maxRunSeconds, setMaxRunSeconds] = useState("");
  const [generations, setGenerations] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setMaxRunSeconds(initialMaxRunSeconds === null || initialMaxRunSeconds === undefined ? "" : String(initialMaxRunSeconds));
    setGenerations(initialGenerations === null || initialGenerations === undefined ? "" : String(initialGenerations));
    setError("");
  }, [open, initialMaxRunSeconds, initialGenerations]);

  if (!open) return null;

  const handleSave = () => {
    const nextTime = String(maxRunSeconds || "").trim();
    const nextGenerations = String(generations || "").trim();
    const filledCount = Number(Boolean(nextTime)) + Number(Boolean(nextGenerations));

    if (filledCount !== 1) {
      setError("Fill exactly one field.");
      return;
    }

    if (nextTime) {
      const n = Number(nextTime);
      if (!Number.isFinite(n) || n <= 0) {
        setError("Time must be a positive number of seconds.");
        return;
      }
      onSave({ customMaxRunSeconds: n, customGenerations: null });
      return;
    }

    const n = Number(nextGenerations);
    if (!Number.isInteger(n) || n <= 0) {
      setError("Generations must be a positive whole number.");
      return;
    }
    onSave({ customMaxRunSeconds: null, customGenerations: n });
  };

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={shellStyle} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: "grid", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 800 }}>{title}</h3>
          <p style={{ margin: 0, color: "rgba(187,201,225,0.84)", lineHeight: 1.5 }}>
            Enter either a run time in seconds or a planned generation count. Only one can be used.
          </p>
        </div>

        <div style={{ display: "grid", gap: 14, marginTop: 18 }}>
          <label style={{ display: "grid", gap: 8 }}>
            <span style={{ fontSize: "0.86rem", fontWeight: 700 }}>Run time (seconds)</span>
            <input
              type="number"
              min="1"
              step="1"
              value={maxRunSeconds}
              onChange={(event) => {
                setMaxRunSeconds(event.target.value);
                if (event.target.value) setGenerations("");
              }}
              style={inputStyle}
              placeholder="Example: 300"
            />
          </label>

          <div style={{ textAlign: "center", fontSize: "0.8rem", color: "rgba(160,176,203,0.72)", letterSpacing: "0.08em" }}>
            OR
          </div>

          <label style={{ display: "grid", gap: 8 }}>
            <span style={{ fontSize: "0.86rem", fontWeight: 700 }}>Planned generations</span>
            <input
              type="number"
              min="1"
              step="1"
              value={generations}
              onChange={(event) => {
                setGenerations(event.target.value);
                if (event.target.value) setMaxRunSeconds("");
              }}
              style={inputStyle}
              placeholder="Example: 120"
            />
          </label>
        </div>

        {error ? (
          <div style={{ marginTop: 14, color: "#fda4af", fontSize: "0.88rem", fontWeight: 600 }}>
            {error}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ ...buttonStyle, background: "rgba(255,255,255,0.06)", color: "rgba(235,243,255,0.92)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            style={{
              ...buttonStyle,
              border: "1px solid rgba(96,165,250,0.5)",
              background: "linear-gradient(135deg, rgba(59,130,246,0.92), rgba(29,78,216,0.92))",
              color: "white",
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default CustomIntensityModal;
