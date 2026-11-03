import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
process.env.MONGOMS_VERSION ||= '7.0.24';
if(!process.env.MONGOMS_SYSTEM_BINARY&&existsSync('tmp/mongodb/mongod.exe'))process.env.MONGOMS_SYSTEM_BINARY=fileURLToPath(new URL('../tmp/mongodb/mongod.exe',import.meta.url));
const exec=promisify(execFile);
test('real server startup, empty database, and idempotent CLI bootstrap', {timeout:240000}, async t=>{
  const db=await MongoMemoryReplSet.create({replSet:{count:1,storageEngine:'wiredTiger'}});let child;
  t.after(async()=>{if(child?.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}await mongoose.disconnect();await db.stop();});
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const uri=db.getUri('hcm_runtime_isolated_test');
  const env={...process.env,NODE_ENV:'test',LOG_LEVEL:'silent',MONGODB_URI:uri,JWT_SECRET:'runtime-test-only-secret-at-least-32',PORT:String(port),ADMIN_EMAIL:'bootstrap@example.com',ADMIN_PASSWORD:'Bootstrap-strong-password-123!',COMPANY_NAME:'CLI Company'};
  child=spawn(process.execPath,['server.js'],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  const base=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(`Server exited unexpectedly: ${output}`);try{const r=await fetch(base+'/ready');if(r.ok){ready=true;break;}}catch{}await delay(100);}
  assert(ready,'Server did not become ready');
  assert.equal((await(await fetch(base+'/health')).json()).data.status,'alive');
  // A bind failure must log the original error and exit, rather than hanging or
  // emitting an uncaught EventEmitter error outside the startup boundary.
  await assert.rejects(()=>exec(process.execPath,['server.js'],{env,windowsHide:true,timeout:15000}),error=>{
    assert.equal(error.code,1);
    assert.match(error.stderr,/EADDRINUSE/);
    assert.match(error.stderr,/Server startup failed/);
    assert.match(error.stderr,/node:net/);
    assert(!error.stderr.includes(uri));
    return true;
  });
  assert.deepEqual((await(await fetch(base+'/api/v1/setup-status')).json()).data,{initializationRequired:true});
  const first=await exec(process.execPath,['src/jobs/bootstrap.js'],{env,windowsHide:true});assert.match(first.stdout,/initialized/);
  const second=await exec(process.execPath,['src/jobs/bootstrap.js'],{env:{...env,ADMIN_PASSWORD:'Should-not-replace-password-123!'},windowsHide:true});assert.match(second.stdout,/Already initialized/);
  await mongoose.connect(uri);const users=await mongoose.connection.db.collection('users').find().toArray();assert.equal(users.length,1);assert(await bcrypt.compare(env.ADMIN_PASSWORD,users[0].passwordHash));
  for(const name of ['employees','attendances','leaves','payrolls','announcements'])assert.equal(await mongoose.connection.db.collection(name).countDocuments(),0);
  assert.deepEqual((await(await fetch(base+'/api/v1/setup-status')).json()).data,{initializationRequired:false});
  const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD})});assert.equal(login.status,200);assert((await login.json()).data.token);
  const beforeRestart=await mongoose.connection.db.collection('users').findOne({email:env.ADMIN_EMAIL});
  await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
  child=spawn(process.execPath,['server.js'],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  ready=false;
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(`Server restart failed: ${output}`);try{if((await fetch(base+'/ready')).ok){ready=true;break;}}catch{}await delay(100);}
  assert(ready,'Restarted server did not become ready');
  assert.deepEqual(await mongoose.connection.db.collection('users').findOne({email:env.ADMIN_EMAIL}),beforeRestart);
  assert.equal(await mongoose.connection.db.collection('users').countDocuments(),1);
  assert(!output.includes('E11000'));
});
