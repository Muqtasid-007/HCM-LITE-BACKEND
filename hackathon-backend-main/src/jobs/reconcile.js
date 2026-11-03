import { runStartup } from '../utils/startup.js';
let mongoose;
await runStartup('Reconciliation failed',async () => {
  const { connectDB } = await import('../config/db.js');
  ({ default:mongoose } = await import('mongoose'));
  const { DateTime } = await import('luxon');
  const { User, ensureIndexes } = await import('../models/index.js');
  const { company } = await import('../services/common.js');
  const { reconcile } = await import('../services/attendance.js');
  const { currentPolicy } = await import('../utils/dates.js');
  await connectDB();
  await ensureIndexes();
  const actor = await User.findOne({role:'Admin',active:true});
  if(!actor) throw new Error('Initialize the application first');
  const c = await company();
  const date = DateTime.now().setZone(currentPolicy(c).timezone).minus({days:1}).toISODate();
  console.log(await reconcile(actor,process.argv[2]||date,process.argv[3]||process.argv[2]||date));
  await mongoose.disconnect();
},async () => { if(mongoose) await mongoose.disconnect(); });
