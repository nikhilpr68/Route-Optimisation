const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getDashboardSummary, getDashboardMetrics } = require('../controllers/dashboardController');

router.get('/summary', protect, getDashboardSummary);
router.get('/metrics', protect, getDashboardMetrics);

module.exports = router;
