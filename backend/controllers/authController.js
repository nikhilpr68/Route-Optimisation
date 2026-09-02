const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { generateToken } = require('../utils/jwt');
const { PASSWORD_POLICY_TEXT, validatePasswordStrength } = require('../utils/validators');

function serializeSubscription(user) {
  return {
    provider: String(user?.subscription?.provider || 'razorpay'),
    customerId: String(user?.subscription?.customerId || ''),
    subscriptionId: String(user?.subscription?.subscriptionId || ''),
    planId: String(user?.subscription?.planId || ''),
    authPaymentId: String(user?.subscription?.authPaymentId || ''),
    status: String(user?.subscription?.status || 'inactive'),
    currentPeriodEnd: user?.subscription?.currentPeriodEnd || null,
    endedAt: user?.subscription?.endedAt || null,
    cancelAtPeriodEnd: Boolean(user?.subscription?.cancelAtPeriodEnd)
  };
}

function serializeUser(user) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    profileImage: String(user.profileImage || ''),
    role: user.role,
    planTier: user.planTier || 'free',
    subscription: serializeSubscription(user)
  };
}

function authPayload(user) {
  return {
    ...serializeUser(user),
    token: generateToken(user._id)
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeName(name) {
  return String(name || '').trim();
}

function normalizeProfileImage(profileImage, res) {
  if (profileImage === undefined) return undefined;
  if (profileImage === null) return '';
  const value = String(profileImage).trim();
  if (!value) return '';

  const match = value.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    res.status(400);
    throw new Error('Profile image must be a valid PNG, JPEG, WEBP, or GIF image.');
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) {
    res.status(400);
    throw new Error('Profile image is empty.');
  }

  if (buffer.length > 5 * 1024 * 1024) {
    res.status(400);
    throw new Error('Profile image must be 5MB or smaller.');
  }

  return `data:${match[1].toLowerCase()};base64,${match[2]}`;
}

function throwIfWeakPassword(password, res, prefix = 'Password') {
  const passwordCheck = validatePasswordStrength(password);
  if (!passwordCheck.valid) {
    res.status(400);
    throw new Error(`${prefix} is too weak. ${PASSWORD_POLICY_TEXT}`);
  }
}

// POST /api/auth/register
const registerUser = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !email || !password) {
    res.status(400);
    throw new Error('name, email, password are required');
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedName = normalizeName(name);

  if (!normalizedName || !normalizedEmail) {
    res.status(400);
    throw new Error('name, email, password are required');
  }

  throwIfWeakPassword(password, res);

  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    res.status(409);
    throw new Error('User already exists');
  }

  const user = await User.create({
    name: normalizedName,
    email: normalizedEmail,
    password: String(password)
  });

  res.status(201).json(authPayload(user));
});

// POST /api/auth/verify-signup-otp
const verifySignupOtp = asyncHandler(async (req, res) => {
  res.status(410).json({ message: 'Signup verification code is no longer required. Please sign up directly.' });
});

// POST /api/auth/login
const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    res.status(400);
    throw new Error('email and password are required');
  }

  const normalizedEmail = normalizeEmail(email);
  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    res.status(401);
    throw new Error('Invalid credentials');
  }

  const ok = await user.matchPassword(password);
  if (!ok) {
    res.status(401);
    throw new Error('Invalid credentials');
  }

  res.json(authPayload(user));
});

// POST /api/auth/google
const googleAuth = asyncHandler(async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) {
    res.status(400);
    throw new Error('Google idToken is required');
  }

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  if (!googleClientId) {
    res.status(500);
    throw new Error('GOOGLE_CLIENT_ID is not configured on server');
  }

  const client = new OAuth2Client(googleClientId);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: googleClientId
  });
  const payload = ticket.getPayload();

  const email = (payload?.email || '').toLowerCase().trim();
  if (!email || payload?.email_verified !== true) {
    res.status(401);
    throw new Error('Google account email is not verified');
  }

  let user = await User.findOne({ email });
  if (!user) {
    const generatedPassword = crypto.randomBytes(24).toString('hex');
    user = await User.create({
      name: (payload?.name || email.split('@')[0] || 'Google User').trim(),
      email,
      password: generatedPassword
    });
  }

  res.json(authPayload(user));
});

// GET /api/auth/me (protected)
const getMe = asyncHandler(async (req, res) => {
  // authMiddleware attaches req.user
  res.json({
    ...serializeUser(req.user),
    createdAt: req.user.createdAt
  });
});

// PUT /api/auth/me (protected)
const updateMe = asyncHandler(async (req, res) => {
  const { name, email, profileImage } = req.body || {};

  const nextName = String(name || '').trim();
  const nextEmail = String(email || '').trim().toLowerCase();
  const nextProfileImage = normalizeProfileImage(profileImage, res);

  if (!nextName || !nextEmail) {
    res.status(400);
    throw new Error('name and email are required');
  }

  const existing = await User.findOne({
    email: nextEmail,
    _id: { $ne: req.user._id }
  });
  if (existing) {
    res.status(409);
    throw new Error('Email is already in use');
  }

  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  user.name = nextName;
  user.email = nextEmail;
  if (nextProfileImage !== undefined) {
    user.profileImage = nextProfileImage;
  }
  await user.save();

  res.json(serializeUser(user));
});

// POST /api/auth/change-password (protected)
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    res.status(400);
    throw new Error('currentPassword and newPassword are required');
  }

  throwIfWeakPassword(newPassword, res, 'New password');

  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  const ok = await user.matchPassword(currentPassword);
  if (!ok) {
    res.status(401);
    throw new Error('Current password is incorrect');
  }

  user.password = String(newPassword);
  await user.save();

  res.json({ message: 'Password changed successfully' });
});

// POST /api/auth/change-password/verify-otp (protected)
const verifyChangePasswordOtp = asyncHandler(async (req, res) => {
  res.status(410).json({ message: 'Password change verification code is no longer required. Submit the new password directly.' });
});

// POST /api/auth/forgot-password
const forgotPassword = asyncHandler(async (req, res) => {
  const { email, newPassword } = req.body || {};

  const normalizedEmail = normalizeEmail(email);
  const nextPassword = String(newPassword || '');

  if (!normalizedEmail || !nextPassword) {
    res.status(400);
    throw new Error('email and newPassword are required');
  }

  throwIfWeakPassword(nextPassword, res, 'New password');

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  user.password = nextPassword;
  await user.save();

  res.json({ message: 'Password reset successful. Please sign in with your new password.' });
});

// POST /api/auth/verify-forgot-password-otp
const verifyForgotPasswordOtp = asyncHandler(async (req, res) => {
  res.status(410).json({ message: 'Forgot password verification code is no longer required. Submit the new password directly.' });
});

module.exports = {
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
};
