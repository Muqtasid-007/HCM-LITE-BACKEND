import { runStartup, exitWithError } from './src/utils/startup.js';

let mongoose, server, stopping = false;
async function closeResources() {
  if (server?.listening) {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
  }
  if (mongoose) await mongoose.disconnect();
}
function fatal(error, context) {
  stopping = true;
  return runStartup(context, async () => { throw error; }, closeResources);
}
process.on('unhandledRejection', error => { void fatal(error, 'Unhandled rejection'); });
process.on('uncaughtException', error => { void fatal(error, 'Uncaught exception'); });

await runStartup('Server startup failed', async () => {
  console.info('[startup] Validating environment');
  // Dynamic imports put module-level validation and dependency failures inside the
  // error boundary. Static imports would fail before this try/catch could run.
  const { env } = await import('./src/config/env.js');
  ({ default: mongoose } = await import('mongoose'));
  const { app } = await import('./src/app.js');
  const { connectDB } = await import('./src/config/db.js');
  const { ensureIndexes } = await import('./src/models/index.js');
  console.info('[startup] Connecting to MongoDB');
  await connectDB();
  console.info('[startup] MongoDB connected; checking indexes');
  await ensureIndexes();
  console.info('[startup] Indexes ready; opening HTTP listener');
  await new Promise((resolve, reject) => {
    server = app.listen(env.PORT, '0.0.0.0', error => error ? reject(error) : resolve());
    server.once('error', reject);
  });
  server.on('error', error => { void fatal(error, 'HTTP server failed'); });
  console.info(`[startup] HCM Lite API listening on port ${env.PORT}`);
}, closeResources);

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.info(`[shutdown] Received ${signal}`);
  const deadline = setTimeout(() => exitWithError(new Error('Graceful shutdown exceeded 10 seconds'), 'Shutdown timeout'), 10000);
  deadline.unref();
  await runStartup('Shutdown failed', closeResources);
  clearTimeout(deadline);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
