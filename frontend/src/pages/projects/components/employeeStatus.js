function normalizeEmployeeStatus(rawStatus) {
  const normalized = String(rawStatus || '').trim().toLowerCase();
  if (!normalized) return 'Waiting';
  if (normalized === 'picked up' || normalized === 'picked_up' || normalized === 'onboard') return 'Picked Up';
  if (normalized === 'assigned') return 'Assigned';
  if (normalized === 'dropped' || normalized === 'dropoff' || normalized === 'completed') return 'Dropped';
  if (normalized === 'issue' || normalized === 'error' || normalized === 'failed') return 'Issue';
  if (normalized === 'unassigned') return 'Unassigned';
  if (normalized === 'waiting' || normalized === 'pending') return 'Waiting';
  return String(rawStatus || 'Waiting');
}

function isEmployeeActive(rawStatus) {
  return normalizeEmployeeStatus(rawStatus) === 'Picked Up';
}

function getEmployeeStatusMeta(rawStatus) {
  const status = normalizeEmployeeStatus(rawStatus);
  if (status === 'Picked Up') {
    return {
      status,
      badgeLabel: 'Onboard',
      background: 'rgba(74, 222, 128, 0.15)',
      color: '#4ade80',
      border: 'rgba(74, 222, 128, 0.3)',
    };
  }
  if (status === 'Assigned') {
    return {
      status,
      badgeLabel: 'Assigned',
      background: 'rgba(96, 165, 250, 0.15)',
      color: '#60a5fa',
      border: 'rgba(96, 165, 250, 0.3)',
    };
  }
  if (status === 'Dropped') {
    return {
      status,
      badgeLabel: 'Dropped',
      background: 'rgba(56, 189, 248, 0.14)',
      color: '#67e8f9',
      border: 'rgba(103, 232, 249, 0.28)',
    };
  }
  if (status === 'Issue') {
    return {
      status,
      badgeLabel: 'Issue',
      background: 'rgba(248, 113, 113, 0.16)',
      color: '#fca5a5',
      border: 'rgba(248, 113, 113, 0.3)',
    };
  }
  if (status === 'Unassigned') {
    return {
      status,
      badgeLabel: 'Unassigned',
      background: 'rgba(250, 204, 21, 0.16)',
      color: '#fcd34d',
      border: 'rgba(250, 204, 21, 0.3)',
    };
  }
  return {
    status: 'Waiting',
    badgeLabel: 'Waiting',
    background: 'rgba(148, 163, 184, 0.15)',
    color: '#cbd5e1',
    border: 'rgba(148, 163, 184, 0.28)',
  };
}

export {
  getEmployeeStatusMeta,
  isEmployeeActive,
  normalizeEmployeeStatus,
};
