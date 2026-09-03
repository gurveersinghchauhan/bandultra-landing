import './env-setup.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import TrialRequest, { assertNoUniqueEmailIndex } from '../src/models/TrialRequest.js';

/**
 * End-to-end suite against a real MongoDB.
 *
 * Uses mongodb-memory-server, which downloads a mongod binary on first run.
 * Where that download is unavailable (an air-gapped CI box, or an egress policy
 * that blocks fastdl.mongodb.org) the whole suite SKIPS rather than fails — the
 * same guarantees are covered server-free by schema.test.js and api.test.js.
 *
 * Force a hard failure instead of a skip with REQUIRE_MONGO=1.
 */
let mongo;
let server;
let baseUrl;
let skipReason = null;

before(async () => {
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'test' });
    await TrialRequest.syncIndexes();

    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  } catch (error) {
    if (process.env.REQUIRE_MONGO === '1') throw error;
    skipReason = `mongod unavailable: ${error.message.split('\n')[0]}`;
    // eslint-disable-next-line no-console
    console.error(`\n[integration.mongo] SKIPPED — ${skipReason}\n`);
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

/** Wraps each test so the suite reports as skipped, not failed, without mongod. */
const dbTest = (name, fn) => test(name, (t) => (skipReason ? t.skip(skipReason) : fn(t)));

const post = (body, path = '/api/v1/trial-requests') =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** Unique number per call so the duplicate-click guard never interferes. */
let seq = 1000000;
const lead = (over = {}) => ({
  name: 'Priya Sharma',
  instituteName: 'Bright Future IELTS Academy',
  address: 'Sector 17, Chandigarh',
  whatsappNumber: `+9198${String(seq++).padStart(8, '0')}`,
  email: 'priya@brightfuture.edu',
  ...over,
});

dbTest('POST creates a lead and returns 201 with a UUID id', async () => {
  const response = await post(lead());
  assert.equal(response.status, 201);

  const body = await response.json();
  assert.equal(body.success, true);
  assert.match(
    body.data.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'primary key must be a UUID v4, not an ObjectId or a business field',
  );

  const stored = await TrialRequest.findById(body.data.id).lean();
  assert.equal(stored.instituteName, 'Bright Future IELTS Academy');
  assert.equal(stored.whatsappCountry, 'IN');
  assert.equal(stored.whatsappNotification.status, 'skipped', 'integration disabled in tests');
});

dbTest('CONSTRAINT: the same email may be submitted many times', async () => {
  const email = 'shared.director@example.com';
  const ids = [];

  for (let i = 0; i < 3; i += 1) {
    const response = await post(lead({ email, instituteName: `Institute ${i}` }));
    assert.equal(response.status, 201, `submission ${i + 1} must be accepted`);
    ids.push((await response.json()).data.id);
  }

  assert.equal(new Set(ids).size, 3, 'each submission gets its own record');
  assert.equal(await TrialRequest.countDocuments({ email }), 3);
});

dbTest('CONSTRAINT: no unique index exists on email', async () => {
  const indexes = await TrialRequest.collection.indexes();
  const emailIndexes = indexes.filter((i) => Object.keys(i.key).includes('email'));

  assert.ok(emailIndexes.length > 0, 'a lookup index on email should exist');
  for (const index of emailIndexes) {
    assert.notEqual(index.unique, true, `index ${index.name} must not be unique`);
  }

  // The _id index must be the UUID field, and nothing else may be a PK.
  const idIndex = indexes.find((i) => i.name === '_id_');
  assert.deepEqual(idIndex.key, { _id: 1 });

  await assertNoUniqueEmailIndex(); // boot-time guard must pass
});

dbTest('boot guard fails loudly if a unique email index is introduced', async () => {
  await TrialRequest.collection.createIndex({ email: 1 }, { unique: true, name: 'bad_unique_idx' });
  await assert.rejects(assertNoUniqueEmailIndex, /UNIQUE index on "email"/);
  await TrialRequest.collection.dropIndex('bad_unique_idx');
  await assertNoUniqueEmailIndex();
});

dbTest('address is optional', async () => {
  const payload = lead();
  delete payload.address;
  const response = await post(payload);
  assert.equal(response.status, 201);
});

dbTest('returns 422 with per-field errors for a bad payload', async () => {
  const response = await post({ name: '', instituteName: '', whatsappNumber: '9876543210', email: 'nope' });
  assert.equal(response.status, 422);

  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error, 'VALIDATION_ERROR');
  assert.ok(body.errors.name);
  assert.ok(body.errors.instituteName);
  assert.match(body.errors.whatsappNumber, /country code/i);
  assert.ok(body.errors.email);
});

dbTest('rejects a NoSQL operator injection attempt', async () => {
  const response = await post(lead({ email: { $ne: null } }));
  assert.equal(response.status, 422);
  assert.equal(await TrialRequest.countDocuments({ 'meta.userAgent': 'never' }), 0);
});

dbTest('silently absorbs honeypot submissions', async () => {
  const before = await TrialRequest.countDocuments();
  const response = await post(lead({ website: 'http://spam.example' }));

  assert.equal(response.status, 202, 'bot sees success');
  assert.equal((await response.json()).success, true);
  assert.equal(await TrialRequest.countDocuments(), before, 'nothing was stored');
});

dbTest('suppresses a duplicate submission from the same number', async () => {
  const number = '+919812345678';
  const first = await post(lead({ whatsappNumber: number }));
  assert.equal(first.status, 201);

  const second = await post(lead({ whatsappNumber: number }));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).data.duplicate, true);
  assert.equal(await TrialRequest.countDocuments({ whatsappNumber: number }), 1);
});

dbTest('returns 400 for malformed JSON', async () => {
  const response = await post('{"name":');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'INVALID_JSON');
});

dbTest('health endpoint reports database and integration state', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.database, 'connected');
  assert.equal(body.whatsapp, 'disabled');
});

dbTest('unknown routes return a JSON 404', async () => {
  const response = await fetch(`${baseUrl}/api/v1/nope`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'NOT_FOUND');
});
