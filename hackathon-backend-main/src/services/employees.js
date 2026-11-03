import bcrypt from 'bcrypt';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { Employee, User, OrgUnit, Attendance, Leave, Payroll } from '../models/index.js';
import { roles, transaction, audit, scopeEmployee, company } from './common.js';
import { temporaryPassword, publicUser } from './auth.js';
import { assert, AppError } from '../utils/errors.js';
import { today, currentPolicy, statusFor } from '../utils/dates.js';
import { employee as employeeSchema } from '../validators/index.js';
async function checkUnits(input,session) {
  for(const [field,kind] of [['departmentId','department'],['designationId','designation']]) if(input[field] && !await OrgUnit.exists({ _id:input[field],kind,active:true }).session(session || null)) throw new AppError(422,`Unknown or inactive ${kind}`,[{field,reason:`Unknown or inactive ${kind}`}]);
}
async function insertEmployee(actor,input,session,linkedUser) {
  await checkUnits(input,session);
  const password=linkedUser ? undefined : temporaryPassword();
  const user=linkedUser || (await User.create([{ email:input.email,role:'Employee',passwordHash:await bcrypt.hash(password,12) }],{session}))[0];
  assert(!user.employeeId,409,'User already has an employee profile');
  const { basicSalary,...fields }=input;
  const [e]=await Employee.create([{ ...fields,userId:user._id,employmentHistory:[{ effectiveDate:input.joiningDate,status:input.status }],salaryHistory:[{ effectiveDate:input.joiningDate,basicMinor:Math.round(basicSalary*100) }] }],{session});
  user.employeeId=e._id; await user.save({session});
  await audit(actor,'created','Employee',e._id,null,e.toObject(),session);
  return { employee:e,user:publicUser(user),...(password && {temporaryPassword:password}) };
}
export async function createEmployee(actor,input) { roles(actor,'HR'); return transaction(s=>insertEmployee(actor,input,s)); }
export async function linkHR(actor,userId,input) {
  roles(actor,'Admin'); return transaction(async s=> { const u=await User.findById(userId).session(s); assert(u?.role==='HR',422,'HR user required'); assert(u.email===input.email,422,'Profile email must match HR login'); return insertEmployee(actor,input,s,u); });
}
export async function editEmployee(actor,id,input) {
  return transaction(async session=> {
    const e=await scopeEmployee(actor,id,session); const before=e.toObject();
    if(actor.role==='Employee') assert(Object.keys(input).every(k=>['phone','address'].includes(k)),403,'Only phone and address are editable');
    else roles(actor,'HR');
    await checkUnits(input,session);
    const c=await company(session); const now=today(currentPolicy(c).timezone);
    if(input.status || input.exitDate) {
      assert(input.effectiveDate && input.effectiveDate > now && input.effectiveDate > e.employmentHistory.at(-1).effectiveDate,422,'Employment changes require a future increasing effectiveDate');
      if(input.status==='exited') assert(input.exitDate && input.exitDate>=input.effectiveDate,422,'Exit date must be on or after effectiveDate');
      if(input.exitDate) assert(input.exitDate>=input.effectiveDate && input.exitDate>=e.joiningDate,422,'Invalid exitDate');
      e.employmentHistory.push({ effectiveDate:input.effectiveDate,status:input.status || e.status });
    }
    const { effectiveDate,...fields }=input; Object.assign(e,fields); await e.save({session});
    await audit(actor,'updated','Employee',id,before,e.toObject(),session); return e;
  });
}
export async function setSalary(actor,id,input) {
  roles(actor,'HR'); return transaction(async session=> {
    const e=await scopeEmployee(actor,id,session),c=await company(session);
    assert(input.effectiveDate>today(currentPolicy(c).timezone) && input.effectiveDate>e.salaryHistory.at(-1).effectiveDate,422,'Salary changes require a future increasing effectiveDate');
    const before=e.toObject(); e.salaryHistory.push({effectiveDate:input.effectiveDate,basicMinor:Math.round(input.basicSalary*100)}); await e.save({session});
    await audit(actor,'salary_changed','Employee',id,before,e.toObject(),session); return e.salaryHistory;
  });
}
export function employeeQuery(actor,f={},date) {
  const q={}; if(actor.role==='Employee') q._id=actor.employeeId || null;
  for(const k of ['departmentId','designationId']) if(f[k]) q[k]=f[k];
  if(f.status) q.$expr={$eq:[{$let:{vars:{history:{$arrayElemAt:[{$filter:{input:'$employmentHistory',as:'h',cond:{$lte:['$$h.effectiveDate',date]}}},-1]}},in:{$ifNull:['$$history.status','$status']}}},f.status]};
  if(f.search) { const re=new RegExp(f.search.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'); q.$or=[{name:re},{code:re},{email:re}]; } return q;
}
export async function listEmployees(actor,f) {
  const c=await company(),date=today(currentPolicy(c).timezone),q=employeeQuery(actor,f,date); const [data,total]=await Promise.all([Employee.find(q).sort(f.sort).skip((f.page-1)*f.limit).limit(f.limit).lean(),Employee.countDocuments(q)]);
  return {items:data.map(e=>({...e,status:statusFor(e,date)})),total,page:f.page,limit:f.limit};
}
export async function employee360(actor,id) {
  const e=await scopeEmployee(actor,id); const [attendance,leaves,runs]=await Promise.all([Attendance.find({employeeId:e._id}).sort({date:-1}).limit(31),Leave.find({employeeId:e._id}).sort({createdAt:-1}).limit(20),Payroll.find({state:'finalized','slips.employeeId':String(e._id)}).sort({month:-1}).limit(12)]);
  return {employee:e,attendance,leaves,payslips:runs.map(r=>({runId:r._id,month:r.month,...r.slips.find(s=>s.employeeId===String(e._id))}))};
}
export async function importCSV(actor,csv,dryRun) {
  roles(actor,'HR'); let rows;
  try { rows=parse(csv,{columns:true,skip_empty_lines:true,bom:true,trim:true,max_record_size:10000}); } catch { throw new AppError(422,'Invalid CSV'); }
  assert(rows.length>0 && rows.length<=500,422,'CSV must contain 1 to 500 rows');
  async function validate(session) {
    const errors=[],valid=[],codes=new Set(),emails=new Set();
    for(const [i,row] of rows.entries()) {
      const parsed=employeeSchema.safeParse({...row,basicSalary:Number(row.basicSalary)});
      if(!parsed.success) { errors.push(...parsed.error.issues.map(e=>({row:i+2,field:e.path.join('.'),reason:e.message}))); continue; }
      const v=parsed.data;
      for(const [field,set] of [['code',codes],['email',emails]]) { if(set.has(v[field])) errors.push({row:i+2,field,reason:'Duplicate within file'}); set.add(v[field]); }
      if(await Employee.exists({code:v.code}).session(session || null)) errors.push({row:i+2,field:'code',reason:'Already exists'});
      if(await User.exists({email:v.email}).session(session || null)) errors.push({row:i+2,field:'email',reason:'Already exists'});
      try { await checkUnits(v,session); } catch(e) { errors.push(...(e.errors||[{field:'departmentId',reason:e.message}]).map(issue=>({row:i+2,...issue}))); } valid.push(v);
    } return {errors,valid};
  }
  if(dryRun) { const r=await validate(); return {dryRun:true,rowCount:rows.length,valid:r.errors.length===0,errors:r.errors}; }
  return transaction(async s=> { const r=await validate(s); if(r.errors.length) throw new AppError(422,'Import rejected; no records saved',r.errors); const items=[]; for(const row of r.valid) items.push(await insertEmployee(actor,row,s)); return {imported:items.length,items}; });
}
export async function exportCSV(actor,f) {
  roles(actor,'HR'); const c=await company(),date=today(currentPolicy(c).timezone); const rows=await Employee.find(employeeQuery(actor,f,date)).sort({code:1}).lean();
  for(const e of rows) e.status=statusFor(e,date);
  const safe=v=>typeof v==='string' && /^[\s]*[=+\-@\t\r]/.test(v) ? `'${v}`:v;
  return stringify(rows.map(e=>Object.fromEntries(['code','email','name','departmentId','designationId','joiningDate','exitDate','status','gender','phone','address','emergencyContact'].map(k=>[k,safe(e[k]?.toString() || '')]))),{header:true});
}
