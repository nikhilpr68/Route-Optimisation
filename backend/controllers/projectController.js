const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const mongoose = require('mongoose');

const Project = require('../models/Project');
const Vehicle = require('../models/Vehicle');
const Ride = require('../models/Ride');
const { reconcileStaleRuns } = require('../services/runRecovery');

const PROJECT_LIST_FIELDS = [
  '_id',
  'name',
  'status',
  'metrics',
  'run',
  'runConfig',
  'runValidation',
  'inputArtifacts.createdAt',
  'inputArtifacts.originalName',
  'parsedInput.employees',
  'results.rides.path.type',
  'results.rides.path.arrivalMinute',
  'results.rides.path.departureMinute',
  'createdAt'
].join(' ');

function parseTimeToMinutes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

function getLifecycleTimeRange(project) {
  const rides = Array.isArray(project?.results?.rides) ? project.results.rides : [];
  let earliestTime = Infinity;
  let latestTime = -Infinity;

  rides.forEach((ride) => {
    const path = Array.isArray(ride?.path) ? ride.path : [];
    path.forEach((stop) => {
      if (stop?.type !== 'pickup' && stop?.type !== 'dropoff') return;
      const arrivalMinute = Number(stop?.arrivalMinute);
      const departureMinute = Number(stop?.departureMinute);

      if (Number.isFinite(arrivalMinute)) {
        earliestTime = Math.min(earliestTime, arrivalMinute);
        latestTime = Math.max(latestTime, arrivalMinute);
      }
      if (Number.isFinite(departureMinute)) {
        earliestTime = Math.min(earliestTime, departureMinute);
        latestTime = Math.max(latestTime, departureMinute);
      }
    });
  });

  if (earliestTime !== Infinity && latestTime !== -Infinity) {
    return { earliestTime, latestTime, source: 'results' };
  }

  const employees = Array.isArray(project?.parsedInput?.employees) ? project.parsedInput.employees : [];
  employees.forEach((employee) => {
    const timeWindow = employee?.time_window || employee?.timeWindow || {};
    const start = parseTimeToMinutes(timeWindow?.start ?? employee?.earliest_pickup ?? employee?.earliestPickup);
    const end = parseTimeToMinutes(timeWindow?.end ?? employee?.latest_drop ?? employee?.latestDrop);

    if (Number.isFinite(start)) earliestTime = Math.min(earliestTime, start);
    if (Number.isFinite(end)) latestTime = Math.max(latestTime, end);
  });

  if (earliestTime !== Infinity && latestTime !== -Infinity) {
    return { earliestTime, latestTime, source: 'input' };
  }

  return null;
}

function summarizeProject(project) {
  if (!project) return project;
  const summary = { ...project };
  summary.lifecycleTimeRange = getLifecycleTimeRange(project);
  delete summary.parsedInput;
  delete summary.results;
  return summary;
}

function ensureValidProjectId(id, res) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error('Invalid project id');
  }
}

function parseProjectIds(ids = []) {
  if (!Array.isArray(ids) || !ids.length) {
    return [];
  }

  const uniqueIds = Array.from(new Set(
    ids
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  ));

  uniqueIds.forEach((id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error(`Invalid project id: ${id}`);
    }
  });

  return uniqueIds.map((id) => new mongoose.Types.ObjectId(id));
}

function ensureOwner(project, userId, res) {
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }

  if (project.user.toString() !== userId.toString()) {
    res.status(403);
    throw new Error('Forbidden');
  }
}

function buildShareUrl(req, token) {
  const explicitBaseUrl = String(
    process.env.PUBLIC_FRONTEND_URL ||
    process.env.FRONTEND_URL ||
    ''
  ).trim().replace(/\/+$/, '');

  const baseUrl = explicitBaseUrl || String(req.get('origin') || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return `/shared/projects/${token}/map-view`;
  return `${baseUrl}/shared/projects/${token}/map-view`;
}

function buildShareResponse(req, project) {
  const share = project?.share || {};
  const enabled = Boolean(share.enabled && share.token);

  return {
    enabled,
    token: enabled ? share.token : null,
    createdAt: enabled ? share.createdAt || null : null,
    lastAccessedAt: enabled ? share.lastAccessedAt || null : null,
    shareUrl: enabled ? buildShareUrl(req, share.token) : null
  };
}

function getLatestArtifactFileName(project) {
  const artifacts = Array.isArray(project?.inputArtifacts) ? project.inputArtifacts : [];
  if (!artifacts.length) return null;
  return artifacts[artifacts.length - 1]?.originalName || null;
}

function buildPublicProjectPayload(project) {
  return {
    id: project._id,
    name: project.name,
    status: project.status,
    createdAt: project.createdAt,
    sharedAt: project?.share?.createdAt || null,
    fileName: getLatestArtifactFileName(project),
    parseReport: project.parseReport || null,
    parsedInput: project.parsedInput || null,
    run: project.run || null,
    runConfig: project.runConfig || null,
    runValidation: project.runValidation || null,
    metrics: project.metrics || null,
    results: project.results || null
  };
}

async function generateUniqueShareToken() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = crypto.randomBytes(24).toString('hex');
    const existing = await Project.exists({ 'share.token': token });
    if (!existing) return token;
  }
  throw new Error('Unable to generate a unique share token');
}

// POST /api/projects
// Create an empty project (dashboard-first workflow)
const createProject = asyncHandler(async (req, res) => {
  const { name } = req.body || {};

  if (!name || !name.trim()) {
    res.status(400);
    throw new Error('Project name is required');
  }

  const project = await Project.create({
    user: req.user._id,
    name: name.trim(),
    status: 'Pending',
    requests: [],
    metrics: {
      totalSystemCost: 0,
      totalDistance: 0,
      baselineCost: 0,
      savings: 0,
      savingsPercent: 0
    }
  });

  const summary = summarizeProject(
    await Project.findById(project._id).select(PROJECT_LIST_FIELDS).lean()
  );
  res.status(201).json(summary);
});

// GET /api/projects?limit=<n>&page=<n>
const listMyProjects = asyncHandler(async (req, res) => {
  await reconcileStaleRuns({ user: req.user._id });

  const hasLimit = req.query.limit !== undefined;
  const parsedLimit = parseInt(req.query.limit || '0', 10);
  const limit = hasLimit && Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 500)
    : null;
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const skip = limit ? (page - 1) * limit : 0;

  const query = Project.find({ user: req.user._id })
    .select(PROJECT_LIST_FIELDS)
    .sort({ createdAt: -1 })
    .lean();
  if (limit) {
    query.skip(skip).limit(limit);
  }
  const [items, total] = await Promise.all([
    query,
    Project.countDocuments({ user: req.user._id })
  ]);

  res.json({
    items: items.map((item) => summarizeProject(item)),
    page: limit ? page : 1,
    limit: limit || items.length,
    total,
    totalPages: limit ? Math.ceil(total / limit) : 1
  });
});

// GET /api/projects/:id
const getProjectById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  ensureValidProjectId(id, res);
  await reconcileStaleRuns({ _id: id, user: req.user._id });

  const project = await Project.findById(id);
  ensureOwner(project, req.user._id, res);

  const summary = summarizeProject(
    await Project.findById(project._id).select(PROJECT_LIST_FIELDS).lean()
  );
  res.json(summary);
});

// PUT /api/projects/:id
const updateProject = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name } = req.body || {};

  ensureValidProjectId(id, res);

  if (!name || !name.trim()) {
    res.status(400);
    throw new Error('Project name is required');
  }

  const project = await Project.findById(id);
  ensureOwner(project, req.user._id, res);

  project.name = name.trim();
  await project.save();

  const summary = summarizeProject(
    await Project.findById(project._id).select(PROJECT_LIST_FIELDS).lean()
  );
  res.json(summary);
});

// DELETE /api/projects/:id
// Also deletes Vehicles + Rides under that project
const deleteProject = asyncHandler(async (req, res) => {
  const { id } = req.params;
  ensureValidProjectId(id, res);

  const project = await Project.findById(id);
  ensureOwner(project, req.user._id, res);

  await Vehicle.deleteMany({ project: project._id });
  await Ride.deleteMany({ project: project._id });
  await Project.deleteOne({ _id: project._id });

  res.json({ success: true });
});

// POST /api/projects/bulk-delete
// Deletes multiple owned projects plus Vehicles + Rides in batch
const bulkDeleteProjects = asyncHandler(async (req, res) => {
  let projectIds;
  try {
    projectIds = parseProjectIds(req.body?.projectIds);
  } catch (error) {
    res.status(400);
    throw error;
  }

  if (!projectIds.length) {
    res.status(400);
    throw new Error('At least one project id is required');
  }

  const ownedProjects = await Project.find({
    _id: { $in: projectIds },
    user: req.user._id
  }).select('_id').lean();

  const ownedProjectIds = ownedProjects.map((project) => project._id);
  if (!ownedProjectIds.length) {
    res.status(404);
    throw new Error('No matching projects found');
  }

  await Vehicle.deleteMany({ project: { $in: ownedProjectIds } });
  await Ride.deleteMany({ project: { $in: ownedProjectIds } });
  const deleteResult = await Project.deleteMany({ _id: { $in: ownedProjectIds }, user: req.user._id });

  res.json({
    success: true,
    deletedCount: deleteResult.deletedCount || ownedProjectIds.length,
  });
});

// GET /api/projects/:id/share
const getProjectShare = asyncHandler(async (req, res) => {
  const { id } = req.params;
  ensureValidProjectId(id, res);

  const project = await Project.findById(id);
  ensureOwner(project, req.user._id, res);

  res.json(buildShareResponse(req, project));
});

// POST /api/projects/:id/share
const createProjectShare = asyncHandler(async (req, res) => {
  const { id } = req.params;
  ensureValidProjectId(id, res);

  const project = await Project.findById(id);
  ensureOwner(project, req.user._id, res);

  if (!project.share?.token) {
    project.share.token = await generateUniqueShareToken();
  }

  project.share.enabled = true;
  project.share.createdAt = new Date();
  await project.save();

  res.json(buildShareResponse(req, project));
});

// DELETE /api/projects/:id/share
const revokeProjectShare = asyncHandler(async (req, res) => {
  const { id } = req.params;
  ensureValidProjectId(id, res);

  const project = await Project.findById(id);
  ensureOwner(project, req.user._id, res);

  project.share.enabled = false;
  project.share.token = null;
  project.share.createdAt = null;
  project.share.lastAccessedAt = null;
  await project.save();

  res.json(buildShareResponse(req, project));
});

// GET /api/shared/projects/:token
const getSharedProjectByToken = asyncHandler(async (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) {
    res.status(400);
    throw new Error('Share token is required');
  }

  const project = await Project.findOne({
    'share.token': token,
    'share.enabled': true
  });

  if (!project) {
    res.status(404);
    throw new Error('Shared project not found');
  }

  project.share.lastAccessedAt = new Date();
  await project.save();

  res.json(buildPublicProjectPayload(project));
});

module.exports = {
  createProject,
  listMyProjects,
  getProjectById,
  updateProject,
  deleteProject,
  bulkDeleteProjects,
  getProjectShare,
  createProjectShare,
  revokeProjectShare,
  getSharedProjectByToken
};
