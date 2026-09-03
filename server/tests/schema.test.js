import './env-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import TrialRequest, { assertNoUniqueEmailIndex } from '../src/models/TrialRequest.js';

/**
 * Schema-level guarantees.
 *
 * These assert the CRITICAL database constraint directly against the compiled
 * Mongoose schema, so they need no running MongoDB: `syncIndexes()` only ever
 * applies what is declared here, so a schema with no unique email index cannot
 * produce a collection with one.
 */

const schema = TrialRequest.schema;

test('CONSTRAINT: email is not a unique index', () => {
  const emailPath = schema.path('email');
  assert.ok(emailPath, 'email must exist on the schema');
  assert.notEqual(emailPath.options.unique, true, 'email must not be declared unique');

  const declared = schema.indexes().filter(([keys]) => 'email' in keys);
  assert.ok(declared.length > 0, 'a lookup index on email is expected');
  for (const [keys, options] of declared) {
    assert.notEqual(
      options.unique,
      true,
      `index on ${JSON.stringify(keys)} must not be unique — email is an identity key only for ` +
        'the superadmin and institute admin collections',
    );
  }
});

test('CONSTRAINT: no field other than _id is unique', () => {
  const uniqueIndexes = schema.indexes().filter(([, options]) => options.unique === true);
  assert.deepEqual(uniqueIndexes, [], 'trial_requests must carry no unique indexes');

  for (const path of Object.keys(schema.paths)) {
    if (path === '_id') continue;
    assert.notEqual(
      schema.path(path).options.unique,
      true,
      `${path} must not be declared unique on a lead collection`,
    );
  }
});

test('CONSTRAINT: the primary key is a generated UUID, not a business field', () => {
  const idPath = schema.path('_id');
  assert.equal(idPath.instance, 'String', '_id must be a string UUID, not an ObjectId');
  assert.equal(idPath.options.immutable, true);

  const generated = idPath.options.default();
  assert.match(
    generated,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    '_id default must produce a UUID v4',
  );
  assert.notEqual(idPath.options.default(), generated, 'each document gets a fresh id');
});

test('CONSTRAINT: there are no references to other collections', () => {
  for (const path of Object.keys(schema.paths)) {
    assert.equal(
      schema.path(path).options.ref,
      undefined,
      `${path} must not be a foreign key — this collection holds unqualified leads`,
    );
  }
});

test('required fields match the form contract', () => {
  for (const field of ['name', 'instituteName', 'whatsappNumber', 'email']) {
    assert.equal(schema.path(field).isRequired, true, `${field} must be required`);
  }
  assert.notEqual(schema.path('address').isRequired, true, 'address must stay optional');
});

test('whatsappNumber is constrained to E.164 at the schema level', () => {
  const validators = schema.path('whatsappNumber').validators.filter((v) => v.type === 'regexp');
  assert.equal(validators.length, 1);
  const { regexp } = validators[0];

  for (const good of ['+919876543210', '+14155552671', '+442071838750']) {
    assert.ok(regexp.test(good), `${good} should pass`);
  }
  for (const bad of ['9876543210', '+0123456789', '+91 98765 43210', '+91987', 'not-a-number']) {
    assert.ok(!regexp.test(bad), `${bad} should fail`);
  }
});

test('a document can be built and validated without a database connection', async () => {
  const doc = new TrialRequest({
    name: 'Priya Sharma',
    instituteName: 'Bright Future IELTS Academy',
    whatsappNumber: '+919876543210',
    email: 'Priya@BrightFuture.EDU',
  });

  await doc.validate();
  assert.equal(doc.email, 'priya@brightfuture.edu', 'email is lower-cased by the schema');
  assert.equal(doc.address, '');
  assert.equal(doc.whatsappNotification.status, 'pending');
  assert.equal(doc.whatsappNotification.attempts, 0);
});

test('the collection is named trial_requests', () => {
  assert.equal(TrialRequest.collection.collectionName, 'trial_requests');
});

/* ------------------------------------------------------------------------ *
 * Regression: the boot guard must not refuse to start on a fresh database.
 * ------------------------------------------------------------------------ */

test('boot guard tolerates a collection that does not exist yet', async () => {
  const realIndexes = TrialRequest.collection.indexes;
  const realInit = TrialRequest.init;
  TrialRequest.init = async () => TrialRequest;

  // What the driver actually throws against an empty database.
  TrialRequest.collection.indexes = async () => {
    const error = new Error('ns does not exist: bandultra.trial_requests');
    error.code = 26;
    throw error;
  };

  await assertNoUniqueEmailIndex(); // must resolve, not throw

  TrialRequest.collection.indexes = realIndexes;
  TrialRequest.init = realInit;
});

test('boot guard still propagates unexpected driver errors', async () => {
  const realIndexes = TrialRequest.collection.indexes;
  const realInit = TrialRequest.init;
  TrialRequest.init = async () => TrialRequest;

  TrialRequest.collection.indexes = async () => {
    const error = new Error('not authorized on bandultra to execute listIndexes');
    error.code = 13; // Unauthorized — a real problem, must not be swallowed
    throw error;
  };

  await assert.rejects(assertNoUniqueEmailIndex, /not authorized/);

  TrialRequest.collection.indexes = realIndexes;
  TrialRequest.init = realInit;
});

test('boot guard still catches a forbidden unique index on email', async () => {
  const realIndexes = TrialRequest.collection.indexes;
  const realInit = TrialRequest.init;
  TrialRequest.init = async () => TrialRequest;

  TrialRequest.collection.indexes = async () => [
    { name: '_id_', key: { _id: 1 } },
    { name: 'email_unique_idx', key: { email: 1 }, unique: true },
  ];

  await assert.rejects(assertNoUniqueEmailIndex, /UNIQUE index on "email"/);

  TrialRequest.collection.indexes = realIndexes;
  TrialRequest.init = realInit;
});

test('no index is a redundant prefix of another', () => {
  const keys = TrialRequest.schema.indexes().map(([k]) => Object.keys(k));
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = 0; j < keys.length; j += 1) {
      if (i === j || keys[i].length >= keys[j].length) continue;
      const isPrefix = keys[i].every((field, n) => field === keys[j][n]);
      assert.ok(
        !isPrefix,
        `index {${keys[i]}} is a redundant prefix of {${keys[j]}} — the longer one covers it`,
      );
    }
  }
});

test('schema options survive: collection name, timestamps, no version key', () => {
  const { options } = TrialRequest.schema;
  assert.equal(options.collection, 'trial_requests');
  assert.equal(options.timestamps, true);
  assert.equal(options.versionKey, false);
  assert.equal(options.autoCreate, true);
});
