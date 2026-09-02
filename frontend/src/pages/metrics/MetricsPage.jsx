import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import { getDashboardMetrics } from "../../api/api";
import { formatUSD, toNumber } from "../../utils/currency";
import "./MetricsPage.css";

function asNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmtMoney(v) {
  return formatUSD(Math.round(toNumber(v, 0)), { fallback: "$0" });
}

function fmtCompact(v) {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(asNumber(v, 0));
}

function fmtPct(v) {
  return `${asNumber(v, 0).toFixed(1)}%`;
}

function fmtMinutes(v) {
  return `${asNumber(v, 0).toFixed(1)} min`;
}

function fmtRuntimeSec(v) {
  return `${asNumber(v, 0).toFixed(1)} sec`;
}

function KpiCard({ title, value, hint, accent = "teal" }) {
  return (
    <div className="glass-morphism reflective-card-container metric-kpi" data-metric-card>
      <div className="metric-kpi-title">{title}</div>
      <div className={`metric-kpi-value ${accent}`}>{value}</div>
      <div className="metric-kpi-hint">{hint}</div>
    </div>
  );
}

function DistanceDonut({ pct, reducedKm }) {
  const value = Math.max(0, Math.min(100, asNumber(pct, 0)));
  const angle = (value / 100) * 360;
  const g1 = angle * 0.33;
  const g2 = angle * 0.66;
  return (
    <div className="glass-morphism reflective-card-container metric-panel" data-metric-card>
      <div className="metric-panel-head metric-panel-head-centered">
        <h3>Distance Reduction</h3>
      </div>
      <div className="donut-wrap">
        <div
          className="donut-ring"
          style={{
            background: `conic-gradient(
              #22c55e 0deg,
              #34d399 ${g1}deg,
              #6ee7b7 ${g2}deg,
              #86efac ${angle}deg,
              #22314d ${angle}deg 360deg
            )`,
          }}
        >
          <div className="donut-inner">
            <div className="donut-value">{value.toFixed(1)}%</div>
            <div className="donut-label">REDUCED</div>
          </div>
        </div>
        <div className="donut-meta">{asNumber(reducedKm, 0).toFixed(1)} km reduced</div>
      </div>
    </div>
  );
}

function CostBars({ series }) {
  const maxY = useMemo(() => {
    const vals = (series || []).flatMap((row) => [asNumber(row?.baselineCost, 0), asNumber(row?.optimizedCost, 0)]);
    return Math.max(1, ...vals);
  }, [series]);

  return (
    <div className="glass-morphism reflective-card-container metric-panel" data-metric-card>
      <div className="metric-panel-head">
        <h3>Cost Comparison (Before vs After)</h3>
      </div>
      <div className="bars-chart">
        {(series || []).map((row) => {
          const before = asNumber(row?.baselineCost, 0);
          const after = asNumber(row?.optimizedCost, 0);
          return (
            <div className="bars-month" key={`cost-${row?.label}`}>
              <div className="bars-pair">
                <div className="bar before" style={{ height: `${(before / maxY) * 100}%` }} />
                <div className="bar after" style={{ height: `${(after / maxY) * 100}%` }} />
              </div>
              <div className="bars-label">{row?.label || "-"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimeArea({ series }) {
  const points = useMemo(() => {
    const list = Array.isArray(series) ? series : [];
    if (!list.length) return "";
    const values = list.map((x) => asNumber(x?.value, 0));
    const maxY = Math.max(1, ...values);
    return list
      .map((row, idx) => {
        const x = (idx / Math.max(1, list.length - 1)) * 100;
        const y = 100 - ((asNumber(row?.value, 0) / maxY) * 85 + 8);
        return `${x},${y}`;
      })
      .join(" ");
  }, [series]);

  const labels = Array.isArray(series) ? series : [];

  return (
    <div className="glass-morphism reflective-card-container metric-panel" data-metric-card>
      <div className="metric-panel-head">
        <h3>Average Time Saved</h3>
        <span>Per ride</span>
      </div>
      <div className="line-chart">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(56,189,248,0.45)" />
              <stop offset="100%" stopColor="rgba(56,189,248,0.03)" />
            </linearGradient>
          </defs>
          {points ? (
            <>
              <polygon points={`0,100 ${points} 100,100`} fill="url(#areaFill)" />
              <polyline points={points} fill="none" stroke="#39c3ff" strokeWidth="1.2" />
            </>
          ) : null}
        </svg>
      </div>
      <div className="line-labels">
        {labels.map((row) => <span key={`t-${row?.label}`}>{row?.label || "-"}</span>)}
      </div>
    </div>
  );
}

function ProjectRides({ rows }) {
  const data = Array.isArray(rows) ? rows : [];
  return (
    <div className="glass-morphism reflective-card-container metric-panel" data-metric-card>
      <div className="metric-panel-head">
        <h3>Rides Optimized Per Project</h3>
        <span>Top projects</span>
      </div>
      <div className="project-list">
        {data.length ? data.map((row) => {
          const delta = asNumber(row?.deltaPct, 0);
          const tone = delta >= 0 ? "pos" : "neg";
          const badge = `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
          const name = String(row?.projectName || "Untitled");
          return (
            <div className="project-row" key={`proj-${row?.projectId || name}`}>
              <div className="project-avatar">{name.charAt(0).toUpperCase()}</div>
              <div className="project-name">{name}</div>
              <div className="project-rides">{asNumber(row?.rides, 0)}</div>
              <div className={`project-delta ${tone}`}>{badge}</div>
            </div>
          );
        }) : (
          <p className="metrics-empty">No completed project runs available.</p>
        )}
      </div>
    </div>
  );
}

function SideValueCard({ value, label, hint }) {
  return (
    <div className="glass-morphism reflective-card-container side-card" data-metric-card>
      <div className="side-value">{value}</div>
      <div className="side-label">{label}</div>
      <div className="side-hint">{hint}</div>
    </div>
  );
}

function SuccessCard({ successRate }) {
  const pct = Math.max(0, Math.min(100, asNumber(successRate, 0)));
  return (
    <div className="glass-morphism reflective-card-container success-card" data-metric-card>
      <div className="success-value">{Math.round(pct)}%</div>
      <div className="success-label">Success Rate</div>
      <div className="success-bar">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const MetricsPage = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [payload, setPayload] = useState(null);
  const pageRef = useRef(null);
  const hasAnimated = useRef(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const data = await getDashboardMetrics();
        if (!mounted) return;
        setPayload(data || null);
      } catch (err) {
        if (!mounted) return;
        setError(err?.response?.data?.message || err?.message || "Failed to load metrics");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, []);

  /* ── GSAP staggered entry animation ── */
  useLayoutEffect(() => {
    if (loading || error || hasAnimated.current || !pageRef.current) return;

    const cards = pageRef.current.querySelectorAll("[data-metric-card]");
    if (!cards.length) return;

    gsap.fromTo(
      cards,
      {
        opacity: 0,
        y: 120,
        filter: "blur(10px)",
      },
      {
        opacity: 1,
        y: 0,
        filter: "blur(0px)",
        duration: 0.8,
        ease: "power3.out",
        stagger: 0.06,
      }
    );

    hasAnimated.current = true;
  }, [loading, error]);

  /* ── Hover handlers ── */
  const handleCardEnter = (e) => {
    gsap.to(e.currentTarget, { scale: 0.97, duration: 0.3, ease: "power2.out" });
  };
  const handleCardLeave = (e) => {
    gsap.to(e.currentTarget, { scale: 1, duration: 0.3, ease: "power2.out" });
  };

  const k = payload?.kpis || {};
  const charts = payload?.charts || {};

  const kpis = [
    {
      title: "Total Savings",
      value: fmtMoney(k.totalSavings),
      hint: `${fmtPct(k.costSavingsPct)} cost reduction vs baseline`,
      accent: "teal",
    },
    {
      title: "Total Rides Optimized",
      value: fmtCompact(k.totalRidesOptimized),
      hint: `${fmtPct(k.feasibleRideRatePct)} rides feasible`,
      accent: "white",
    },
    {
      title: "Avg. Time Saved",
      value: fmtMinutes(k.avgTimeSavedPerRideMin),
      hint: `${fmtPct(k.timeSavingsPct)} faster overall`,
      accent: "cyan",
    },
  ];

  return (
    <div className="metrics-v2-page" ref={pageRef}>
      {loading ? <p className="metrics-empty">Loading live metrics...</p> : null}
      {error ? <p className="metrics-error">{error}</p> : null}

      {!loading && !error ? (
        <>
          <div className="kpi-grid">
            {kpis.map((item) => (
              <div key={item.title} onMouseEnter={handleCardEnter} onMouseLeave={handleCardLeave}>
                <KpiCard
                  title={item.title}
                  value={item.value}
                  hint={item.hint}
                  accent={item.accent}
                />
              </div>
            ))}
          </div>

          <div className="metrics-main-grid">
            <div onMouseEnter={handleCardEnter} onMouseLeave={handleCardLeave}>
              <DistanceDonut
                pct={charts?.distanceDonut?.reducedPct}
                reducedKm={charts?.distanceDonut?.reducedKm ?? k.distanceReducedKm}
              />
            </div>
            <div onMouseEnter={handleCardEnter} onMouseLeave={handleCardLeave}>
              <CostBars series={charts?.costComparison || []} />
            </div>
            <div className="right-stack">
              <div onMouseEnter={handleCardEnter} onMouseLeave={handleCardLeave}>
                <SideValueCard
                  value={Math.round(asNumber(k.efficiencyScore, 0))}
                  label="Efficiency Score"
                  hint="Weighted performance index"
                />
              </div>
              <div onMouseEnter={handleCardEnter} onMouseLeave={handleCardLeave}>
                <SideValueCard
                  value={fmtRuntimeSec(k.avgRuntimeSec)}
                  label="Runtime"
                  hint="Average solver run duration"
                />
              </div>
            </div>

            <div onMouseEnter={handleCardEnter} onMouseLeave={handleCardLeave}>
              <TimeArea series={charts?.averageTimeSavedTrend || []} />
            </div>
            <div onMouseEnter={handleCardEnter} onMouseLeave={handleCardLeave}>
              <ProjectRides rows={charts?.ridesPerProject || []} />
            </div>
            <div onMouseEnter={handleCardEnter} onMouseLeave={handleCardLeave}>
              <SuccessCard successRate={k.successRatePct} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
};

export default MetricsPage;

