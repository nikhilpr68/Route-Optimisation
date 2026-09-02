const { spawn } = require('child_process');
const path = require('path');
const Project = require('../models/Project');
const Ride = require('../models/Ride');

const solveVRP = async (projectId) => {
  try {
    // 1. Fetch Data from MongoDB
    const project = await Project.findById(projectId).populate('user');
    
    if (!project) throw new Error("Project not found");
    
    // Prepare data for Python
    // We send only what's necessary to keep it light
    const inputData = {
      requests: project.requests,
      vehicles: [/* You might need to fetch vehicles if they are in a separate collection */]
    };
    
    // If you stored Vehicles in a separate collection, fetch them:
    const Vehicle = require('../models/Vehicle');
    inputData.vehicles = await Vehicle.find({ project: projectId });

    // 2. Spawn Python Process
    const pythonScript = path.join(__dirname, '../engine/optimizer.py');
    const pythonProcess = spawn('python3', [pythonScript]); // Use 'python' or 'python3'

    let resultString = '';
    let errorString = '';

    // Send Data to Python
    pythonProcess.stdin.write(JSON.stringify(inputData));
    pythonProcess.stdin.end();

    // Listen for Data from Python
    pythonProcess.stdout.on('data', (data) => {
      resultString += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      errorString += data.toString();
    });

    // 3. Handle Completion
    pythonProcess.on('close', async (code) => {
      if (code !== 0) {
        console.error(`Python Error: ${errorString}`);
        project.status = 'Failed';
        await project.save();
        return;
      }

      try {
        const optimizedResults = JSON.parse(resultString);

        // 4. Save Results to MongoDB (Create Ride documents)
        const rides = optimizedResults.routes.map(route => ({
          project: projectId,
          vehicle: route.vehicleId, // You'll need to map this back to _id if using sourceId
          path: route.path,
          metrics: {
            cost: route.cost,
            totalDistance: route.totalDistance
          }
        }));

        // Insert Rides
        await Ride.insertMany(rides);

        // Update Project Status & Metrics
        project.metrics = optimizedResults.metrics;
        project.status = 'Completed';
        await project.save();
        
        console.log(`Optimization Completed for Project: ${projectId}`);

      } catch (parseError) {
        console.error('Failed to parse Python output:', parseError);
        project.status = 'Failed';
        await project.save();
      }
    });

  } catch (err) {
    console.error("Solver Service Error:", err);
  }
};

module.exports = { solveVRP };