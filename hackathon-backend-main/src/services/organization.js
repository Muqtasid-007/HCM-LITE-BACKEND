import { DateTime } from 'luxon';
import { OrgUnit, Employee } from '../models/index.js';
import { company, transaction, roles, audit } from './common.js';
import { today, currentPolicy } from '../utils/dates.js';
import { assert } from '../utils/errors.js';
export async function getOrganization(actor) { roles(actor,'Admin','HR'); const c=await company(); return { company:c, units:await OrgUnit.find().sort({ kind:1,name:1 }) }; }
export async function changeOrganization(actor,input) {
  roles(actor,'Admin');
  return transaction(async session => {
    const c=await company(session); const current=currentPolicy(c);
    const earliest=DateTime.now().setZone(current.timezone).plus({days:1}).toISODate();
    assert(input.effectiveDate >= earliest,422,'Policy changes take effect no earlier than tomorrow');
    assert(input.effectiveDate > c.policies.at(-1).effectiveDate,422,'Policy versions must have increasing effective dates');
    const before=c.toObject();
    // Types are deactivated, never removed, so historical references remain meaningful.
    assert(c.policies.at(-1).leaveTypes.every(t => input.policy.leaveTypes.some(n => n.name === t.name)),422,'Deactivate leave types instead of removing them');
    if(input.name) c.name=input.name;
    c.policies.push({ ...input.policy,effectiveDate:input.effectiveDate }); await c.save({ session });
    await audit(actor,'policy_changed','Company',c._id,before,c.toObject(),session); return c;
  });
}
export async function saveUnit(actor,id,input) {
  roles(actor,'Admin');
  return transaction(async session => {
    let unit=id ? await OrgUnit.findById(id).session(session) : new OrgUnit(input);
    assert(unit,404,'Configuration record not found'); const before=id ? unit.toObject() : null;
    Object.assign(unit,input); await unit.save({ session });
    await audit(actor,id?'updated':'created','OrgUnit',unit._id,before,unit.toObject(),session); return unit;
  });
}
export async function deleteUnit(actor,id) {
  roles(actor,'Admin');
  return transaction(async session => {
    const unit=await OrgUnit.findById(id).session(session); assert(unit,404,'Configuration record not found');
    assert(!await Employee.exists({ $or:[{ departmentId:id },{ designationId:id }] }).session(session),409,'Record is referenced; deactivate instead');
    await unit.deleteOne({ session }); await audit(actor,'deleted','OrgUnit',id,unit.toObject(),null,session); return null;
  });
}
