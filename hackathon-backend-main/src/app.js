import express from 'express';
import mongoose from 'mongoose';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { AppError, ok } from './utils/errors.js';
import { router } from './routes/index.js';
import { openapi } from './utils/openapi.js';

// ---------------------------------------------------------------------------
// Logger — in production enforce warn+ to prevent sensitive data leaking via
// info-level request logs on misconfigured deployments.
// ---------------------------------------------------------------------------
const logLevel = env.NODE_ENV === 'production'
  ? (['trace','debug','info'].includes(env.LOG_LEVEL) ? 'warn' : env.LOG_LEVEL)
  : env.LOG_LEVEL;

export const logger = pino({
  level: logLevel,
  redact: ['password', 'passwordHash', 'token', 'authorization', 'AI_API_KEY',
           'req.headers.authorization', 'req.headers.cookie'],
});

export const app = express();
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Request ID — attach before any other middleware
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  req.id = randomUUID();
  res.set('X-Request-Id', req.id);
  const start = Date.now();
  res.on('finish', () =>
    logger.info(
      { requestId: req.id, method: req.method, path: req.path,
        status: res.statusCode, durationMs: Date.now() - start },
      'request',
    ),
  );
  next();
});

// ---------------------------------------------------------------------------
// Security headers — tightened Helmet CSP
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc:  ["'none'"],
      styleSrc:   ["'none'"],
      imgSrc:     ["'none'"],
      connectSrc: ["'self'"],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
      baseUri:    ["'none'"],
      formAction: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,          // 1 year
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ---------------------------------------------------------------------------
// CORS — explicit allowlist only; wildcard *.vercel.app removed
// ---------------------------------------------------------------------------
const allowed = env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin / server-to-server calls (no Origin header)
    if (!origin) return cb(null, true);
    // Always check explicit allowlist first
    if (allowed.includes(origin)) return cb(null, true);
    // Allow localhost only in non-production
    if (env.NODE_ENV !== 'production' && localOrigin.test(origin)) return cb(null, true);
    return cb(new AppError(403, 'Origin not allowed'));
  },
  credentials: false,
}));

// ---------------------------------------------------------------------------
// Body parsing — keep 1 MB ceiling to prevent oversized payload attacks
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// NoSQL injection sanitization — strip keys starting with $ or containing .
// Applied to body, query, and params after parsing.
// ---------------------------------------------------------------------------
function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
    } else {
      sanitizeObject(obj[key]);
    }
  }
  return obj;
}

app.use((req, _res, next) => {
  sanitizeObject(req.body);
  sanitizeObject(req.query);
  // req.params is set per-route; sanitize what we can at the app level
  sanitizeObject(req.params);
  next();
});

// ---------------------------------------------------------------------------
// XSS sanitization — strip <script> tags and javascript: URIs from strings
// Only sanitizes string leaf values; structured data is validated by Zod.
// ---------------------------------------------------------------------------
const XSS_PATTERNS = [
  /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
  /<[^>]*\s(?:on\w+|href\s*=\s*["']?\s*javascript:)[^>]*>/gi,
  /javascript\s*:/gi,
];

function sanitizeStrings(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    let value = obj;
    for (const pattern of XSS_PATTERNS) value = value.replace(pattern, '');
    return value;
  }
  if (Array.isArray(obj)) return obj.map(sanitizeStrings);
  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) obj[key] = sanitizeStrings(obj[key]);
  }
  return obj;
}

app.use((req, _res, next) => {
  req.body  = sanitizeStrings(req.body);
  req.query = sanitizeStrings(req.query);
  next();
});

// ---------------------------------------------------------------------------
// Global rate limit — 300 req/min per IP across all routes
// ---------------------------------------------------------------------------
app.use(rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Rate limit exceeded' },
}));

// ---------------------------------------------------------------------------
// Health / readiness probes (unauthenticated, not rate-limited separately)
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => ok(res, { status: 'alive' }));
app.get('/ready', async (req, res) => {
  if (mongoose.connection.readyState !== 1)
    return res.status(503).json({ success: false, message: 'Database unavailable' });
  try {
    await mongoose.connection.db.admin().ping();
    ok(res, { status: 'ready' });
  } catch {
    res.status(503).json({ success: false, message: 'Database unavailable' });
  }
});

// OpenAPI spec (non-sensitive, public)
app.get('/api/v1/openapi.json', (req, res) => res.json(openapi()));

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------
app.use('/api/v1', router);
app.use('/api', router);

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------
app.use((req, res) =>
  res.status(404).json({ success: false, message: 'Endpoint not found', requestId: req.id }),
);

// ---------------------------------------------------------------------------
// Centralised error handler — never leak stack traces or internal details
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  let status  = err.status || 500;
  let message = status < 500 ? err.message : 'An unexpected error occurred';
  let errors  = err.errors;

  if (err instanceof ZodError) {
    status  = 422;
    message = 'Validation failed';
    errors  = err.issues.map(i => ({ field: i.path.join('.'), reason: i.message }));
  }
  if (err.code === 11000)  { status = 409; message = 'Record already exists'; errors = undefined; }
  if (err.name === 'CastError') { status = 422; message = 'Invalid identifier'; errors = undefined; }
  if (err.type === 'entity.parse.failed') { status = 400; message = 'Invalid JSON'; errors = undefined; }
  if (err.type === 'entity.too.large')    { status = 413; message = 'Request body too large'; errors = undefined; }

  // Log 5xx with structured context but NO stack trace in the response
  if (status >= 500)
    logger.error({ requestId: req.id, errorType: err.name, code: err.code }, 'request failed');

  res.status(status).json({
    success: false,
    message,
    ...(status < 500 && errors && { errors }),
    requestId: req.id,
  });
});
