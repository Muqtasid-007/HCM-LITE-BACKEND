import { DateTime } from 'luxon';
import { Leave, Attendance, Employee } from '../models/index.js';
import { transaction, company, scopeEmployee, roles, audit, notify } from './common.js';
import { dates, policyFor, currentPolicy, working, employed, today } from '../utils/dates.js';
import { assert } from '../utils/errors.js';
import { reconcileDate } from './attendance.js';
export async function leaveBalance(actor,id,year,session) {
  const e=await scopeEmployee(actor,id,session),c=await company(session);
  const p=policyFor(c,`${year}-12-31`);
  const requests=await Leave.find({employeeId:e._id,state:'approved','days.year':year}).session(session || null);
  return {employeeId:e._id,year,pendingReservesBalance:false,types:p.leaveTypes.map(t=> { const used=requests.filter(r=>r.type===t.name).flatMap(r=>r.days).filter(d=>d.year===year).length; return {type:t.name,quota:t.quota,used,remaining:t.quota===null?null:Math.max(0,t.quota-used),active:t.active}; })};
}
function allocation(c,e,input) {
  const result=[];
  for(const date of dates(input.start,input.end)) {
    const p=policyFor(c,date),t=p.leaveTypes.find(t=>t.name===input.type && t.active);
    assert(t,422,'Unknown or inactive leave type for requested date');
    assert(employed(e,date),422,'Leave falls outside eligible employment');
    if(working(date,p)) result.push({date,year:Number(date.slice(0,4)),paid:t.paid,quota:t.quota});
  } assert(result.length,422,'Leave must include at least one working day'); return result;
}
async function validateRequest(e,input,days,session,ignoreId) {
  const q={employeeId:e._id,state:{$in:['pending','approved']},start:{$lte:input.end},end:{$gte:input.start}};
  if(ignoreId) q._id={$ne:ignoreId};
  assert(!await Leave.exists(q).session(session),422,'Leave request overlaps an active request');
  assert(!await Attendance.exists({employeeId:e._id,date:{$in:days.map(d=>d.date)},checkIn:{$ne:null}}).session(session),422,'Attendance already exists on a leave day');
  const approved=await Leave.find({employeeId:e._id,type:input.type,state:'approved',...(ignoreId && {_id:{$ne:ignoreId}})}).session(session);
  // Each year is checked independently. Mid-year quota changes use the lowest quota
  // among the requested days, so a later increase cannot backdate entitlement.
  for(const year of new Set(days.map(d=>d.year))) {
    const allocated=days.filter(d=>d.year===year),quotas=allocated.map(d=>d.quota).filter(q=>q!==null);
    if(!quotas.length) continue;
    const used=approved.flatMap(r=>r.days).filter(d=>d.year===year && d.paid).length;
    assert(used+allocated.filter(d=>d.paid).length<=Math.min(...quotas),422,`Insufficient ${input.type} balance for ${year}`);
  }
}
export async function applyLeave(actor,input) {
  roles(actor,'Employee','HR'); return transaction(async s=> {
    const e=await scopeEmployee(actor,'me',s),c=await company(s),p=policyFor(c,input.start);
    assert(input.start>=today(p.timezone),422,'Leave applications cannot start in the past');
    const days=allocation(c,e,input); await validateRequest(e,input,days,s);
    const [r]=await Leave.create([{...input,employeeId:e._id,days}],{session:s}); await audit(actor,'applied','Leave',r._id,null,r.toObject(),s); return r;
  });
}
export async function decideLeave(actor,id,input) {
  roles(actor,'HR'); return transaction(async s=> {
    const r=await Leave.findById(id).session(s); assert(r,404,'Leave not found'); assert(r.state==='pending',409,'Already reviewed'); assert(String(r.employeeId)!==String(actor.employeeId),403,'Cannot review your own leave');
    if(input.decision==='approved') {
      const e=await scopeEmployee(actor,r.employeeId,s),c=await company(s);
      r.days=allocation(c,e,r); await validateRequest(e,r,r.days,s,r._id);
    }
    const before=r.toObject(); r.state=input.decision; r.comment=input.comment; r.reviewedBy=actor._id; await r.save({session:s});
    if(r.state==='approved') { const c=await company(s); for(const d of r.days) if(d.date<today(policyFor(c,d.date).timezone)) await reconcileDate(d.date,s); }
    await notify(r.employeeId,`Leave ${r.state}: ${input.comment}`,r._id,s); await audit(actor,r.state,'Leave',id,before,r.toObject(),s); return r;
  });
}
export async function cancelLeave(actor,id) {
  roles(actor,'Employee','HR'); return transaction(async s=> {
    const r=await Leave.findById(id).session(s); assert(r,404,'Leave not found'); assert(String(r.employeeId)===String(actor.employeeId),403,'Only your own leave can be cancelled');
    const c=await company(s),p=policyFor(c,r.start);
    assert(['pending','approved'].includes(r.state) && r.start>today(p.timezone),422,'Only pending or approved requests starting after today may be cancelled');
    const before=r.toObject(); r.state='cancelled'; await r.save({session:s}); await audit(actor,'cancelled','Leave',id,before,r.toObject(),s); return r;
  });
}
export async function listLeave(actor,f) {
  const q={}; if(actor.role==='Employee') q.employeeId=actor.employeeId||null; else if(f.employeeId) q.employeeId=f.employeeId;
  if(f.departmentId && actor.role!=='Employee') { const {Employee}=await import('../models/index.js'); q.employeeId={$in:(await Employee.find({departmentId:f.departmentId})).map(e=>e._id)}; }
  if(f.state) q.state=f.state;
  if(f.from) q.end={$gte:f.from}; if(f.to) q.start={$lte:f.to};
  const [items,total]=await Promise.all([Leave.find(q).sort({createdAt:-1}).skip((f.page-1)*f.limit).limit(f.limit),Leave.countDocuments(q)]); return {items,total,page:f.page,limit:f.limit};
}
export async function leaveSummary(actor,f={}) {
  const c=await company();
  const from=f.from||today(currentPolicy(c).timezone),to=f.to||from; dates(from,to);
  const employeeQuery=actor.role==='Employee'?{_id:actor.employeeId||null}:f.departmentId?{departmentId:f.departmentId}:{};
  const employees=await Employee.find(employeeQuery).select('name departmentId').lean();
  const match={employeeId:{$in:employees.map(e=>e._id)},state:'approved','days.date':{$gte:from,$lte:to}};
  const byType=await Leave.aggregate([{$match:match},{$unwind:'$days'},{$match:{'days.date':{$gte:from,$lte:to}}},{$group:{_id:'$type',days:{$sum:1}}},{$sort:{_id:1}}]);
  const requests=await Leave.find(match).sort({start:1}).limit(100).lean();
  return {from,to,byType:byType.map(t=>({type:t._id,days:t.days})),requests:requests.map(r=>({id:r._id,employeeId:r.employeeId,name:employees.find(e=>String(e._id)===String(r.employeeId))?.name,type:r.type,start:r.start,end:r.end,days:r.days.filter(d=>d.date>=from&&d.date<=to).length})),requestsTruncated:await Leave.countDocuments(match)>100};
}
