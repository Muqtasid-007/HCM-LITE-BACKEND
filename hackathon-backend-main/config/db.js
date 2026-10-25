// Compatibility for older imports; use the same awaited, validated connector.
// Failures propagate to the caller's startup error boundary.
export { connectDB as default } from '../src/config/db.js';
