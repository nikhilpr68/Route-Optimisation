const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const mongoose = require('mongoose');

const Project = require('../models/Project');
const Team = require('../models/Team');
const User = require('../models/User');

const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TEAM_POPULATION = [
  { path: 'createdBy', select: 'name email profileImage' },
  { path: 'members.user', select: 'name email profileImage' },
  { path: 'sharedProjects.project', select: 'name status createdAt' },
  { path: 'sharedProjects.sharedBy', select: 'name email profileImage' },
  { path: 'assignments.createdBy', select: 'name email profileImage' },
  { path: 'assignments.driverUser', select: 'name email profileImage' },
  { path: 'assignments.employeeAssignments.user', select: 'name email profileImage' },
  { path: 'messages.sender', select: 'name email profileImage' },
];
const NON_EMPLOYEE_STOP_LABELS = new Set([
  'company',
  'office',
  'hq',
  'head office',
  'head_office',
]);
const ASSIGNMENT_ROLES = new Set(['employee', 'driver', 'both', 'unassigned']);
const TEAM_ROLES = new Set(['admin', 'member']);

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || '').trim());
}

function ensureValidObjectId(value, label, res) {
  if (!isValidObjectId(value)) {
    res.status(400);
    throw new Error(`Invalid ${label}`);
  }
}

function asId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function sameId(left, right) {
  return asId(left) && asId(left) === asId(right);
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeJoinCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeAssignmentRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ASSIGNMENT_ROLES.has(normalized) ? normalized : null;
}

function normalizeTeamRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return TEAM_ROLES.has(normalized) ? normalized : null;
}

function normalizeStopType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'pickup') return 'pickup';
  if (normalized === 'dropoff' || normalized === 'drop') return 'dropoff';
  return 'stop';
}

function isNonEmployeeStopLabel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized ? NON_EMPLOYEE_STOP_LABELS.has(normalized) : false;
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPoint(source) {
  if (!source || typeof source !== 'object') return null;
  const lat = toFiniteNumber(source.lat ?? source.latitude ?? source.pickupLat ?? source.startLat);
  const lng = toFiniteNumber(source.lng ?? source.longitude ?? source.pickupLng ?? source.startLng);
  const nested = source.location && typeof source.location === 'object' ? source.location : null;
  const nestedLat = lat ?? toFiniteNumber(nested?.lat ?? nested?.latitude);
  const nestedLng = lng ?? toFiniteNumber(nested?.lng ?? nested?.longitude);
  if (!Number.isFinite(nestedLat) || !Number.isFinite(nestedLng)) return null;
  return {
    lat: nestedLat,
    lng: nestedLng,
    address: normalizeText(
      source.address
      || source.formattedAddress
      || nested?.address
      || nested?.formattedAddress,
      320
    ),
  };
}

function parseClockToMinutes(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

function normalizeClock(value) {
  if (!value) return '';
  const minutes = parseClockToMinutes(String(value));
  if (minutes === null) return null;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function minuteToClock(value) {
  const minute = toFiniteNumber(value);
  if (!Number.isFinite(minute)) return '';
  const normalized = ((Math.round(minute) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const remainder = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function buildJoinCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let idx = 0; idx < 8; idx += 1) {
    code += JOIN_CODE_ALPHABET[bytes[idx] % JOIN_CODE_ALPHABET.length];
  }
  return code;
}

async function generateUniqueJoinCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const joinCode = buildJoinCode();
    const existing = await Team.exists({ joinCode });
    if (!existing) return joinCode;
  }
  throw new Error('Unable to generate a unique team code');
}

function serializeUser(user) {
  if (!user) return null;
  return {
    _id: asId(user),
    name: normalizeText(user.name, 120) || 'User',
    email: normalizeText(user.email, 160),
    profileImage: normalizeText(user.profileImage, 600),
  };
}

function requireMembership(team, userId, res) {
  if (!team) {
    res.status(404);
    throw new Error('Team not found');
  }
  const membership = Array.isArray(team.members)
    ? team.members.find((member) => sameId(member.user, userId))
    : null;
  if (!membership) {
    res.status(403);
    throw new Error('You are not a member of this team');
  }
  return membership;
}

function requireAdmin(team, userId, res) {
  const membership = requireMembership(team, userId, res);
  if (sameId(team.createdBy, userId)) return membership;
  if (String(membership.teamRole || '') !== 'admin') {
    res.status(403);
    throw new Error('Admin access is required for this action');
  }
  return membership;
}

function serializeMember(member, currentUserId) {
  return {
    user: serializeUser(member?.user),
    teamRole: String(member?.teamRole || 'member'),
    assignmentRole: String(member?.assignmentRole || 'unassigned'),
    title: normalizeText(member?.title, 120),
    joinedAt: member?.joinedAt || null,
    isCurrentUser: sameId(member?.user, currentUserId),
  };
}

function serializeMessage(message, currentUserId) {
  return {
    _id: asId(message?._id),
    sender: serializeUser(message?.sender),
    text: normalizeText(message?.text, 1200),
    createdAt: message?.createdAt || null,
    isMine: sameId(message?.sender, currentUserId),
  };
}

function serializeEmployeeAssignment(assignment, currentUserId) {
  return {
    routeEmployeeId: normalizeText(assignment?.routeEmployeeId, 120),
    user: serializeUser(assignment?.user),
    pickupStopIndex: toFiniteNumber(assignment?.pickupStopIndex),
    dropStopIndex: toFiniteNumber(assignment?.dropStopIndex),
    pickupMinute: toFiniteNumber(assignment?.pickupMinute),
    dropMinute: toFiniteNumber(assignment?.dropMinute),
    pickup: assignment?.pickup || null,
    dropoff: assignment?.dropoff || null,
    isCurrentUser: sameId(assignment?.user, currentUserId),
  };
}

function serializeAssignment(assignment, currentUserId) {
  const employeeAssignments = (Array.isArray(assignment?.employeeAssignments)
    ? assignment.employeeAssignments
    : []
  ).map((item) => serializeEmployeeAssignment(item, currentUserId));
  const myEmployeeAssignments = employeeAssignments.filter((item) => item.isCurrentUser);
  const isDriver = sameId(assignment?.driverUser, currentUserId);
  let myRole = 'viewer';
  if (isDriver && myEmployeeAssignments.length) myRole = 'driver-employee';
  else if (isDriver) myRole = 'driver';
  else if (myEmployeeAssignments.length) myRole = 'employee';

  return {
    _id: asId(assignment?._id),
    title: normalizeText(assignment?.title, 180),
    projectId: asId(assignment?.project),
    projectName: normalizeText(assignment?.projectName, 180),
    vehicleId: normalizeText(assignment?.vehicleId, 120),
    assignmentDate: assignment?.assignmentDate || null,
    reportAt: normalizeText(assignment?.reportAt, 16),
    endAt: normalizeText(assignment?.endAt, 16),
    notes: normalizeText(assignment?.notes, 1200),
    startLocation: assignment?.startLocation || null,
    routeMetrics: assignment?.routeMetrics || null,
    routePath: Array.isArray(assignment?.routePath) ? assignment.routePath : [],
    driver: serializeUser(assignment?.driverUser),
    employeeAssignments,
    createdBy: serializeUser(assignment?.createdBy),
    createdAt: assignment?.createdAt || null,
    myRole,
    myEmployeeAssignments,
  };
}

function serializeSharedProject(sharedProject) {
  const project = sharedProject?.project;
  return {
    _id: asId(sharedProject?._id),
    projectId: asId(project || sharedProject?.project),
    name: normalizeText(project?.name || sharedProject?.projectName, 180),
    status: normalizeText(project?.status, 60),
    projectCreatedAt: project?.createdAt || null,
    sharedAt: sharedProject?.sharedAt || null,
    sharedBy: serializeUser(sharedProject?.sharedBy),
  };
}

function serializeTeamSummary(team, currentUserId) {
  const members = Array.isArray(team?.members) ? team.members : [];
  const currentMembership = members.find((member) => sameId(member?.user, currentUserId)) || null;
  const upcomingAssignmentCount = (Array.isArray(team?.assignments) ? team.assignments : [])
    .filter((assignment) => {
      const date = assignment?.assignmentDate ? new Date(assignment.assignmentDate) : null;
      return date && !Number.isNaN(date.getTime()) && date >= new Date(new Date().toDateString());
    })
    .length;

  return {
    _id: asId(team?._id),
    name: normalizeText(team?.name, 160),
    description: normalizeText(team?.description, 600),
    joinCode: normalizeJoinCode(team?.joinCode),
    createdAt: team?.createdAt || null,
    updatedAt: team?.updatedAt || null,
    createdBy: serializeUser(team?.createdBy),
    memberCount: members.length,
    assignmentCount: Array.isArray(team?.assignments) ? team.assignments.length : 0,
    sharedProjectCount: Array.isArray(team?.sharedProjects) ? team.sharedProjects.length : 0,
    messageCount: Array.isArray(team?.messages) ? team.messages.length : 0,
    upcomingAssignmentCount,
    currentUserMembership: currentMembership ? serializeMember(currentMembership, currentUserId) : null,
    isAdmin: sameId(team?.createdBy, currentUserId)
      || String(currentMembership?.teamRole || '') === 'admin',
  };
}

function serializeTeam(team, currentUserId) {
  const members = (Array.isArray(team?.members) ? team.members : [])
    .map((member) => serializeMember(member, currentUserId))
    .sort((left, right) => {
      const leftRank = left.teamRole === 'admin' ? 0 : 1;
      const rightRank = right.teamRole === 'admin' ? 0 : 1;
      const byRole = leftRank - rightRank;
      if (byRole !== 0) return byRole;
      return String(left.user?.name || '').localeCompare(String(right.user?.name || ''));
    });
  const assignments = (Array.isArray(team?.assignments) ? team.assignments : [])
    .map((assignment) => serializeAssignment(assignment, currentUserId))
    .sort((left, right) => {
      const leftDate = left.assignmentDate ? new Date(left.assignmentDate).getTime() : Number.MAX_SAFE_INTEGER;
      const rightDate = right.assignmentDate ? new Date(right.assignmentDate).getTime() : Number.MAX_SAFE_INTEGER;
      if (leftDate !== rightDate) return leftDate - rightDate;
      return (parseClockToMinutes(left.reportAt) ?? 0) - (parseClockToMinutes(right.reportAt) ?? 0);
    });
  const messages = (Array.isArray(team?.messages) ? team.messages : [])
    .map((message) => serializeMessage(message, currentUserId))
    .sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
  const sharedProjects = (Array.isArray(team?.sharedProjects) ? team.sharedProjects : [])
    .map((sharedProject) => serializeSharedProject(sharedProject))
    .sort((left, right) => new Date(right.sharedAt || 0) - new Date(left.sharedAt || 0));
  const summary = serializeTeamSummary(team, currentUserId);

  return {
    ...summary,
    members,
    sharedProjects,
    assignments,
    myAssignments: assignments.filter((assignment) => assignment.myRole !== 'viewer'),
    messages,
  };
}

async function loadTeamForResponse(teamId) {
  return Team.findById(teamId).populate(TEAM_POPULATION);
}

function extractRideEmployeeIds(ride) {
  const ids = new Set();
  (Array.isArray(ride?.assignedEmployees) ? ride.assignedEmployees : []).forEach((employeeId) => {
    const normalized = normalizeText(employeeId, 120);
    if (normalized && !isNonEmployeeStopLabel(normalized)) ids.add(normalized);
  });
  (Array.isArray(ride?.path) ? ride.path : []).forEach((stop) => {
    const type = normalizeStopType(stop?.type);
    const employeeId = normalizeText(stop?.employeeId, 120);
    if ((type === 'pickup' || type === 'dropoff') && employeeId && !isNonEmployeeStopLabel(employeeId)) {
      ids.add(employeeId);
    }
  });
  return Array.from(ids);
}

function snapshotRoutePath(path = []) {
  return (Array.isArray(path) ? path : []).map((stop, index) => {
    const point = toPoint(stop);
    return {
      stopIndex: index + 1,
      type: normalizeStopType(stop?.type),
      employeeId: isNonEmployeeStopLabel(stop?.employeeId) ? '' : normalizeText(stop?.employeeId, 120),
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
      address: point?.address || '',
      arrivalMinute: toFiniteNumber(stop?.arrivalMinute ?? stop?.arrival_minute ?? stop?.arrivalTime ?? stop?.time),
      departureMinute: toFiniteNumber(stop?.departureMinute ?? stop?.departure_minute ?? stop?.departureTime),
      distanceFromPrevKm: toFiniteNumber(stop?.distanceFromPrevKm ?? stop?.distanceFromPrev ?? stop?.distance_km),
    };
  });
}

function buildEmployeeRouteSummary(routePath = []) {
  const byEmployee = new Map();
  routePath.forEach((stop) => {
    const employeeId = normalizeText(stop?.employeeId, 120);
    if (!employeeId) return;
    const type = normalizeStopType(stop?.type);
    if (type !== 'pickup' && type !== 'dropoff') return;
    const current = byEmployee.get(employeeId) || {
      routeEmployeeId: employeeId,
      pickupStopIndex: null,
      dropStopIndex: null,
      pickupMinute: null,
      dropMinute: null,
      pickup: null,
      dropoff: null,
    };
    const point = toPoint(stop);
    if (type === 'pickup' && current.pickupStopIndex === null) {
      current.pickupStopIndex = toFiniteNumber(stop?.stopIndex);
      current.pickupMinute = toFiniteNumber(stop?.arrivalMinute ?? stop?.departureMinute);
      current.pickup = point;
    }
    if (type === 'dropoff') {
      current.dropStopIndex = toFiniteNumber(stop?.stopIndex);
      current.dropMinute = toFiniteNumber(stop?.arrivalMinute ?? stop?.departureMinute);
      current.dropoff = point;
    }
    byEmployee.set(employeeId, current);
  });
  return byEmployee;
}

function findProjectVehicle(project, vehicleId) {
  const vehicles = Array.isArray(project?.parsedInput?.vehicles) ? project.parsedInput.vehicles : [];
  return vehicles.find((vehicle) => normalizeText(vehicle?.id, 120) === vehicleId) || null;
}

function normalizeAssignmentDate(value) {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

const listTeams = asyncHandler(async (req, res) => {
  const teams = await Team.find({ 'members.user': req.user._id })
    .populate([
      { path: 'createdBy', select: 'name email profileImage' },
      { path: 'members.user', select: 'name email profileImage' },
    ])
    .sort({ updatedAt: -1 });

  res.json({
    items: teams.map((team) => serializeTeamSummary(team, req.user._id)),
  });
});

const createTeam = asyncHandler(async (req, res) => {
  const name = normalizeText(req.body?.name, 160);
  const description = normalizeText(req.body?.description, 600);

  if (!name) {
    res.status(400);
    throw new Error('Team name is required');
  }

  const team = await Team.create({
    name,
    description,
    joinCode: await generateUniqueJoinCode(),
    createdBy: req.user._id,
    members: [{
      user: req.user._id,
      teamRole: 'admin',
      assignmentRole: 'unassigned',
      title: 'Owner',
    }],
  });

  const populated = await loadTeamForResponse(team._id);
  res.status(201).json(serializeTeam(populated, req.user._id));
});

const joinTeamByCode = asyncHandler(async (req, res) => {
  const joinCode = normalizeJoinCode(req.body?.joinCode);
  if (!joinCode) {
    res.status(400);
    throw new Error('Team code is required');
  }

  const team = await Team.findOne({ joinCode });
  if (!team) {
    res.status(404);
    throw new Error('Team not found for this code');
  }

  const existingMembership = team.members.find((member) => sameId(member.user, req.user._id));
  if (!existingMembership) {
    team.members.push({
      user: req.user._id,
      teamRole: 'member',
      assignmentRole: 'unassigned',
      title: '',
    });
    await team.save();
  }

  const populated = await loadTeamForResponse(team._id);
  res.json(serializeTeam(populated, req.user._id));
});

const getTeamById = asyncHandler(async (req, res) => {
  ensureValidObjectId(req.params.teamId, 'team id', res);
  const team = await loadTeamForResponse(req.params.teamId);
  requireMembership(team, req.user._id, res);
  res.json(serializeTeam(team, req.user._id));
});

const searchUsers = asyncHandler(async (req, res) => {
  const query = normalizeText(req.query?.q, 120);
  if (query.length < 2) {
    return res.json({ items: [] });
  }

  let excludedIds = [req.user._id];
  if (req.query?.teamId) {
    ensureValidObjectId(req.query.teamId, 'team id', res);
    const team = await Team.findById(req.query.teamId).select('members createdBy');
    requireMembership(team, req.user._id, res);
    excludedIds = excludedIds.concat((team.members || []).map((member) => member.user));
  }

  const matcher = new RegExp(escapeRegex(query), 'i');
  const users = await User.find({
    _id: { $nin: excludedIds },
    $or: [
      { name: matcher },
      { email: matcher },
    ],
  })
    .select('name email profileImage')
    .sort({ name: 1, email: 1 })
    .limit(12);

  res.json({
    items: users.map((user) => serializeUser(user)),
  });
});

const addTeamMember = asyncHandler(async (req, res) => {
  ensureValidObjectId(req.params.teamId, 'team id', res);
  const team = await Team.findById(req.params.teamId);
  requireAdmin(team, req.user._id, res);

  const requestedUserId = normalizeText(req.body?.userId, 120);
  const requestedEmail = normalizeText(req.body?.email, 200).toLowerCase();
  const assignmentRole = req.body?.assignmentRole === undefined
    ? 'unassigned'
    : normalizeAssignmentRole(req.body?.assignmentRole);
  let user = null;

  if (assignmentRole === null) {
    res.status(400);
    throw new Error('Invalid assignment role');
  }

  if (requestedUserId) {
    ensureValidObjectId(requestedUserId, 'user id', res);
    user = await User.findById(requestedUserId);
  } else if (requestedEmail) {
    user = await User.findOne({ email: requestedEmail });
  }

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  if (team.members.some((member) => sameId(member.user, user._id))) {
    res.status(409);
    throw new Error('User is already a member of this team');
  }

  team.members.push({
    user: user._id,
    teamRole: 'member',
    assignmentRole,
    title: normalizeText(req.body?.title, 120),
  });
  await team.save();

  const populated = await loadTeamForResponse(team._id);
  res.status(201).json(serializeTeam(populated, req.user._id));
});

const updateTeamMember = asyncHandler(async (req, res) => {
  ensureValidObjectId(req.params.teamId, 'team id', res);
  ensureValidObjectId(req.params.userId, 'user id', res);
  const team = await Team.findById(req.params.teamId);
  requireAdmin(team, req.user._id, res);

  const member = team.members.find((item) => sameId(item.user, req.params.userId));
  if (!member) {
    res.status(404);
    throw new Error('Team member not found');
  }

  const nextTeamRole = req.body?.teamRole;
  const nextAssignmentRole = req.body?.assignmentRole;
  const nextTitle = req.body?.title;

  if (nextTeamRole !== undefined) {
    const normalizedTeamRole = normalizeTeamRole(nextTeamRole);
    if (!normalizedTeamRole) {
      res.status(400);
      throw new Error('Invalid team role');
    }
    if (sameId(member.user, team.createdBy) && normalizedTeamRole !== 'admin') {
      res.status(400);
      throw new Error('The team owner must remain an admin');
    }
    member.teamRole = normalizedTeamRole;
  }
  if (nextAssignmentRole !== undefined) {
    const normalizedAssignmentRole = normalizeAssignmentRole(nextAssignmentRole);
    if (!normalizedAssignmentRole) {
      res.status(400);
      throw new Error('Invalid assignment role');
    }
    member.assignmentRole = normalizedAssignmentRole;
  }
  if (nextTitle !== undefined) {
    member.title = normalizeText(nextTitle, 120);
  }

  await team.save();
  const populated = await loadTeamForResponse(team._id);
  res.json(serializeTeam(populated, req.user._id));
});

const removeTeamMember = asyncHandler(async (req, res) => {
  ensureValidObjectId(req.params.teamId, 'team id', res);
  ensureValidObjectId(req.params.userId, 'user id', res);
  const team = await Team.findById(req.params.teamId);
  const isSelfRemoval = sameId(req.params.userId, req.user._id);
  if (isSelfRemoval) {
    requireMembership(team, req.user._id, res);
  } else {
    requireAdmin(team, req.user._id, res);
  }

  if (sameId(req.params.userId, team.createdBy)) {
    res.status(400);
    throw new Error('The team owner cannot be removed');
  }

  const hasMember = team.members.some((member) => sameId(member.user, req.params.userId));
  if (!hasMember) {
    res.status(404);
    throw new Error('Team member not found');
  }

  team.members = team.members.filter((member) => !sameId(member.user, req.params.userId));
  team.assignments = team.assignments
    .filter((assignment) => !sameId(assignment.driverUser, req.params.userId))
    .map((assignment) => {
      assignment.employeeAssignments = assignment.employeeAssignments.filter(
        (employeeAssignment) => !sameId(employeeAssignment.user, req.params.userId)
      );
      return assignment;
    });

  await team.save();

  if (isSelfRemoval) {
    return res.json({ success: true, removed: true });
  }

  const populated = await loadTeamForResponse(team._id);
  res.json(serializeTeam(populated, req.user._id));
});

const createAssignment = asyncHandler(async (req, res) => {
  ensureValidObjectId(req.params.teamId, 'team id', res);
  const team = await Team.findById(req.params.teamId);
  requireAdmin(team, req.user._id, res);

  const projectId = normalizeText(req.body?.projectId, 120);
  const vehicleId = normalizeText(req.body?.vehicleId, 120);
  const driverUserId = normalizeText(req.body?.driverUserId, 120);
  const assignmentDate = normalizeAssignmentDate(req.body?.assignmentDate);
  const title = normalizeText(req.body?.title, 180);
  const notes = normalizeText(req.body?.notes, 1200);
  const reportAtInput = req.body?.reportAt;
  const endAtInput = req.body?.endAt;

  if (!projectId || !vehicleId || !driverUserId || !assignmentDate) {
    res.status(400);
    throw new Error('Project, vehicle, driver, and assignment date are required');
  }

  ensureValidObjectId(projectId, 'project id', res);
  ensureValidObjectId(driverUserId, 'driver user id', res);

  if (!team.members.some((member) => sameId(member.user, driverUserId))) {
    res.status(400);
    throw new Error('Driver must be a current team member');
  }

  const employeeAssignmentsInput = Array.isArray(req.body?.employeeAssignments)
    ? req.body.employeeAssignments
    : [];
  if (!employeeAssignmentsInput.length) {
    res.status(400);
    throw new Error('At least one employee assignment is required');
  }

  const project = await Project.findById(projectId).select('user name parsedInput results');
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  if (!sameId(project.user, req.user._id)) {
    res.status(403);
    throw new Error('You can only create collaborate assignments from your own projects');
  }

  const rides = Array.isArray(project?.results?.rides) ? project.results.rides : [];
  const ride = rides.find((candidate) => normalizeText(candidate?.vehicleId, 120) === vehicleId);
  if (!ride) {
    res.status(404);
    throw new Error('Selected vehicle route was not found in this project');
  }

  const routePath = snapshotRoutePath(ride?.path);
  const routeEmployeeIds = extractRideEmployeeIds(ride);
  const routeEmployeeSet = new Set(routeEmployeeIds);
  const routeEmployeeSummary = buildEmployeeRouteSummary(routePath);
  const memberIds = new Set((team.members || []).map((member) => asId(member.user)));
  const seenRouteEmployees = new Set();
  const preparedEmployeeAssignments = employeeAssignmentsInput.map((item) => {
    const routeEmployeeId = normalizeText(item?.routeEmployeeId, 120);
    const userId = normalizeText(item?.userId, 120);
    if (!routeEmployeeId || !userId) {
      res.status(400);
      throw new Error('Each employee assignment must include a route employee and a team member');
    }
    ensureValidObjectId(userId, 'employee user id', res);
    if (!routeEmployeeSet.has(routeEmployeeId)) {
      res.status(400);
      throw new Error(`Route employee ${routeEmployeeId} is not assigned to vehicle ${vehicleId}`);
    }
    if (seenRouteEmployees.has(routeEmployeeId)) {
      res.status(400);
      throw new Error(`Route employee ${routeEmployeeId} was assigned more than once`);
    }
    if (!memberIds.has(userId)) {
      res.status(400);
      throw new Error('Each assigned employee must be a current team member');
    }
    seenRouteEmployees.add(routeEmployeeId);
    const summary = routeEmployeeSummary.get(routeEmployeeId) || {};
    return {
      routeEmployeeId,
      user: userId,
      pickupStopIndex: summary.pickupStopIndex ?? null,
      dropStopIndex: summary.dropStopIndex ?? null,
      pickupMinute: summary.pickupMinute ?? null,
      dropMinute: summary.dropMinute ?? null,
      pickup: summary.pickup || null,
      dropoff: summary.dropoff || null,
    };
  });

  const projectVehicle = findProjectVehicle(project, vehicleId);
  const startLocation = toPoint(
    projectVehicle?.start_location
    || projectVehicle?.startLocation
    || projectVehicle
  );

  const reportAt = reportAtInput === undefined
    ? minuteToClock(routePath[0]?.departureMinute ?? routePath[0]?.arrivalMinute)
    : normalizeClock(reportAtInput);
  if (reportAtInput !== undefined && reportAt === null) {
    res.status(400);
    throw new Error('Report time must use HH:MM format');
  }
  const endAt = endAtInput === undefined
    ? minuteToClock(routePath[routePath.length - 1]?.arrivalMinute ?? routePath[routePath.length - 1]?.departureMinute)
    : normalizeClock(endAtInput);
  if (endAtInput !== undefined && endAt === null) {
    res.status(400);
    throw new Error('End time must use HH:MM format');
  }

  const routeMetrics = {
    totalDistance: toFiniteNumber(
      ride?.metrics?.totalDistance
      ?? ride?.metrics?.totalDistanceKm
      ?? ride?.metrics?.distanceKm
      ?? ride?.metrics?.distance
    ),
    totalTimeMinutes: toFiniteNumber(
      ride?.metrics?.totalTimeMinutes
      ?? ride?.metrics?.totalTime
      ?? ride?.metrics?.durationMinutes
    ),
    cost: toFiniteNumber(ride?.metrics?.cost ?? ride?.metrics?.totalCost),
  };

  team.assignments.push({
    title: title || `${project.name} - ${vehicleId}`,
    project: project._id,
    projectName: project.name,
    vehicleId,
    assignmentDate,
    reportAt: reportAt || '',
    endAt: endAt || '',
    notes,
    startLocation: startLocation || {},
    routeMetrics,
    routePath,
    driverUser: driverUserId,
    employeeAssignments: preparedEmployeeAssignments,
    createdBy: req.user._id,
  });

  await team.save();
  const populated = await loadTeamForResponse(team._id);
  res.status(201).json(serializeTeam(populated, req.user._id));
});

const shareProject = asyncHandler(async (req, res) => {
  ensureValidObjectId(req.params.teamId, 'team id', res);
  const team = await Team.findById(req.params.teamId);
  requireAdmin(team, req.user._id, res);

  const projectId = normalizeText(req.body?.projectId, 120);
  if (!projectId) {
    res.status(400);
    throw new Error('Project id is required');
  }
  ensureValidObjectId(projectId, 'project id', res);

  const project = await Project.findById(projectId).select('user name status createdAt');
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  if (!sameId(project.user, req.user._id)) {
    res.status(403);
    throw new Error('You can only share your own projects with the team');
  }

  team.sharedProjects = (Array.isArray(team.sharedProjects) ? team.sharedProjects : [])
    .filter((item) => !sameId(item.project, project._id));

  team.sharedProjects.unshift({
    project: project._id,
    projectName: project.name,
    sharedBy: req.user._id,
    sharedAt: new Date(),
  });

  await team.save();
  const populated = await loadTeamForResponse(team._id);
  res.status(201).json(serializeTeam(populated, req.user._id));
});

const deleteAssignment = asyncHandler(async (req, res) => {
  ensureValidObjectId(req.params.teamId, 'team id', res);
  ensureValidObjectId(req.params.assignmentId, 'assignment id', res);
  const team = await Team.findById(req.params.teamId);
  requireAdmin(team, req.user._id, res);

  const assignment = team.assignments.id(req.params.assignmentId);
  if (!assignment) {
    res.status(404);
    throw new Error('Assignment not found');
  }

  assignment.deleteOne();
  await team.save();

  const populated = await loadTeamForResponse(team._id);
  res.json(serializeTeam(populated, req.user._id));
});

const postMessage = asyncHandler(async (req, res) => {
  ensureValidObjectId(req.params.teamId, 'team id', res);
  const team = await Team.findById(req.params.teamId);
  requireMembership(team, req.user._id, res);

  const text = normalizeText(req.body?.text, 1200);
  if (!text) {
    res.status(400);
    throw new Error('Message text is required');
  }

  team.messages.push({
    sender: req.user._id,
    text,
  });

  if (team.messages.length > 300) {
    team.messages = team.messages.slice(-300);
  }

  await team.save();
  const populated = await loadTeamForResponse(team._id);
  res.status(201).json(serializeTeam(populated, req.user._id));
});

module.exports = {
  addTeamMember,
  createAssignment,
  createTeam,
  deleteAssignment,
  getTeamById,
  joinTeamByCode,
  listTeams,
  postMessage,
  removeTeamMember,
  searchUsers,
  shareProject,
  updateTeamMember,
};
