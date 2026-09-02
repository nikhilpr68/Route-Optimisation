const express = require('express');
const {
  cancelSubscription,
  createSubscription,
  getBillingStatus,
  verifySubscriptionPayment,
} = require('../controllers/billingController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/status', protect, getBillingStatus);
router.post('/subscription', protect, createSubscription);
router.post('/verify', protect, verifySubscriptionPayment);
router.post('/cancel', protect, cancelSubscription);

module.exports = router;
