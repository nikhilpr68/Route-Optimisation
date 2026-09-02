const asyncHandler = require('express-async-handler');
const Razorpay = require('razorpay');
const User = require('../models/User');
const {
  normalizeUnixSeconds,
  planTierForSubscriptionStatus,
} = require('../utils/billing');

let razorpayClient = null;

function getRazorpayClient() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keyId || !keySecret) {
    const err = new Error('Razorpay billing is not configured on server');
    err.statusCode = 500;
    throw err;
  }
  if (!razorpayClient) {
    razorpayClient = new Razorpay({
      key_id: keyId,
      key_secret: keySecret
    });
  }
  return razorpayClient;
}

function razorpayKeyId() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  if (!keyId) {
    const err = new Error('RAZORPAY_KEY_ID is not configured');
    err.statusCode = 500;
    throw err;
  }
  return keyId;
}

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
    cancelAtPeriodEnd: Boolean(user?.subscription?.cancelAtPeriodEnd),
  };
}

function subscriptionNotesForUser(user) {
  return {
    userId: String(user._id),
    email: String(user.email || ''),
    name: String(user.name || '')
  };
}

function extractSubscriptionSummary(subscription, fallbackUser = null) {
  return {
    provider: 'razorpay',
    customerId: String(subscription?.customer_id || fallbackUser?.subscription?.customerId || ''),
    subscriptionId: String(subscription?.id || ''),
    planId: String(subscription?.plan_id || ''),
    authPaymentId: String(
      subscription?.auth_attempts?.[0]?.payment_id ||
      fallbackUser?.subscription?.authPaymentId ||
      ''
    ),
    status: String(subscription?.status || 'inactive'),
    currentPeriodEnd: normalizeUnixSeconds(subscription?.current_end || subscription?.charge_at),
    endedAt: normalizeUnixSeconds(subscription?.ended_at || subscription?.expire_by),
    cancelAtPeriodEnd: false
  };
}

async function syncUserSubscriptionRecord(user, subscription, extras = {}) {
  const nextSubscription = extractSubscriptionSummary(subscription, user);
  user.subscription = {
    ...nextSubscription,
    authPaymentId: String(extras.authPaymentId || nextSubscription.authPaymentId || ''),
    customerId: String(extras.customerId || nextSubscription.customerId || user?.subscription?.customerId || '')
  };
  user.planTier = planTierForSubscriptionStatus(user.subscription.status);
  await user.save();
  return user;
}

async function findUserForRazorpaySubscriptionEntity(subscription) {
  const notes = subscription?.notes || {};
  const noteUserId = String(notes.userId || '').trim();
  if (noteUserId) {
    const user = await User.findById(noteUserId);
    if (user) return user;
  }

  const subscriptionId = String(subscription?.id || '').trim();
  if (subscriptionId) {
    const user = await User.findOne({ 'subscription.subscriptionId': subscriptionId });
    if (user) return user;
  }

  const customerId = String(subscription?.customer_id || '').trim();
  if (customerId) {
    const user = await User.findOne({ 'subscription.customerId': customerId });
    if (user) return user;
  }

  const email = String(notes.email || '').trim().toLowerCase();
  if (email) {
    return User.findOne({ email });
  }

  return null;
}

const getBillingStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('-password');
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  res.json({
    planTier: user.planTier || 'free',
    subscription: serializeSubscription(user)
  });
});

const createSubscription = asyncHandler(async (req, res) => {
  const razorpay = getRazorpayClient();
  const planId = String(process.env.RAZORPAY_PLAN_ID_PREMIUM_MONTHLY || '').trim();
  if (!planId) {
    res.status(500);
    throw new Error('RAZORPAY_PLAN_ID_PREMIUM_MONTHLY is not configured');
  }

  const totalCount = Number(process.env.RAZORPAY_SUBSCRIPTION_TOTAL_COUNT || 120);
  const expireByDays = Number(process.env.RAZORPAY_SUBSCRIPTION_EXPIRE_BY_DAYS || 2);
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  const existingStatus = String(user?.subscription?.status || '').trim().toLowerCase();
  if (['created', 'authenticated', 'active', 'pending', 'halted'].includes(existingStatus)) {
    res.status(400);
    throw new Error('A Razorpay subscription already exists for this account');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const subscription = await razorpay.subscriptions.create({
    plan_id: planId,
    total_count: Number.isFinite(totalCount) && totalCount > 0 ? totalCount : 120,
    quantity: 1,
    customer_notify: 1,
    expire_by: nowSeconds + (Math.max(expireByDays, 1) * 24 * 60 * 60),
    notes: subscriptionNotesForUser(user)
  });

  user.subscription = {
    provider: 'razorpay',
    customerId: String(user?.subscription?.customerId || ''),
    subscriptionId: String(subscription.id || ''),
    planId,
    authPaymentId: '',
    status: String(subscription.status || 'created'),
    currentPeriodEnd: normalizeUnixSeconds(subscription.charge_at),
    endedAt: normalizeUnixSeconds(subscription.expire_by),
    cancelAtPeriodEnd: false
  };
  user.planTier = planTierForSubscriptionStatus(user.subscription.status);
  await user.save();

  res.json({
    keyId: razorpayKeyId(),
    subscriptionId: subscription.id,
    planId,
    prefill: {
      name: user.name,
      email: user.email
    }
  });
});

const verifySubscriptionPayment = asyncHandler(async (req, res) => {
  const razorpay = getRazorpayClient();
  const {
    razorpay_payment_id: paymentId,
    razorpay_subscription_id: subscriptionId,
    razorpay_signature: signature
  } = req.body || {};

  if (!paymentId || !subscriptionId || !signature) {
    res.status(400);
    throw new Error('razorpay_payment_id, razorpay_subscription_id and razorpay_signature are required');
  }

  const verified = Razorpay.validatePaymentVerification(
    {
      subscription_id: String(subscriptionId),
      payment_id: String(paymentId)
    },
    String(signature),
    String(process.env.RAZORPAY_KEY_SECRET || '').trim()
  );

  if (!verified) {
    res.status(400);
    throw new Error('Razorpay subscription payment verification failed');
  }

  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  const subscription = await razorpay.subscriptions.fetch(String(subscriptionId));
  await syncUserSubscriptionRecord(user, subscription, { authPaymentId: paymentId });

  res.json({
    success: true,
    planTier: user.planTier || 'free',
    subscription: serializeSubscription(user)
  });
});

const cancelSubscription = asyncHandler(async (req, res) => {
  const razorpay = getRazorpayClient();
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  const subscriptionId = String(user?.subscription?.subscriptionId || '').trim();
  if (!subscriptionId) {
    res.status(400);
    throw new Error('No Razorpay subscription is linked to this account');
  }

  const cancelled = await razorpay.subscriptions.cancel(subscriptionId, {
    cancel_at_cycle_end: 0
  });
  await syncUserSubscriptionRecord(user, cancelled);

  res.json({
    success: true,
    planTier: user.planTier || 'free',
    subscription: serializeSubscription(user)
  });
});

const handleRazorpayWebhook = asyncHandler(async (req, res) => {
  const webhookSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  if (!webhookSecret) {
    res.status(500);
    throw new Error('RAZORPAY_WEBHOOK_SECRET is not configured');
  }

  const signature = String(req.headers['x-razorpay-signature'] || '').trim();
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const verified = Razorpay.validateWebhookSignature(rawBody, signature, webhookSecret);
  if (!verified) {
    res.status(400);
    throw new Error('Razorpay webhook signature verification failed');
  }

  const event = JSON.parse(rawBody || '{}');
  const subscription = event?.payload?.subscription?.entity;
  if (subscription?.id) {
    const user = await findUserForRazorpaySubscriptionEntity(subscription);
    if (user) {
      await syncUserSubscriptionRecord(user, subscription);
    }
  }

  res.json({ received: true });
});

module.exports = {
  createSubscription,
  verifySubscriptionPayment,
  cancelSubscription,
  getBillingStatus,
  handleRazorpayWebhook,
};
