import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import { Company, User, Session } from '../models/index.js';
import { env } from '../config/env.js';
import { assert } from '../utils/errors.js';
import { transaction, audit, roles } from './common.js';
import { policy as policySchema } from '../validators/index.js';
import { normalizeEmail } from '../utils/email.js';
export const temporaryPassword = () => randomBytes(18).toString('base64url');
export const publicUser = u => ({ id:u._id, email:u.email, role:u.role, active:u.active, mustChangePassword:u.mustChangePassword, employeeId:u.employeeId });
async function initializeCompany(input, { reuseExistingUser = false, idempotent = false } = {}) {
  return transaction(async session => {
    const initialized = await Company.findById('singleton').session(session);
    if (initialized && idempotent) return { initialized:false, companyName:initialized.name };
    assert(!initialized, 409, 'Application already initialized');
    const email = normalizeEmail(input.email);
    let user = reuseExistingUser ? await User.findOne({ email }).session(session) : null;
    const reusedUser = Boolean(user);
    const [company] = await Company.create([{ _id:'singleton', name:input.companyName, policies:[{ ...policySchema.parse(input.policy || {}), effectiveDate:'0001-01-01' }] }], { session });
    if (!user) [user] = await User.create([{ email, passwordHash:await bcrypt.hash(input.password,12), role:'Admin', mustChangePassword:false }], { session });
    await audit(user,'setup','Company',company._id,null,{ name:company.name },session);
    return { initialized:true, reusedUser, companyName:company.name, user:publicUser(user) };
  }, { business:false });
}
export async function setupCompany(input) {
  const { companyName, user } = await initializeCompany(input);
  return { companyName, user };
}
// Explicit CLI bootstrap only. Public setup must still reject a second initialization.
export async function bootstrapCompany(input) {
  const email = normalizeEmail(input.email);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await initializeCompany({ ...input, email }, { reuseExistingUser:true, idempotent:true });
    } catch (error) {
      if (error.code !== 11000) throw error;
      // Duplicate inserts abort a MongoDB transaction. Fetch outside that transaction,
      // then retry the entire initialization in a fresh one rather than continuing it.
      const existingUser = await User.findOne({ email });
      const existingCompany = await Company.findById('singleton');
      if (existingCompany) return { initialized:false, companyName:existingCompany.name };
      if (!existingUser || attempt === 2) throw error;
    }
  }
}
// A fixed dummy hash makes nonexistent-user and wrong-password paths both perform bcrypt work.
const dummyHash = await bcrypt.hash(randomBytes(24).toString('hex'),12);
export async function login({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash');
  const valid = await bcrypt.compare(password, user?.passwordHash || dummyHash);
  assert(user && valid && user.active, 401, 'Invalid email or password');
  return transaction(async session => {
    const current = await User.findById(user._id).select('+passwordHash').session(session);
    assert(current.active && current.passwordHash === user.passwordHash, 401, 'Invalid email or password');
    const sid = randomUUID();
    await Session.create([{ _id:sid, userId:user._id, expiresAt:new Date(Date.now()+8*3600000) }], { session });
    const token = jwt.sign({ sub:String(user._id), ver:current.tokenVersion, sid },env.JWT_SECRET,{ expiresIn:'8h', issuer:'hcm-lite', audience:'hcm-api', algorithm:'HS256' });
    return { token, tokenType:'Bearer', expiresIn:28800, user:publicUser(current) };
  }, { business:false });
}
export async function changePassword(actor, input) {
  return transaction(async session => {
    const u = await User.findById(actor._id).select('+passwordHash').session(session);
    assert(await bcrypt.compare(input.currentPassword,u.passwordHash),401,'Current password is incorrect');
    assert(input.currentPassword !== input.newPassword,422,'Choose a different password');
    u.passwordHash = await bcrypt.hash(input.newPassword,12); u.mustChangePassword = false; u.tokenVersion++;
    await u.save({ session }); await Session.deleteMany({ userId:u._id },{ session });
    await audit(actor,'password_changed','User',u._id,null,null,session);
    return { loginRequired:true };
  }, { business:false });
}
export async function createHR(actor, input) {
  roles(actor,'Admin');
  return transaction(async session => {
    const password = temporaryPassword();
    const [u] = await User.create([{ email:input.email, role:'HR', passwordHash:await bcrypt.hash(password,12) }], { session });
    await audit(actor,'created','User',u._id,null,publicUser(u),session);
    return { user:publicUser(u), temporaryPassword:password };
  }, { business:false });
}
export async function manageUser(actor,id,action) {
  roles(actor,'Admin');
  return transaction(async session => {
    const u = await User.findById(id).session(session); assert(u && u.role !== 'Admin',403,'Only HR and Employee logins can be managed');
    const before = publicUser(u); let password;
    if(action === 'reset') { password=temporaryPassword(); u.passwordHash=await bcrypt.hash(password,12); u.mustChangePassword=true; }
    else u.active = action === 'activate';
    u.tokenVersion++; await u.save({ session }); await Session.deleteMany({ userId:id },{ session });
    await audit(actor,action,'User',id,before,publicUser(u),session);
    return { user:publicUser(u), ...(password && { temporaryPassword:password }) };
  }, { business:false });
}

