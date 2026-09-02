import React from "react";
import { useNavigate } from "react-router-dom";
import { formatUSDCompact, toNumber } from "../../../utils/currency";

const StatCard = ({ title, value, sub, color, onClick }) => (
  <div
    className="glass-morphism reflective-card-container"
    onClick={onClick}
    style={{
      background:
        "linear-gradient(135deg, rgba(0, 0, 0, 0.15) 0%, rgba(0, 0, 0, 0.05) 100%)",
      padding: "25px",
      borderRadius: "16px",
      flex: 1,
      minWidth: "120px",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      position: "relative",
      overflow: "hidden",
      cursor: "pointer",
      transition: "0.25s ease",
    }}
    onMouseEnter={(e) =>
      (e.currentTarget.style.transform = "translateY(-4px)")
    }
    onMouseLeave={(e) =>
      (e.currentTarget.style.transform = "translateY(0)")
    }
  >
    <div style={{ opacity: 0.9, fontSize: "0.9rem", color: "#fff" }}>
      {title}
    </div>

    <div
      style={{
        fontSize: "2rem",
        fontWeight: "700",
        margin: "5px 0",
        color: color,
      }}
    >
      {value}
    </div>

    <div style={{ fontSize: "0.8rem", opacity: 0.8, color: "#e0e0e0" }}>
      {sub}
    </div>
  </div>
);

const UserAnalytics = ({ metrics }) => {
  const navigate = useNavigate();

  const formatCurrency = (val) => formatUSDCompact(toNumber(val, 0), { fallback: "$0" });

  const formatTime = (minutes) => {
    if (!minutes) return "0h";
    const hrs = Math.floor(minutes / 60);
    return `${hrs}h ${(minutes % 60).toFixed(0)}m`;
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "15px",
        height: "100%",
        justifyContent: "space-between",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h3>Optimization Metrics</h3>
        <span style={{ fontSize: "0.8rem", opacity: 0.7 }}>
          Cumulative
        </span>
      </div>

      <div style={{ display: "flex", gap: "15px", flexWrap: "wrap" }}>
        <StatCard
          title="Total Savings"
          value={formatCurrency(metrics?.totalSavings || 0)}
          sub="Total cost reduction"
          color="#4ade80"
          onClick={() => navigate("/metrics")}
        />

        <StatCard
          title="Projects Optimized"
          value={metrics?.totalProjects || 0}
          sub="Successful runs"
          color="#60a5fa"
          onClick={() => navigate("/metrics")}
        />
      </div>

      <div style={{ display: "flex", gap: "15px", flexWrap: "wrap" }}>
        <StatCard
          title="Total Time Saved"
          value={formatTime(metrics?.totalTimeSaved || 0)}
          sub="Across all projects"
          color="#facc15"
          onClick={() => navigate("/metrics")}
        />

        <StatCard
          title="Avg. Savings"
          value={`${(metrics?.avgSavingsPercent || 0).toFixed(1)}%`}
          sub="Per project average"
          color="#f472b6"
          onClick={() => navigate("/metrics")}
        />
      </div>
    </div>
  );
};

export default UserAnalytics;
