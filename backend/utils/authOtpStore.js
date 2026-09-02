const crypto = require('crypto');

const OTP_TTL_MS = Number(process.env.AUTH_OTP_TTL_MS || 10 * 60 * 1000);
const MAX_OTP_ATTEMPTS = Number(process.env.AUTH_OTP_MAX_ATTEMPTS || 5);

const otpStore = new Map();

function toKey(purpose, email) {
  return `${String(purpose || '').trim().toLowerCase()}:${String(email || '').trim().toLowerCase()}`;
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function issueOtp({ purpose, email, payload = null }) {
  const key = toKey(purpose, email);
  const otp = generateOtp();

  otpStore.set(key, {
    otpHash: hashOtp(otp),
    attempts: 0,
    expiresAt: Date.now() + OTP_TTL_MS,
    payload
  });

  return otp;
}

function verifyOtpAndConsume({ purpose, email, otp }) {
  const key = toKey(purpose, email);
  const record = otpStore.get(key);

  if (!record) {
    return { ok: false, reason: 'not_found' };
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(key);
    return { ok: false, reason: 'expired' };
  }

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    otpStore.delete(key);
    return { ok: false, reason: 'max_attempts' };
  }

  const isMatch = hashOtp(otp) === record.otpHash;
  if (!isMatch) {
    record.attempts += 1;
    otpStore.set(key, record);
    return { ok: false, reason: 'invalid' };
  }

  otpStore.delete(key);
  return {
    ok: true,
    payload: record.payload
  };
}

module.exports = {
  issueOtp,
  verifyOtpAndConsume
};
