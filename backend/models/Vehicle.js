const mongoose = require('mongoose');

const PointSchema = new mongoose.Schema({
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  address: String
}, { _id: false });

const VehicleSchema = new mongoose.Schema({
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  sourceId: { type: String, required: true }, // Excel ID (e.g., "VEH005")
  
  // Fleet Attributes [cite: 49-60]
  mode: { 
    type: String, 
    enum: ['2-wheeler', '4-wheeler', 'Van'], 
    required: true 
  },
  fuelType: { 
    type: String, 
    enum: ['Petrol', 'Diesel', 'Electric'] 
  },
  capacity: { type: Number, required: true },
  costPerKm: { type: Number, required: true },
  
  // Performance History [cite: 55-58]
  specs: {
    avgMileage: Number,
    avgSpeed: Number,
    age: Number
  },
  
  // State for the simulation
  startLocation: PointSchema,
  availableTime: String // e.g., "08:00"
});

// Index to quickly find fleet for a project
VehicleSchema.index({ project: 1 });

module.exports = mongoose.model('Vehicle', VehicleSchema);