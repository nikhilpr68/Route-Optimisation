const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');

dotenv.config();

const connectDB = require('./config/db');
const { errorHandler } = require('./middleware/errorMiddleware');
const { startRunRecoveryMonitor } = require('./services/runRecovery');

// Routes
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes');
const publicProjectRoutes = require('./routes/publicProjectRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const validatorRoutes = require('./routes/validatorRoutes');
const collaborateRoutes = require('./routes/collaborateRoutes');

const app = express();
const PORT = Number(process.env.PORT) || 5001;
const isVercel = Boolean(process.env.VERCEL);
const rawCorsOrigins = String(
  process.env.CORS_ORIGINS ||
  process.env.CORS_ORIGIN ||
  process.env.FRONTEND_URL ||
  'http://localhost:5173,http://localhost:5174'
);
const corsDebug = String(process.env.CORS_DEBUG || '').toLowerCase() === 'true';

const normalizeOrigin = (origin) => String(origin || '').trim().replace(/\/+$/, '').toLowerCase();
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const allowedOriginTokens = rawCorsOrigins
  .split(/[,\n]/)
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);

const allowAnyOrigin = allowedOriginTokens.includes('*');
const exactAllowedOrigins = new Set(
  allowedOriginTokens.filter((origin) => origin !== '*' && !origin.includes('*'))
);
const wildcardOriginPatterns = allowedOriginTokens
  .filter((origin) => origin.includes('*'))
  .map((pattern) => new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, '.*')}$`));

const isAllowedOrigin = (origin) => {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return true;
  if (allowAnyOrigin) return true;
  if (exactAllowedOrigins.has(normalized)) return true;
  return wildcardOriginPatterns.some((pattern) => pattern.test(normalized));
};

const ensureDbReady = async (_req, res, next) => {
  try {
    await connectDB();
    return next();
  } catch (error) {
    return res.status(503).json({
      message: 'Database unavailable. Please retry shortly.',
      detail: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

connectDB().catch((error) => {
  console.error(`Startup Mongo connect failed: ${error.message}`);
});
if (!isVercel) {
  startRunRecoveryMonitor();
}

// In Vercel serverless, only /tmp is writable. Keep local behavior unchanged.
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : (process.env.VERCEL ? path.join(os.tmpdir(), 'uploads') : path.join(__dirname, 'uploads'));
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
process.env.UPLOAD_DIR = uploadDir;

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests without an Origin header (e.g., curl/Postman/server-to-server).
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    if (corsDebug) {
      console.warn(`⛔ CORS blocked for origin: ${origin}`);
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Mount routes
app.get('/', (_req, res) => {
  res.status(200).json({ service: 'route-optimization-backend', status: 'ok' });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/api', ensureDbReady);
app.use('/api/auth', authRoutes);
app.use('/api/shared', publicProjectRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/validator', validatorRoutes);
app.use('/api/collaborate', collaborateRoutes);

// Error handler last
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(
      `🌐 Allowed CORS origins: ${allowAnyOrigin
        ? '*'
        : [...exactAllowedOrigins, ...wildcardOriginPatterns.map((p) => p.toString())].join(', ')
      }`
    );
  });
}

module.exports = app;
