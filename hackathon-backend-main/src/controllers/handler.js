import { ok } from '../utils/errors.js';
export const handle = fn => async (req,res) => { const result=await fn(req,res); if(!res.headersSent) ok(res,result); };
