const asyncHandler = require('express-async-handler');
const Project = require('../models/Project');
const Ride = require('../models/Ride');

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function pct(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return (numerator / denominator) * 100;
}

function monthKey(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function haversineKm(a, b) {
  if (!a || !b) return 0;
  const lat1 = toNum(a.lat, NaN);
  const lon1 = toNum(a.lng, NaN);
  const lat2 = toNum(b.lat, NaN);
  const lon2 = toNum(b.lng, NaN);
  if (![lat1, lon1, lat2, lon2].every((x) => Number.isFinite(x))) return 0;

  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);

  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function getProjectDerivedMetrics(project) {
  const resultMetrics = project?.results?.metrics || {};
  const projectMetrics = project?.metrics || {};
  const rides = Array.isArray(project?.results?.rides) ? project.results.rides : [];

  const optimizedCost = toNum(
    projectMetrics.totalSystemCost ?? resultMetrics.totalSystemCost ?? resultMetrics.totalCost,
    0
  );
  const baselineCost = toNum(
    projectMetrics.baselineCost ?? resultMetrics.baselineCost,
    0
  );

  const optimizedTime = toNum(
    projectMetrics.totalTimeMinutes ?? resultMetrics.totalTimeMinutes,
    0
  );
  const baselineTime = toNum(
    projectMetrics.baselineTimeMinutes ?? resultMetrics.baselineTimeMinutes,
    0
  );

  const rideCount = rides.length;
  const savings = baselineCost - optimizedCost;
  const timeSaved = baselineTime - optimizedTime;
  const timeSavedPerRide = rideCount > 0 ? (timeSaved / rideCount) : 0;

  let optimizedDistanceKm = 0;
  let delayedRideCount = 0;
  let feasibleRideCount = 0;
  rides.forEach((ride) => {
    const path = Array.isArray(ride?.path) ? ride.path : [];
    const rideDistanceMetric = toNum(ride?.metrics?.totalDistance, NaN);
    if (Number.isFinite(rideDistanceMetric) && rideDistanceMetric > 0) {
      optimizedDistanceKm += rideDistanceMetric;
    } else {
      for (let i = 1; i < path.length; i += 1) {
        optimizedDistanceKm += haversineKm(path[i - 1], path[i]);
      }
    }

    const rideDelay = toNum(ride?.metrics?.delayMinutes, 0);
    if (rideDelay > 0) delayedRideCount += 1;
    if (ride?.feasible === false) return;
    feasibleRideCount += 1;
  });

  let baselineDistanceKm = 0;
  if (optimizedDistanceKm > 0 && optimizedTime > 0 && baselineTime > 0) {
    baselineDistanceKm = optimizedDistanceKm * (baselineTime / optimizedTime);
  }
  const distanceReducedKm = Math.max(0, baselineDistanceKm - optimizedDistanceKm);
  const distanceReducedPct = pct(distanceReducedKm, baselineDistanceKm);

  const runStarted = project?.run?.startedAt ? new Date(project.run.startedAt).getTime() : NaN;
  const runFinished = project?.run?.finishedAt ? new Date(project.run.finishedAt).getTime() : NaN;
  const runtimeSec = (Number.isFinite(runStarted) && Number.isFinite(runFinished) && runFinished >= runStarted)
    ? (runFinished - runStarted) / 1000
    : null;

  return {
    projectId: String(project?._id || ''),
    projectName: String(project?.name || 'Untitled'),
    createdAt: project?.createdAt || null,
    optimizedCost,
    baselineCost,
    savings,
    optimizedTime,
    baselineTime,
    timeSaved,
    timeSavedPerRide,
    rideCount,
    optimizedDistanceKm,
    baselineDistanceKm,
    distanceReducedKm,
    distanceReducedPct,
    delayedRideCount,
    feasibleRideCount,
    runtimeSec
  };
}

const getDashboardSummary = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [projectsCount, completedCount, recentProjects] = await Promise.all([
    Project.countDocuments({ user: userId }),
    Project.countDocuments({ user: userId, status: 'Completed' }),
    Project.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(8)
      .select('name status metrics createdAt')
  ]);

  const projectIds = recentProjects.map(p => p._id);
  const ridesCount = await Ride.countDocuments({ project: { $in: projectIds } });

  res.json({
    user: {
      name: req.user.name,
      email: req.user.email,
      role: req.user.role
    },
    stats: {
      projectsCount,
      completedCount,
      ridesCount
    },
    recentProjects
  });
});

const getDashboardMetrics = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const projects = await Project.find({ user: userId })
    .sort({ createdAt: -1 })
    .select('name status createdAt metrics results run runValidation');

  const completedProjects = projects.filter((p) => String(p?.status || '').toLowerCase() === 'completed');
  const runs = completedProjects.map(getProjectDerivedMetrics);

  const totals = runs.reduce((acc, run) => {
    acc.savings += run.savings;
    acc.optimizedCost += run.optimizedCost;
    acc.baselineCost += run.baselineCost;
    acc.optimizedTime += run.optimizedTime;
    acc.baselineTime += run.baselineTime;
    acc.timeSaved += run.timeSaved;
    acc.rides += run.rideCount;
    acc.distanceOptimized += run.optimizedDistanceKm;
    acc.distanceBaseline += run.baselineDistanceKm;
    acc.distanceReduced += run.distanceReducedKm;
    acc.delayedRides += run.delayedRideCount;
    acc.feasibleRides += run.feasibleRideCount;
    if (Number.isFinite(run.runtimeSec)) {
      acc.runtimeSecSum += run.runtimeSec;
      acc.runtimeSecCount += 1;
    }
    return acc;
  }, {
    savings: 0,
    optimizedCost: 0,
    baselineCost: 0,
    optimizedTime: 0,
    baselineTime: 0,
    timeSaved: 0,
    rides: 0,
    distanceOptimized: 0,
    distanceBaseline: 0,
    distanceReduced: 0,
    delayedRides: 0,
    feasibleRides: 0,
    runtimeSecSum: 0,
    runtimeSecCount: 0
  });

  const totalSavings = totals.savings;
  const totalRidesOptimized = totals.rides;
  const avgTimeSavedPerRideMin = totalRidesOptimized > 0 ? (totals.timeSaved / totalRidesOptimized) : 0;
  const distanceReducedPct = pct(totals.distanceReduced, totals.distanceBaseline);
  const costSavingsPct = pct(totalSavings, totals.baselineCost);
  const timeSavingsPct = pct(totals.timeSaved, totals.baselineTime);

  const completedCount = completedProjects.length;
  const validatedRuns = completedProjects.filter((p) => p?.runValidation && p.runValidation.status !== 'NotValidated');
  const validatedPassed = validatedRuns.filter((p) => String(p?.runValidation?.status || '').toLowerCase() === 'passed');
  const successRatePct = validatedRuns.length > 0
    ? pct(validatedPassed.length, validatedRuns.length)
    : pct(completedCount, Math.max(1, projects.length));

  const feasibleRideRatePct = pct(totals.feasibleRides, Math.max(1, totals.rides));
  const delayPenaltyPct = pct(totals.delayedRides, Math.max(1, totals.rides));

  const efficiencyScore = Math.round(clamp(
    (costSavingsPct * 0.4)
    + (timeSavingsPct * 0.3)
    + (feasibleRideRatePct * 0.2)
    + ((100 - delayPenaltyPct) * 0.1),
    0,
    100
  ));

  const avgRuntimeSec = totals.runtimeSecCount > 0 ? (totals.runtimeSecSum / totals.runtimeSecCount) : 0;

  const months = [];
  const now = new Date();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: monthKey(d),
      label: MONTH_SHORT[d.getMonth()]
    });
  }
  const monthSeries = Object.fromEntries(months.map((m) => [m.key, {
    label: m.label,
    baselineCost: 0,
    optimizedCost: 0,
    avgTimeSavedPerRideMinSum: 0,
    timeSavedSamples: 0
  }]));

  runs.forEach((run) => {
    const k = monthKey(run.createdAt);
    if (!monthSeries[k]) return;
    monthSeries[k].baselineCost += run.baselineCost;
    monthSeries[k].optimizedCost += run.optimizedCost;
    if (run.rideCount > 0) {
      monthSeries[k].avgTimeSavedPerRideMinSum += run.timeSavedPerRide;
      monthSeries[k].timeSavedSamples += 1;
    }
  });

  const costComparison = months.map((m) => {
    const row = monthSeries[m.key];
    return {
      label: m.label,
      baselineCost: Math.round(row.baselineCost),
      optimizedCost: Math.round(row.optimizedCost)
    };
  });

  const averageTimeSavedTrend = months.map((m) => {
    const row = monthSeries[m.key];
    const v = row.timeSavedSamples > 0 ? (row.avgTimeSavedPerRideMinSum / row.timeSavedSamples) : 0;
    return {
      label: m.label,
      value: Math.round(v * 10) / 10
    };
  });

  const avgRidesAcrossProjects = runs.length ? (totals.rides / runs.length) : 0;
  const ridesPerProject = [...runs]
    .sort((a, b) => b.rideCount - a.rideCount)
    .slice(0, 6)
    .map((run) => {
      const deltaPct = avgRidesAcrossProjects > 0
        ? pct(run.rideCount - avgRidesAcrossProjects, avgRidesAcrossProjects)
        : 0;
      return {
        projectId: run.projectId,
        projectName: run.projectName,
        rides: run.rideCount,
        deltaPct: Math.round(deltaPct * 10) / 10
      };
    });

  res.json({
    kpis: {
      totalSavings,
      totalRidesOptimized,
      avgTimeSavedPerRideMin,
      distanceReducedPct,
      distanceReducedKm: totals.distanceReduced,
      costSavingsPct,
      timeSavingsPct,
      feasibleRideRatePct,
      efficiencyScore,
      avgRuntimeSec,
      successRatePct
    },
    formulas: {
      totalSavings: 'sum(baselineCost - optimizedCost) over completed runs',
      totalRidesOptimized: 'sum(rideCount) over completed runs',
      avgTimeSavedPerRideMin: 'sum(baselineTime - optimizedTime) / sum(rideCount)',
      distanceReducedPct: '(sum(estimatedBaselineDistanceKm - optimizedDistanceKm) / sum(estimatedBaselineDistanceKm)) * 100',
      efficiencyScore: '0.4*costSavingsPct + 0.3*timeSavingsPct + 0.2*feasibleRideRatePct + 0.1*(100-delayPenaltyPct)',
      avgRuntimeSec: 'average(run.finishedAt - run.startedAt) in seconds'
    },
    charts: {
      costComparison,
      averageTimeSavedTrend,
      ridesPerProject,
      distanceDonut: {
        reducedPct: distanceReducedPct,
        reducedKm: totals.distanceReduced,
        baselineKm: totals.distanceBaseline,
        optimizedKm: totals.distanceOptimized
      }
    },
    counts: {
      projects: projects.length,
      completedProjects: completedCount,
      runsWithResults: runs.length
    }
  });
});

module.exports = { getDashboardSummary, getDashboardMetrics };



