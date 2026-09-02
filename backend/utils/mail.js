const nodemailer = require('nodemailer');
const dns = require('dns');

// Force IPv4 DNS resolution to avoid ENETUNREACH on cloud platforms (e.g. Railway)
// where IPv6 connectivity to SMTP servers like Gmail may not be available.
dns.setDefaultResultOrder('ipv4first');

let transporter;

function shouldAllowDevMailTransport() {
  return String(process.env.AUTH_ALLOW_DEV_MAIL_TRANSPORT || '').trim().toLowerCase() === 'true';
}

function readTimeout(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildTransportConfig() {
  const host = process.env.MAIL_HOST;
  const port = Number(process.env.MAIL_PORT || 587);
  const secure = String(process.env.MAIL_SECURE || '').toLowerCase() === 'true';
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;
  const service = process.env.MAIL_SERVICE;

  if (host || service) {
    const config = {
      ...(service ? { service } : { host, port, secure }),
      connectionTimeout: readTimeout('MAIL_CONNECTION_TIMEOUT_MS', 10000),
      greetingTimeout: readTimeout('MAIL_GREETING_TIMEOUT_MS', 10000),
      socketTimeout: readTimeout('MAIL_SOCKET_TIMEOUT_MS', 15000)
    };

    if (user && pass) {
      config.auth = { user, pass };
    }

    if (host) {
      config.name = process.env.MAIL_HELO_NAME || 'localhost';
      config.tls = {
        servername: host
      };
    }

    return config;
  }

  if (shouldAllowDevMailTransport()) {
    return { jsonTransport: true };
  }

  throw new Error('Mail transport is not configured. Set MAIL_HOST/MAIL_PORT/MAIL_USER/MAIL_PASS or MAIL_SERVICE.');
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport(buildTransportConfig());
  }
  return transporter;
}

function getFromAddress() {
  return (
    process.env.MAIL_FROM ||
    process.env.MAIL_USER ||
    process.env.SMTP_FROM ||
    'no-reply@route-optimizer.local'
  );
}

async function sendMail({ to, subject, text, html }) {
  const mailer = getTransporter();
  const info = await mailer.sendMail({
    from: getFromAddress(),
    to,
    subject,
    text,
    ...(html ? { html } : {})
  });

  return info;
}

module.exports = {
  sendMail
};
