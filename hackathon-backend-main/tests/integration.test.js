import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import http from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.env.NODE_ENV='test';
process.env.LOG_LEVEL='silent';
process.env.JWT_SECRET='test-only-secret-32-characters-or-more';
process.env.MONGODB_URI='mongodb://127.0.0.1/test';
process.env.AI_API_KEY='test-provider-key';
process.env.AI_BASE_URL='http://127.0.0.1:19443/v1';
// Reuse a local binary when present; a fresh checkout downloads the pinned version.
process.env.MONGOMS_VERSION ||= '7.0.24';
if(!process.env.MONGOMS_SYSTEM_BINARY && existsSync('tmp/mongodb/mongod.exe')) process.env.MONGOMS_SYSTEM_BINARY=fileURLToPath(new URL('../tmp/mongodb/mongod.exe',import.meta.url));
const {app}=await import('../src/app.js');
const models=await import('../src/models/index.js');
const {User,Employee,Attendance,Leave,Payroll,Company,AiLog,Audit}=models;
const {monthlyTax}=await import('../src/services/payroll.js');
const {runTool}=await import('../src/services/ai.js');
const {classify}=await import('../src/services/attendance.js');
const {policy}=await import('../src/validators/index.js');
const {DateTime}=await import('luxon');
const api=request(app),prefix='/api/v1',password='Secure-password-123!';
const call=(method,path,token,body)=>{let r=api[method](prefix+path);if(token)r=r.set('Authorization',`Bearer ${token}`);return body===undefined?r:r.send(body);};
async function login(email,p=password){const r=await call('post','/auth/login',null,{email,password:p});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;}
test('HCM Lite integration against isolated transactional MongoDB', {timeout:240000}, async t=>{
  const db=await MongoMemoryReplSet.create({replSet:{count:1,storageEngine:'wiredTiger'}});
  await mongoose.connect(db.getUri(),{dbName:'hcm_lite_isolated_test'});await models.ensureIndexes();
  t.after(async()=>{t.mock.timers.reset();await mongoose.disconnect();await db.stop();});
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-02T05:00:00Z')});
  let admin,hr,employee,second,departmentId,designationId,employeeId,secondId,hrId;
  await t.test('liveness, readiness, restrictive CORS and public setup status',async()=>{
    assert.equal((await api.get('/health')).status,200);assert.equal((await api.get('/ready')).status,200);
    assert.equal((await api.get('/health').set('Origin','https://evil.example')).status,403);
    assert.deepEqual((await call('get','/setup-status')).body.data,{initializationRequired:true});
    assert.equal((await call('get','/employees')).status,401);
  });
  await t.test('concurrent setup creates exactly one company and Admin, zero business activity',async()=>{
    const body={companyName:'Test Company',email:'admin@example.com',password};
    const responses=await Promise.all([call('post','/setup',null,body),call('post','/setup',null,body)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(await User.countDocuments(),1);
    assert.equal(await Employee.countDocuments(),0);assert.equal(await Attendance.countDocuments(),0);assert.equal(await Leave.countDocuments(),0);assert.equal(await Payroll.countDocuments(),0);
    assert.deepEqual((await call('get','/setup-status')).body.data,{initializationRequired:false});admin=(await login('admin@example.com')).token;
    const d=(await call('get','/dashboard',admin)).body.data;assert.equal(d.headcount,0);assert.equal(d.payroll.grossMinor,0);assert.equal(d.attendanceRate,0);
  });
  await t.test('create HR, force password change, and revoke old token',async()=>{
    const r=await call('post','/users/hr',admin,{email:'hr@example.com'});assert.equal(r.status,200);hrId=r.body.data.user.id;
    const initial=await login('hr@example.com',r.body.data.temporaryPassword);
    assert.equal((await call('get','/employees',initial.token)).status,403);
    assert.equal((await call('get','/auth/me',initial.token)).status,200);
    assert.equal((await call('post','/auth/change-password',initial.token,{currentPassword:r.body.data.temporaryPassword,newPassword:password})).status,200);
    assert.equal((await call('get','/auth/me',initial.token)).status,401);hr=(await login('hr@example.com')).token;
    assert.equal((await call('post','/users/hr',hr,{email:'rogue@example.com'})).status,403);
    assert.equal((await call('get','/audit-logs',hr)).status,403);
  });
  const employeeBody=(code,email,name='Test Person')=>({code,email,name,departmentId,designationId,joiningDate:'2026-09-01',basicSalary:100000,status:'active'});
  await t.test('organization and atomic employee registration with linked accounts',async()=>{
    departmentId=(await call('post','/organization/units',admin,{kind:'department',name:'Engineering'})).body.data._id;
    designationId=(await call('post','/organization/units',admin,{kind:'designation',name:'Engineer'})).body.data._id;
    assert.equal((await call('post','/organization/units',hr,{kind:'department',name:'Bad'})).status,403);
    for(const [code,email]of [['E001','one@example.com'],['E002','two@example.com']]){
      const r=await call('post','/employees',hr,employeeBody(code,email));assert.equal(r.status,200,JSON.stringify(r.body));const e=r.body.data;
      assert.equal(e.employee.userId,e.user.id);assert(!JSON.stringify(e).includes('passwordHash'));
      const auth=await login(email,e.temporaryPassword);await call('post','/auth/change-password',auth.token,{currentPassword:e.temporaryPassword,newPassword:password});
      if(code==='E001'){employee=(await login(email)).token;employeeId=e.employee._id;}else{second=(await login(email)).token;secondId=e.employee._id;}
    }
    const before=await User.countDocuments();assert.equal((await call('post','/employees',hr,employeeBody('E001','orphan@example.com'))).status,409);assert.equal(await User.countDocuments(),before);
    assert.equal((await call('delete',`/organization/units/${departmentId}`,admin)).status,409);
    assert.equal((await call('post',`/users/${hrId}/employee-profile`,admin,employeeBody('HR001','hr@example.com'))).status,200);
  });
  await t.test('object authorization, field allowlists and scoped directory',async()=>{
    assert.equal((await call('get',`/employees/${secondId}`,employee)).status,403);
    const own=await call('get','/employees',employee);assert.equal(own.body.data.total,1);assert.equal(own.body.data.items[0]._id,employeeId);
    assert.equal((await call('patch','/employees/me',employee,{basicSalary:999999})).status,422);
    assert.equal((await call('patch','/employees/me',employee,{name:'Changed'})).status,403);
    assert.equal((await call('patch','/employees/me',employee,{phone:'123',address:'Home'})).status,200);
    assert.equal((await call('get','/employees?search=Test&limit=1',hr)).body.data.items.length,1);
    const d=(await call('get','/dashboard',employee)).body.data;assert.equal(d.headcount,1);assert(!JSON.stringify(d).includes('two@example.com'));
    await assert.rejects(()=>runTool(awaitActor(employeeId),'get_payroll_summary',{}));
  });
  function awaitActor(id){return {role:'Employee',employeeId:new mongoose.Types.ObjectId(id)};}
  await t.test('CSV dry run, duplicate/error rows, all-or-nothing import and formula-safe export',async()=>{
    const header='code,email,name,departmentId,designationId,joiningDate,basicSalary';
    const row=`E003,three@example.com,=SUM(1),${departmentId},${designationId},2026-09-01,10000`;
    const count=await Employee.countDocuments();const dry=await call('post','/employees/import',hr,{csv:`${header}\n${row}`,dryRun:true});assert.equal(dry.body.data.valid,true);assert.equal(await Employee.countDocuments(),count);
    const invalid=await call('post','/employees/import',hr,{csv:`${header}\n${row}\n${row}`,dryRun:false});assert.equal(invalid.status,422);assert(invalid.body.errors.some(e=>e.row===3));assert.equal(await Employee.countDocuments(),count);
    const r=await call('post','/employees/import',hr,{csv:`${header}\n${row}`,dryRun:false});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.data.imported,1);
    const csv=await call('get','/employees/export',hr);assert.match(csv.text,/'=SUM\(1\)/);
    assert.equal((await call('get','/employees/export',admin)).status,403);
    const bad=await call('post','/employees/import',hr,{csv:`${header}\nE004,bad,Name,${departmentId},${designationId},2026-02-30,-1`,dryRun:true});assert(bad.body.data.errors.length>=3);
  });
  await t.test('check-in uniqueness, server timestamps, open status and half-day late flags',async()=>{
    const attempts=await Promise.all([call('post','/attendance/check-in',employee,{}),call('post','/attendance/check-in',employee,{})]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
    const a=await Attendance.findOne({employeeId,date:'2026-11-02'});assert.equal(a.status,'open');assert.equal(a.late,true);assert.equal(await Attendance.countDocuments({employeeId,date:'2026-11-02'}),1);
    assert.equal((await call('post','/attendance/check-in',second,{employeeId})).status,422);
    const closed=await call('post','/attendance/check-out',employee,{});assert.equal(closed.body.data.status,'half_day');assert.equal(closed.body.data.late,true);
    assert.equal((await call('post','/attendance/check-out',employee,{})).status,409);
    assert.equal((await call('post','/attendance/check-out',second,{})).status,409);
    const p=policy.parse({});assert.equal(classify('2026-11-02T04:15:00Z',null,'2026-11-02',p).late,false);assert.equal(classify('2026-11-02T04:15:01Z','2026-11-02T09:15:01Z','2026-11-02',p).status,'late');
  });
  await t.test('reconciliation is idempotent, excludes weekends/future and never closes today',async()=>{
    assert.equal((await call('post','/attendance/reconcile',hr,{from:'2026-11-02',to:'2026-11-02'})).status,422);
    const body={from:'2026-10-30',to:'2026-11-01'};const a=await call('post','/attendance/reconcile',hr,body);assert.equal(a.status,200);const b=await call('post','/attendance/reconcile',hr,body);assert.equal(b.body.data.changed,0);
    assert.equal(await Attendance.countDocuments({date:'2026-10-31'}),0);assert.equal((await Attendance.findOne({employeeId,date:'2026-10-30'})).status,'absent');
  });
  await t.test('correction request, independent HR approval and notifications',async()=>{
    const r=await call('post','/attendance/corrections',employee,{date:'2026-10-30',checkIn:'2026-10-30T04:00:00Z',checkOut:'2026-10-30T12:00:00Z',reason:'Browser was unavailable'});assert.equal(r.status,200,JSON.stringify(r.body));
    assert.equal((await call('post',`/attendance/corrections/${r.body.data._id}/decision`,employee,{decision:'approved',comment:'ok'})).status,403);
    assert.equal((await call('post',`/attendance/corrections/${r.body.data._id}/decision`,hr,{decision:'approved',comment:'Verified'})).status,200);
    const a=await Attendance.findOne({employeeId,date:'2026-10-30'});assert.equal(a.status,'present');assert.equal(a.correctionHistory.length,1);
    const notifications=await call('get','/notifications',employee);assert(notifications.body.data.total>=1);
    assert.equal((await call('post',`/notifications/${notifications.body.data.items[0]._id}/read`,second,{})).status,404);
  });
  await t.test('leave working days, overlap, ownership, decisions, cancellation and balance restoration',async()=>{
    assert.equal((await call('post','/leaves',employee,{type:'casual',start:'2026-11-07',end:'2026-11-08',reason:'Weekend'})).status,422);
    const r=await call('post','/leaves',employee,{type:'casual',start:'2026-11-03',end:'2026-11-04',reason:'Wedding'});assert.equal(r.status,200);const id=r.body.data._id;
    assert.equal((await call('post','/leaves',employee,{type:'sick',start:'2026-11-04',end:'2026-11-05',reason:'Overlap'})).status,422);
    assert.equal((await call('post',`/leaves/${id}/cancel`,second,{})).status,403);
    assert.equal((await call('post',`/leaves/${id}/decision`,admin,{decision:'approved',comment:'ok'})).status,403);
    assert.equal((await call('post',`/leaves/${id}/decision`,hr,{decision:'approved',comment:'Approved wedding'})).status,200);
    let b=(await call('get','/leaves/balances/me?year=2026',employee)).body.data;assert.equal(b.types.find(t=>t.type==='casual').remaining,8);
    assert.equal((await call('post',`/leaves/${id}/cancel`,employee,{})).status,200);b=(await call('get','/leaves/balances/me?year=2026',employee)).body.data;assert.equal(b.types.find(t=>t.type==='casual').remaining,10);
    assert.equal((await call('get',`/leaves/balances/${secondId}?year=2026`,employee)).status,403);
  });
  await t.test('concurrent approvals cannot overspend quota; pending does not reserve',async()=>{
    const requests=[];
    for(const [start,end]of [['2026-11-03','2026-11-12'],['2026-11-16','2026-11-25']]){const r=await call('post','/leaves',second,{type:'annual',start,end,reason:'Time off'});assert.equal(r.status,200);requests.push(r.body.data._id);}
    const decisions=await Promise.all(requests.map(id=>call('post',`/leaves/${id}/decision`,hr,{decision:'approved',comment:'Reviewed'})));assert.deepEqual(decisions.map(r=>r.status).sort(),[200,422]);
    const balance=(await call('get','/leaves/balances/me?year=2026',second)).body.data;assert.equal(balance.types.find(t=>t.type==='annual').used,8);
  });
  await t.test('cross-year leave allocates quotas by year and holidays are excluded',async()=>{
    const r=await call('post','/leaves',employee,{type:'annual',start:'2026-12-31',end:'2027-01-04',reason:'Year crossing'});assert.equal(r.status,200);assert.deepEqual(r.body.data.days.map(d=>d.year),[2026,2027,2027]);
    assert.equal((await call('post',`/leaves/${r.body.data._id}/decision`,hr,{decision:'approved',comment:'Approved'})).status,200);
    assert.equal((await call('get','/leaves/balances/me?year=2027',employee)).body.data.types.find(t=>t.type==='annual').used,2);
  });
  await t.test('payroll formulas, drafts, scope, stale check, Admin finalization and immutable snapshots',async()=>{
    const r=await call('post','/payroll',hr,{month:'2026-09'});assert.equal(r.status,200,JSON.stringify(r.body));const runId=r.body.data._id,slip=r.body.data.slips.find(s=>s.employeeId===employeeId);
    assert.equal(slip.basicMinor,10000000);assert.equal(slip.hraMinor,4000000);assert.equal(slip.medicalMinor,1000000);assert.equal(slip.grossMinor,15000000);assert.equal(slip.deductionsMinor,15000000);assert.equal(slip.netMinor,0);
    assert.equal((await call('get',`/payslips/${runId}/${employeeId}`,employee)).status,404);
    assert.equal((await call('post',`/payroll/${runId}/finalize`,hr,{})).status,403);
    const finalized=await call('post',`/payroll/${runId}/finalize`,admin,{});assert.equal(finalized.status,200,JSON.stringify(finalized.body));
    assert.equal((await call('post','/payroll',hr,{month:'2026-09'})).status,409);
    assert.equal((await call('post',`/payroll/${runId}/finalize`,admin,{})).status,409);
    assert.equal((await call('get',`/payslips/${runId}/${secondId}`,employee)).status,403);
    const pdf=await call('get',`/payslips/${runId}/${employeeId}/pdf`,employee);assert.equal(pdf.status,200);assert.equal(pdf.headers['content-type'],'application/pdf');assert.equal(pdf.body.subarray(0,4).toString(),'%PDF');
    mkdirSync('tmp/pdfs',{recursive:true});writeFileSync('tmp/pdfs/verified-payslip.pdf',pdf.body);
    assert.equal(monthlyTax(5000000),0);assert.equal(monthlyTax(10000000),250000);assert.equal(monthlyTax(20000000),1750000);assert.equal(monthlyTax(30000000),4250000);assert.equal(monthlyTax(40000000),7750000);
    const november=await call('post','/payroll',hr,{month:'2026-11'});assert.equal(november.status,200);assert.equal((await call('post',`/payroll/${november.body.data._id}/finalize`,admin,{})).status,422);
  });
  await t.test('analytics reflect real records, role scopes, authorized AI tools and empty denominators',async()=>{
    const d=await call('get','/dashboard?from=2026-11-02&to=2026-11-02',hr);assert.equal(d.status,200);assert.equal(d.body.data.headcount,4);assert.equal(d.body.data.attendance.half_day,1);assert.equal(d.body.data.attendance.absent,0);
    const a=await call('get','/analytics/get_headcount',hr);assert.equal(a.body.data.headcount,4);
    assert.equal((await call('get','/analytics/get_headcount',employee)).status,403);
    const self=await call('get','/analytics/get_attendance_summary',employee);assert.equal(self.body.data.attendance.half_day,1);
    assert.equal((await call('get','/dashboard?from=2026-11-03&to=2026-11-04',hr)).status,422);
  });
  await t.test('prospective settings and salary history preserve old attendance and payroll',async()=>{
    const before=await Attendance.findOne({employeeId,date:'2026-11-02'}).lean();
    assert.equal((await call('put',`/employees/${employeeId}/salary`,hr,{effectiveDate:'2026-11-02',basicSalary:120000})).status,422);
    assert.equal((await call('put',`/employees/${employeeId}/salary`,hr,{effectiveDate:'2026-11-03',basicSalary:120000})).status,200);
    const input={effectiveDate:'2026-11-03',policy:{...policy.parse({}),officeStart:'10:00',holidays:[{date:'2026-11-06',name:'Holiday',active:true}]}};
    assert.equal((await call('put','/organization',hr,input)).status,403);assert.equal((await call('put','/organization',admin,input)).status,200);
    const after=await Attendance.findById(before._id).lean();assert.equal(after.policySnapshot.officeStart,'09:00');
    const run=await Payroll.findOne({month:'2026-09'});assert.equal(run.slips.find(s=>s.employeeId===employeeId).basicMinor,10000000);
  });
  await t.test('prorated payroll uses disjoint paid/unpaid/half-day/absence factors and detects stale drafts',async()=>{
    // Isolated historical fixtures exercise payroll edge cases; never run against app data.
    const fixture=await Employee.create({code:'FIXTURE',email:'fixture@example.com',name:'Historical fixture',departmentId,designationId,joiningDate:'2026-08-17',exitDate:'2026-08-21',status:'exited',employmentHistory:[{effectiveDate:'2026-08-17',status:'exited'}],salaryHistory:[{effectiveDate:'2026-08-17',basicMinor:1000000}]});
    const p=policy.parse({});
    for(const [date,status]of [['2026-08-17','present'],['2026-08-18','half_day']])await Attendance.create({employeeId:fixture._id,date,status,checkIn:new Date(`${date}T04:00:00Z`),checkOut:new Date(`${date}T${status==='half_day'?'06':'12'}:00:00Z`),policySnapshot:{...p,effectiveDate:'0001-01-01'}});
    for(const [date,type,paid]of [['2026-08-19','annual',true],['2026-08-20','unpaid',false]])await Leave.create({employeeId:fixture._id,start:date,end:date,type,state:'approved',days:[{date,year:2026,paid,quota:paid?14:null}]});
    let r=await call('post','/payroll',hr,{month:'2026-08'});assert.equal(r.status,200);let slip=r.body.data.slips.find(s=>s.employeeId===String(fixture._id));
    assert.equal(slip.eligibleDays,5);assert.equal(slip.absentDays,1);assert.equal(slip.unpaidDays,1);assert.equal(slip.halfDays,1);assert.equal(slip.deductionsMinor,Math.round(1500000/slip.workingDays*2.5));assert.equal(slip.taxMinor,0);
    assert.equal(slip.basicMinor,Math.round(1000000/slip.workingDays*5));
    const runId=r.body.data._id;
    await call('post','/announcements',hr,{title:'Real announcement',body:'Business revision changes'});
    assert.equal((await call('post',`/payroll/${runId}/finalize`,admin,{})).status,409);
    r=await call('post','/payroll',hr,{month:'2026-08'});assert.equal(r.body.data._id,runId);
    assert.equal((await call('post',`/payroll/${runId}/finalize`,admin,{})).status,200);
  });
  await t.test('holiday exclusion, year allocation, future settings and zero working-day payroll are safe',async()=>{
    const r=await call('post','/leaves',employee,{type:'casual',start:'2026-11-05',end:'2026-11-06',reason:'Includes public holiday'});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.data.days.length,1);
    const futurePolicy={...policy.parse({}),weekendDays:[1,2,3,4,5,6,7]};
    assert.equal((await call('put','/organization',admin,{effectiveDate:'2027-02-01',policy:futurePolicy})).status,200);
    const empty=await call('post','/payroll',hr,{month:'2027-02'});assert.equal(empty.status,200);assert.deepEqual(empty.body.data.slips,[]);
    const company=await Company.findById('singleton');const {currentPolicy}=await import('../src/utils/dates.js');assert.equal(currentPolicy(company).officeStart,'09:00');
  });
  await t.test('hosted-compatible AI executes tool calls, validates smart leave, and degrades safely',async()=>{
    let mode='chat',seen=[];
    const provider=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const payload=JSON.parse(body);seen.push(payload);res.setHeader('Content-Type','application/json');
      let message;
      if(mode==='error'){res.statusCode=503;return res.end('{"secret":"provider-error-do-not-leak"}');}
      if(mode==='smart') message={role:'assistant',content:JSON.stringify({type:'casual',start:'2026-11-09',end:'2026-11-10',reason:'Wedding'})};
      else if(!payload.messages.some(m=>m.role==='tool')) message={role:'assistant',content:null,tool_calls:[{id:'call1',type:'function',function:{name:'get_my_leave_balance',arguments:'{"year":2026}'}}]};
      else message={role:'assistant',content:'AI-generated: your leave balance is based on the authorized tool result.'};
      res.end(JSON.stringify({choices:[{message}]}));
    });await new Promise(resolve=>provider.listen(19443,'127.0.0.1',resolve));
    try {let r=await call('post','/ai/chat',employee,{message:'How much leave remains?'});assert.equal(r.status,200);assert.deepEqual(r.body.data.toolsUsed,['get_my_leave_balance']);assert(seen[1].messages.some(m=>m.role==='tool'));
      mode='smart';const count=await Leave.countDocuments();r=await call('post','/ai/smart-leave',employee,{message:'Wedding next week'});assert.equal(r.body.data.requiresConfirmation,true);assert.equal(await Leave.countDocuments(),count);
      mode='error';r=await call('post','/ai/chat',employee,{message:'Hello'});assert.equal(r.body.data.fallback,true);assert(!JSON.stringify(r.body).includes('provider-error'));assert(await AiLog.countDocuments()>=3);assert.equal(AiLog.collection.name,'ai_logs');
    }finally{await new Promise(resolve=>provider.close(resolve));}
  });
  await t.test('logout, reset and deactivation invalidate existing sessions; errors contain no secrets',async()=>{
    const extra=(await login('one@example.com')).token;assert.equal((await call('post','/auth/logout',extra,{})).status,200);assert.equal((await call('get','/auth/me',extra)).status,401);
    const u=await User.findOne({employeeId:secondId});const reset=await call('post',`/users/${u._id}/reset`,admin,{});assert(reset.body.data.temporaryPassword);assert.equal((await call('get','/auth/me',second)).status,401);
    const auth=await login('two@example.com',reset.body.data.temporaryPassword);await call('post',`/users/${u._id}/deactivate`,admin,{});assert.equal((await call('get','/auth/me',auth.token)).status,401);
    const audit=await call('get','/audit-logs',admin);assert.equal(audit.status,200);assert(!JSON.stringify(audit.body).includes('passwordHash'));assert(!JSON.stringify(audit.body).includes(reset.body.data.temporaryPassword));
    const boundary=await Audit.create({action:'timezone_boundary_fixture',entity:'Test',entityId:'test',createdAt:new Date('2026-11-01T20:00:00Z')});
    const localDay=await call('get','/audit-logs?from=2026-11-02&to=2026-11-02&limit=100',admin);assert(localDay.body.data.items.some(a=>a._id===String(boundary._id)));
    const previousDay=await call('get','/audit-logs?from=2026-11-01&to=2026-11-01&limit=100',admin);assert(!previousDay.body.data.items.some(a=>a._id===String(boundary._id)));
    const bad=await call('get','/employees/not-an-id',admin);assert.equal(bad.status,422);assert(!bad.body.stack);
    const spec=await call('get','/openapi.json');assert.equal(spec.status,200);assert(Object.keys(spec.body.paths).length>40);
  });
  await t.test('repeated failed authentication is rate limited with generic responses',async()=>{
    const messages=[];let last;
    for(let i=0;i<12;i++){last=await call('post','/auth/login',null,{email:'unknown@example.com',password:'wrong-password'});if(last.status===401)messages.push(last.body.message);}
    assert.equal(last.status,429);assert(messages.every(m=>m==='Invalid email or password'));
  });
});
