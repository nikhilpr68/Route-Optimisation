const mongoose = require('mongoose');

const PointSchema = new mongoose.Schema({
  lat: { type: Number },
  lng: { type: Number },
  address: { type: String, trim: true, default: '' },
}, { _id: false });

const TeamMemberSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  teamRole: {
    type: String,
    enum: ['admin', 'member'],
    default: 'member',
  },
  assignmentRole: {
    type: String,
    enum: ['employee', 'driver', 'both', 'unassigned'],
    default: 'unassigned',
  },
  title: { type: String, trim: true, default: '' },
  joinedAt: { type: Date, default: Date.now },
}, { _id: false });

const TeamRouteStopSchema = new mongoose.Schema({
  stopIndex: { type: Number },
  type: {
    type: String,
    enum: ['pickup', 'dropoff', 'stop'],
    default: 'stop',
  },
  employeeId: { type: String, trim: true, default: '' },
  lat: { type: Number },
  lng: { type: Number },
  address: { type: String, trim: true, default: '' },
  arrivalMinute: { type: Number },
  departureMinute: { type: Number },
  distanceFromPrevKm: { type: Number },
}, { _id: false });

const TeamEmployeeAssignmentSchema = new mongoose.Schema({
  routeEmployeeId: { type: String, required: true, trim: true },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  pickupStopIndex: { type: Number },
  dropStopIndex: { type: Number },
  pickupMinute: { type: Number },
  dropMinute: { type: Number },
  pickup: { type: PointSchema, default: () => ({}) },
  dropoff: { type: PointSchema, default: () => ({}) },
}, { _id: false });

const TeamAssignmentSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    default: null,
  },
  projectName: { type: String, trim: true, default: '' },
  vehicleId: { type: String, trim: true, default: '' },
  assignmentDate: { type: Date, required: true },
  reportAt: { type: String, trim: true, default: '' },
  endAt: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  startLocation: { type: PointSchema, default: () => ({}) },
  routeMetrics: {
    totalDistance: { type: Number, default: null },
    totalTimeMinutes: { type: Number, default: null },
    cost: { type: Number, default: null },
  },
  routePath: { type: [TeamRouteStopSchema], default: [] },
  driverUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  employeeAssignments: { type: [TeamEmployeeAssignmentSchema], default: [] },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
});

const TeamMessageSchema = new mongoose.Schema({
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  text: { type: String, required: true, trim: true, maxlength: 1200 },
  createdAt: { type: Date, default: Date.now },
});

const TeamSharedProjectSchema = new mongoose.Schema({
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
  },
  projectName: { type: String, trim: true, default: '' },
  sharedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  sharedAt: { type: Date, default: Date.now },
}, { _id: true });

const TeamSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: '' },
  joinCode: { type: String, required: true, unique: true, uppercase: true, trim: true },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  members: { type: [TeamMemberSchema], default: [] },
  sharedProjects: { type: [TeamSharedProjectSchema], default: [] },
  assignments: { type: [TeamAssignmentSchema], default: [] },
  messages: { type: [TeamMessageSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

TeamSchema.pre('save', function updateTimestamp() {
  this.updatedAt = new Date();
});

TeamSchema.index({ 'members.user': 1, createdAt: -1 });
TeamSchema.index({ createdBy: 1, createdAt: -1 });

module.exports = mongoose.model('Team', TeamSchema);
