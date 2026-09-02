const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_POLICY_TEXT =
  'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.';

function validatePasswordStrength(rawPassword) {
  const password = String(rawPassword || '');
  const issues = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push(`at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!/[A-Z]/.test(password)) {
    issues.push('an uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    issues.push('a lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    issues.push('a number');
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    issues.push('a special character');
  }

  return {
    valid: issues.length === 0,
    issues,
    message: issues.length ? `Password must include ${issues.join(', ')}.` : ''
  };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_TEXT,
  validatePasswordStrength
};
