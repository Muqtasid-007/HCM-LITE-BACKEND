import { DateTime } from 'luxon';
import { assert } from './errors.js';
export const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid;
export const today = timezone => DateTime.now().setZone(timezone).toISODate();
export function dates(start, end) {
  assert(isoDate(start) && isoDate(end) && start <= end, 422, 'Valid ordered ISO dates required');
  assert(DateTime.fromISO(end).diff(DateTime.fromISO(start), 'days').days <= 1096, 422, 'Date range exceeds three years');
  const result = [];
  for (let d = DateTime.fromISO(start); d.toISODate() <= end; d = d.plus({ days: 1 })) result.push(d.toISODate());
  return result;
}
export const policyFor = (company, date) => [...company.policies].reverse().find(p => p.effectiveDate <= date) || company.policies[0];
export const currentPolicy = company => [...company.policies].reverse().find(p => p.effectiveDate <= today(p.timezone)) || company.policies[0];
export const working = (date, policy) => !policy.weekendDays.includes(DateTime.fromISO(date).weekday) && !policy.holidays.some(h => h.date === date && h.active !== false);
export const employed = (employee, date) => employee.joiningDate <= date && (!employee.exitDate || date <= employee.exitDate) && statusFor(employee, date) !== 'inactive';
export const statusFor = (employee, date) => [...employee.employmentHistory].reverse().find(h => h.effectiveDate <= date)?.status || employee.status;
export const salaryFor = (employee, date) => [...employee.salaryHistory].reverse().find(h => h.effectiveDate <= date)?.basicMinor || 0;
export function monthRange(month) { const d = DateTime.fromISO(`${month}-01`); assert(/^\d{4}-\d{2}$/.test(month) && d.isValid, 422, 'Invalid month'); return [d.toISODate(), d.endOf('month').toISODate()]; }
