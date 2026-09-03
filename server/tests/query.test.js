import './env-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import TrialRequest from '../src/models/TrialRequest.js';

/**
 * Regression tests for query construction.
 *
 * These run Mongoose's REAL filter casting (`_castConditions`) without needing
 * a live MongoDB, so they catch cast failures offline.
 *
 * Background: production sets `sanitizeFilter: true` globally (config/db.js) to
 * neutralise injected query operators. That setting also rewrites our OWN
 * operator objects — `{ createdAt: { $gte: date } }` became
 * `{ createdAt: { $eq: { $gte: date } } }` — which failed to cast with
 * "Cast to date failed for value "{ '$gte': ... }" (type Object)".
 * The duplicate-click guard now wraps its operator in `mongoose.trusted()`.
 */

/** Cast a filter exactly as Mongoose would before hitting the database. */
function castFilter(filter) {
  const query = TrialRequest.findOne(filter);
  query._castConditions();
  const error = query.error();
  if (error) throw error;
  return query.getFilter();
}

const withSanitize = (on, fn) => {
  const previous = mongoose.get('sanitizeFilter');
  mongoose.set('sanitizeFilter', on);
  try {
    return fn();
  } finally {
    mongoose.set('sanitizeFilter', previous);
  }
};

test('the duplicate-window filter casts cleanly under production settings', () => {
  const since = new Date(Date.now() - 600_000);

  const filter = withSanitize(true, () =>
    castFilter({
      whatsappNumber: '+919876543210',
      createdAt: mongoose.trusted({ $gte: since }),
    }),
  );

  assert.equal(filter.whatsappNumber, '+919876543210');
  assert.ok(filter.createdAt.$gte instanceof Date, '$gte must survive as a Date');
  assert.equal(filter.createdAt.$gte.getTime(), since.getTime());
  assert.ok(!('$eq' in filter.createdAt), 'sanitizeFilter must not have wrapped our operator');
});

test('REGRESSION: an untrusted $gte under sanitizeFilter throws the reported CastError', () => {
  const since = new Date(Date.now() - 600_000);

  assert.throws(
    () => withSanitize(true, () => castFilter({ createdAt: { $gte: since } })),
    (error) => {
      assert.equal(error.name, 'CastError');
      assert.match(error.message, /Cast to date failed/);
      assert.match(error.message, /\$gte/);
      assert.match(error.message, /at path "createdAt"/);
      return true;
    },
    'this is the exact failure the fix prevents — if it stops throwing, ' +
      'sanitizeFilter was removed and the trusted() wrapper is no longer needed',
  );
});

test('sanitizeFilter still refuses an injected operator from user input', () => {
  // A hostile value reaching a filter must never be executed as an operator.
  // sanitizeFilter wraps it in $eq; on a typed String path that then fails to
  // cast, so the query is refused outright rather than matching every row.
  // (Without sanitizeFilter, `{ $ne: null }` would run and match everything.)
  for (const hostile of [
    { whatsappNumber: { $ne: null } },
    { email: { $gt: '' } },
    { whatsappNumber: { $regex: '.*' } },
  ]) {
    assert.throws(
      () => withSanitize(true, () => castFilter(hostile)),
      /Cast to string failed/,
      `injected operator ${JSON.stringify(hostile)} must not reach the database`,
    );
  }
});

test('without sanitizeFilter the same injection would execute — proving it earns its place', () => {
  // Documents why the global setting exists at all, and therefore why the
  // trusted() wrapper in the controller is necessary rather than incidental.
  const filter = withSanitize(false, () => castFilter({ whatsappNumber: { $ne: null } }));
  assert.deepEqual(filter.whatsappNumber, { $ne: null }, 'operator would run unsanitised');
});

test('the time window is a real Date, not a string or a number', () => {
  const DUPLICATE_WINDOW_MS = 600_000;
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);

  assert.ok(since instanceof Date);
  assert.ok(!Number.isNaN(since.getTime()), 'must not be an Invalid Date');
  assert.ok(since.getTime() < Date.now(), 'window opens in the past');
  assert.ok(Date.now() - since.getTime() <= DUPLICATE_WINDOW_MS + 1000);
});

test('the notification status update targets a plain string _id', () => {
  // The dispatcher filters on { _id: <uuid string> }; no operator, nothing for
  // sanitizeFilter to rewrite. Guard against that changing silently.
  const filter = withSanitize(true, () =>
    castFilter({ _id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
  );
  assert.equal(typeof filter._id, 'string');
});
