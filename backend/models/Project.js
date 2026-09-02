const mongoose = require('mongoose');

// Helper for location data (lat/lng)
const PointSchema = new mongoose.Schema({
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  address: String
}, { _id: false });

// Embedded Schema: Employee Request
const EmployeeRequestSchema = new mongoose.Schema({
  sourceId: { type: String, required: true }, // Excel ID (e.g., "EMP001")
  name: String,
  priority: { type: String, enum: ['High', 'Medium', 'Low'], default: 'Medium' },
  pickup: PointSchema,
  dropoff: PointSchema,
  timeWindow: {
    start: String, // "09:00"
    end: String    // "09:30"
  },
  preferences: {
    vehicleType: { type: String, enum: ['Normal', 'Premium'] },
    sharing: { type: String, enum: ['Single', 'Double', 'Triple'] }
  }
}, { _id: false });

const InputArtifactSchema = new mongoose.Schema({
  kind: { type: String, enum: ['file', 'text'], required: true },
  originalName: String,
  mimeType: String,
  size: Number,
  storagePath: String,   // local uploads/ path
  text: String,          // if kind=text
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const ProjectSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  name: { type: String, required: true },

  status: {
    type: String,
    enum: ['Pending', 'Processing', 'Completed', 'Infeasible', 'Failed'],
    default: 'Pending'
  },

  // Finalized demand data used by engine (optional for now)
  requests: [EmployeeRequestSchema],

  // High-level analytics (filled after run)
  metrics: {
    totalSystemCost: { type: Number, default: 0 },
    totalDistance: { type: Number, default: 0 },
    baselineCost: { type: Number, default: 0 },
    savings: { type: Number, default: 0 },
    savingsPercent: { type: Number, default: 0 },
    totalTimeMinutes: { type: Number, default: 0 },
    baselineTimeMinutes: { type: Number, default: 0 }
  },

  // ✅ New: ingestion artifacts (files/text the user uploaded)
  inputArtifacts: { type: [InputArtifactSchema], default: [] },

  // ✅ New: LLM parsed canonical JSON (can be partial; do NOT validate with PointSchema)
  parsedInput: { type: mongoose.Schema.Types.Mixed, default: null },

  // ✅ New: parse report
  parseReport: {
    status: { type: String, enum: ['success', 'needs_review', 'failed'], default: 'failed' },
    confidence: { type: Number, default: 0 },
    missingRequired: { type: [String], default: [] },
    assumptions: { type: [String], default: [] },
    warnings: { type: [String], default: [] },
    model: { type: String, default: '' },
    parsedAt: Date
  },

  runConfig: {
    optimizationIntensity: {
      type: String,
      enum: ['low', 'medium', 'high', 'custom'],
      default: 'medium'
    },
    customMaxRunSeconds: {
      type: Number,
      default: null
    },
    customGenerations: {
      type: Number,
      default: null
    },
    distanceMetric: {
      type: String,
      enum: ['osrm', 'haversine'],
      default: 'osrm'
    },
    preferenceRelaxation: {
      type: String,
      enum: ['none', 'sharing', 'vehicle', 'both'],
      default: 'none'
    },
    computeTier: {
      type: String,
      enum: ['free', 'premium'],
      default: 'free'
    },
    runDate: { type: Date, default: null }
  },

  // ✅ New: engine execution + results
  run: {
    state: { type: String, enum: ['NotRun', 'Running', 'Done', 'Infeasible', 'Failed'], default: 'NotRun' },
    startedAt: Date,
    finishedAt: Date,
    error: String
  },

  runValidation: {
    status: {
      type: String,
      enum: ['NotValidated', 'Running', 'Passed', 'Failed'],
      default: 'NotValidated'
    },
    requestedAt: Date,
    finishedAt: Date,
    score: { type: Number, default: 0 },
    message: { type: String, default: '' },
    checks: {
      type: [{
        name: String,
        passed: Boolean,
        detail: String
      }],
      default: []
    }
  },

  results: { type: mongoose.Schema.Types.Mixed, default: null },

  share: {
    enabled: { type: Boolean, default: false },
    token: { type: String, default: null },
    createdAt: { type: Date, default: null },
    lastAccessedAt: { type: Date, default: null }
  },

  createdAt: { type: Date, default: Date.now }
});

ProjectSchema.index(
  { 'share.token': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'share.token': { $type: 'string' }
    }
  }
);

module.exports = mongoose.model('Project', ProjectSchema);
