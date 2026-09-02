import React, { useCallback, useEffect, useState } from 'react';
import { getResults, startRunValidation } from '../../../../api/api';
import { tableCell, tableHeadCell } from '../constants';
import { parseNumericLike } from '../helpers';

function normalizeSolutionStatus(rawStatus, feasibleFlag, unassignedCount) {
  const normalized = String(rawStatus || '').trim().toLowerCase();
  if (['feasible', 'partial', 'infeasible'].includes(normalized)) return normalized;
  if (feasibleFlag === false) return 'infeasible';
  if (Number.isFinite(unassignedCount) && unassignedCount > 0) return 'partial';
  return 'feasible';
}

function formatSolutionStatus(status) {
  if (status === 'not_run') return 'Not Run';
  if (status === 'infeasible') return 'Infeasible';
  if (status === 'partial') return 'Partial';
  return 'Feasible';
}

function solutionStatusColor(status) {
  if (status === 'not_run') return '#94a3b8';
  if (status === 'infeasible') return '#fca5a5';
  if (status === 'partial') return '#fde68a';
  return '#6ee7b7';
}

function formatObjective(value) {
  if (!Number.isFinite(value)) return '—';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ConstraintsPanel({
  rides = [],
  employees = [],
  resultPayload = null,
  projectId,
  initialValidationResult = null,
  readOnly = false
}) {
  const [expandedViolations, setExpandedViolations] = useState({});
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(initialValidationResult);
  const [lastChecked, setLastChecked] = useState(null);

  useEffect(() => {
    setValidationResult(initialValidationResult);
  }, [initialValidationResult]);

  // Poll for validation results
  useEffect(() => {
    if (readOnly) return undefined;
    if (validating && projectId) {
      const interval = setInterval(async () => {
        try {
          const result = await getResults(projectId);
          if (result?.runValidation?.status !== 'Running') {
            setValidationResult(result.runValidation);
            setValidating(false);
            setLastChecked(new Date());
            clearInterval(interval);
          }
        } catch (err) {
          console.error('Error polling validation:', err);
        }
      }, 2000);
      return () => clearInterval(interval);
    }
  }, [validating, projectId, readOnly]);

  const loadValidationResult = useCallback(async () => {
    try {
      const result = await getResults(projectId);
      if (result?.runValidation) {
        setValidationResult(result.runValidation);
        setLastChecked(new Date());
      }
    } catch (err) {
      console.error('Error loading validation:', err);
    }
  }, [projectId]);

  // Load existing validation result on mount
  useEffect(() => {
    if (readOnly) return;
    if (projectId) {
      loadValidationResult();
    }
  }, [projectId, readOnly, loadValidationResult]);

  const handleRunValidation = async () => {
    if (!projectId) {
      alert('No project ID available');
      return;
    }

    setValidating(true);
    setValidationResult(null);
    setLastChecked(null);
    try {
      await startRunValidation(projectId);
    } catch (err) {
      alert('Failed to start validation: ' + (err.response?.data?.message || err.message));
      setValidating(false);
    }
  };

  const checks = validationResult?.checks || [];
  const passed = checks.filter((c) => c.status === 'Pass' || c.status === 'pass' || c.passed === true).length;
  const failed = checks.filter((c) => c.status === 'Fail' || c.status === 'fail' || c.passed === false).length;
  const warnings = checks.filter((c) => c.status === 'Warning' || c.status === 'warning').length;

  // Calculate route and assignment statistics.
  const normalizeEmployeeId = (value) => {
    if (value && typeof value === 'object') {
      const raw = value.employeeId ?? value.id ?? value.empId ?? value.employee_id ?? value.emp_id;
      return String(raw || '').trim();
    }
    return String(value || '').trim();
  };
  const isRideFeasible = (ride) => {
    const hasViolation =
      Boolean(ride?.violation)
      || (ride?.violationDetails && Object.keys(ride.violationDetails).length > 0)
      || (Array.isArray(ride?.violations) && ride.violations.length > 0)
      || (Array.isArray(ride?.consistencyErrors) && ride.consistencyErrors.length > 0);
    return ride?.feasible !== false && !hasViolation;
  };
  const getRideEmployeeIds = (ride) => {
    const assignedFromRide = Array.isArray(ride?.assignedEmployees)
      ? ride.assignedEmployees
      : [];
    const assignedFromPath = Array.isArray(ride?.path)
      ? ride.path
        .filter((stop) => String(stop?.type || '').toLowerCase() === 'pickup')
        .map((stop) => stop?.employeeId)
      : [];
    const source = assignedFromRide.length > 0 ? assignedFromRide : assignedFromPath;
    return [...new Set(source.map((value) => String(value || '').trim()).filter(Boolean))];
  };

  const totalRoutes = rides.length;
  const feasibleRoutes = rides.filter((ride) => isRideFeasible(ride)).length;
  const infeasibleRoutes = totalRoutes - feasibleRoutes;
  const violatedRoutes = rides.filter((ride) => !isRideFeasible(ride)).length;

  const assignmentFeasibilityByEmployee = rides.reduce((acc, ride) => {
    const employeeIds = getRideEmployeeIds(ride);
    if (!employeeIds.length) return acc;
    const rideFeasible = isRideFeasible(ride);
    employeeIds.forEach((employeeId) => {
      if (!(employeeId in acc)) {
        acc[employeeId] = rideFeasible;
        return;
      }
      if (!rideFeasible) {
        acc[employeeId] = false;
      }
    });
    return acc;
  }, {});

  const parsedEmployees = Array.isArray(employees) ? employees : [];
  const hasParsedEmployeeList = parsedEmployees.length > 0;
  const unassignedEmployeeIds = new Set(
    (Array.isArray(resultPayload?.unassigned) ? resultPayload.unassigned : [])
      .map((value) => normalizeEmployeeId(value))
      .filter(Boolean)
  );
  const discoveredEmployeeIds = new Set([
    ...Object.keys(assignmentFeasibilityByEmployee),
    ...unassignedEmployeeIds
  ]);
  const totalAssignments = hasParsedEmployeeList
    ? parsedEmployees.length
    : discoveredEmployeeIds.size;
  const feasibleAssignments = hasParsedEmployeeList
    ? parsedEmployees.reduce((count, employee) => {
      const employeeId = normalizeEmployeeId(employee?.id);
      if (!employeeId) return count;
      return (assignmentFeasibilityByEmployee[employeeId] === true && !unassignedEmployeeIds.has(employeeId))
        ? count + 1
        : count;
    }, 0)
    : Array.from(discoveredEmployeeIds).filter((employeeId) => (
      assignmentFeasibilityByEmployee[employeeId] === true && !unassignedEmployeeIds.has(employeeId)
    )).length;
  const infeasibleAssignments = totalAssignments - feasibleAssignments;
  const feasibleUnits = feasibleRoutes + feasibleAssignments;
  const totalUnits = totalRoutes + totalAssignments;
  const overallFeasibility = totalUnits > 0 ? Math.round((feasibleUnits / totalUnits) * 100) : 0;
  const assignmentFeasibility = totalAssignments > 0 ? Math.round((feasibleAssignments / totalAssignments) * 100) : 0;
  const conditionViolations = violatedRoutes + failed;
  const infeasibilityRate = totalUnits > 0 ? Math.round(((infeasibleRoutes + infeasibleAssignments) / totalUnits) * 100) : 0;
  const hasSolutionSnapshot = Boolean(resultPayload) || totalRoutes > 0;
  const unassignedCount = parseNumericLike(
    resultPayload?.unassignedCount
    ?? resultPayload?.unassigned?.length
    ?? unassignedEmployeeIds.size
  ) ?? unassignedEmployeeIds.size;
  const solutionStatus = hasSolutionSnapshot
    ? normalizeSolutionStatus(resultPayload?.status, resultPayload?.feasible !== false, unassignedCount)
    : 'not_run';
  const solutionObjectiveScore = parseNumericLike(resultPayload?.objectiveScore);
  const topLevelViolations = [
    ...(Array.isArray(resultPayload?.violations) ? resultPayload.violations : []),
    ...(Array.isArray(resultPayload?.consistencyErrors) ? resultPayload.consistencyErrors : []),
  ].filter(Boolean);
  const hasAnyInfeasibility =
    solutionStatus === 'infeasible'
    || solutionStatus === 'partial'
    || infeasibleRoutes > 0
    || infeasibleAssignments > 0
    || failed > 0;

  // Group violations by type
  const violationsByType = rides.reduce((acc, ride) => {
    if (isRideFeasible(ride)) return acc;
    
    const type = ride.violationDetails?.type || 'unknown';
    if (!acc[type]) {
      acc[type] = [];
    }
    acc[type].push(ride);
    return acc;
  }, {});

  const violationTypeLabels = {
    capacity: 'Capacity Violations',
    time_window: 'Time Window Violations',
    premium: 'Premium Vehicle Violations',
    sharing: 'Sharing Preference Violations',
    precedence: 'Precedence Violations',
    empty_route: 'Empty Route Violations',
    unknown: 'Other Violations'
  };

  const formatRouteStopChain = (ride) => {
    const path = Array.isArray(ride?.path) ? ride.path : [];
    if (!path.length) return 'No path available';
    return path
      .map((stop) => {
        const type = String(stop?.type || '').toLowerCase();
        const tag = type === 'pickup' ? 'P' : (type === 'dropoff' || type === 'drop' ? 'D' : 'M');
        const emp = String(stop?.employeeId || '-');
        return `${tag}:${emp}`;
      })
      .join(' -> ');
  };

  const toggleViolation = (type) => {
    setExpandedViolations(prev => ({
      ...prev,
      [type]: !prev[type]
    }));
  };

  const overallStatus = validationResult?.status || 'Not Run';
  const statusColor =
    overallStatus === 'Passed' ? '#6ee7b7' :
    overallStatus === 'Failed' ? '#fca5a5' :
    overallStatus === 'Running' ? '#fde68a' : '#94a3b8';

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <div className="glass-morphism reflective-card-container" style={{ padding: 16 }}>
          <div style={{ opacity: 0.74, fontSize: '0.9rem', marginBottom: 8 }}>Solution Feasibility</div>
          <div style={{
            fontSize: '2.4rem',
            fontWeight: 900,
            lineHeight: 1,
            color: solutionStatusColor(solutionStatus),
          }}>
            {formatSolutionStatus(solutionStatus)}
          </div>
          <div style={{
            marginTop: 8,
            fontSize: '0.85rem',
            opacity: 0.7,
          }}>
            {solutionStatus === 'not_run'
              ? 'Run the solver to populate solution status'
              : `Routes: ${feasibleRoutes}/${totalRoutes || 0} • Assignments: ${feasibleAssignments}/${totalAssignments || 0}`}
          </div>
          <div style={{
            marginTop: 8,
            height: 6,
            borderRadius: 999,
            background: 'rgba(255,255,255,0.1)',
            overflow: 'hidden'
          }}>
            <div style={{
              height: '100%',
              width: solutionStatus === 'feasible' ? '100%' : solutionStatus === 'partial' ? '60%' : solutionStatus === 'infeasible' ? '28%' : '0%',
              background: solutionStatusColor(solutionStatus),
              transition: 'width 0.5s ease'
            }} />
          </div>
        </div>
        <div className="glass-morphism reflective-card-container" style={{ padding: 16 }}>
          <div style={{ opacity: 0.74, fontSize: '0.9rem' }}>Objective Score</div>
          <div style={{ marginTop: 6, fontSize: '2.2rem', fontWeight: 800, color: '#6ee7b7' }}>
            {formatObjective(solutionObjectiveScore)}
          </div>
          <div style={{ marginTop: 8, opacity: 0.7, fontSize: '0.85rem' }}>
            {Number.isFinite(solutionObjectiveScore) ? 'Shown even when the solution is infeasible' : 'Objective not available yet'}
          </div>
        </div>
        <div className="glass-morphism reflective-card-container" style={{ padding: 16 }}>
          <div style={{ opacity: 0.74, fontSize: '0.9rem' }}>Feasible Assignments</div>
          <div style={{ marginTop: 6, fontSize: '2.2rem', fontWeight: 800, color: '#6ee7b7' }}>
            {feasibleAssignments} / {totalAssignments}
          </div>
          <div style={{ marginTop: 8, opacity: 0.7, fontSize: '0.85rem' }}>
            {totalAssignments > 0 ? `${assignmentFeasibility}% of employees are feasible` : 'No assignments available'}
          </div>
        </div>
        <div className="glass-morphism reflective-card-container" style={{ padding: 16 }}>
          <div style={{ opacity: 0.74, fontSize: '0.9rem' }}>No. of Violations of Conditions</div>
          <div style={{ marginTop: 6, fontSize: '2.2rem', fontWeight: 800, color: conditionViolations > 0 ? '#fca5a5' : '#6ee7b7' }}>
            {conditionViolations}
          </div>
          <div style={{ marginTop: 8, opacity: 0.7, fontSize: '0.85rem' }}>
            {conditionViolations > 0
              ? `${failed} failed checks + ${violatedRoutes} route violations`
              : `${infeasibilityRate}% infeasibility rate`}
          </div>
        </div>
      </div>

      {(topLevelViolations.length > 0 || (hasSolutionSnapshot && solutionStatus !== 'feasible' && solutionStatus !== 'not_run')) ? (
        <div className="glass-morphism reflective-card-container" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: '1.4rem' }}>Overall Solution Status</h3>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              borderRadius: 999,
              padding: '6px 12px',
              border: `1px solid ${solutionStatus === 'feasible' ? 'rgba(110,231,183,0.35)' : solutionStatus === 'partial' ? 'rgba(253,224,71,0.35)' : 'rgba(252,165,165,0.35)'}`,
              background: solutionStatus === 'feasible' ? 'rgba(16,185,129,0.12)' : solutionStatus === 'partial' ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)',
              color: solutionStatusColor(solutionStatus),
              fontWeight: 800,
            }}>
              {formatSolutionStatus(solutionStatus)}
            </div>
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ opacity: 0.9, fontSize: '0.95rem' }}>
              Objective Score: <span style={{ fontWeight: 800, color: 'white' }}>{formatObjective(solutionObjectiveScore)}</span>
            </div>
            {unassignedCount > 0 ? (
              <div style={{ opacity: 0.85, fontSize: '0.92rem' }}>
                Unassigned Employees: {unassignedCount}
              </div>
            ) : null}
            {topLevelViolations.length > 0 ? (
              <div style={{
                padding: 12,
                borderRadius: 10,
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.18)',
              }}>
                <div style={{ fontSize: '0.92rem', fontWeight: 700, marginBottom: 8, color: '#fca5a5' }}>
                  Solution-level violations
                </div>
                <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
                  {topLevelViolations.map((item, idx) => (
                    <li key={`${item}-${idx}`} style={{ opacity: 0.94 }}>
                      {String(item)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div style={{ opacity: 0.78, fontSize: '0.9rem' }}>
                No additional solution-level violation strings were recorded.
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Violations by Type */}
      {Object.keys(violationsByType).length > 0 ? (
        <div className="glass-morphism reflective-card-container" style={{ padding: 18 }}>
          <h3 style={{ margin: 0, fontSize: '1.4rem', marginBottom: 14 }}>Violations by Type</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            {Object.entries(violationsByType).map(([type, violations]) => (
              <div key={type} style={{
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 12,
                background: 'rgba(239,68,68,0.05)',
                overflow: 'hidden'
              }}>
                {/* Violation Type Header */}
                <button
                  type="button"
                  onClick={() => toggleViolation(type)}
                  style={{
                    width: '100%',
                    padding: '14px 16px',
                    background: 'rgba(239,68,68,0.1)',
                    border: 'none',
                    color: 'white',
                    fontSize: '1.05rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    textAlign: 'left'
                  }}
                >
                  <span>{violationTypeLabels[type] || type}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{
                      padding: '4px 12px',
                      borderRadius: 999,
                      background: 'rgba(239,68,68,0.3)',
                      fontSize: '0.9rem',
                      fontWeight: 800
                    }}>
                      {violations.length}
                    </span>
                    <span style={{ fontSize: '1.2rem' }}>
                      {expandedViolations[type] ? '▼' : '▶'}
                    </span>
                  </div>
                </button>

                {/* Violation Details */}
                {expandedViolations[type] && (
                  <div style={{ padding: '12px 16px' }}>
                    {violations.map((ride, idx) => (
                      <div key={`${ride.vehicleId}-${idx}`} style={{
                        marginBottom: idx < violations.length - 1 ? 12 : 0,
                        padding: 14,
                        borderRadius: 10,
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.1)'
                      }}>
                        {/* Vehicle and Employees */}
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 6 }}>
                            Vehicle: {ride.vehicleId}
                          </div>
                          <div style={{ opacity: 0.85, fontSize: '0.95rem' }}>
                            Assigned Employees: {Array.isArray(ride.assignedEmployees) 
                              ? ride.assignedEmployees.join(', ') 
                              : 'None'}
                          </div>
                        </div>

                        {/* Violation Details */}
                        {ride.violationDetails && Object.keys(ride.violationDetails).length > 0 ? (
                          <div style={{
                            padding: 12,
                            borderRadius: 8,
                            background: 'rgba(0,0,0,0.2)',
                            border: '1px solid rgba(255,255,255,0.08)'
                          }}>
                            <div style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: 8, color: '#fca5a5' }}>
                              Constraint Broken:
                            </div>
                            <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
                              {ride.violationDetails.message && (
                                <li style={{ opacity: 0.95 }}>{ride.violationDetails.message}</li>
                              )}
                              {ride.violationDetails.expected && (
                                <li style={{ opacity: 0.9 }}>
                                  Expected: {ride.violationDetails.expected}
                                </li>
                              )}
                              {ride.violationDetails.actual && (
                                <li style={{ opacity: 0.9 }}>
                                  Actual: {ride.violationDetails.actual}
                                </li>
                              )}
                              {ride.violationDetails.employeeId && (
                                <li style={{ opacity: 0.9 }}>
                                  Affected Employee: {ride.violationDetails.employeeId}
                                </li>
                              )}
                              {ride.violationDetails.delayMinutes !== undefined && (
                                <li style={{ opacity: 0.9 }}>
                                  Delay: {ride.violationDetails.delayMinutes} minutes
                                </li>
                              )}
                            </ul>
                          </div>
                        ) : (
                          <div style={{ opacity: 0.7, fontSize: '0.9rem', fontStyle: 'italic' }}>
                            {ride.violation || 'No detailed violation information available'}
                          </div>
                        )}

                        <div style={{
                          marginTop: 10,
                          padding: 10,
                          borderRadius: 8,
                          background: 'rgba(15,23,42,0.32)',
                          border: '1px solid rgba(255,255,255,0.1)'
                        }}>
                          <div style={{ fontSize: '0.82rem', opacity: 0.72, marginBottom: 4 }}>Actual Route Stop Order</div>
                          <div style={{ fontSize: '0.85rem', fontFamily: 'monospace', lineHeight: 1.55 }}>
                            {formatRouteStopChain(ride)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="glass-morphism reflective-card-container" style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: '3rem', marginBottom: 12 }}>
            {hasAnyInfeasibility ? '⚠️' : '✅'}
          </div>
          <div style={{
            fontSize: '1.3rem',
            fontWeight: 700,
            marginBottom: 8,
            color: hasAnyInfeasibility ? '#fca5a5' : '#6ee7b7'
          }}>
            {hasAnyInfeasibility ? 'Not Feasible' : 'No Violations Found'}
          </div>
          <p style={{ opacity: 0.7, fontSize: '0.95rem', margin: 0 }}>
            {solutionStatus === 'partial'
              ? 'All displayed routes are feasible, but the overall solution is partial because some employees are unassigned.'
              : solutionStatus === 'infeasible'
                ? `${infeasibleAssignments} infeasible assignments, ${infeasibleRoutes} infeasible routes${failed > 0 ? `, ${failed} failed checks` : ''}`
                : 'All routes and assignments satisfy the constraints and are feasible'}
          </p>
        </div>
      )}

      {/* No Data Message */}
      {totalRoutes === 0 && (
        <div className="glass-morphism reflective-card-container" style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ opacity: 0.7, fontSize: '1.1rem', marginBottom: 12 }}>
            No route data available
          </div>
          <p style={{ opacity: 0.6, fontSize: '0.95rem', margin: 0 }}>
            Run the solver first to see constraint violations
          </p>
        </div>
      )}

      {/* Validation Section */}
      <div className="glass-morphism reflective-card-container" style={{ padding: '24px 28px', borderRadius: 18, marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 800 }}>Run Validation</h3>
            <p style={{ margin: '6px 0 0 0', opacity: 0.75, fontSize: '0.95rem' }}>
              {readOnly
                ? 'This shared page shows the latest validation snapshot from the owner.'
                : 'Validate solver output for feasibility, consistency, and quality checks'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            {lastChecked && (
              <span style={{ opacity: 0.65, fontSize: '0.9rem', fontWeight: 600 }}>
                Last checked: {lastChecked.toLocaleTimeString()}
              </span>
            )}
            {!readOnly ? (
              <button
                type="button"
                style={{
                  padding: '12px 24px',
                  borderRadius: 12,
                  border: validating ? '1px solid rgba(250,204,21,0.5)' : '1px solid rgba(96,165,250,0.5)',
                  background: validating ? 'rgba(250,204,21,0.18)' : 'rgba(96,165,250,0.18)',
                  color: 'white',
                  fontSize: '0.95rem',
                  fontWeight: 700,
                  cursor: validating ? 'not-allowed' : 'pointer',
                  opacity: validating ? 0.7 : 1,
                  transition: 'all 0.2s',
                  boxShadow: validating ? 'none' : '0 4px 12px rgba(96,165,250,0.2)'
                }}
                onClick={handleRunValidation}
                disabled={validating}
              >
                {validating ? '⏳ Running...' : '▶ Run Validation'}
              </button>
            ) : null}
          </div>
        </div>

        {/* Validation Status Cards */}
        {validationResult && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 20 }}>
              <div style={{ padding: '16px 18px', borderRadius: 14, background: 'rgba(255,255,255,0.04)' }}>
                <div style={{ opacity: 0.74, fontSize: '0.85rem', fontWeight: 600, marginBottom: 6 }}>Overall Status</div>
                <div style={{ fontSize: '1.6rem', fontWeight: 900, color: statusColor, letterSpacing: '-0.5px' }}>
                  {overallStatus}
                </div>
              </div>
              <div style={{ padding: '16px 18px', borderRadius: 14, background: 'rgba(255,255,255,0.04)' }}>
                <div style={{ opacity: 0.74, fontSize: '0.85rem', fontWeight: 600, marginBottom: 6 }}>Passed</div>
                <div style={{ fontSize: '1.6rem', fontWeight: 900, color: '#6ee7b7', letterSpacing: '-0.5px' }}>
                  {passed}
                </div>
              </div>
              <div style={{ padding: '16px 18px', borderRadius: 14, background: 'rgba(255,255,255,0.04)' }}>
                <div style={{ opacity: 0.74, fontSize: '0.85rem', fontWeight: 600, marginBottom: 6 }}>Warnings</div>
                <div style={{ fontSize: '1.6rem', fontWeight: 900, color: '#fde68a', letterSpacing: '-0.5px' }}>
                  {warnings}
                </div>
              </div>
              <div style={{ padding: '16px 18px', borderRadius: 14, background: 'rgba(255,255,255,0.04)' }}>
                <div style={{ opacity: 0.74, fontSize: '0.85rem', fontWeight: 600, marginBottom: 6 }}>Failed</div>
                <div style={{ fontSize: '1.6rem', fontWeight: 900, color: '#fca5a5', letterSpacing: '-0.5px' }}>
                  {failed}
                </div>
              </div>
            </div>

            {/* Validation Score */}
            {validationResult.score !== undefined && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h4 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700 }}>Validation Score</h4>
                  <span style={{ fontSize: '2rem', fontWeight: 900, color: validationResult.score >= 80 ? '#6ee7b7' : validationResult.score >= 60 ? '#fde68a' : '#fca5a5', letterSpacing: '-1px' }}>
                    {validationResult.score}%
                  </span>
                </div>
                <div style={{ height: 12, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${validationResult.score}%`,
                      height: '100%',
                      background: validationResult.score >= 80 ? 'linear-gradient(90deg, #6ee7b7, #34d399)' : validationResult.score >= 60 ? 'linear-gradient(90deg, #fde68a, #fbbf24)' : 'linear-gradient(90deg, #fca5a5, #f87171)',
                      transition: 'width 0.6s ease',
                      boxShadow: '0 0 12px rgba(255,255,255,0.3)'
                    }}
                  />
                </div>
                {validationResult.message && (
                  <p style={{ margin: '12px 0 0 0', opacity: 0.85, fontSize: '0.9rem', lineHeight: 1.6 }}>
                    {validationResult.message}
                  </p>
                )}
              </div>
            )}

            {/* Validation Checks Table */}
            {checks.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h4 style={{ margin: '0 0 14px 0', fontSize: '1.2rem', fontWeight: 700 }}>Validation Checks</h4>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                        <th style={{ ...tableHeadCell, fontSize: '0.9rem' }}>Check</th>
                        <th style={{ ...tableHeadCell, fontSize: '0.9rem' }}>Status</th>
                        <th style={{ ...tableHeadCell, fontSize: '0.9rem' }}>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checks.map((c, idx) => (
                        <tr key={idx} style={{ background: idx % 2 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                          <td style={{ ...tableCell, fontSize: '0.9rem', fontWeight: 600 }}>{c.name || c.check}</td>
                          <td style={tableCell}>
                            <span
                              style={{
                                padding: '4px 12px',
                                borderRadius: 999,
                                fontWeight: 700,
                                fontSize: '0.8rem',
                                background:
                                  (c.status === 'Pass' || c.status === 'pass' || c.passed === true) ? 'rgba(16,185,129,0.18)' :
                                  (c.status === 'Fail' || c.status === 'fail' || c.passed === false) ? 'rgba(239,68,68,0.18)' :
                                  'rgba(245,158,11,0.18)',
                                color:
                                  (c.status === 'Pass' || c.status === 'pass' || c.passed === true) ? '#34d399' :
                                  (c.status === 'Fail' || c.status === 'fail' || c.passed === false) ? '#f87171' :
                                  '#fbbf24',
                                border: `1px solid ${
                                  (c.status === 'Pass' || c.status === 'pass' || c.passed === true) ? 'rgba(16,185,129,0.3)' :
                                  (c.status === 'Fail' || c.status === 'fail' || c.passed === false) ? 'rgba(239,68,68,0.3)' :
                                  'rgba(245,158,11,0.3)'
                                }`
                              }}
                            >
                              {c.status || (c.passed === true ? 'Pass' : c.passed === false ? 'Fail' : 'N/A')}
                            </span>
                          </td>
                          <td style={{ ...tableCell, fontSize: '0.85rem' }}>{c.detail || c.message || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Python Output */}
            {validationResult.pythonOutput && (
              <div style={{ marginBottom: 20 }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '1.2rem', fontWeight: 700 }}>Python Validation Output</h4>
                <pre style={{
                  background: 'rgba(0,0,0,0.4)',
                  padding: 14,
                  borderRadius: 10,
                  overflow: 'auto',
                  maxHeight: 300,
                  fontSize: '0.85rem',
                  lineHeight: 1.6,
                  color: '#e2e8f0',
                  border: '1px solid rgba(255,255,255,0.1)'
                }}>
                  {validationResult.pythonOutput}
                </pre>
              </div>
            )}

            {/* Python Errors */}
            {validationResult.pythonError && (
              <div style={{ border: '1px solid rgba(239,68,68,0.4)', borderRadius: 12, padding: 16, background: 'rgba(239,68,68,0.05)' }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '1.2rem', fontWeight: 700, color: '#f87171' }}>Python Validation Errors</h4>
                <pre style={{
                  background: 'rgba(239,68,68,0.12)',
                  padding: 14,
                  borderRadius: 10,
                  overflow: 'auto',
                  maxHeight: 300,
                  fontSize: '0.85rem',
                  lineHeight: 1.6,
                  color: '#fca5a5',
                  border: '1px solid rgba(239,68,68,0.2)'
                }}>
                  {validationResult.pythonError}
                </pre>
              </div>
            )}
          </>
        )}

        {/* Empty State */}
        {!validationResult && !validating && (
          <div style={{ padding: '32px 24px', textAlign: 'center' }}>
            <div style={{ 
              width: '60px', 
              height: '60px', 
              borderRadius: '50%', 
              background: 'rgba(96,165,250,0.12)', 
              border: '2px solid rgba(96,165,250,0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
              fontSize: '2rem'
            }}>
              ✓
            </div>
            <div style={{ opacity: 0.8, fontSize: '1.1rem', fontWeight: 700, marginBottom: 8 }}>
              No validation results yet
            </div>
            <p style={{ opacity: 0.6, fontSize: '0.9rem', margin: 0, lineHeight: 1.6 }}>
              {readOnly
                ? 'The project owner has not published a validation snapshot yet.'
                : 'Click "Run Validation" to validate the solver output and check for issues'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default ConstraintsPanel;
