# HCM Lite backend

JavaScript ES modules, Node.js 22+, Express 5, MongoDB/Mongoose, JWT, bcrypt, Zod, PDFKit and a hosted tool-calling LLM. **Backend only.** No Python or TypeScript runtime, no frontend, no seeded employees or activity. The challenge PDF was read as a specification; its sample dashboard numbers are never inserted.

## Run locally

1. Install Node.js 22+ and Docker (or provide a MongoDB Atlas replica set).
2. `npm ci`
3. Copy `.env.example` to `.env`, configure a random `JWT_SECRET` of at least 32 characters and your permitted frontend origins. Existing `.env` files have been preserved; update their configuration for this backend. The application reads `.env`, not `.env.local`.
4. `docker compose up -d --wait` starts a local single-node MongoDB replica set. The database port is bound to localhost. For hosted deployment, use an authenticated Atlas URI and HTTPS.
5. `npm start` (port 5000 by default). `GET /health` checks liveness; `GET /ready` checks the database.
6. Call `GET /api/v1/setup-status`, then `POST /api/v1/setup` with `{"companyName":"My Company","email":"admin@example.com","password":"a-strong-unique-password"}`. Setup creates policy defaults and one Admin only. Setup is protected against races by a singleton unique key plus transaction. There is no public registration or reset endpoint that bypasses Admin authorization.

Alternative explicit first-run bootstrap: set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and optionally `COMPANY_NAME`, then `npm run bootstrap`. It does nothing if initialization already happened. Before creating an Admin, bootstrap looks up the trimmed, lowercase email and reuses an existing user without changing their password, role, active state, or sessions. A concurrent duplicate insert is recovered by fetching the existing user outside the aborted transaction and retrying initialization. Existing non-Admin users are never promoted by bootstrap. Startup does **not** run bootstrap automatically. On Render use `npm start` as the start command; if you explicitly run bootstrap before it, repeated bootstrap runs are safe. Keep bootstrap secrets out of version control.

MongoDB transactions are required; standalone `mongod` is deliberately rejected on startup. All indexes are initialized before listening. One installation serves one company. A MongoDB replica set backs both local use and isolated tests.

## Frontend handoff

- [API guide](docs/API.md): flows, authorization, request examples, response objects and errors.
- [Business rules](docs/RULES.md): date boundaries, attendance precedence, quota concurrency, payroll/tax/rounding semantics, analytics definitions and deployment limits.
- [OpenAPI 3.1](docs/openapi.json): every application route, role requirements, generated request schemas and query parameters. Also served at `/api/v1/openapi.json` without authentication. Run `npm run docs` after changing routes/schemas.

All JSON uses `{success,message,data}` or `{success:false,message,errors?,requestId}`. Authentication uses `Authorization: Bearer <token>`. Login is the sole endpoint returning a JWT. Creation/reset returns temporary credentials only to the authorized creator. Never log or persist those plaintext credentials in a frontend. After temporary login, only `me`, `logout` and `change-password` are available; changing a password invalidates every old session, requiring another login.

## Verification and maintenance

```sh
npm run check
npm test
npm run docs
npm run reconcile -- 2026-10-01 2026-10-23
```

Tests run entirely on Node.js using `node:test`, Supertest and `mongodb-memory-server` with a fresh disposable replica set. They ignore the real database URI and never write application fixtures to your configured database. The first test run downloads a pinned MongoDB 7.0.24 executable (network access and disk space required); later runs reuse the cache. `MONGOMS_SYSTEM_BINARY` can point to an existing compatible `mongod`. On Windows, install the Microsoft Visual C++ 2015–2022 x64 runtime if the MongoDB executable cannot launch. For this workspace a verified cached test binary is available under ignored `tmp/mongodb/` and the tests automatically use it when present. There is no test setup against the production database. Provider integration tests use a local HTTP mock that verifies real request/tool-call dispatch, not a paid live provider request.

Run reconciliation daily after company-local midnight using your hosting scheduler (`npm run reconcile` defaults to yesterday). It is idempotent and can backfill a date range. REST and payroll generation also expose/use the same reconciliation service. Analytics derive eligible historical absences even before backfill. There are no fabricated absences for today or future dates.

## AI configuration

Set `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` for a hosted provider implementing the OpenAI-compatible `/chat/completions` protocol, including function tool calls and JSON object mode. The default base URL is `https://api.openai.com/v1`; select a model supported by your provider/account. Credentials stay on the server and are never sent to the browser. If `AI_API_KEY` is empty, or the provider is unavailable, `AI_FALLBACK_MODE=auto` uses the server-side deterministic read-only assistant for policy answers, authorized dashboard tools, and validated smart-leave proposals; set it to `never` to disable that fallback. The assistant has seven read-only tools that call the same authorized services as REST; it cannot save or approve data. Chat, summaries and smart leave share 20 requests/user/hour, a 15-second provider deadline, sanitized fallback responses and metadata-only AI logs. Smart leave returns a proposal requiring an explicit ordinary `POST /leaves` after frontend confirmation. No AI API key is required for the rest of the system.

## Scope delivered

First-run auth and account lifecycle; versioned company policy and configuration; linked HR/Employee profiles; directory, 360 and atomic CSV import/export; attendance/corrections/reconciliation; leave approval, cancellation and balances; salary history and immutable payroll/payslips/PDFs; dashboards and read tools; hosted AI chat, summaries and smart leave; announcements, notifications, audit and AI logs. No optional camera/face attendance or risk-scoring bonuses. No frontend or hosting deployment is included.

The legacy `config/db.js` and `config/cloudinary.js` were preserved as existing files; the new server uses `src/config/db.js` and does not import the legacy Cloudinary configuration. No Python application files or dependencies existed or were introduced.

## Operational notes

Set exact `CORS_ORIGINS` (comma separated) for non-Vercel origins, HTTPS at your reverse proxy, and a unique strong JWT secret. The backend also permits HTTPS `*.vercel.app` preview/deployment origins because Vercel deployment URLs change; credentials are disabled. CORS limits browser origins; it is not an authentication mechanism. Proxy trust is disabled by default; rate limiting uses the socket peer IP. Configure trusted proxy hops in `src/app.js` only if your deployment requires it. The provided rate limits are process-local; use one API process for the hackathon, or replace the limiter store with a shared store before horizontal scaling. Business transactions serialize on the singleton company to prioritize correctness at hackathon scale. Graceful shutdown waits for in-flight HTTP requests and closes MongoDB. Logs contain method/path/status/request ID, never request bodies or authorization headers.

Startup always prints safe phase markers: environment validation, MongoDB connection, index checks, and the HTTP listener. Fatal startup/job errors print their original error name, message, stack, code, and available nested MongoDB DNS/TLS/socket errors to stderr via `console.error`, even with `LOG_LEVEL=silent`. Connection strings and environment credentials are redacted; validation remains enabled. The server exits nonzero after closing resources. It binds `0.0.0.0` on Render's `PORT` and rejects port-binding failures. Required environment variables are `MONGODB_URI` (mongodb:// or mongodb+srv://) and `JWT_SECRET` (at least 32 characters); `LOG_LEVEL` must be a supported Pino level. A database selection failure normally appears after the configured 10-second connection timeout. Use the last phase and sanitized exception to diagnose the failure rather than logging the URI or resetting records. Startup never seeds users automatically.
