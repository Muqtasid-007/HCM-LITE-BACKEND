import PDFDocument from 'pdfkit';
import { DateTime } from 'luxon';
import { Employee, Attendance, Leave, Payroll } from '../models/index.js';
import { transaction, company, roles, audit, notify } from './common.js';
import { dates, monthRange, policyFor, employed, working, salaryFor, today } from '../utils/dates.js';
import { assert } from '../utils/errors.js';
import { reconcileDate } from './attendance.js';
export function monthlyTax(grossMinor) {
  const annual=grossMinor*12;
  const tax=annual<=60000000?0:annual<=120000000?(annual-60000000)*0.05:annual<=240000000?3000000+(annual-120000000)*0.15:annual<=360000000?21000000+(annual-240000000)*0.25:51000000+(annual-360000000)*0.35;
  return Math.round(tax/12);
}
export async function generatePayroll(actor,month) {
  roles(actor,'HR');
  return transaction(async s=> {
    const [from,to]=monthRange(month),c=await company(s);
    let run=await Payroll.findOne({month}).session(s); assert(!run || run.state==='draft',409,'Finalized payroll is immutable');
    const old=run?.toObject(); const days=dates(from,to);
    // Drafts for an ongoing month project future eligible workdays as payable. Finalization
    // is only permitted once the whole month has closed and regenerates under this lock.
    for(const d of days) if(d<today(policyFor(c,d).timezone)) await reconcileDate(d,s);
    const employees=await Employee.find({joiningDate:{$lte:to},$or:[{exitDate:{$exists:false}},{exitDate:null},{exitDate:{$gte:from}}]}).session(s);
    const slips=[];
    for(const e of employees) {
      const monthDays=days.filter(d=>working(d,policyFor(c,d))),eligible=monthDays.filter(d=>employed(e,d));
      if(!eligible.length) continue;
      const records=await Attendance.find({employeeId:e._id,date:{$gte:from,$lte:to}}).session(s),leaves=await Leave.find({employeeId:e._id,state:'approved',start:{$lte:to},end:{$gte:from}}).session(s);
      let basic=0,hra=0,medical=0,deductions=0,tax=0,absent=0,unpaid=0,halfDays=0;
      const breakdown=[];
      for(const d of eligible) {
        const fullBasic=salaryFor(e,d),fullHra=Math.round(fullBasic*0.4),fullMedical=Math.round(fullBasic*0.1),fullGross=fullBasic+fullHra+fullMedical;
        const a=records.find(a=>a.date===d),l=leaves.flatMap(l=>l.days).find(x=>x.date===d);
        let factor=0,reason='payable';
        if(l && !l.paid) { factor=1; reason='unpaid_leave'; unpaid++; }
        else if(l?.paid) reason='paid_leave';
        else if(a?.status==='absent') {factor=1;reason='absent';absent++;}
        else if(a?.status==='half_day') {factor=0.5;reason='half_day';halfDays++;}
        basic+=fullBasic/monthDays.length; hra+=fullHra/monthDays.length; medical+=fullMedical/monthDays.length; deductions+=fullGross/monthDays.length*factor; tax+=monthlyTax(fullGross)/monthDays.length;
        breakdown.push({date:d,basicMinor:fullBasic,grossMonthlyMinor:fullGross,perDayMinor:Math.round(fullGross/monthDays.length),deductionFactor:factor,reason,attendanceId:a?._id,leavePaid:l?.paid,policyEffectiveDate:policyFor(c,d).effectiveDate});
      }
      basic=Math.round(basic); hra=Math.round(hra); medical=Math.round(medical); const gross=basic+hra+medical; deductions=Math.round(deductions); tax=Math.round(tax);
      slips.push({employeeId:String(e._id),employeeCode:e.code,employeeName:e.name,departmentId:String(e.departmentId),designationId:String(e.designationId),companyName:c.name,currency:'PKR',basicMinor:basic,hraMinor:hra,medicalMinor:medical,grossMinor:gross,workingDays:monthDays.length,eligibleDays:eligible.length,absentDays:absent,unpaidDays:unpaid,halfDays,deductionsMinor:deductions,taxMinor:tax,netMinor:Math.max(0,gross-deductions-tax),breakdown});
    }
    if(!run) run=new Payroll({month}); run.slips=slips; run.sourceRevision=c.revision; run.generatedAt=new Date(); run.policySnapshots=c.policies; await run.save({session:s});
    await audit(actor,'draft_generated','Payroll',run._id,old,run.toObject(),s); return run;
  });
}
export async function finalizePayroll(actor,id) {
  roles(actor,'Admin'); return transaction(async s=> {
    const run=await Payroll.findById(id).session(s); assert(run,404,'Payroll not found'); assert(run.state==='draft',409,'Finalized payroll is immutable');
    const c=await company(s),[,end]=monthRange(run.month);
    assert(end<today(policyFor(c,end).timezone),422,'Payroll may only be finalized after month end');
    assert(c.revision===run.sourceRevision+1,409,'Draft is stale; HR must regenerate before finalization');
    assert(JSON.stringify(run.policySnapshots.map(p=>p.toObject()))===JSON.stringify(c.policies.map(p=>p.toObject())),409,'Policies changed; regenerate draft');
    run.state='finalized'; run.finalizedAt=new Date(); run.finalizedBy=actor._id; await run.save({session:s});
    for(const slip of run.slips) await notify(slip.employeeId,`Payslip published for ${run.month}`,run._id,s);
    await audit(actor,'finalized','Payroll',id,{state:'draft'},{state:'finalized'},s); return run;
  });
}
export async function listPayroll(actor) { roles(actor,'Admin','HR'); return Payroll.find().select('-slips.breakdown').sort({month:-1}).limit(100); }
export async function getPayroll(actor,id) { roles(actor,'Admin','HR'); const run=await Payroll.findById(id); assert(run,404,'Payroll not found'); return run; }
export async function payslips(actor) {
  const runs=await Payroll.find(actor.role==='Employee'?{state:'finalized','slips.employeeId':String(actor.employeeId)}:{}).sort({month:-1}).limit(100);
  return runs.flatMap(r=>r.slips.filter(s=>actor.role!=='Employee'||s.employeeId===String(actor.employeeId)).map(s=>({runId:r._id,month:r.month,state:r.state,...s})));
}
export async function getPayslip(actor,runId,employeeId) {
  assert(actor.role!=='Employee'||String(actor.employeeId)===employeeId,403,'Access denied');
  const run=await Payroll.findById(runId); assert(run && (actor.role!=='Employee'||run.state==='finalized'),404,'Published payslip not found');
  const slip=run.slips.find(s=>s.employeeId===employeeId); assert(slip,404,'Payslip not found'); return {month:run.month,state:run.state,...slip};
}
export function renderPayslip(slip) {
  return new Promise((resolve,reject)=> {
    const doc=new PDFDocument({size:'A4',margin:50,info:{Title:`Payslip ${slip.month}`}}),chunks=[];
    doc.on('data',c=>chunks.push(c)); doc.on('end',()=>resolve(Buffer.concat(chunks))); doc.on('error',reject);
    doc.fontSize(24).text('HCM Lite | Payslip').moveDown(0.5); doc.fontSize(14).text(slip.companyName).moveDown();
    doc.fontSize(11).text(`Period: ${slip.month}   Status: ${slip.state}`).text(`Employee: ${slip.employeeName}`).text(`Code: ${slip.employeeCode}`).moveDown();
    for(const [label,key] of [['Basic','basicMinor'],['HRA (40%)','hraMinor'],['Medical (10%)','medicalMinor'],['Gross','grossMinor'],['Attendance / unpaid deductions','deductionsMinor'],['Challenge tax','taxMinor'],['Net pay','netMinor']]) doc.text(`${label}: PKR ${(slip[key]/100).toFixed(2)}`).moveDown(0.4);
    doc.moveDown().text(`Working days: ${slip.workingDays} | Eligible: ${slip.eligibleDays}`).text(`Absent: ${slip.absentDays} | Unpaid: ${slip.unpaidDays} | Half days: ${slip.halfDays}`).moveDown().fontSize(9).text('Amounts use challenge rules and are not statutory tax advice. This document is generated from the saved payroll snapshot.');
    doc.end();
  });
}
