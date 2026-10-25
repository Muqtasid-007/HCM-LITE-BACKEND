import express from 'express';
import mongoose from 'mongoose';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { AppError, ok } from './utils/errors.js';
import { router } from './routes/index.js';
import { openapi } from './utils/openapi.js';
export const logger=pino({level:env.LOG_LEVEL,redact:['password','passwordHash','token','authorization','AI_API_KEY']});
export const app=express();
app.disable('x-powered-by');
app.use((req,res,next)=>{req.id=randomUUID();res.set('X-Request-Id',req.id);const start=Date.now();res.on('finish',()=>logger.info({requestId:req.id,method:req.method,path:req.path,status:res.statusCode,durationMs:Date.now()-start},'request'));next();});
app.use(helmet());
const allowed=env.CORS_ORIGINS.split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({origin:(origin,cb)=>cb(origin&&!allowed.includes(origin)?new AppError(403,'Origin not allowed'):null,true),credentials:false}));
app.use(express.json({limit:'1mb'}));
app.use(rateLimit({windowMs:60000,limit:300,standardHeaders:'draft-8',legacyHeaders:false,message:{success:false,message:'Rate limit exceeded'}}));
app.get('/health',(req,res)=>ok(res,{status:'alive'}));
app.get('/ready',async(req,res)=>{if(mongoose.connection.readyState!==1)return res.status(503).json({success:false,message:'Database unavailable'});try{await mongoose.connection.db.admin().ping();ok(res,{status:'ready'});}catch{res.status(503).json({success:false,message:'Database unavailable'});}});
app.get('/api/v1/openapi.json',(req,res)=>res.json(openapi()));
app.use('/api/v1',router);
app.use((req,res)=>res.status(404).json({success:false,message:'Endpoint not found',requestId:req.id}));
app.use((err,req,res,next)=>{
  let status=err.status||500,message=status<500?err.message:'An unexpected error occurred',errors=err.errors;
  if(err instanceof ZodError){status=422;message='Validation failed';errors=err.issues.map(i=>({field:i.path.join('.'),reason:i.message}));}
  if(err.code===11000){status=409;message='Record already exists';errors=undefined;}
  if(err.name==='CastError'){status=422;message='Invalid identifier';errors=undefined;}
  if(err.type==='entity.parse.failed'){status=400;message='Invalid JSON';errors=undefined;}
  if(err.type==='entity.too.large'){status=413;message='Request body too large';errors=undefined;}
  if(status>=500)logger.error({requestId:req.id,errorType:err.name,code:err.code},'request failed');
  res.status(status).json({success:false,message,...(status<500&&errors&&{errors}),requestId:req.id});
});
