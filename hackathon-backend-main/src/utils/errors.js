export class AppError extends Error {
  constructor(status, message, errors) { super(message); this.status = status; this.errors = errors; }
}
export function assert(condition, status, message) { if (!condition) throw new AppError(status, message); }
export const ok = (res, data, message = 'OK', meta) => res.json({ success: true, message, data, ...(meta && { meta }) });
