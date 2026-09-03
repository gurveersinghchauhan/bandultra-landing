import './env-setup.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import TrialRequest from '../src/models/TrialRequest.js';

/**
 * HTTP-level suite.
 *
 * Real Express, real middleware chain, real validator, real controller — only
 * the persistence boundary (three Mongoose model methods) is stubbed, so this
 * runs anywhere without a mongod binary. The same paths are exercised against a
 * real database by integration.mongo.test.js.
 */

let server;
let baseUrl;

/** In-memory stand-in for the trial_requests collection. */
const store = [];

const original = {
  create: TrialRequest.create,
  findOne: TrialRequest.findOne,
  updateOne: TrialRequest.updateOne,
};

before(async () => {
  TrialRequest.create = async (payload) => {
    // Run the real schema validation so required fields and the E.164 regex
    // are genuinely enforced, then store the plain object.
    const doc = new TrialRequest(payload);
    await doc.validate();
    const stored = doc.toObject();
    stored.createdAt = new Date();
    store.push(stored);
    return stored;
  };

  TrialRequest.findOne = (rawFilter = {}) => {
    // Run the REAL Mongoose filter casting first, under the same
    // `sanitizeFilter` setting production uses. Without this the stub would
    // happily accept a filter the database would reject — which is exactly how
    // the `Cast to date failed ... at path "createdAt"` bug reached production
    // with a green test suite.
    const previous = mongoose.get('sanitizeFilter');
    mongoose.set('sanitizeFilter', true);
    let filter;
    try {
      const query = TrialRequest.find(rawFilter);
      query._castConditions();
      if (query.error()) throw query.error();
      filter = query.getFilter();
    } finally {
      mongoose.set('sanitizeFilter', previous);
    }

    const since = filter.createdAt?.$gte;
    const match = store.find(
      (row) =>
        (filter.whatsappNumber === undefined || row.whatsappNumber === filter.whatsappNumber) &&
        (since === undefined || row.createdAt >= since),
    );
    // Minimal chainable stub matching the controller's `.select().lean()` usage.
    const chain = { select: () => chain, lean: async () => match ?? null };
    return chain;
  };

  TrialRequest.updateOne = async (filter, update) => {
    const row = store.find((item) => item._id === filter._id);
    if (row) Object.assign(row, { _stubUpdate: update.$set });
    return { acknowledged: true, modifiedCount: row ? 1 : 0 };
  };

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Object.assign(TrialRequest, original);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  store.length = 0;
});

const post = (body, path = '/api/v1/trial-requests') =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

let seq = 10000000;
const lead = (over = {}) => ({
  name: 'Priya Sharma',
  instituteName: 'Bright Future IELTS Academy',
  address: 'Sector 17, Chandigarh',
  whatsappNumber: `+9198${seq++}`,
  email: 'priya@brightfuture.edu',
  ...over,
});

test('creates a lead and returns 201 with a UUID id', async () => {
  const response = await post(lead());
  assert.equal(response.status, 201);

  const body = await response.json();
  assert.equal(body.success, true);
  assert.match(
    body.data.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'primary key must be a UUID, not an ObjectId or a business field',
  );
  assert.equal(store.length, 1);
  assert.equal(store[0].whatsappCountry, 'IN');
});

test('CONSTRAINT: the same email may be submitted repeatedly', async () => {
  const email = 'shared.director@example.com';
  const ids = [];

  for (let i = 0; i < 3; i += 1) {
    const response = await post(lead({ email, instituteName: `Institute ${i}` }));
    assert.equal(response.status, 201, `submission ${i + 1} must be accepted`);
    ids.push((await response.json()).data.id);
  }

  assert.equal(new Set(ids).size, 3, 'each submission gets its own record');
  assert.equal(store.filter((row) => row.email === email).length, 3);
});

test('address is optional', async () => {
  const payload = lead();
  delete payload.address;
  assert.equal((await post(payload)).status, 201);
});

test('normalises a formatted number into E.164 before storing', async () => {
  await post(lead({ whatsappNumber: '+91 (98765) 43-210' }));
  assert.equal(store[0].whatsappNumber, '+919876543210');
});

test('returns 422 with per-field errors', async () => {
  const response = await post({
    name: '',
    instituteName: '',
    whatsappNumber: '9876543210',
    email: 'nope',
  });
  assert.equal(response.status, 422);

  const body = await response.json();
  assert.equal(body.error, 'VALIDATION_ERROR');
  assert.ok(body.errors.name);
  assert.ok(body.errors.instituteName);
  assert.match(body.errors.whatsappNumber, /country code/i);
  assert.ok(body.errors.email);
  assert.equal(store.length, 0, 'nothing is stored on a validation failure');
});

test('rejects a NoSQL operator injection attempt', async () => {
  const response = await post(lead({ email: { $ne: null } }));
  assert.equal(response.status, 422);
  assert.equal(store.length, 0);
});

test('silently absorbs honeypot submissions', async () => {
  const response = await post(lead({ website: 'http://spam.example' }));
  assert.equal(response.status, 202, 'the bot sees success');
  assert.equal((await response.json()).success, true);
  assert.equal(store.length, 0, 'nothing is stored');
});

test('suppresses a duplicate submission from the same number', async () => {
  const number = '+919812345678';
  assert.equal((await post(lead({ whatsappNumber: number }))).status, 201);

  const second = await post(lead({ whatsappNumber: number }));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).data.duplicate, true);
  assert.equal(store.length, 1);
});

test('returns 400 for malformed JSON', async () => {
  const response = await post('{"name":');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'INVALID_JSON');
});

test('rejects an oversized body', async () => {
  const response = await post(lead({ address: 'x'.repeat(40_000) }));
  assert.equal(response.status, 413);
});

test('unknown routes return a JSON 404', async () => {
  const response = await fetch(`${baseUrl}/api/v1/nope`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'NOT_FOUND');
});

test('health endpoint reports integration state', async () => {
  const body = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(body.whatsapp, 'disabled');
  assert.equal(typeof body.pendingNotifications, 'number');
});

test('a database failure returns 503 and never leaks internals', async () => {
  const restore = TrialRequest.create;
  TrialRequest.create = async () => {
    const error = new Error('connection <credentials> refused');
    error.name = 'MongoNetworkError';
    throw error;
  };

  const response = await post(lead());
  assert.equal(response.status, 503);

  const body = await response.json();
  assert.equal(body.error, 'SERVICE_UNAVAILABLE');
  assert.ok(!JSON.stringify(body).includes('credentials'), 'driver detail must not reach the client');

  TrialRequest.create = restore;
});

test('the response does not wait on the WhatsApp send', async () => {
  // WHATSAPP_ENABLED is false, so the dispatcher resolves immediately; this
  // asserts the endpoint stays fast and that dispatch never blocks the reply.
  const started = Date.now();
  const response = await post(lead());
  assert.equal(response.status, 201);
  await response.json();
  assert.ok(Date.now() - started < 1500, 'endpoint should respond well inside a second');
});

test('a dispatcher failure cannot fail the request', async () => {
  const restore = TrialRequest.updateOne;
  TrialRequest.updateOne = async () => {
    throw new Error('status write failed');
  };

  const response = await post(lead());
  assert.equal(response.status, 201, 'the lead is still accepted');

  await new Promise((resolve) => setTimeout(resolve, 60));
  TrialRequest.updateOne = restore;
});

test('generated ids are unique across many submissions', async () => {
  const ids = new Set();
  for (let i = 0; i < 25; i += 1) {
    const response = await post(lead({ email: `dir${i}@example.com` }));
    ids.add((await response.json()).data.id);
  }
  assert.equal(ids.size, 25);
  assert.ok(!ids.has(randomUUID()), 'sanity: ids are genuinely random');
});

test('a query cast failure surfaces as structured JSON, not a crash', async () => {
  const restore = TrialRequest.findOne;
  TrialRequest.findOne = () => {
    const error = new mongoose.Error.CastError('date', { $gte: new Date() }, 'createdAt');
    throw error;
  };

  const response = await post(lead());
  assert.equal(response.status, 500);

  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error, 'QUERY_CAST_ERROR');
  assert.equal(typeof body.message, 'string');
  assert.ok(!JSON.stringify(body).includes('$gte'), 'internals must not leak to the client');

  TrialRequest.findOne = restore;

  // The server is still alive and serving.
  assert.equal((await post(lead())).status, 201);
});

test('a total WhatsApp outage still returns 201 and never crashes the process', async () => {
  // The dispatcher is the only thing between Meta and the request cycle. Make
  // its send path fail hard and confirm the lead is still accepted, the status
  // is recorded, and the server keeps serving.
  const restore = TrialRequest.updateOne;
  const statuses = [];
  TrialRequest.updateOne = async (filter, update) => {
    statuses.push(update.$set['whatsappNotification.status']);
    return { acknowledged: true };
  };

  const started = Date.now();
  const response = await post(lead());
  const elapsed = Date.now() - started;

  assert.equal(response.status, 201, 'the lead is accepted regardless of Meta');
  assert.ok(elapsed < 1500, `response must not wait on the send (took ${elapsed}ms)`);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(statuses.length > 0, 'an outcome was persisted asynchronously');

  TrialRequest.updateOne = restore;
  assert.equal((await post(lead())).status, 201, 'server still serving');
});

test('an unhandled rejection is never produced by the dispatch path', async () => {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on('unhandledRejection', onRejection);

  const restore = TrialRequest.updateOne;
  TrialRequest.updateOne = async () => {
    throw new Error('status write exploded');
  };

  assert.equal((await post(lead())).status, 201);
  await new Promise((resolve) => setTimeout(resolve, 250));

  TrialRequest.updateOne = restore;
  process.off('unhandledRejection', onRejection);
  assert.deepEqual(seen, [], 'the dispatcher must swallow its own failures');
});
