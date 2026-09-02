const express = require('express');
const router = express.Router();

const {
  registerUser,
  verifySignupOtp,
  loginUser,
  googleAuth,
  getMe,
  updateMe,
  changePassword,
  verifyChangePasswordOtp,
  forgotPassword,
  verifyForgotPasswordOtp
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', registerUser);
router.post('/verify-signup-otp', verifySignupOtp);
router.post('/login', loginUser);
router.post('/google', googleAuth);
router.post('/forgot-password', forgotPassword);
router.post('/verify-forgot-password-otp', verifyForgotPasswordOtp);
router.get('/me', protect, getMe);
router.put('/me', protect, updateMe);
router.post('/change-password', protect, changePassword);
router.post('/change-password/verify-otp', protect, verifyChangePasswordOtp);

module.exports = router;
