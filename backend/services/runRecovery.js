const Project = require('../models/Project');

function timeoutMsForProject(project) {
  const computeTier = String(project?.runConfig?.computeTier || 'free').trim().toLowerCase();
  if (computeTier === 'premium') return 35 * 60 * 1000;
  return 20 * 60 * 1000;
}

function isProjectRunStale(project, now = Date.now()) {
  if (String(project?.status || '') !== 'Processing') return false;
  if (String(project?.run?.state || '') !== 'Running') return false;

  const startedAt = project?.run?.startedAt ? new Date(project.run.startedAt).getTime() : NaN;
  if (!Number.isFinite(startedAt)) return true;

  return (now - startedAt) > timeoutMsForProject(project);
}

async function markProjectFailed(project, reason) {
  project.status = 'Failed';
  if (!project.run) project.run = {};
  project.run.state = 'Failed';
  project.run.finishedAt = new Date();
  project.run.error = reason;

  if (project.runValidation?.status === 'Running') {
    project.runValidation.status = 'Failed';
    project.runValidation.finishedAt = new Date();
    project.runValidation.message = reason;
    project.runValidation.checks = [];
  }

  await project.save();
  return project;
}

async function reconcileStaleRuns(filter = {}) {
  const query = {
    status: 'Processing',
    'run.state': 'Running',
    ...filter,
  };
  const candidates = await Project.find(query);
  const now = Date.now();
  const updated = [];

  for (const project of candidates) {
    if (!isProjectRunStale(project, now)) continue;
    const reason = 'Run interrupted or timed out before completion';
    await markProjectFailed(project, reason);
    updated.push(project._id.toString());
  }

  return updated;
}

function startRunRecoveryMonitor() {
  const intervalMs = Math.max(30 * 1000, Number(process.env.RUN_RECOVERY_INTERVAL_MS) || 60 * 1000);

  const tick = async () => {
    try {
      const updated = await reconcileStaleRuns();
      if (updated.length > 0) {
        console.warn(`Recovered ${updated.length} stale run(s): ${updated.join(', ')}`);
      }
    } catch (error) {
      console.error('Run recovery monitor failed:', error);
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  void tick();
  return timer;
}

module.exports = {
  reconcileStaleRuns,
  startRunRecoveryMonitor,
};
