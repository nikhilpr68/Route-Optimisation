import React, { useState } from 'react';
import LegendItem from './LegendItem';

function CostBreakdownPanel({ costData }) {
  const [openDetailCard, setOpenDetailCard] = useState(null);
  const kpis = [
    { label: 'Total Objective', value: costData.totalObjectiveLabel, detailKey: 'objective' },
    { label: 'Operational Cost', value: costData.operationalCostLabel, detailKey: 'operational' },
    { label: 'Total Time', value: costData.totalTimeLabel, detailKey: 'totalTime' },
    { label: 'Delay Time', value: costData.delayTimeLabel, detailKey: 'delayTime' },
  ];
  const vehicleStacks = costData.vehicleStacks;
  const delayByVehicleGraph = Array.isArray(costData.delayByVehicleGraph) ? costData.delayByVehicleGraph : [];
  const delayByEmployeeGraph = Array.isArray(costData.delayByEmployeeGraph) ? costData.delayByEmployeeGraph : [];
  const delayByEmployeeMaxMinutes = Number(costData.delayByEmployeeMaxMinutes) || 0;
  const pareto = Array.isArray(costData.paretoEmployees) ? costData.paretoEmployees : [];
  const topVehicleObjectives = Array.isArray(costData.topVehicleObjectives) ? costData.topVehicleObjectives : [];
  const vehicleObjectiveCount = Number(costData.vehicleObjectiveCount) || 0;
  const topVehicleOperationalCosts = Array.isArray(costData.topVehicleOperationalCosts) ? costData.topVehicleOperationalCosts : [];
  const vehicleOperationalCount = Number(costData.vehicleOperationalCount) || 0;
  const topVehicleDelayTimes = Array.isArray(costData.topVehicleDelayTimes) ? costData.topVehicleDelayTimes : [];
  const vehicleDelayTimeCount = Number(costData.vehicleDelayTimeCount) || 0;
  const topVehicleTotalTimes = Array.isArray(costData.topVehicleTotalTimes) ? costData.topVehicleTotalTimes : [];
  const vehicleTotalTimeCount = Number(costData.vehicleTotalTimeCount) || 0;
  const delayVehicleCount = delayByVehicleGraph.length;
  const hasAnyVehicleDelay = delayByVehicleGraph.some((row) => (Number(row.delayMinutes) || 0) > 0);
  const delayBarSlotWidth = delayVehicleCount > 80 ? 18 : 28;
  const delayBarWidth = delayVehicleCount > 80 ? 8 : 12;

  // Employee delay variables
  const delayEmployeeCount = delayByEmployeeGraph.length;
  const delayEmployeeBarWidth = 10;

  const detailContentByKey = {
    objective: {
      title: 'Vehicle Objective Contribution',
      rows: topVehicleObjectives.map((row) => ({ id: row.id, value: row.objectiveLabel })),
      totalCount: vehicleObjectiveCount,
      emptyText: 'No per-vehicle objective found.',
    },
    operational: {
      title: 'Vehicle Operational Cost',
      rows: topVehicleOperationalCosts.map((row) => ({ id: row.id, value: row.operationalLabel })),
      totalCount: vehicleOperationalCount,
      emptyText: 'No per-vehicle operational cost found.',
    },
    delayTime: {
      title: 'Vehicle Delay Time',
      rows: topVehicleDelayTimes.map((row) => ({ id: row.id, value: row.delayTimeLabel })),
      totalCount: vehicleDelayTimeCount,
      emptyText: 'No per-vehicle delay time found.',
    },
    totalTime: {
      title: 'Vehicle Total Time',
      rows: topVehicleTotalTimes.map((row) => ({ id: row.id, value: row.totalTimeLabel })),
      totalCount: vehicleTotalTimeCount,
      emptyText: 'No per-vehicle total time found.',
    },
  };

  return (
    <div style={{ display: 'grid', gap: 16, width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {kpis.map((item) => {
          if (item.detailKey) {
            const isOpen = openDetailCard === item.detailKey;
            const detail = detailContentByKey[item.detailKey];
            return (
              <div
                key={item.label}
                className="glass-morphism reflective-card-container"
                style={{
                  padding: 18,
                  position: 'relative',
                  cursor: 'pointer',
                  overflow: 'visible',
                  zIndex: isOpen ? 20 : 1,
                }}
                onPointerEnter={(e) => {
                  if (e.pointerType === 'mouse') setOpenDetailCard(item.detailKey);
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType === 'mouse') setOpenDetailCard((prev) => (prev === item.detailKey ? null : prev));
                }}
                onClick={() => setOpenDetailCard((prev) => (prev === item.detailKey ? null : item.detailKey))}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenDetailCard((prev) => (prev === item.detailKey ? null : item.detailKey));
                  }
                }}
              >
                <div style={{ opacity: 0.75, fontSize: '1rem' }}>{item.label}</div>
                <div style={{ marginTop: 6, fontSize: '2.6rem', fontWeight: 800, lineHeight: 1.1 }}>{item.value}</div>

                {isOpen ? (
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 8px)',
                      left: 0,
                      right: 0,
                      zIndex: 30,
                      borderRadius: 12,
                      border: '1px solid rgba(255,255,255,0.2)',
                      background: 'rgba(5,16,36,0.96)',
                      boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
                      padding: 12,
                    }}
                  >
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>{detail.title}</div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {detail.rows.map((row) => (
                        <div key={`${item.detailKey}-${row.id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                          <span style={{ opacity: 0.9 }}>{row.id}</span>
                          <span style={{ fontWeight: 700 }}>{row.value}</span>
                        </div>
                      ))}
                      {!detail.rows.length ? <div style={{ opacity: 0.72 }}>{detail.emptyText}</div> : null}
                    </div>
                    {detail.totalCount > detail.rows.length ? (
                      <div style={{ marginTop: 8, opacity: 0.7, fontSize: '0.78rem' }}>
                        Showing top {detail.rows.length} of {detail.totalCount} vehicles.
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          }

          return (
            <div key={item.label} className="glass-morphism reflective-card-container" style={{ padding: 18 }}>
              <div style={{ opacity: 0.75, fontSize: '1rem' }}>{item.label}</div>
              <div style={{ marginTop: 6, fontSize: '2.6rem', fontWeight: 800, lineHeight: 1.1 }}>{item.value}</div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <div className="glass-morphism reflective-card-container" style={{ padding: 18 }}>
          <h3 style={{ margin: 0, fontSize: '1.9rem', marginBottom: 12 }}>Stacked Cost per Vehicle</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            {vehicleStacks.map((row) => (
              <div key={row.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontWeight: 700 }}>{row.id}</span>
                  <span style={{ opacity: 0.88, fontWeight: 700 }}>{row.totalLabel}</span>
                </div>
                {(() => {
                  const opRaw = Number(row.op) || 0;
                  const delayRaw = Number(row.delay) || 0;
                  const denom = Math.max(1, opRaw + delayRaw);
                  const opPct = Math.max(0, (opRaw / denom) * 100);
                  const delayPct = Math.max(0, (delayRaw / denom) * 100);
                  return (
                    <div style={{ height: 18, borderRadius: 999, background: 'rgba(255,255,255,0.09)', overflow: 'hidden', display: 'flex' }}>
                      <div style={{ width: `${opPct}%`, background: '#3b82f6' }} />
                      <div style={{ width: `${delayPct}%`, background: '#f59e0b' }} />
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <LegendItem color="#3b82f6" label="Operational" />
            <LegendItem color="#f59e0b" label="Delay" />
          </div>
        </div>

        <div className="glass-morphism reflective-card-container" style={{ padding: 18 }}>
          <h3 style={{ margin: 0, fontSize: '1.9rem', marginBottom: 12 }}>Delay Distribution</h3>
          {delayEmployeeCount > 0 ? (
            <div
              className="timeline-scroll-shell"
              style={{
                height: 280,
                overflowX: 'hidden',
                overflowY: 'hidden',
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(255,255,255,0.03)',
                padding: '8px 8px 10px',
              }}
            >
              <div
                style={{
                  width: '100%',
                  minWidth: 0,
                  height: '100%',
                  display: 'grid',
                  gridTemplateColumns: `repeat(${delayEmployeeCount}, minmax(0, 1fr))`,
                  columnGap: 6,
                  alignItems: 'end',
                }}
              >
                {delayByEmployeeGraph.map((row) => (
                  <div key={`delay-emp-${row.id}`} style={{ width: '100%', display: 'grid', justifyItems: 'center', gap: 6 }}>
                    {(() => {
                      const delayMinutes = Number(row.delayMinutes) || 0;
                      const scaledHeight = Math.max(0, Math.round((Number(row.heightPct) || 0) * 2.2));
                      // Keep a visible baseline dot at zero delay, then grow with delay.
                      const visualHeight = delayMinutes > 0 ? (12 + scaledHeight) : 12;
                      return (
                        <div
                          style={{
                            width: delayEmployeeBarWidth,
                            height: `${visualHeight}px`,
                            borderRadius: 999,
                            background: '#be1e4f',
                          }}
                          title={`${row.id}: ${Number(delayMinutes || 0).toLocaleString('en-US', { maximumFractionDigits: 6 })} min (max ${Number(delayByEmployeeMaxMinutes || 0).toLocaleString('en-US', { maximumFractionDigits: 6 })} min)`}
                        />
                      );
                    })()}
                    <div
                      title={row.id}
                      style={{
                        width: '100%',
                        fontSize: '0.54rem',
                        lineHeight: 1,
                        textAlign: 'center',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        opacity: 0.82,
                      }}
                    >
                      {row.id}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ height: 220, display: 'grid', placeItems: 'center', opacity: 0.78 }}>
              No employees found in this testcase.
            </div>
          )}
        </div>

        <div className="glass-morphism reflective-card-container" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: '1.9rem' }}>Pareto Contributors</h3>
          </div>
          <div style={{
            display: 'grid',
            gap: 10,
            maxHeight: 220,
            overflowY: 'auto',
            paddingRight: 6,
          }}>
            {pareto.map((row) => (
              <div key={row.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span>{row.id}</span>
                  <span style={{ opacity: 0.9 }}>{row.costLabel || '—'}</span>
                </div>
                <div style={{ height: 12, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.max(0, Number(row.widthPct) || 0)}%`, height: '100%', background: '#be1e4f' }} />
                </div>
              </div>
            ))}
          </div>
          <p style={{ marginTop: 14, opacity: 0.72 }}>Top contributors to objective cost.</p>
        </div>
      </div>
    </div>
  );
}

export default CostBreakdownPanel;
