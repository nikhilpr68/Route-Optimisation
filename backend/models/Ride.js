const mongoose = require('mongoose');

const PointSchema = new mongoose.Schema({
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  address: String
}, { _id: false });

// A single stop on the route [cite: 75-76]
const RouteStepSchema = new mongoose.Schema({
  order: Number,
  type: { type: String, enum: ['pickup', 'dropoff'], required: true },
  employeeId: String, // Refers to the sourceId in Project.requests
  location: PointSchema,
  estimatedArrival: Date,
  distanceFromPrev: Number // km
}, { _id: false });

const RideSchema = new mongoose.Schema({
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  vehicle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
    required: true
  },
  
  // The Optimized Route [cite: 75]
  path: [RouteStepSchema],
  
  // Summary for this specific car [cite: 77]
  metrics: {
    totalDistance: Number,
    totalTime: Number, // minutes
    cost: Number       // operational cost
  },
  
  // List of users serviced by this ride [cite: 74]
  assignedEmployees: [String] // Array of Employee sourceIds
});

// Index to quickly fetch the "Dashboard" view
RideSchema.index({ project: 1 });

module.exports = mongoose.model('Ride', RideSchema);