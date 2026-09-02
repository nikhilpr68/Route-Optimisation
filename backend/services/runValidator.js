function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function validateRunOutput(project) {
  const results = project?.results || {};
  const rides = Array.isArray(results?.rides) ? results.rides : [];
  const metrics = results?.metrics || project?.metrics || {};
  const solveStatus = String(results?.status || '').trim().toLowerCase();
  const topLevelFeasible = results?.feasible !== false && solveStatus !== 'infeasible' && solveStatus !== 'error';
  const unassigned = Array.isArray(results?.unassigned) ? results.unassigned : [];

  const checks = [];

  // Solver Execution Status
  const solverPassed = solveStatus !== 'error' && !results?.error;
  checks.push({
    name: 'Solver Execution',
    passed: solverPassed,
    severity: solverPassed ? 'OK' : 'Error',
    detail: solverPassed 
      ? 'Optimization run completed without errors'
      : `Solver failed: status=${results?.status || project?.status || 'Unknown'}, error=${results?.error || project?.run?.error || 'Unknown'}`
  });

  // Solution Feasibility Status
  const totalStops = rides.reduce((sum, r) => sum + (Array.isArray(r?.path) ? r.path.length : 0), 0);
  const feasibleRides = rides.filter((r) => r?.feasible !== false).length;
  const allFeasible = rides.length > 0 && feasibleRides === rides.length && topLevelFeasible && unassigned.length === 0;
  checks.push({
    name: 'Solution Feasibility',
    passed: allFeasible,
    severity: allFeasible ? 'OK' : 'Error',
    detail: allFeasible
      ? 'All routes feasible and all employees assigned'
      : `${feasibleRides}/${rides.length} routes feasible, ${unassigned.length} unassigned, ${totalStops} stops emitted`
  });

  // Capacity Compliance Status
  const capacityIssues = [];
  rides.forEach((ride, idx) => {
    const violations = Array.isArray(ride?.violations) ? ride.violations : [];
    const consistencyErrors = Array.isArray(ride?.consistencyErrors) ? ride.consistencyErrors : [];
    const capacityViolation = violations.some((v) => String(v).toLowerCase().includes('capacity'));
    const capacityConsistency = consistencyErrors.some((v) => String(v).toLowerCase().includes('capacity'));
    if (capacityViolation || capacityConsistency) {
      capacityIssues.push(`Vehicle ${ride?.vehicleId || idx + 1} has capacity-related violations`);
    }
  });
  const capacityPassed = capacityIssues.length === 0;
  checks.push({
    name: 'Capacity Compliance',
    passed: capacityPassed,
    severity: capacityPassed ? 'OK' : 'Error',
    detail: capacityPassed
      ? 'No capacity violations emitted by engine'
      : capacityIssues.join(', ')
  });

  // Time Window Compliance Status
  let timeWindowViolations = 0;
  rides.forEach((ride) => {
    const violations = Array.isArray(ride?.violations) ? ride.violations : [];
    const routePenaltyBreakdown = ride?.penaltyBreakdown || {};
    timeWindowViolations += violations.filter((v) => String(v).toLowerCase().includes('late') || String(v).toLowerCase().includes('time')).length;
    if (Number(routePenaltyBreakdown?.lateness || 0) > 0) {
      timeWindowViolations += 1;
    }
  });
  const timeWindowPassed = timeWindowViolations === 0;
  checks.push({
    name: 'Time Window Compliance',
    passed: timeWindowPassed,
    severity: timeWindowPassed ? 'OK' : 'Error',
    detail: timeWindowPassed
      ? 'No lateness violations emitted by engine'
      : `${timeWindowViolations} time-window or lateness violations detected`
  });

  const consistencyIssues = rides.reduce(
    (sum, ride) => sum + (Array.isArray(ride?.consistencyErrors) ? ride.consistencyErrors.length : 0),
    0
  ) + (Array.isArray(results?.consistencyErrors) ? results.consistencyErrors.length : 0);
  checks.push({
    name: 'Consistency Checks',
    passed: consistencyIssues === 0,
    severity: consistencyIssues === 0 ? 'OK' : 'Error',
    detail: consistencyIssues === 0
      ? 'No route or solution consistency errors emitted'
      : `${consistencyIssues} consistency errors emitted by engine`
  });

  // Cost, Distance & Time Metrics Status
  const systemCost = toNumber(metrics?.totalSystemCost, NaN);
  const totalDistance = toNumber(metrics?.totalDistanceKm || metrics?.totalDistance, NaN);
  const totalTime = toNumber(metrics?.totalTimeMinutes || metrics?.totalTime, NaN);
  const metricsPassed = Number.isFinite(systemCost) && systemCost >= 0 && Number.isFinite(totalDistance) && totalDistance >= 0;
  checks.push({
    name: 'Cost, Distance & Time Metrics',
    passed: metricsPassed,
    severity: metricsPassed ? 'OK' : 'Error',
    detail: metricsPassed
      ? `Operational metrics validated (Cost: ${systemCost.toFixed(2)}, Distance: ${totalDistance.toFixed(2)} km, Time: ${Number.isFinite(totalTime) ? totalTime.toFixed(0) + ' min' : 'N/A'})`
      : 'Invalid or missing operational metrics'
  });

  const passedCount = checks.filter((c) => c.passed).length;
  const score = Math.round((passedCount / checks.length) * 100);
  const passed = checks.every((c) => c.passed);

  return {
    passed,
    score,
    message: passed
      ? `Validation passed (${score}%)`
      : `Validation failed (${score}%). Review checks.`,
    checks
  };
}

module.exports = { validateRunOutput };
