import mongoose from 'mongoose';
import { Company, Audit, Employee, Notification } from '../models/index.js';
import { assert } from '../utils/errors.js';
export const privileged = actor => ['Admin','HR'].includes(actor.role);
export const roles = (actor, ...allowed) => assert(allowed.includes(actor.role), 403, 'Access denied');
export async function scopeEmployee(actor, id, session) {
  const resolved = id === 'me' ? actor.employeeId : id;
  assert(resolved && (privileged(actor) || String(resolved) === String(actor.employeeId)), 403, 'Access denied');
  const employee = await Employee.findById(resolved).session(session || null);
  assert(employee, 404, 'Employee not found'); return employee;
}
export async function company(session) { const c = await Company.findById('singleton').session(session || null); assert(c, 409, 'Company setup required'); return c; }
// All business writes contend on the singleton. MongoDB retries transaction write conflicts,
// preventing concurrent quota overspend, stale payroll finalization, and orphan accounts.
export async function transaction(fn, { business = true } = {}) {
  return mongoose.connection.transaction(async session => {
    await Company.updateOne({ _id: 'singleton' }, { $inc: { lock: 1, ...(business && { revision: 1 }) } }, { session });
    return fn(session);
  });
}
export async function audit(actor, action, entity, id, before, after, session) {
  await Audit.create([{ actorId: actor?._id, action, entity, entityId: String(id), before, after }], { session });
}
export async function notify(employeeId, title, entityId, session) { const e = await Employee.findById(employeeId).session(session); if (e) await Notification.create([{ userId: e.userId, title, entityId: String(entityId) }], { session }); }
