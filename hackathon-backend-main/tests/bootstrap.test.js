import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/bootstrap_test';
process.env.JWT_SECRET = 'bootstrap-test-only-secret-at-least-32';
process.env.MONGOMS_VERSION ||= '7.0.24';
if (!process.env.MONGOMS_SYSTEM_BINARY && existsSync('tmp/mongodb/mongod.exe')) {
  process.env.MONGOMS_SYSTEM_BINARY = fileURLToPath(new URL('../tmp/mongodb/mongod.exe', import.meta.url));
}
const { User, Company, ensureIndexes } = await import('../src/models/index.js');
const { bootstrapCompany, setupCompany } = await import('../src/services/auth.js');
const { setup } = await import('../src/validators/index.js');
const input = { companyName:'Bootstrap Test', email:'  BAKHTIAR@GMAIL.COM  ', password:'New-bootstrap-password-123!' };

test('bootstrap preserves unique email and existing accounts across retries and races', { timeout:240000 }, async t => {
  const db = await MongoMemoryReplSet.create({ replSet:{ count:1, storageEngine:'wiredTiger' } });
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  async function isolatedDatabase(name) {
    await mongoose.disconnect();
    await mongoose.connect(db.getUri(name));
    await ensureIndexes();
    // Models survive reconnects; explicitly create indexes in each fresh test database.
    await Promise.all(Object.values(mongoose.models).map(model => model.createIndexes()));
  }

  await t.test('normalized existing email is reused without changing any account fields', async () => {
    await isolatedDatabase('existing_user');
    const original = await User.create({ email:'bakhtiar@gmail.com', passwordHash:await bcrypt.hash('Original-password-123!',12), role:'HR', active:false, mustChangePassword:true, tokenVersion:7 });
    const before = await User.findById(original._id).select('+passwordHash').lean();
    assert.equal(setup.parse(input).email,'bakhtiar@gmail.com');
    const result = await bootstrapCompany(input);
    assert.equal(result.initialized,true);
    assert.equal(result.reusedUser,true);
    assert.equal(String(result.user.id),String(original._id));
    assert.deepEqual(await User.findById(original._id).select('+passwordHash').lean(),before);
    assert.equal((await bootstrapCompany({ ...input, password:'Another-password-123!' })).initialized,false);
    assert.deepEqual(await User.findById(original._id).select('+passwordHash').lean(),before);
    assert.equal(await User.countDocuments(),1);
    assert.equal(await Company.countDocuments(),1);
    const indexes = await User.collection.indexes();
    assert(indexes.some(index => index.key.email === 1 && index.unique === true));
  });

  await t.test('concurrent bootstrap processes create one user and one company', async () => {
    await isolatedDatabase('concurrent_bootstrap');
    const results = await Promise.all([bootstrapCompany(input),bootstrapCompany({ ...input, email:'bakhtiar@gmail.com' })]);
    assert.equal(results.filter(result => result.initialized).length,1);
    assert.equal(await User.countDocuments(),1);
    assert.equal(await Company.countDocuments(),1);
    const user = await User.findOne({ email:'bakhtiar@gmail.com' }).select('+passwordHash');
    assert.equal(user.role,'Admin');
    assert(await bcrypt.compare(input.password,user.passwordHash));
    await assert.rejects(() => setupCompany({ ...input, email:'other@example.com' }), { status:409 });
  });

  await t.test('an actual concurrent E11000 email insert is recovered outside the failed transaction', async () => {
    await isolatedDatabase('email_insert_race');
    const passwordHash = await bcrypt.hash('Existing-race-password-123!',12);
    const originalCreate = User.create;
    let inserted = false;
    const createMock = t.mock.method(User,'create',async function (...args) {
      if (!inserted) {
        inserted = true;
        // Another writer commits after bootstrap's lookup but before its insert.
        // This is a real unique-index collision, not a mocked duplicate error.
        await User.collection.insertOne({ email:'bakhtiar@gmail.com', passwordHash, role:'Employee', active:false, mustChangePassword:true, tokenVersion:9 });
      }
      return originalCreate.apply(this,args);
    });
    try {
      const result = await bootstrapCompany(input);
      assert(inserted);
      assert.equal(createMock.mock.callCount(),1);
      assert.equal(result.initialized,true);
      assert.equal(result.reusedUser,true);
      const user = await User.findOne({ email:'bakhtiar@gmail.com' }).select('+passwordHash');
      assert.equal(user.passwordHash,passwordHash);
      assert.equal(user.role,'Employee');
      assert.equal(user.active,false);
      assert.equal(user.tokenVersion,9);
      assert.equal(await User.countDocuments(),1);
      assert.equal(await Company.countDocuments(),1);
    } finally { createMock.mock.restore(); }
  });
});
