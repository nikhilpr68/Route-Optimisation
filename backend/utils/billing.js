function normalizeUnixSeconds(value) {
  if (!value) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric * 1000);
}

function isPremiumSubscriptionStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return ['created', 'authenticated', 'active', 'pending', 'resumed'].includes(normalized);
}

function planTierForSubscriptionStatus(status) {
  return isPremiumSubscriptionStatus(status) ? 'premium' : 'free';
}

module.exports = {
  normalizeUnixSeconds,
  isPremiumSubscriptionStatus,
  planTierForSubscriptionStatus,
};
