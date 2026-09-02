const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

const {
  ingestArtifacts,
  parseAndRun,
  parseOnly,
  runSolver,
  getParsedInput,
  getResults,
  getCompareRuns,
  validateRun
} = require('../controllers/projectPipelineController');

// Upload any set of files + optional notes text
router.post(
  '/:id/ingest',
  protect,
  upload.any(),     // accept arbitrary artifacts
  ingestArtifacts
);

// Parse + run end-to-end
router.post('/:id/parse-and-run', protect, parseAndRun);

// Parse only (no solver run)
router.post('/:id/parse-only', protect, parseOnly);

// Run solver on existing parsed input
router.post('/:id/run-solver', protect, runSolver);

// Get parsed canonical JSON
router.get('/:id/input', protect, getParsedInput);

// Get results for dashboard/map/stats
router.get('/:id/results', protect, getResults);

// Get solver run-history data for Compare Runs
router.get('/:id/compare-runs', protect, getCompareRuns);

// Validate completed run in background
router.post('/:id/validate-run', protect, validateRun);

module.exports = router;
