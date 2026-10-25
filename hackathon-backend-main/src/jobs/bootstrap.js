import { runStartup } from '../utils/startup.js';
let mongoose;
await runStartup('Bootstrap failed',async () => {
  const { connectDB } = await import('../config/db.js');
  ({ default:mongoose } = await import('mongoose'));
  const { ensureIndexes, Company } = await import('../models/index.js');
  const { setup } = await import('../validators/index.js');
  const { bootstrapCompany } = await import('../services/auth.js');
  await connectDB();await ensureIndexes();
  if(await Company.exists({_id:'singleton'})) console.log('Already initialized; no accounts changed.');
  else {
    const input=setup.parse({companyName:process.env.COMPANY_NAME||'HCM Lite',email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});
    const result=await bootstrapCompany(input);
    if(!result.initialized) console.log('Already initialized; no accounts changed.');
    else if(result.reusedUser) console.log('Company initialized; existing user reused without changing password, role, or account state.');
    else console.log('Company and first Admin initialized.');
  }
  await mongoose.disconnect();
},async () => { if(mongoose) await mongoose.disconnect(); });
