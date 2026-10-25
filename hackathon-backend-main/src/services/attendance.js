import { DateTime } from 'luxon';
import { Attendance, Correction, Employee, Leave } from '../models/index.js';
import { transaction, company, scopeEmployee, roles, audit, notify } from './common.js';
import { today, policyFor, currentPolicy, working, employed, dates } from '../utils/dates.js';
import { assert } from '../utils/errors.js';
export function classify(checkIn,checkOut,date,policy,closed=false) {
  const start=DateTime.fromISO(`${date}T${policy.officeStart}`,{zone:policy.timezone}).plus({minutes:policy.graceMinutes});
  const late=new Date(checkIn).getTime()>start.toMillis();
  const minutes=checkOut ? Math.floor((new Date(checkOut)-new Date(checkIn))/60000):0;
  return {late,minutes,status:!checkOut ? (closed?'missing_checkout':'open') : minutes<policy.halfDayHours*60 ? 'half_day':late?'late':'present'};
}
export async function checkIn(actor) {
  roles(actor,'Employee','HR');
  return transaction(async session=> {
    const e=await scopeEmployee(actor,'me',session),c=await company(session);
    const policy=currentPolicy(c),date=today(policy.timezone),now=new Date();
    assert(employed(e,date),422,'Not eligible for attendance on this date');
    assert(working(date,policy),422,'Today is not a working day');
    assert(!await Leave.exists({employeeId:e._id,state:'approved','days.date':date}).session(session),422,'Approved leave exists for today');
    const existing=await Attendance.findOne({employeeId:e._id,date}).session(session);
    assert(!existing || ['absent','on_leave'].includes(existing.status),409,'Already checked in');
    const fields={employeeId:e._id,date,checkIn:now,policySnapshot:policy,...classify(now,null,date,policy)};
    const a=existing ? Object.assign(existing,fields) : new Attendance(fields); await a.save({session});
    await audit(actor,'check_in','Attendance',a._id,null,a.toObject(),session); return a;
  });
}
export async function checkOut(actor) {
  roles(actor,'Employee','HR');
  return transaction(async session=> {
    const e=await scopeEmployee(actor,'me',session),c=await company(session),p=currentPolicy(c);
    const a=await Attendance.findOne({employeeId:e._id,date:today(p.timezone)}).session(session);
    assert(a?.checkIn,409,'No open check-in for today; request a correction for an earlier day'); assert(!a.checkOut,409,'Already checked out');
    const before=a.toObject(); a.checkOut=new Date(); Object.assign(a,classify(a.checkIn,a.checkOut,a.date,a.policySnapshot)); await a.save({session});
    await audit(actor,'check_out','Attendance',a._id,before,a.toObject(),session); return a;
  });
}
export async function reconcileDate(date,session) {
  const c=await company(session),policy=policyFor(c,date);
  assert(date<today(policy.timezone),422,'Only completed local dates can be reconciled');
  const employees=await Employee.find({joiningDate:{$lte:date}}).session(session);
  let count=0;
  for(const e of employees) {
    if(!employed(e,date) || !working(date,policy)) continue;
    const a=await Attendance.findOne({employeeId:e._id,date}).session(session);
    const leave=await Leave.findOne({employeeId:e._id,state:'approved','days.date':date}).session(session);
    if(a?.checkIn) { if(!a.checkOut && a.status!=='missing_checkout') { a.status='missing_checkout'; await a.save({session}); count++; } }
    else {
      const state=leave?'on_leave':'absent';
      if(!a) { await Attendance.create([{employeeId:e._id,date,status:state,policySnapshot:policy}],{session}); count++; }
      else if(a.status!==state) { a.status=state; await a.save({session}); count++; }
    }
  } return count;
}
export async function reconcile(actor,from,to) {
  roles(actor,'Admin','HR'); return transaction(async s=> { let changed=0; for(const date of dates(from,to)) changed+=await reconcileDate(date,s); await audit(actor,'reconciled','Attendance',`${from}/${to}`,null,{changed},s); return {changed}; });
}
export async function attendanceList(actor,f) {
  const c=await company(),p=currentPolicy(c),from=f.from||today(p.timezone),to=f.to||from; dates(from,to);
  let ids;
  if(actor.role==='Employee') ids=[(await scopeEmployee(actor,'me'))._id];
  else if(f.employeeId) ids=[(await scopeEmployee(actor,f.employeeId))._id];
  else ids=(await Employee.find(f.departmentId?{departmentId:f.departmentId}:{}).select('_id')).map(e=>e._id);
  const query={employeeId:{$in:ids},date:{$gte:from,$lte:to}};
  const [items,total]=await Promise.all([Attendance.find(query).sort({date:-1,employeeId:1}).skip((f.page-1)*f.limit).limit(f.limit),Attendance.countDocuments(query)]);
  return {items,total,page:f.page,limit:f.limit};
}
export async function requestCorrection(actor,input) {
  roles(actor,'Employee','HR'); return transaction(async session=> {
    const e=await scopeEmployee(actor,'me',session),c=await company(session),p=policyFor(c,input.date);
    assert(employed(e,input.date) && working(input.date,p),422,'Not an eligible working date');
    assert(input.date<=today(p.timezone),422,'Future correction not allowed');
    assert(DateTime.fromISO(input.checkIn).setZone(p.timezone).toISODate()===input.date && DateTime.fromISO(input.checkOut).setZone(p.timezone).toISODate()===input.date,422,'Timestamps must fall on the requested company-local date');
    assert(new Date(input.checkOut)<=new Date(),422,'Future timestamps not allowed');
    assert(!await Leave.exists({employeeId:e._id,state:'approved','days.date':input.date}).session(session),422,'Approved leave exists');
    const [r]=await Correction.create([{...input,employeeId:e._id}],{session}); await audit(actor,'requested','Correction',r._id,null,r.toObject(),session); return r;
  });
}
export async function decideCorrection(actor,id,input) {
  roles(actor,'HR'); return transaction(async session=> {
    const r=await Correction.findById(id).session(session); assert(r,404,'Correction not found'); assert(r.state==='pending',409,'Already reviewed'); assert(String(r.employeeId)!==String(actor.employeeId),403,'Cannot review your own request');
    const c=await company(session),p=policyFor(c,r.date);
    if(input.decision==='approved') {
      assert(!await Leave.exists({employeeId:r.employeeId,state:'approved','days.date':r.date}).session(session),422,'Approved leave conflicts with correction');
      let a=await Attendance.findOne({employeeId:r.employeeId,date:r.date}).session(session); const before=a?.toObject();
      if(!a) a=new Attendance({employeeId:r.employeeId,date:r.date,policySnapshot:p});
      const appliedPolicy=a.policySnapshot || p;
      a.checkIn=r.checkIn; a.checkOut=r.checkOut; Object.assign(a,classify(r.checkIn,r.checkOut,r.date,appliedPolicy)); a.source='correction';
      a.correctionHistory.push({correctionId:r._id,before:before||null,actorId:actor._id,at:new Date(),comment:input.comment}); await a.save({session});
      await audit(actor,'corrected','Attendance',a._id,before,a.toObject(),session);
    }
    r.state=input.decision; r.comment=input.comment; r.reviewedBy=actor._id; await r.save({session}); await notify(r.employeeId,`Attendance correction ${r.state}`,r._id,session); await audit(actor,r.state,'Correction',r._id,null,r.toObject(),session); return r;
  });
}
export async function listCorrections(actor,f) {
  const q={}; if(actor.role==='Employee') q.employeeId=actor.employeeId || null; else if(f.employeeId) q.employeeId=f.employeeId;
  if(f.state) q.state=f.state;
  const [items,total]=await Promise.all([Correction.find(q).sort({createdAt:-1}).skip((f.page-1)*f.limit).limit(f.limit),Correction.countDocuments(q)]); return {items,total,page:f.page,limit:f.limit};
}
