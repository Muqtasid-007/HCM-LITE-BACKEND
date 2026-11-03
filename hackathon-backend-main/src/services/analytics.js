import { DateTime } from 'luxon';
import { Employee, Attendance, Leave, Payroll, Announcement, Correction, Audit } from '../models/index.js';
import { company, scopeEmployee } from './common.js';
import { dates, policyFor, currentPolicy, working, employed, statusFor, salaryFor, today } from '../utils/dates.js';
import { assert } from '../utils/errors.js';
export async function dashboard(actor,f={}) {
  const c=await company(),p=currentPolicy(c),now=today(p.timezone);
  const from=f.from||DateTime.fromISO(now).startOf('month').toISODate(),to=f.to||now,range=dates(from,to);
  assert(to<=now,422,'Analytics cannot include future dates');
  const q={}; if(actor.role==='Employee') q._id=actor.employeeId||null; else if(f.departmentId) q.departmentId=f.departmentId;
  const employees=await Employee.find(q).lean(),ids=employees.map(e=>e._id),match={employeeId:{$in:ids},date:{$gte:from,$lte:to}};
  const [attendance,leave,runs,announcements,lateGroups,headcountGroups]=await Promise.all([
    Attendance.find(match).lean(),Leave.find({employeeId:{$in:ids},state:'approved',start:{$lte:to},end:{$gte:from}}).lean(),
    Payroll.find({state:'finalized',month:{$gte:from.slice(0,7),$lte:to.slice(0,7)}}).lean(),
    Announcement.find().sort({createdAt:-1}).limit(10).lean(),
    Attendance.aggregate([{$match:{...match,late:true}},{$group:{_id:'$employeeId',count:{$sum:1}}},{$sort:{count:-1,_id:1}},{$limit:5}]),
    Employee.aggregate([
      {$match:{_id:{$in:ids},joiningDate:{$lte:to},$or:[{exitDate:null},{exitDate:{$gte:to}}]}},
      {$set:{effectiveStatus:{$let:{vars:{history:{$arrayElemAt:[{$filter:{input:'$employmentHistory',as:'h',cond:{$lte:['$$h.effectiveDate',to]}}},-1]}},in:{$ifNull:['$$history.status','$status']}}},effectiveBasic:{$let:{vars:{salary:{$arrayElemAt:[{$filter:{input:'$salaryHistory',as:'s',cond:{$lte:['$$s.effectiveDate',to]}}},-1]}},in:{$ifNull:['$$salary.basicMinor',0]}}}}},
      {$match:{effectiveStatus:{$in:['active','probation']}}},
      {$group:{_id:'$departmentId',headcount:{$sum:1},totalGrossMinor:{$sum:{$multiply:['$effectiveBasic',1.5]}}}},
    ]),
  ]);
  const counts={present:0,late:0,half_day:0,missing_checkout:0,open:0,absent:0,on_leave:0,expectedDays:0,lateFlags:0,minutes:0},trend=[],byDepartment={};
  const index=new Map(attendance.map(a=>[`${a.employeeId}:${a.date}`,a])),leaveIndex=new Map();
  for(const r of leave) for(const d of r.days) leaveIndex.set(`${r.employeeId}:${d.date}`,{...d,type:r.type});
  for(const date of range) {
    const daily={date,present:0,late:0,half_day:0,missing_checkout:0,open:0,absent:0,on_leave:0,expectedDays:0,lateFlags:0,minutes:0};
    for(const e of employees) {
      if(!employed(e,date)||!working(date,policyFor(c,date))) continue;
      const key=`${e._id}:${date}`,a=index.get(key),l=leaveIndex.get(key);
      let status=l?'on_leave':a?.status || (date<now?'absent':null);
      if(a?.checkIn) status=!a.checkOut && date<now?'missing_checkout':a.status;
      // Today's people who have not arrived are not counted absent or in the rate denominator.
      if(!status) continue;
      const dept=String(e.departmentId); byDepartment[dept]||={departmentId:dept,expectedDays:0,absent:0,on_leave:0,lateFlags:0,headcount:0};
      counts.expectedDays++; daily.expectedDays++; byDepartment[dept].expectedDays++;
      if(status in counts) {counts[status]++;daily[status]++;}
      if(['absent','on_leave'].includes(status)) byDepartment[dept][status]++;
      if(a?.late) { counts.lateFlags++;daily.lateFlags++;byDepartment[dept].lateFlags++; }
      counts.minutes+=a?.minutes||0;daily.minutes+=a?.minutes||0;
    } trend.push(daily);
  }
  const active=e=>employed(e,to)&&['active','probation'].includes(statusFor(e,to));
  const headcount=headcountGroups.reduce((n,g)=>n+g.headcount,0),startHeadcount=employees.filter(e=>employed(e,from)&&['active','probation'].includes(statusFor(e,from))).length;
  const exits=employees.filter(e=>e.exitDate&&e.exitDate>=from&&e.exitDate<=to).length,avg=(headcount+startHeadcount)/2;
  const slips=runs.flatMap(r=>r.slips.filter(s=>ids.some(id=>String(id)===s.employeeId)).map(s=>({...s,month:r.month})));
  const payrollByMonth={},payrollByDepartment={},salaryByDesignation={},gender={},tenure={under1Year:0,oneToThreeYears:0,over3Years:0};
  for(const s of slips) { payrollByMonth[s.month]||={grossMinor:0,netMinor:0}; payrollByMonth[s.month].grossMinor+=s.grossMinor;payrollByMonth[s.month].netMinor+=s.netMinor; payrollByDepartment[s.departmentId]||={grossMinor:0,netMinor:0};payrollByDepartment[s.departmentId].grossMinor+=s.grossMinor;payrollByDepartment[s.departmentId].netMinor+=s.netMinor; }
  for(const e of employees.filter(active)) { const dept=String(e.departmentId);byDepartment[dept]||={departmentId:dept,expectedDays:0,absent:0,on_leave:0,lateFlags:0,headcount:0};byDepartment[dept].headcount++;const g=e.gender||'unspecified';gender[g]=(gender[g]||0)+1;const years=DateTime.fromISO(to).diff(DateTime.fromISO(e.joiningDate),'years').years;tenure[years<1?'under1Year':years<=3?'oneToThreeYears':'over3Years']++; const d=String(e.designationId);salaryByDesignation[d]||={count:0,totalGrossMinor:0};salaryByDesignation[d].count++;salaryByDesignation[d].totalGrossMinor+=Math.round(salaryFor(e,to)*1.5); }
  const denominator=counts.expectedDays-counts.on_leave;
  const pending=actor.role==='Employee'?0:await Leave.countDocuments({employeeId:{$in:ids},state:'pending'})+await Correction.countDocuments({employeeId:{$in:ids},state:'pending'});
  const leaveByType={}; for(const l of leave) for(const d of l.days) if(d.date>=from&&d.date<=to) leaveByType[l.type]=(leaveByType[l.type]||0)+1;
  const quotaTotal=p.leaveTypes.filter(t=>t.paid&&t.active).reduce((n,t)=>n+(t.quota||0)*headcount,0);
  const result={from,to,headcount,exits,attritionPercent:avg?exits/avg*100:0,attendance:counts,attendanceRate:denominator?(counts.present+counts.late+counts.missing_checkout+counts.open+0.5*counts.half_day)/denominator*100:0,latePercent:counts.present+counts.late?counts.late/(counts.present+counts.late)*100:0,absenteeismPercent:counts.expectedDays?counts.absent/counts.expectedDays*100:0,pendingApprovals:pending,trend,byDepartment:Object.values(byDepartment).map(d=>({...d,absenteeismPercent:d.expectedDays?d.absent/d.expectedDays*100:0})),lateComers:lateGroups.map(g=>({employeeId:g._id,name:employees.find(e=>String(e._id)===String(g._id))?.name,count:g.count})),leaveByType,leaveUtilizationPercent:quotaTotal?Object.entries(leaveByType).filter(([name])=>p.leaveTypes.some(t=>t.name===name&&t.paid)).reduce((n,[,v])=>n+v,0)/quotaTotal*100:0,payroll:{grossMinor:slips.reduce((n,s)=>n+s.grossMinor,0),netMinor:slips.reduce((n,s)=>n+s.netMinor,0),byMonth:payrollByMonth,byDepartment:payrollByDepartment},averageGrossMinor:headcount?Math.round(employees.filter(active).reduce((n,e)=>n+salaryFor(e,to)*1.5,0)/headcount):0,salaryByDesignation:Object.fromEntries(Object.entries(salaryByDesignation).map(([k,v])=>[k,{...v,averageGrossMinor:Math.round(v.totalGrossMinor/v.count)}])),gender,tenure,announcements};
  if(actor.role==='Admin') result.auditFeed=await Audit.find().sort({createdAt:-1}).limit(10).lean();
  result.leaveUtilizationByType=p.leaveTypes.map(t=>({type:t.name,used:leaveByType[t.name]||0,quota:t.quota===null?null:t.quota*headcount,percent:t.quota&&headcount?(leaveByType[t.name]||0)/(t.quota*headcount)*100:null}));
  for(const dept of result.byDepartment) {
    const salary=headcountGroups.find(g=>String(g._id)===dept.departmentId);dept.averageGrossMinor=salary?.headcount?Math.round(salary.totalGrossMinor/salary.headcount):0;
    dept.leaveByType={};
    for(const r of leave) if(String(employees.find(e=>String(e._id)===String(r.employeeId))?.departmentId)===dept.departmentId) dept.leaveByType[r.type]=(dept.leaveByType[r.type]||0)+r.days.filter(d=>d.date>=from&&d.date<=to).length;
    dept.leaveUtilizationByType=p.leaveTypes.map(t=>({type:t.name,used:dept.leaveByType[t.name]||0,quota:t.quota===null?null:t.quota*dept.headcount,percent:t.quota&&dept.headcount?(dept.leaveByType[t.name]||0)/(t.quota*dept.headcount)*100:null}));
  }
  if(actor.role==='Employee') { const {leaveBalance}=await import('./leave.js');result.leaveBalance=actor.employeeId?await leaveBalance(actor,'me',Number(to.slice(0,4))):null;result.hoursWorked=counts.minutes/60;result.weeklyTargetHours=40; const latest=await Payroll.findOne({state:'finalized','slips.employeeId':String(actor.employeeId)}).sort({month:-1}).lean(); result.lastPayslip=latest?{runId:latest._id,month:latest.month,...latest.slips.find(s=>s.employeeId===String(actor.employeeId))}:null; }
  return result;
}
