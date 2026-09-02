import React, { useMemo, useState } from 'react';
import { tableCell, tableHeadCell } from './constants';
import { displayValue, toHeaderLabel } from './helpers';
import { SanityCard } from './panel';

function DataOverviewSection({
  employees,
  vehicles,
  employeeQuery,
  onEmployeeQueryChange,
  employeeColumns,
  filteredEmployees,
  vehicleColumns,
  flattenedVehicles,
  baselineCost,
  baselineTimeMins,
  baselineArrayRows,
  baselineRows,
  baselineCostTotal,
  baselineTimeTotal,
  invalidCoordinatesCount,
  duplicateIdsCount,
  invalidTimeWindowCount,
  missingCapacityCount,
  distanceInfo,
  loadingData,
  parsedInput,
  diagnosticsErrors,
  diagnosticsWarnings,
}) {
  const [vehicleQuery, setVehicleQuery] = useState('');
  const [baselineQuery, setBaselineQuery] = useState('');
  const [sanityQuery, setSanityQuery] = useState('');
  const [diagnosticsQuery, setDiagnosticsQuery] = useState('');
  const EMPLOYEE_VISIBLE_LIMIT = 10;
  const VEHICLE_VISIBLE_LIMIT = 5;
  const BASELINE_VISIBLE_LIMIT = 10;
  const TABLE_HEADER_PX = 44;
  const TABLE_ROW_PX = 42;

  const searchInputStyle = {
    width: 220,
    height: 38,
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.2)',
    background: 'rgba(10,20,42,0.6)',
    color: 'white',
    padding: '0 12px',
    outline: 'none',
  };
  const cappedHeadCellStyle = {
    ...tableHeadCell,
    height: `${TABLE_HEADER_PX}px`,
    boxSizing: 'border-box',
    padding: '10px 10px',
    lineHeight: '20px',
    whiteSpace: 'nowrap',
  };
  const cappedBodyCellStyle = {
    ...tableCell,
    height: `${TABLE_ROW_PX}px`,
    boxSizing: 'border-box',
    padding: '10px 10px',
    lineHeight: '20px',
    whiteSpace: 'nowrap',
  };

  const normalizedVehicleQuery = vehicleQuery.trim().toLowerCase();
  const filteredVehicleRows = useMemo(() => {
    if (!normalizedVehicleQuery) return flattenedVehicles;
    return flattenedVehicles.filter((row) => vehicleColumns.some((col) => (
      String(displayValue(row?.[col])).toLowerCase().includes(normalizedVehicleQuery)
    )));
  }, [flattenedVehicles, vehicleColumns, normalizedVehicleQuery]);

  const normalizedBaselineQuery = baselineQuery.trim().toLowerCase();
  const filteredBaselineArrayRows = useMemo(() => {
    if (!normalizedBaselineQuery) return baselineArrayRows;
    return baselineArrayRows.filter((row) => (
      String(displayValue(row.employeeId)).toLowerCase().includes(normalizedBaselineQuery)
      || String(displayValue(row.baselineCost)).toLowerCase().includes(normalizedBaselineQuery)
      || String(displayValue(row.baselineTimeMin)).toLowerCase().includes(normalizedBaselineQuery)
    ));
  }, [baselineArrayRows, normalizedBaselineQuery]);

  const filteredBaselineRows = useMemo(() => {
    if (!normalizedBaselineQuery) return baselineRows;
    return baselineRows.filter((row) => (
      String(toHeaderLabel(row.key)).toLowerCase().includes(normalizedBaselineQuery)
      || String(row.value ?? '').toLowerCase().includes(normalizedBaselineQuery)
    ));
  }, [baselineRows, normalizedBaselineQuery]);

  const sanityItems = useMemo(() => ([
    { label: 'Invalid coordinates', value: invalidCoordinatesCount, tone: invalidCoordinatesCount ? 'danger' : 'ok' },
    { label: 'Duplicate IDs', value: duplicateIdsCount, tone: duplicateIdsCount ? 'warning' : 'ok' },
    { label: 'Invalid time windows', value: invalidTimeWindowCount, tone: invalidTimeWindowCount ? 'warning' : 'ok' },
    { label: 'Missing capacity', value: missingCapacityCount, tone: missingCapacityCount ? 'warning' : 'ok' },
  ]), [invalidCoordinatesCount, duplicateIdsCount, invalidTimeWindowCount, missingCapacityCount]);

  const normalizedSanityQuery = sanityQuery.trim().toLowerCase();
  const filteredSanityItems = useMemo(() => {
    if (!normalizedSanityQuery) return sanityItems;
    return sanityItems.filter((item) => item.label.toLowerCase().includes(normalizedSanityQuery));
  }, [sanityItems, normalizedSanityQuery]);

  const normalizedDiagnosticsQuery = diagnosticsQuery.trim().toLowerCase();
  const filteredDiagnosticsErrors = useMemo(() => {
    if (!normalizedDiagnosticsQuery) return diagnosticsErrors;
    return diagnosticsErrors.filter((item) => String(item).toLowerCase().includes(normalizedDiagnosticsQuery));
  }, [diagnosticsErrors, normalizedDiagnosticsQuery]);

  const filteredDiagnosticsWarnings = useMemo(() => {
    if (!normalizedDiagnosticsQuery) return diagnosticsWarnings;
    return diagnosticsWarnings.filter((item) => String(item).toLowerCase().includes(normalizedDiagnosticsQuery));
  }, [diagnosticsWarnings, normalizedDiagnosticsQuery]);

  const buildScrollableTableStyle = (rowCount, limit) => {
    const exceeds = rowCount > limit;
    return {
      overflowX: 'auto',
      overflowY: exceeds ? 'auto' : 'visible',
      maxHeight: exceeds ? `${TABLE_HEADER_PX + (TABLE_ROW_PX * limit)}px` : 'none',
    };
  };

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: 'min(860px, 100%)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
          {[
            { label: 'Total Employees', value: employees.length || 0 },
            { label: 'Total Vehicles', value: vehicles.length || 0 },
            {
              label: 'Distance Backend',
              value: distanceInfo?.backendLabel || distanceInfo?.metricLabel || '—',
              meta: distanceInfo?.strictRoad === true
                ? 'Strict road mode'
                : (distanceInfo?.strictRoad === false ? 'Road fallback enabled' : ''),
            },
          ].map((item) => (
            <div key={item.label} className="glass-morphism reflective-card-container" style={{ padding: '14px 16px', textAlign: 'center' }}>
              <div style={{ opacity: 0.7, fontSize: '0.9rem' }}>{item.label}</div>
              <div style={{ marginTop: 4, fontSize: '2rem', fontWeight: 800, lineHeight: 1.1 }}>{item.value}</div>
              {item.meta ? (
                <div style={{ marginTop: 4, opacity: 0.72, fontSize: '0.75rem' }}>{item.meta}</div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="glass-morphism reflective-card-container" style={{ padding: '18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: '2rem' }}>Employees</h2>
          <input
            type="text"
            placeholder="Search employees"
            value={employeeQuery}
            onChange={(e) => onEmployeeQueryChange(e.target.value)}
            style={searchInputStyle}
          />
        </div>
        <div style={buildScrollableTableStyle(filteredEmployees.length, EMPLOYEE_VISIBLE_LIMIT)}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {employeeColumns.map((col) => (
                  <th key={col} style={cappedHeadCellStyle}>{toHeaderLabel(col)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredEmployees.map((row, idx) => (
                <tr key={row?.displayId || row?.display_id || row?.normalizedId || row?.id || `row-${idx}`}>
                  {employeeColumns.map((col) => (
                    <td key={`${row?.displayId || row?.display_id || row?.normalizedId || row?.id || idx}-${col}`} style={cappedBodyCellStyle}>
                      {displayValue(row?.[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="glass-morphism reflective-card-container" style={{ padding: '18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: '2rem' }}>Vehicles</h2>
          <input
            type="text"
            placeholder="Search vehicles"
            value={vehicleQuery}
            onChange={(e) => setVehicleQuery(e.target.value)}
            style={searchInputStyle}
          />
        </div>
        <div style={buildScrollableTableStyle(filteredVehicleRows.length, VEHICLE_VISIBLE_LIMIT)}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {vehicleColumns.map((col) => (
                  <th key={col} style={cappedHeadCellStyle}>{toHeaderLabel(col)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredVehicleRows.map((row, idx) => (
                <tr key={row?.displayId || row?.display_id || row?.normalizedId || row?.id || `vehicle-${idx}`}>
                  {vehicleColumns.map((col) => (
                    <td key={`${row?.displayId || row?.display_id || row?.normalizedId || row?.id || idx}-${col}`} style={cappedBodyCellStyle}>
                      {displayValue(row?.[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {normalizedVehicleQuery && !filteredVehicleRows.length ? (
            <p style={{ opacity: 0.75, marginTop: 10 }}>No matching vehicles found.</p>
          ) : null}
        </div>
      </div>

      <div className="glass-morphism reflective-card-container" style={{ padding: '18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: '2rem' }}>Baseline</h2>
          <input
            type="text"
            placeholder="Search baseline"
            value={baselineQuery}
            onChange={(e) => setBaselineQuery(e.target.value)}
            style={searchInputStyle}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div style={{ border: '1px solid rgba(255,255,255,0.14)', borderRadius: 12, background: 'rgba(255,255,255,0.03)', padding: '12px 14px' }}>
            <div style={{ opacity: 0.75, fontSize: '0.84rem' }}>Total Baseline Cost</div>
            <div style={{ marginTop: 4, fontSize: '1.35rem', fontWeight: 800 }}>
              {baselineCost == null ? '\u2014' : `\u20B9${Math.round(baselineCost).toLocaleString('en-IN')}`}
            </div>
          </div>
          <div style={{ border: '1px solid rgba(255,255,255,0.14)', borderRadius: 12, background: 'rgba(255,255,255,0.03)', padding: '12px 14px' }}>
            <div style={{ opacity: 0.75, fontSize: '0.84rem' }}>Total Baseline Time</div>
            <div style={{ marginTop: 4, fontSize: '1.35rem', fontWeight: 800 }}>
              {baselineTimeMins == null ? '\u2014' : `${Math.round(baselineTimeMins)} min`}
            </div>
          </div>
        </div>
        <div
          style={buildScrollableTableStyle(
            baselineArrayRows.length ? filteredBaselineArrayRows.length : filteredBaselineRows.length,
            BASELINE_VISIBLE_LIMIT
          )}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {baselineArrayRows.length ? (
                  <>
                    <th style={cappedHeadCellStyle}>Employee ID</th>
                    <th style={cappedHeadCellStyle}>Baseline Cost</th>
                    <th style={cappedHeadCellStyle}>Baseline Time (min)</th>
                  </>
                ) : (
                  <>
                    <th style={cappedHeadCellStyle}>Field</th>
                    <th style={cappedHeadCellStyle}>Value</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {baselineArrayRows.length ? (
                <>
                  {filteredBaselineArrayRows.map((row, idx) => (
                    <tr key={`baseline-row-${row.index}`} style={{ background: idx % 2 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                      <td style={cappedBodyCellStyle}>{displayValue(row.employeeId)}</td>
                      <td style={cappedBodyCellStyle}>{displayValue(row.baselineCost)}</td>
                      <td style={cappedBodyCellStyle}>{displayValue(row.baselineTimeMin)}</td>
                    </tr>
                  ))}
                  {!normalizedBaselineQuery ? (
                    <tr style={{ background: 'rgba(59,130,246,0.12)' }}>
                      <td style={{ ...cappedBodyCellStyle, fontWeight: 800 }}>Total</td>
                      <td style={{ ...cappedBodyCellStyle, fontWeight: 800 }}>{baselineCostTotal}</td>
                      <td style={{ ...cappedBodyCellStyle, fontWeight: 800 }}>{baselineTimeTotal}</td>
                    </tr>
                  ) : null}
                </>
              ) : filteredBaselineRows.length ? filteredBaselineRows.map((row, idx) => (
                <tr key={row.key} style={{ background: idx % 2 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                  <td style={cappedBodyCellStyle}>{toHeaderLabel(row.key)}</td>
                  <td style={cappedBodyCellStyle}>{row.value}</td>
                </tr>
              )) : (
                <tr>
                  <td style={cappedBodyCellStyle} colSpan={2}>No baseline data in parsed output.</td>
                </tr>
              )}
            </tbody>
          </table>
          {normalizedBaselineQuery && !filteredBaselineArrayRows.length && !filteredBaselineRows.length ? (
            <p style={{ opacity: 0.75, marginTop: 10 }}>No matching baseline entries found.</p>
          ) : null}
        </div>
      </div>

      <div className="glass-morphism reflective-card-container" style={{ padding: '18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: '2rem' }}>Input Sanity Checks</h2>
          <input
            type="text"
            placeholder="Search checks"
            value={sanityQuery}
            onChange={(e) => setSanityQuery(e.target.value)}
            style={searchInputStyle}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {filteredSanityItems.map((item) => (
            <SanityCard
              key={item.label}
              label={item.label}
              count={item.value}
              tone={item.tone}
            />
          ))}
        </div>
        {normalizedSanityQuery && !filteredSanityItems.length ? (
          <p style={{ opacity: 0.75, marginTop: 10 }}>No matching sanity checks found.</p>
        ) : null}
        {loadingData ? <p style={{ opacity: 0.7, marginTop: 10 }}>Loading data overview...</p> : null}
        {!loadingData && !parsedInput ? (
          <p style={{ opacity: 0.78, marginTop: 10 }}>No parsed input yet. Parse testcase first.</p>
        ) : null}
        {diagnosticsWarnings.length ? (
          <p style={{ opacity: 0.7, marginTop: 10, fontSize: '0.88rem' }}>
            Parser warnings: {diagnosticsWarnings.length}
          </p>
        ) : null}
      </div>

      <div className="glass-morphism reflective-card-container" style={{ padding: '18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: '2rem' }}>Parsing Diagnostics</h2>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <span style={{
              display: 'inline-flex',
              padding: '6px 14px',
              borderRadius: 999,
              border: '1px solid rgba(244,114,182,0.45)',
              background: 'rgba(244,114,182,0.12)',
              color: '#f9a8d4',
              fontWeight: 800,
            }}>
              Errors
            </span>
            <ul style={{ margin: '10px 0 0 20px', color: '#f9a8d4', fontSize: '1.05rem', lineHeight: 1.6 }}>
              {(filteredDiagnosticsErrors.length ? filteredDiagnosticsErrors : ['No errors']).map((item, idx) => (
                <li key={`missing-${idx}`}>{String(item)}</li>
              ))}
            </ul>
          </div>

          <div>
            <span style={{
              display: 'inline-flex',
              padding: '6px 14px',
              borderRadius: 999,
              border: '1px solid rgba(250,204,21,0.45)',
              background: 'rgba(250,204,21,0.11)',
              color: '#fde047',
              fontWeight: 800,
            }}>
              Warnings
            </span>
            <ul style={{ margin: '10px 0 0 20px', color: '#fde047', fontSize: '1.05rem', lineHeight: 1.6 }}>
              {(filteredDiagnosticsWarnings.length ? filteredDiagnosticsWarnings : ['No warnings']).map((item, idx) => (
                <li key={`warning-${idx}`}>{String(item)}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DataOverviewSection;
