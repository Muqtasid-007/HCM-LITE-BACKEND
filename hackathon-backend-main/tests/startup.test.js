import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { logStartupError } from '../src/utils/startup.js';

function run(entry, overrides = {}) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[entry],{
      windowsHide:true,
      env:{ ...process.env, NODE_ENV:'test', LOG_LEVEL:'silent', PORT:'18573',
        JWT_SECRET:'startup-test-secret-at-least-32-characters',
        MONGODB_URI:'mongodb://127.0.0.1:1/startup_test', ...overrides },
      stdio:['ignore','pipe','pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data',chunk => stdout += chunk);
    child.stderr.on('data',chunk => stderr += chunk);
    child.once('error',reject);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Failed startup did not terminate')); },25000);
    child.once('exit',code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('startup errors preserve messages/stacks and redact secrets and connection strings', t => {
  const previous = process.env.MONGODB_URI;
  process.env.MONGODB_URI = 'mongodb://diagnostic-user:Encoded%40Password@localhost:27017/private';
  const cause = new Error('TLS handshake failed');
  const error = new Error(`Cannot connect ${process.env.MONGODB_URI}; password=Encoded@Password`,{cause});
  error.code = 'ECONNRESET';
  error.reason = { servers:new Map([['localhost',{error:new Error('Server TLS certificate rejected')} ]]) };
  const originalStack = error.stack;
  const messages = [];
  const mock = t.mock.method(console,'error',value => messages.push(value));
  try { logStartupError(error,'Startup test'); }
  finally { mock.mock.restore(); if(previous===undefined)delete process.env.MONGODB_URI;else process.env.MONGODB_URI=previous; }
  const output = messages.join('\n');
  assert.match(output,/TLS handshake failed/);
  assert.match(output,/Server TLS certificate rejected/);
  assert.match(output,/ECONNRESET/);
  assert.match(output,/startup\.test\.js/);
  assert(!output.includes('mongodb://'));
  assert(!output.includes('diagnostic-user'));
  assert(!output.includes('Encoded%40Password'));
  assert(!output.includes('Encoded@Password'));
  assert.equal(error.stack,originalStack);
  const previousKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'secret-with-"quotes"';
  const quotedMessages = [];
  const quotedMock = t.mock.method(console,'error',value => quotedMessages.push(value));
  try { logStartupError(new Error(`Key was ${process.env.AI_API_KEY}`),'Quoted credential'); }
  finally { quotedMock.mock.restore(); if(previousKey===undefined)delete process.env.AI_API_KEY;else process.env.AI_API_KEY=previousKey; }
  assert(!quotedMessages.join('').includes('secret-with-'));
});

test('module-level environment validation failures log stacks even with silent logging',async () => {
  for(const [entry,overrides,expected] of [
    ['server.js',{JWT_SECRET:'too-short-secret'},'JWT_SECRET'],
    ['server.js',{MONGODB_URI:'not-a-mongodb-connection'},'MONGODB_URI'],
    ['server.js',{LOG_LEVEL:'invalid-level'},'LOG_LEVEL'],
    ['src/jobs/bootstrap.js',{JWT_SECRET:'too-short-secret'},'Bootstrap failed'],
    ['src/jobs/reconcile.js',{JWT_SECRET:'too-short-secret'},'Reconciliation failed'],
  ]) {
    const result = await run(entry,overrides);
    assert.equal(result.code,1,result.stderr);
    assert(result.stderr.includes(expected),result.stderr);
    assert.match(result.stderr,/ZodError/);
    assert.match(result.stderr,/env\.js/);
    assert(!result.stderr.includes('too-short-secret'));
    assert(!result.stderr.includes('mongodb://127.0.0.1:1/startup_test'));
  }
});

test('database connection failure exits with original error and stack but no credentials', {timeout:30000},async () => {
  const uri = 'mongodb://startup-diagnostic-user:ConnectionPassword123@127.0.0.1:1/startup_test';
  const result = await run('server.js',{MONGODB_URI:uri});
  assert.equal(result.code,1,result.stderr);
  assert.match(result.stdout,/Connecting to MongoDB/);
  assert.match(result.stderr,/Server startup failed/);
  assert.match(result.stderr,/MongooseServerSelectionError|MongoServerSelectionError/);
  assert.match(result.stderr,/db\.js/);
  for(const secret of [uri,'startup-diagnostic-user','ConnectionPassword123'])assert(!result.stderr.includes(secret),result.stderr);
});
