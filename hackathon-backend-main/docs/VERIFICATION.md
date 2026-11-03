# Local verification

Completed on 24 October 2026 using Node.js, npm and an isolated MongoDB 7.0.24 replica set. No application/production database was used and no provider key was needed for tests.

- `npm run check`: all application, job, script and test JavaScript files pass Node syntax checking.
- `npm test`: **29 passed, 0 failed, 0 skipped**. Integration, bootstrap race, real HTTP-server/CLI and startup-failure tests complete in approximately 61 seconds with the MongoDB binary cached.
- `npm run docs`: generates the checked-in OpenAPI document directly from actual route and Zod definitions.
- `git diff --check`: no whitespace errors.
- Downloaded payslip has an application/pdf response and valid PDF signature. Rendered locally with Poppler and visually checked for readable text, amounts and layout. Test PDF/render live in ignored `tmp/pdfs/`.

Coverage includes concurrent singleton setup; initially empty company data and metrics; mandatory temporary-password change; JWT logout/version revocation; HR linking and linked-user rollback; role and object scopes; CSV dry-run/errors/atomic rollback/formula safety; duplicate attendance races; lateness/half-day boundaries; reconciliation and correction notifications; leave overlap/quota/year-crossing/cancellation; concurrent quota approval; gross/allowances/challenge tax; payroll proration and disjoint deductions; stale-draft detection and immutable finalization; zero-working-day months; scoped analytics; prospective policy/salary history; actual hosted-compatible function-call request/response dispatch through a local provider mock; AI safe fallback; failed-login limiting; real `server.js` readiness and idempotent `bootstrap.js` execution.

The live paid/hosted AI provider was not called. Set your provider URL/model/key to enable it; the same HTTP integration is exercised by the local mock. Docker Compose was provided for local database setup; the local verification used mongodb-memory-server instead of Docker. No deployment or frontend was requested or performed. Optional camera, facial matching and risk/anomaly bonus features are excluded.

Bootstrap regression checks cover a pre-existing normalized email with no company record, preservation of the entire existing account document (including password hash, role, inactive state and session version), concurrent bootstrap calls, and an actual MongoDB E11000 caused by another writer inserting the email after the lookup. The HTTP server is started, stopped and started again against the same isolated database. Both starts become ready, the existing user remains identical, and the unique email index stays enabled. No application database was reset or modified during verification.

Startup diagnostics additionally cover invalid JWT secret, MongoDB URI prefix and log level, configuration failures in both CLI jobs, a refused database connection, and a real occupied HTTP port. Failures exit with status 1 and include the original error/stack on stderr even with silent application logging. Tests assert that connection strings, database credentials and quoted secrets do not appear in logs, and that nested MongoDB TLS errors retain useful details. Render's own environment/network failure was not reproduced or diagnosed against its live database; the updated diagnostics expose its precise failure without logging credentials.
