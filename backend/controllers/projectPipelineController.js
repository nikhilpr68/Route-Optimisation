const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Project = require('../models/Project');

const { parseWithPythonRgx } = require('../services/pythonRgxParser');
const { validateCanonical } = require('../validation/validateCanonical');
const { runPythonEngine } = require('../services/engineRunner');
const { computeBaselineFromCanonical } = require('../services/baselineRunner');
const { validateRunOutput } = require('../services/runValidator');
const { reconcileStaleRuns } = require('../services/runRecovery');

function userPlanTier(user) {
  return String(user?.planTier || 'free').trim().toLowerCase();
}

function ensureOwner(project, userId) {
  if (project.user.toString() !== userId.toString()) {
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }
}

function ensureComputeTierAllowed(user, computeTier) {
  const tier = normalizeComputeTier(computeTier);
  const role = String(user?.role || '').trim();
  if (tier !== 'premium') return;
  if (role === 'Admin') return;
  if (userPlanTier(user) === 'premium') return;
  const err = new Error('Premium large-case compute requires a premium plan');
  err.statusCode = 403;
  throw err;
}

async function findConcurrentRun(userId, projectId) {
  await reconcileStaleRuns({ user: userId });

  const activeRun = await Project.findOne({
    user: userId,
    _id: { $ne: projectId },
    status: 'Processing',
    'run.state': 'Running',
  }).sort({ 'run.startedAt': 1, createdAt: 1 });

  return activeRun;
}

function normalizeCoordinate(rawValue) {
  if (!rawValue || typeof rawValue !== 'object') return null;
  const lat = Number(rawValue.lat ?? rawValue.latitude);
  const lng = Number(rawValue.lng ?? rawValue.lon ?? rawValue.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function addCoordinateToSet(target, rawValue) {
  const point = normalizeCoordinate(rawValue);
  if (!point) return;
  target.add(`${point.lat.toFixed(6)},${point.lng.toFixed(6)}`);
}

function largeCaseContextFromCanonical(canonical) {
  const employees = Array.isArray(canonical?.employees) ? canonical.employees : [];
  const vehicles = Array.isArray(canonical?.vehicles) ? canonical.vehicles : [];
  const uniqueLocations = new Set();

  employees.forEach((employee) => {
    addCoordinateToSet(uniqueLocations, employee?.pickup);
    addCoordinateToSet(uniqueLocations, employee?.pickup_loc);
    addCoordinateToSet(uniqueLocations, employee?.pickupLocation);
    addCoordinateToSet(uniqueLocations, employee?.dropoff);
    addCoordinateToSet(uniqueLocations, employee?.dropoff_loc);
    addCoordinateToSet(uniqueLocations, employee?.dropoffLocation);
  });

  vehicles.forEach((vehicle) => {
    addCoordinateToSet(uniqueLocations, vehicle?.start_location);
    addCoordinateToSet(uniqueLocations, vehicle?.start_loc);
    addCoordinateToSet(uniqueLocations, vehicle?.startLocation);
  });

  const employeeCount = employees.length;
  const vehicleCount = vehicles.length;
  const uniqueLocationCount = uniqueLocations.size;
  const vehiclePressureLarge = (
    vehicleCount > LARGE_CASE_VEHICLE_THRESHOLD
    && employeeCount >= LARGE_CASE_VEHICLE_EMPLOYEE_FLOOR
  );
  const isLarge = (
    employeeCount > LARGE_CASE_EMPLOYEE_THRESHOLD
    || vehiclePressureLarge
    || uniqueLocationCount > LARGE_CASE_LOCATION_THRESHOLD
  );

  return {
    isLarge,
    employeeCount,
    vehicleCount,
    uniqueLocationCount,
  };
}

function resolveAccessibleComputeTier(canonical, requestedComputeTier) {
  const requestedTier = normalizeComputeTier(requestedComputeTier);
  const largeCaseContext = largeCaseContextFromCanonical(canonical);
  if (!largeCaseContext.isLarge) {
    return { computeTier: requestedTier, largeCaseContext };
  }

  // Large testcases now always receive the extended search tier.
  return { computeTier: 'premium', largeCaseContext };
}

function normalizeUploadedFiles(reqFiles) {
  if (!reqFiles) return [];
  if (Array.isArray(reqFiles)) return reqFiles; // upload.any()
  const out = [];
  for (const key of Object.keys(reqFiles)) {
    for (const f of (reqFiles[key] || [])) out.push(f);
  }
  return out;
}

function mergeUniqueStrings(...groups) {
  return Array.from(new Set(
    groups
      .flat()
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
  ));
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sumCanonicalBaseline(canonical) {
  const baseline = canonical?.baseline;
  if (!baseline) {
    return { baselineCost: 0, baselineTimeMinutes: 0 };
  }

  let baselineCost = 0;
  let baselineTimeMinutes = 0;

  if (Array.isArray(baseline)) {
    baseline.forEach((row) => {
      if (!row || typeof row !== 'object') return;
      baselineCost += toFiniteNumber(row.cost ?? row.baseline_cost, 0);
      baselineTimeMinutes += toFiniteNumber(
        row.time ?? row.baseline_time_min ?? row.baseline_time,
        0
      );
    });
    return { baselineCost, baselineTimeMinutes };
  }

  if (typeof baseline === 'object') {
    Object.values(baseline).forEach((row) => {
      if (!row || typeof row !== 'object') return;
      baselineCost += toFiniteNumber(row.cost ?? row.baseline_cost, 0);
      baselineTimeMinutes += toFiniteNumber(
        row.time ?? row.baseline_time_min ?? row.baseline_time,
        0
      );
    });
  }

  return { baselineCost, baselineTimeMinutes };
}

function hasUsableBaseline(canonical) {
  const baseline = canonical?.baseline;
  if (!baseline) return false;

  if (Array.isArray(baseline)) {
    return baseline.some((row) => row && typeof row === 'object');
  }

  if (typeof baseline === 'object') {
    return Object.values(baseline).some((row) => row && typeof row === 'object');
  }

  return false;
}

function applyBaselineMetrics(project, totals) {
  if (!project.metrics || typeof project.metrics !== 'object') project.metrics = {};
  project.metrics.baselineCost = toFiniteNumber(totals?.baselineCost, 0);
  project.metrics.baselineTimeMinutes = toFiniteNumber(totals?.baselineTimeMinutes, 0);
}

function resetParseState(project, warningMessage = '') {
  project.parsedInput = null;
  project.results = null;
  applyBaselineMetrics(project, { baselineCost: 0, baselineTimeMinutes: 0 });

  if (!project.parseReport || typeof project.parseReport !== 'object') {
    project.parseReport = {};
  }

  project.parseReport.status = 'failed';
  project.parseReport.confidence = 0;
  project.parseReport.missingRequired = [];
  project.parseReport.assumptions = [];
  project.parseReport.warnings = warningMessage ? [warningMessage] : [];
  project.parseReport.model = '';
  project.parseReport.parsedAt = null;
  project.parseReport.sanityChecks = null;

  if (!project.runValidation || typeof project.runValidation !== 'object') {
    project.runValidation = {};
  }
  project.runValidation.status = 'NotValidated';
  project.runValidation.requestedAt = null;
  project.runValidation.finishedAt = null;
  project.runValidation.score = 0;
  project.runValidation.message = '';
  project.runValidation.checks = [];
}

async function syncComputedBaseline(canonicalInput) {
  const canonical = (canonicalInput && typeof canonicalInput === 'object')
    ? canonicalInput
    : {};
  const fallbackTotals = sumCanonicalBaseline(canonical);

  if (hasUsableBaseline(canonical)) {
    return {
      canonical,
      totals: fallbackTotals,
      warnings: [],
    };
  }

  try {
    const result = await computeBaselineFromCanonical(canonical);

    if (result?.error) {
      return {
        canonical,
        totals: fallbackTotals,
        warnings: [`Baseline auto-compute failed: ${String(result.error)}`],
      };
    }

    if (result?.baseline && typeof result.baseline === 'object' && !Array.isArray(result.baseline)) {
      canonical.baseline = result.baseline;
    }

    return {
      canonical,
      totals: {
        baselineCost: toFiniteNumber(result?.totals?.baselineCost, fallbackTotals.baselineCost),
        baselineTimeMinutes: toFiniteNumber(result?.totals?.baselineTimeMinutes, fallbackTotals.baselineTimeMinutes),
      },
      warnings: mergeUniqueStrings(result?.warnings || []),
    };
  } catch (e) {
    return {
      canonical,
      totals: fallbackTotals,
      warnings: [`Baseline auto-compute failed: ${e.message}`],
    };
  }
}

function normalizeIntensity(v) {
  const x = String(v || '').trim().toLowerCase();
  if (x === 'low' || x === 'high' || x === 'custom') return x;
  return 'medium';
}

function readOptionalPositiveNumber(raw, { integer = false, treatAsProvided = false } = {}) {
  if (raw === undefined || raw === null) return { provided: treatAsProvided, value: null, valid: true };
  const text = String(raw).trim();
  if (!text) return { provided: treatAsProvided, value: null, valid: true };
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return { provided: true, value: null, valid: false };
  if (integer && !Number.isInteger(n)) return { provided: true, value: null, valid: false };
  return { provided: true, value: integer ? Math.trunc(n) : n, valid: true };
}

function resolveCustomIntensityConfig(reqBody = {}, existingRunConfig = {}, optimizationIntensity = 'medium') {
  const hasReqTime = Object.prototype.hasOwnProperty.call(reqBody || {}, 'customMaxRunSeconds');
  const hasReqGenerations = Object.prototype.hasOwnProperty.call(reqBody || {}, 'customGenerations');
  const reqTime = readOptionalPositiveNumber(reqBody?.customMaxRunSeconds, { treatAsProvided: hasReqTime });
  const reqGenerations = readOptionalPositiveNumber(reqBody?.customGenerations, { integer: true, treatAsProvided: hasReqGenerations });
  if (!reqTime.valid || !reqGenerations.valid) {
    const err = new Error('Custom intensity values must be positive numbers, and generations must be a whole number');
    err.statusCode = 400;
    throw err;
  }

  if (optimizationIntensity !== 'custom') {
    return { customMaxRunSeconds: null, customGenerations: null };
  }

  const customMaxRunSeconds = reqTime.provided
    ? reqTime.value
    : readOptionalPositiveNumber(existingRunConfig?.customMaxRunSeconds).value;
  const customGenerations = reqGenerations.provided
    ? reqGenerations.value
    : readOptionalPositiveNumber(existingRunConfig?.customGenerations, { integer: true }).value;
  const filledCount = Number(Boolean(customMaxRunSeconds)) + Number(Boolean(customGenerations));

  if (filledCount !== 1) {
    const err = new Error('Custom intensity requires exactly one value: time in seconds or generations');
    err.statusCode = 400;
    throw err;
  }

  return { customMaxRunSeconds, customGenerations };
}

function normalizeRunDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function normalizeDistanceMetric(v) {
  return 'osrm';
}

function normalizePreferenceRelaxation(v) {
  const x = String(v || '').trim().toLowerCase();
  if (x === 'sharing' || x === 'vehicle' || x === 'both') return x;
  return 'none';
}

function normalizeComputeTier(v) {
  const x = String(v || '').trim().toLowerCase();
  if (x === 'premium' || x === 'paid' || x === 'pro') return 'premium';
  return 'free';
}

function engineTimeoutMsForTier(computeTier) {
  return computeTier === 'premium' ? 21 * 60 * 1000 : 10 * 60 * 1000;
}

function buildEngineArgs({
  optimizationIntensity,
  preferenceRelaxation,
  computeTier,
  customMaxRunSeconds = null,
  customGenerations = null,
}) {
  const args = [
    '--intensity', optimizationIntensity,
    '--preference-relaxation', preferenceRelaxation,
    '--compute-tier', computeTier
  ];
  if (optimizationIntensity === 'custom') {
    args.push('--early-stop-enabled', 'false');
    if (customGenerations) args.push('--generations', String(customGenerations));
    if (customMaxRunSeconds) args.push('--max-run-seconds', String(customMaxRunSeconds));
  }
  return args;
}

function buildCanonicalForRun(parsedInput, runConfig = {}) {
  const canonical = JSON.parse(JSON.stringify(parsedInput || {}));
  const metadata = (canonical.metadata && typeof canonical.metadata === 'object' && !Array.isArray(canonical.metadata))
    ? { ...canonical.metadata }
    : {};

  const distanceMetric = normalizeDistanceMetric(runConfig.distanceMetric);
  const preferenceRelaxation = normalizePreferenceRelaxation(runConfig.preferenceRelaxation);
  const computeTier = normalizeComputeTier(runConfig.computeTier);
  const allowSharingViolation = preferenceRelaxation === 'sharing' || preferenceRelaxation === 'both';
  const allowPremiumMismatch = preferenceRelaxation === 'vehicle' || preferenceRelaxation === 'both';

  metadata.distance_metric = distanceMetric;
  metadata.distance_method = distanceMetric;
  metadata.ALLOW_SHARING_VIOLATION = allowSharingViolation ? 'true' : 'false';
  metadata.ALLOW_PREMIUM_MISMATCH = allowPremiumMismatch ? 'true' : 'false';
  metadata.allow_sharing_violation = allowSharingViolation;
  metadata.allow_premium_mismatch = allowPremiumMismatch;
  metadata.preference_relaxation = preferenceRelaxation;
  metadata.requested_compute_tier = computeTier;
  metadata.compute_tier = computeTier;

  canonical.metadata = metadata;
  return canonical;
}

function classifyEngineResult(engineResult, validationReport = null) {
  const solveStatus = String(engineResult?.status || '').trim().toLowerCase();
  if (solveStatus === 'error' || engineResult?.error) {
    return { projectStatus: 'Failed', runState: 'Failed', error: engineResult?.error || 'Engine error' };
  }
  if (solveStatus === 'infeasible' || engineResult?.feasible === false) {
    return { projectStatus: 'Infeasible', runState: 'Infeasible', error: 'No feasible solution found within constraints' };
  }
  if (validationReport && !validationReport.passed) {
    return { projectStatus: 'Infeasible', runState: 'Infeasible', error: validationReport.message || 'Run validation failed' };
  }
  return { projectStatus: 'Completed', runState: 'Done', error: '' };
}

async function persistRunOutcome(project, engineResult) {
  project.results = engineResult;
  if (engineResult?.metrics) {
    project.metrics = { ...project.metrics, ...engineResult.metrics };
  }

  const validationReport = validateRunOutput({
    status: 'Completed',
    run: { state: 'Done' },
    results: engineResult,
    metrics: project.metrics,
  });
  project.runValidation = {
    ...(project.runValidation || {}),
    status: validationReport.passed ? 'Passed' : 'Failed',
    requestedAt: project.run?.startedAt || new Date(),
    finishedAt: new Date(),
    score: validationReport.score,
    message: validationReport.message,
    checks: validationReport.checks,
  };

  const outcome = classifyEngineResult(engineResult, validationReport);
  project.status = outcome.projectStatus;
  project.run.state = outcome.runState;
  project.run.finishedAt = new Date();
  project.run.error = outcome.error;
  await project.save();
  return { validationReport, outcome };
}

// POST /api/projects/:id/ingest
const ingestArtifacts = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error('Invalid project id');
  }

  const project = await Project.findById(id);
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  ensureOwner(project, req.user._id);

  if (!Array.isArray(project.inputArtifacts)) project.inputArtifacts = [];
  if (!project.parseReport) project.parseReport = {};
  if (!project.run) project.run = {};
  if (!project.metrics || typeof project.metrics !== 'object') project.metrics = {};
  if (!project.runValidation || typeof project.runValidation !== 'object') project.runValidation = {};

  const notes = req.body?.notes;
  let changedArtifacts = false;
  if (notes && typeof notes === 'string' && notes.trim()) {
    project.inputArtifacts.push({ kind: 'text', text: notes.trim() });
    changedArtifacts = true;
  }

  const files = normalizeUploadedFiles(req.files);
  for (const f of files) {
    project.inputArtifacts.push({
      kind: 'file',
      originalName: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
      storagePath: f.path
    });
    changedArtifacts = true;
  }

  if (changedArtifacts) {
    resetParseState(project, 'Artifacts changed. Re-parse required.');
    project.status = 'Pending';
    project.run.state = 'NotRun';
    project.run.finishedAt = null;
    project.run.error = '';
  }

  await project.save();
  res.json({
    success: true,
    artifactsCount: project.inputArtifacts.length,
    baselineInitialized: false,
    baselineCost: toFiniteNumber(project.metrics?.baselineCost, 0),
    baselineTimeMinutes: toFiniteNumber(project.metrics?.baselineTimeMinutes, 0),
    warnings: changedArtifacts ? ['Artifacts uploaded. Parsing will run when you start parse/run.'] : []
  });
});

// POST /api/projects/:id/parse-and-run
const parseAndRun = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error('Invalid project id');
  }

  const project = await Project.findById(id);
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  ensureOwner(project, req.user._id);
  const concurrentRun = await findConcurrentRun(req.user._id, project._id);
  if (concurrentRun) {
    const activeName = String(concurrentRun.name || '').trim();
    res.status(409);
    throw new Error(
      activeName
        ? `Another run is already in progress for "${activeName}". Wait for it to finish before starting a new run.`
        : 'Another run is already in progress. Wait for it to finish before starting a new run.'
    );
  }

  if (!Array.isArray(project.inputArtifacts)) project.inputArtifacts = [];
  if (!project.run) project.run = {};
  if (!project.parseReport) project.parseReport = {};
  if (!project.runConfig) project.runConfig = {};
  if (project.run.state === 'Running') {
    return res.status(202).json({
      success: false,
      message: 'Optimization already running for this project',
      run: project.run
    });
  }

  const optimizationIntensity = normalizeIntensity(
    req.body?.optimizationIntensity || project.runConfig.optimizationIntensity
  );
  const distanceMetric = normalizeDistanceMetric(
    req.body?.distanceMetric || project.runConfig.distanceMetric
  );
  const preferenceRelaxation = normalizePreferenceRelaxation(
    req.body?.preferenceRelaxation || project.runConfig.preferenceRelaxation
  );
  const computeTier = normalizeComputeTier(
    req.body?.computeTier || project.runConfig.computeTier
  );
  ensureComputeTierAllowed(req.user, computeTier);
  const runDate = normalizeRunDate(req.body?.runDate || project.runConfig.runDate);
  const { customMaxRunSeconds, customGenerations } = resolveCustomIntensityConfig(
    req.body,
    project.runConfig,
    optimizationIntensity
  );
  project.runConfig.optimizationIntensity = optimizationIntensity;
  project.runConfig.customMaxRunSeconds = customMaxRunSeconds;
  project.runConfig.customGenerations = customGenerations;
  project.runConfig.distanceMetric = distanceMetric;
  project.runConfig.preferenceRelaxation = preferenceRelaxation;
  project.runConfig.computeTier = computeTier;
  project.runConfig.runDate = runDate;

  project.status = 'Processing';
  project.run.state = 'Running';
  project.run.startedAt = new Date();
  project.run.finishedAt = null;
  project.run.error = '';
  await project.save();

  let parsed;
  try {
    parsed = await parseWithPythonRgx({ artifacts: project.inputArtifacts });
  } catch (e) {
    const message = e.message || 'Parser request failed';

    project.parseReport.model = 'python-rgx';
    project.parseReport.parsedAt = new Date();
    project.parseReport.status = 'failed';
    project.parseReport.confidence = 0;
    project.parseReport.missingRequired = [];
    project.parseReport.assumptions = [];
    project.parseReport.warnings = [message];
    project.parsedInput = null;
    project.results = null;
    applyBaselineMetrics(project, { baselineCost: 0, baselineTimeMinutes: 0 });
    project.status = 'Failed';
    project.run.state = 'Failed';
    project.run.finishedAt = new Date();
    project.run.error = message;
    await project.save();

    return res.status(502).json({
      success: false,
      error: message,
      parseReport: project.parseReport,
      optimizationIntensity,
      distanceMetric,
      preferenceRelaxation,
      computeTier,
      runDate: runDate ? runDate.toISOString() : null
    });
  }

  project.parseReport.model = parsed?.modelUsed || 'python-rgx';
  project.parseReport.parsedAt = new Date();
  project.parseReport.sanityChecks = parsed?.sanity_checks || parsed?.sanityChecks || null;

  if (!parsed || !parsed.canonical) {
    project.parseReport.status = 'failed';
    project.parseReport.confidence = 0;
    project.parseReport.missingRequired = parsed?.missing_required || [];
    project.parseReport.assumptions = parsed?.assumptions || [];
    project.parseReport.warnings = (parsed?.warnings || []).concat(['No canonical output']);
    project.parsedInput = null;
    project.results = null;
    applyBaselineMetrics(project, { baselineCost: 0, baselineTimeMinutes: 0 });

    project.status = 'Failed';
    project.run.state = 'Failed';
    project.run.finishedAt = new Date();
    project.run.error = 'Parser returned no canonical output';
    await project.save();

    res.status(400).json({
      success: false,
      parseReport: project.parseReport,
      optimizationIntensity,
      computeTier,
      runDate: runDate ? runDate.toISOString() : null
    });
    return;
  }

  const baselineSync = await syncComputedBaseline(parsed.canonical);

  // validate canonical JSON
  const { ok, errors, warnings } = validateCanonical(baselineSync.canonical);

  project.parsedInput = baselineSync.canonical;
  applyBaselineMetrics(project, baselineSync.totals);
  project.parseReport.status = parsed.status || (ok ? 'success' : 'needs_review');
  project.parseReport.confidence = parsed.confidence ?? 0;
  project.parseReport.missingRequired = parsed.missing_required || [];
  project.parseReport.assumptions = parsed.assumptions || [];
  project.parseReport.warnings = mergeUniqueStrings(
    parsed.warnings || [],
    warnings || [],
    ok ? [] : errors,
    baselineSync.warnings || []
  );
  await project.save();

  const missing = project.parseReport.missingRequired || [];
  if (!ok || missing.length > 0) {
    project.status = 'Pending';
    project.run.state = 'NotRun';
    project.run.finishedAt = null;
    project.run.error = '';
    await project.save();

    res.status(200).json({
      success: true,
      message: 'Parsed but needs review',
      parseReport: project.parseReport,
      parsedInput: project.parsedInput,
      optimizationIntensity,
      distanceMetric,
      preferenceRelaxation,
      computeTier,
      runDate: runDate ? runDate.toISOString() : null
    });
    return;
  }

  // run python engine
  try {
    const canonicalForRun = buildCanonicalForRun(project.parsedInput, {
      distanceMetric,
      preferenceRelaxation,
      computeTier
    });
    const runValidation = validateCanonical(canonicalForRun);
    project.parseReport.warnings = mergeUniqueStrings(
      project.parseReport.warnings || [],
      runValidation.warnings || []
    );
    if (!runValidation.ok) {
      project.status = 'Pending';
      project.run.state = 'NotRun';
      project.run.finishedAt = null;
      project.run.error = '';
      project.parseReport.warnings = mergeUniqueStrings(project.parseReport.warnings || [], runValidation.errors || []);
      await project.save();
      return res.status(400).json({
        success: false,
        error: 'Parsed testcase failed semantic validation before solve',
        validationErrors: runValidation.errors,
        optimizationIntensity,
        distanceMetric,
        preferenceRelaxation,
        computeTier,
        runDate: runDate ? runDate.toISOString() : null
      });
    }
    const engineResult = await runPythonEngine(canonicalForRun, {
      args: buildEngineArgs({
        optimizationIntensity,
        preferenceRelaxation,
        computeTier,
        customMaxRunSeconds,
        customGenerations,
      }),
      timeoutMs: engineTimeoutMsForTier(computeTier),
    });
    const { validationReport, outcome } = await persistRunOutcome(project, engineResult);

    res.json({
      success: outcome.projectStatus === 'Completed',
      projectId: project._id,
      status: project.status,
      solveStatus: engineResult?.status || null,
      runValidation: validationReport,
      message: outcome.error || null,
      optimizationIntensity,
      customMaxRunSeconds,
      customGenerations,
      distanceMetric,
      preferenceRelaxation,
      computeTier,
      runDate: runDate ? runDate.toISOString() : null
    });
  } catch (e) {
    project.status = 'Failed';
    project.run.state = 'Failed';
    project.run.finishedAt = new Date();
    project.run.error = e.message;
    await project.save();

    res.status(500).json({
      success: false,
      error: e.message,
      optimizationIntensity,
      customMaxRunSeconds,
      customGenerations,
      distanceMetric,
      preferenceRelaxation,
      computeTier,
      runDate: runDate ? runDate.toISOString() : null
    });
  }
});

// POST /api/projects/:id/parse-only
const parseOnly = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error('Invalid project id');
  }

  const project = await Project.findById(id);
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  ensureOwner(project, req.user._id);

  if (!Array.isArray(project.inputArtifacts)) project.inputArtifacts = [];
  if (!project.parseReport) project.parseReport = {};
  if (!project.run) project.run = {};
  if (!project.runConfig) project.runConfig = {};

  const optimizationIntensity = normalizeIntensity(
    req.body?.optimizationIntensity || project.runConfig.optimizationIntensity
  );
  const distanceMetric = normalizeDistanceMetric(
    req.body?.distanceMetric || project.runConfig.distanceMetric
  );
  const preferenceRelaxation = normalizePreferenceRelaxation(
    req.body?.preferenceRelaxation || project.runConfig.preferenceRelaxation
  );
  const computeTier = normalizeComputeTier(
    req.body?.computeTier || project.runConfig.computeTier
  );
  ensureComputeTierAllowed(req.user, computeTier);
  const runDate = normalizeRunDate(req.body?.runDate || project.runConfig.runDate);
  const { customMaxRunSeconds, customGenerations } = resolveCustomIntensityConfig(
    req.body,
    project.runConfig,
    optimizationIntensity
  );
  project.runConfig.optimizationIntensity = optimizationIntensity;
  project.runConfig.customMaxRunSeconds = customMaxRunSeconds;
  project.runConfig.customGenerations = customGenerations;
  project.runConfig.distanceMetric = distanceMetric;
  project.runConfig.preferenceRelaxation = preferenceRelaxation;
  project.runConfig.computeTier = computeTier;
  project.runConfig.runDate = runDate;

  let parsed;
  try {
    parsed = await parseWithPythonRgx({ artifacts: project.inputArtifacts });
  } catch (e) {
    const message = e.message || 'Parser request failed';

    project.parseReport.model = 'python-rgx';
    project.parseReport.parsedAt = new Date();
    project.parseReport.status = 'failed';
    project.parseReport.confidence = 0;
    project.parseReport.missingRequired = [];
    project.parseReport.assumptions = [];
    project.parseReport.warnings = [message];
    project.parsedInput = null;
    applyBaselineMetrics(project, { baselineCost: 0, baselineTimeMinutes: 0 });
    project.status = 'Failed';
    project.run.state = 'NotRun';
    project.run.error = message;
    await project.save();

    return res.status(502).json({
      success: false,
      error: message,
      parseReport: project.parseReport,
      optimizationIntensity,
      customMaxRunSeconds,
      customGenerations,
      distanceMetric,
      preferenceRelaxation,
      computeTier,
      runDate: runDate ? runDate.toISOString() : null
    });
  }

  project.parseReport.model = parsed?.modelUsed || 'python-rgx';
  project.parseReport.parsedAt = new Date();
  project.parseReport.sanityChecks = parsed?.sanity_checks || parsed?.sanityChecks || null;

  if (!parsed || !parsed.canonical) {
    project.parseReport.status = 'failed';
    project.parseReport.confidence = 0;
    project.parseReport.missingRequired = parsed?.missing_required || [];
    project.parseReport.assumptions = parsed?.assumptions || [];
    project.parseReport.warnings = (parsed?.warnings || []).concat(['No canonical output']);
    project.parsedInput = null;
    applyBaselineMetrics(project, { baselineCost: 0, baselineTimeMinutes: 0 });
    project.status = 'Failed';
    project.run.state = 'NotRun';
    await project.save();

    res.status(400).json({
      success: false,
      parseReport: project.parseReport,
      optimizationIntensity,
      customMaxRunSeconds,
      customGenerations,
      distanceMetric,
      preferenceRelaxation,
      computeTier,
      runDate: runDate ? runDate.toISOString() : null
    });
    return;
  }

  const baselineSync = await syncComputedBaseline(parsed.canonical);
  const { ok, errors, warnings } = validateCanonical(baselineSync.canonical);

  project.parsedInput = baselineSync.canonical;
  applyBaselineMetrics(project, baselineSync.totals);
  project.parseReport.status = parsed.status || (ok ? 'success' : 'needs_review');
  project.parseReport.confidence = parsed.confidence ?? 0;
  project.parseReport.missingRequired = parsed.missing_required || [];
  project.parseReport.assumptions = parsed.assumptions || [];
  project.parseReport.warnings = mergeUniqueStrings(
    parsed.warnings || [],
    warnings || [],
    ok ? [] : errors,
    baselineSync.warnings || []
  );
  project.status = 'Pending';
  project.run.state = 'NotRun';
  project.run.error = '';
  await project.save();

  res.json({
    success: true,
    message: 'Parsed successfully',
    parseReport: project.parseReport,
    parsedInput: project.parsedInput,
    optimizationIntensity,
    customMaxRunSeconds,
    customGenerations,
    distanceMetric,
    preferenceRelaxation,
    computeTier,
    runDate: runDate ? runDate.toISOString() : null
  });
});

// POST /api/projects/:id/run-solver
const runSolver = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error('Invalid project id');
  }

  const project = await Project.findById(id);
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  ensureOwner(project, req.user._id);
  const concurrentRun = await findConcurrentRun(req.user._id, project._id);
  if (concurrentRun) {
    const activeName = String(concurrentRun.name || '').trim();
    res.status(409);
    throw new Error(
      activeName
        ? `Another run is already in progress for "${activeName}". Wait for it to finish before starting a new run.`
        : 'Another run is already in progress. Wait for it to finish before starting a new run.'
    );
  }

  if (!project.parsedInput) {
    res.status(400);
    throw new Error('No parsed testcase found. Parse testcase first.');
  }

  if (!project.run) project.run = {};
  if (!project.runConfig) project.runConfig = {};
  if (project.run.state === 'Running') {
    return res.status(202).json({
      success: false,
      message: 'Optimization already running for this project',
      run: project.run
    });
  }

  const optimizationIntensity = normalizeIntensity(
    req.body?.optimizationIntensity || project.runConfig.optimizationIntensity
  );
  const distanceMetric = normalizeDistanceMetric(
    req.body?.distanceMetric || project.runConfig.distanceMetric
  );
  const preferenceRelaxation = normalizePreferenceRelaxation(
    req.body?.preferenceRelaxation || project.runConfig.preferenceRelaxation
  );
  const computeTier = normalizeComputeTier(
    req.body?.computeTier || project.runConfig.computeTier
  );
  ensureComputeTierAllowed(req.user, computeTier);
  const runDate = normalizeRunDate(req.body?.runDate || project.runConfig.runDate);
  const { customMaxRunSeconds, customGenerations } = resolveCustomIntensityConfig(
    req.body,
    project.runConfig,
    optimizationIntensity
  );
  project.runConfig.optimizationIntensity = optimizationIntensity;
  project.runConfig.customMaxRunSeconds = customMaxRunSeconds;
  project.runConfig.customGenerations = customGenerations;
  project.runConfig.distanceMetric = distanceMetric;
  project.runConfig.preferenceRelaxation = preferenceRelaxation;
  project.runConfig.computeTier = computeTier;
  project.runConfig.runDate = runDate;

  project.status = 'Processing';
  project.run.state = 'Running';
  project.run.startedAt = new Date();
  project.run.finishedAt = null;
  project.run.error = '';
  await project.save();

  try {
    const baselineSync = await syncComputedBaseline(project.parsedInput);
    project.parsedInput = baselineSync.canonical;
    applyBaselineMetrics(project, baselineSync.totals);
    project.parseReport = project.parseReport || {};
    project.parseReport.warnings = mergeUniqueStrings(
      project.parseReport.warnings || [],
      baselineSync.warnings || []
    );

    const canonicalForRun = buildCanonicalForRun(project.parsedInput, {
      distanceMetric,
      preferenceRelaxation,
      computeTier
    });
    const runValidation = validateCanonical(canonicalForRun);
    project.parseReport.warnings = mergeUniqueStrings(
      project.parseReport.warnings || [],
      runValidation.warnings || []
    );
    if (!runValidation.ok) {
      project.status = 'Pending';
      project.run.state = 'NotRun';
      project.run.finishedAt = null;
      project.run.error = '';
      project.parseReport = project.parseReport || {};
      project.parseReport.warnings = mergeUniqueStrings(project.parseReport.warnings || [], runValidation.errors || []);
      await project.save();
      return res.status(400).json({
        success: false,
        error: 'Parsed testcase failed semantic validation before solve',
        validationErrors: runValidation.errors,
        optimizationIntensity,
        distanceMetric,
        preferenceRelaxation,
        computeTier,
        runDate: runDate ? runDate.toISOString() : null
      });
    }
    const engineResult = await runPythonEngine(canonicalForRun, {
      args: buildEngineArgs({
        optimizationIntensity,
        preferenceRelaxation,
        computeTier,
        customMaxRunSeconds,
        customGenerations,
      }),
      timeoutMs: engineTimeoutMsForTier(computeTier),
    });
    const { validationReport, outcome } = await persistRunOutcome(project, engineResult);

    res.json({
      success: outcome.projectStatus === 'Completed',
      projectId: project._id,
      status: project.status,
      solveStatus: engineResult?.status || null,
      runValidation: validationReport,
      message: outcome.error || null,
      optimizationIntensity,
      customMaxRunSeconds,
      customGenerations,
      distanceMetric,
      preferenceRelaxation,
      computeTier,
      runDate: runDate ? runDate.toISOString() : null
    });
  } catch (e) {
    project.status = 'Failed';
    project.run.state = 'Failed';
    project.run.finishedAt = new Date();
    project.run.error = e.message;
    await project.save();

    res.status(500).json({
      success: false,
      error: e.message,
      optimizationIntensity,
      customMaxRunSeconds,
      customGenerations,
      distanceMetric,
      preferenceRelaxation,
      computeTier,
      runDate: runDate ? runDate.toISOString() : null
    });
  }
});

// GET /api/projects/:id/input
const getParsedInput = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error('Invalid project id');
  }

  const project = await Project.findById(id);
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  ensureOwner(project, req.user._id);

  const fileName = project.inputArtifacts?.length > 0 
    ? project.inputArtifacts[project.inputArtifacts.length - 1].originalName 
    : null;
  
  res.json({ 
    parseReport: project.parseReport || null, 
    parsedInput: project.parsedInput || null,
    fileName 
  });
});

// GET /api/projects/:id/results
const getResults = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error('Invalid project id');
  }

  await reconcileStaleRuns({ _id: id, user: req.user._id });

  const project = await Project.findById(id);
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  ensureOwner(project, req.user._id);

  res.json({
    status: project.status,
    run: project.run || null,
    runConfig: project.runConfig || null,
    runValidation: project.runValidation || null,
    metrics: project.metrics || null,
    results: project.results || null
  });
});

// GET /api/projects/:id/compare-runs
const getCompareRuns = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error('Invalid project id');
  }

  const project = await Project.findById(id);
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  ensureOwner(project, req.user._id);

  const results = project.results || {};
  const solverRuns = Array.isArray(results?.solverRuns)
    ? results.solverRuns
    : (Array.isArray(results?.solverRunsByOrder) ? results.solverRunsByOrder : []);
  const objectiveTrend = Array.isArray(results?.objectiveTrend) ? results.objectiveTrend : [];

  res.json({
    status: project.status,
    run: project.run || null,
    solverRuns,
    objectiveTrend,
    solverConfig: results?.solverConfig || null
  });
});

// POST /api/projects/:id/validate-run
const validateRun = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error('Invalid project id');
  }

  const project = await Project.findById(id);
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  ensureOwner(project, req.user._id);

  if (!project.runValidation) project.runValidation = {};
  if (project.runValidation.status === 'Running') {
    return res.status(202).json({
      success: true,
      message: 'Validation already running',
      runValidation: project.runValidation
    });
  }

  project.runValidation.status = 'Running';
  project.runValidation.requestedAt = new Date();
  project.runValidation.finishedAt = null;
  project.runValidation.message = 'Validation in progress';
  project.runValidation.checks = [];
  await project.save();

  // Fire-and-forget background validation
  setImmediate(async () => {
    try {
      const fresh = await Project.findById(id);
      if (!fresh) return;

      // Run the Python validation script
      const { spawn } = require('child_process');
      const path = require('path');
      const scriptPath = path.join(__dirname, '../engine/validate_distance.py');
      
      const pythonProcess = spawn(process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3'), [scriptPath]);
      
      let output = '';
      let errorOutput = '';
      
      pythonProcess.stdout.on('data', (data) => {
        output += data.toString();
        console.log('Validation output:', data.toString());
      });
      
      pythonProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
        console.error('Validation error:', data.toString());
      });
      
      pythonProcess.on('close', async (code) => {
        try {
          const freshProject = await Project.findById(id);
          if (!freshProject) return;
          
          if (code === 0) {
            // Also run the existing validation checks
            const report = validateRunOutput(freshProject);
            freshProject.runValidation.status = report.passed ? 'Passed' : 'Failed';
            freshProject.runValidation.finishedAt = new Date();
            freshProject.runValidation.score = report.score;
            freshProject.runValidation.message = report.message;
            freshProject.runValidation.checks = report.checks;
            freshProject.runValidation.pythonOutput = output;
          } else {
            freshProject.runValidation.status = 'Failed';
            freshProject.runValidation.finishedAt = new Date();
            freshProject.runValidation.message = `Python validation failed with code ${code}`;
            freshProject.runValidation.checks = [];
            freshProject.runValidation.pythonOutput = output;
            freshProject.runValidation.pythonError = errorOutput;
          }
          
          await freshProject.save();
        } catch (e) {
          console.error('Error saving validation result:', e);
        }
      });
    } catch (e) {
      try {
        const fresh = await Project.findById(id);
        if (!fresh) return;
        fresh.runValidation.status = 'Failed';
        fresh.runValidation.finishedAt = new Date();
        fresh.runValidation.message = `Validation error: ${e.message}`;
        fresh.runValidation.checks = [];
        await fresh.save();
      } catch (_) {}
    }
  });

  return res.status(202).json({
    success: true,
    message: 'Validation started',
    runValidation: project.runValidation
  });
});

module.exports = {
  ingestArtifacts,
  parseAndRun,
  parseOnly,
  runSolver,
  getParsedInput,
  getResults,
  getCompareRuns,
  validateRun
};
