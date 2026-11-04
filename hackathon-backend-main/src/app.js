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
// Security headers
// Helmet is applied globally with a strict default CSP suited to a JSON API.
// The /api/docs route overrides the CSP header after Helmet runs, relaxing
// only the directives Swagger UI requires (CDN scripts/styles + data: images).
// Every other route keeps the locked-down defaults.
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'none'"],
      scriptSrc:   ["'none'"],
      styleSrc:    ["'none'"],
      imgSrc:      ["'none'"],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
      baseUri:     ["'none'"],
      formAction:  ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,   // 1 year
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Docs-route CSP — applied after Helmet so it overwrites only for /api/docs*.
// Allows the unpkg CDN bundle Swagger UI needs and nothing else.
const SWAGGER_CDN = 'https://unpkg.com';
const DOCS_CSP = [
  `default-src 'none'`,
  `script-src  'self' ${SWAGGER_CDN} 'unsafe-inline'`,   // swagger-ui-bundle.js needs unsafe-inline for its worker
  `style-src   'self' ${SWAGGER_CDN} 'unsafe-inline'`,   // swagger-ui.css uses inline style overrides
  `img-src     'self' ${SWAGGER_CDN} data:`,              // data: URIs used for embedded icons
  `connect-src 'self'`,                                   // API calls from the Try-It-Out panel
  `frame-src   'none'`,
  `object-src  'none'`,
  `base-uri    'none'`,
  `form-action 'none'`,
].join('; ');

app.use('/api/docs', (_req, res, next) => {
  res.setHeader('Content-Security-Policy', DOCS_CSP);
  next();
});

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
// Operates on keys only, so password *values* are never affected.
// This runs on ALL routes including auth — it's the primary defence against
// MongoDB operator injection attacks like { "$gt": "" } login bypasses.
// ---------------------------------------------------------------------------
function sanitizeObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 10) return obj;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
    } else {
      sanitizeObject(obj[key], depth + 1);
    }
  }
  return obj;
}

app.use((req, _res, next) => {
  try {
    sanitizeObject(req.body);
    const query = sanitizeObject(req.query);
    // Express 5 reparses req.query on each getter access; retain this sanitized
    // object downstream without assigning through the getter-only property.
    Object.defineProperty(req, 'query', { configurable: true, enumerable: true, writable: true, value: query });
    // req.params is populated per-route; sanitize defensively at app level too
    sanitizeObject(req.params);
  } catch (err) {
    // Sanitization must never crash a request — log and continue
    logger.warn({ requestId: req.id, err: err.message }, 'sanitizeObject failed');
  }
  next();
});

// ---------------------------------------------------------------------------
// XSS sanitization — strip <script> blocks and javascript: URIs from strings.
//
// PASSWORD FIELDS ARE INTENTIONALLY EXCLUDED.
// Passwords are hashed immediately on receipt and never rendered as HTML, so
// stripping characters from them would silently corrupt credentials without
// any security benefit. The NoSQL pass above already covers injection for
// auth routes; Zod schema validation catches everything else.
//
// Excluded fields: password, currentPassword, newPassword
// ---------------------------------------------------------------------------
const XSS_PATTERNS = [
  /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
  /<[^>]*\s(?:on\w+|href\s*=\s*["']?\s*javascript:)[^>]*>/gi,
  /javascript\s*:/gi,
];

const PASSWORD_FIELDS = new Set(['password', 'currentPassword', 'newPassword']);

function sanitizeStringsInPlace(value, depth = 0) {
  if (value === null || value === undefined || depth > 10 || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) {
    // Skip password fields — preserve them exactly as the user typed
    if (PASSWORD_FIELDS.has(key)) continue;

    const current = value[key];
    if (typeof current === 'string') {
      let sanitized = current;
      for (const pattern of XSS_PATTERNS) sanitized = sanitized.replace(pattern, '');
      value[key] = sanitized;
    } else if (current && typeof current === 'object') {
      sanitizeStringsInPlace(current, depth + 1);
    }
  }
  return value;
}

app.use((req, _res, next) => {
  try {
    sanitizeStringsInPlace(req.body);
    sanitizeStringsInPlace(req.query);
  } catch (err) {
    // Sanitization must never crash a request — log and continue
    logger.warn({ requestId: req.id, err: err.message }, 'sanitizeStrings failed');
  }
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
// Swagger UI — served from CDN bundle, no additional npm dependency.
// The DOCS_CSP middleware above already set the relaxed header for this path.
// Available at: /api/docs
// ---------------------------------------------------------------------------
app.get('/api/docs', (_req, res) => {
  const swaggerUiVersion = '5.18.2'; // pinned CDN version
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HCM Lite – API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${swaggerUiVersion}/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@${swaggerUiVersion}/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/v1/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
      persistAuthorization: true,
    });
  </script>
</body>
</html>`);
});

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
