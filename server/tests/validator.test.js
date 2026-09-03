import './env-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTrialRequest } from '../src/validators/trialRequest.validator.js';
import { ZERO_WIDTH_NAME, CONTROL_NAME, BIDI_INSTITUTE } from './sanitize-fixture.js';

const valid = {
  name: 'Priya Sharma',
  instituteName: 'Bright Future IELTS Academy',
  address: 'Sector 17, Chandigarh',
  whatsappNumber: '+919876543210',
  email: 'Priya@BrightFuture.edu',
};

test('accepts a well-formed payload and normalises it', () => {
  const { valid: ok, data } = validateTrialRequest(valid);
  assert.equal(ok, true);
  assert.equal(data.email, 'priya@brightfuture.edu', 'email is lower-cased');
  assert.equal(data.whatsappNumber, '+919876543210');
  assert.equal(data.whatsappCountry, 'IN');
  assert.equal(data.source, 'landing-page');
});

test('address is optional', () => {
  const { valid: ok, data } = validateTrialRequest({ ...valid, address: undefined });
  assert.equal(ok, true);
  assert.equal(data.address, '');
});

test('requires name, institute, number and email', () => {
  const { valid: ok, errors } = validateTrialRequest({});
  assert.equal(ok, false);
  for (const field of ['name', 'instituteName', 'whatsappNumber', 'email']) {
    assert.ok(errors[field], `expected an error for ${field}`);
  }
  assert.ok(!errors.address, 'address must not be required');
});

test('rejects a number with no country code', () => {
  const { valid: ok, errors } = validateTrialRequest({ ...valid, whatsappNumber: '9876543210' });
  assert.equal(ok, false);
  assert.match(errors.whatsappNumber, /country code/i);
});

test('rejects a number that is invalid for its country code', () => {
  const { valid: ok } = validateTrialRequest({ ...valid, whatsappNumber: '+91123' });
  assert.equal(ok, false);
});

test('normalises spaces, dashes and brackets into E.164', () => {
  const { valid: ok, data } = validateTrialRequest({
    ...valid,
    whatsappNumber: '+91 (98765) 43-210',
  });
  assert.equal(ok, true);
  assert.equal(data.whatsappNumber, '+919876543210');
});

test('accepts non-Indian country codes', () => {
  for (const [number, country] of [
    ['+447712345678', 'GB'],  // mobile; a GB landline is rejected by design
    ['+971501234567', 'AE'],
    ['+14155552671', 'US'],
  ]) {
    const { valid: ok, data } = validateTrialRequest({ ...valid, whatsappNumber: number });
    assert.equal(ok, true, `${number} should be valid`);
    assert.equal(data.whatsappCountry, country);
  }
});

test('rejects malformed emails', () => {
  for (const email of ['nope', 'a@b', 'a b@c.com', '@nope.com', 'a@.com', `${'x'.repeat(250)}@b.com`]) {
    const { valid: ok } = validateTrialRequest({ ...valid, email });
    assert.equal(ok, false, `${email} should be rejected`);
  }
});

test('rejects NoSQL operator payloads outright', () => {
  const { valid: ok, errors } = validateTrialRequest({ ...valid, email: { $ne: null } });
  assert.equal(ok, false);
  assert.ok(errors._, 'expected a body-level error, not a field error');
});

test('rejects dotted keys used for path traversal', () => {
  const { valid: ok } = validateTrialRequest({ ...valid, 'meta.ip': '1.2.3.4' });
  assert.equal(ok, false);
});

test('strips zero-width characters without altering the visible name', () => {
  const { valid: ok, data } = validateTrialRequest({ ...valid, name: ZERO_WIDTH_NAME });
  assert.equal(ok, true);
  assert.equal(data.name, 'Priya Sharma', 'invisible padding must not survive');
});

test('replaces control characters with a space rather than joining tokens', () => {
  const { valid: ok, data } = validateTrialRequest({ ...valid, name: CONTROL_NAME });
  assert.equal(ok, true);
  assert.equal(data.name, 'Priya Sharma');
  assert.ok(!/[\u0000-\u001F]/.test(data.name), 'no control characters remain');
});

test('strips bidirectional overrides used to disguise text', () => {
  const { data } = validateTrialRequest({ ...valid, instituteName: BIDI_INSTITUTE });
  assert.equal(data.instituteName, 'Bright Future Academy');
  assert.ok(!/[\u202A-\u202E]/.test(data.instituteName));
});

test('caps overlong input rather than erroring on length alone', () => {
  const { data } = validateTrialRequest({ ...valid, instituteName: 'A'.repeat(500) });
  assert.equal(data.instituteName.length, 160);
});

test('rejects a non-object body', () => {
  for (const body of [null, 'string', 42, ['a']]) {
    assert.equal(validateTrialRequest(body).valid, false);
  }
});

/* --------------------------------------------------------------------- *
 * Strict E.164 enforcement (the value goes straight to the Cloud API).
 * --------------------------------------------------------------------- */

test('E.164: accepts real numbers in any common separator style', () => {
  for (const [input, expected, country] of [
    ['+919876543210', '+919876543210', 'IN'],
    ['+91 98765 43210', '+919876543210', 'IN'],
    ['+91-98765-43210', '+919876543210', 'IN'],
    ['+91 (98765) 43210', '+919876543210', 'IN'],
    ['  +919876543210  ', '+919876543210', 'IN'],
    ['+44 7712 345678', '+447712345678', 'GB'],
    ['+971 50 123 4567', '+971501234567', 'AE'],
    ['+1 202 555 0123', '+12025550123', 'US'],
  ]) {
    const { valid: ok, data } = validateTrialRequest({ ...valid, whatsappNumber: input });
    assert.equal(ok, true, `${input} should be accepted`);
    assert.equal(data.whatsappNumber, expected);
    assert.equal(data.whatsappCountry, country);
    assert.match(data.whatsappNumber, /^\+[1-9]\d{7,14}$/, 'stored value must be canonical E.164');
  }
});

test('E.164: rejects everything that is not a clean international number', () => {
  for (const bad of [
    '9876543210',           // no country code
    '0919876543210',        // trunk prefix, no +
    '919876543210',         // country code without +
    '+0919876543210',       // country code cannot start with 0
    '++919876543210',       // doubled +
    '+919876543210abc',     // trailing letters — must not be silently truncated
    '+91 98765 4321O',      // letter O typed for zero
    '+91,9876543210',       // stray punctuation
    'tel:+919876543210',    // URI scheme
    '+1-800-FLOWERS',       // vanity number
    '+91987654321012345',   // too long
    '+911',                 // too short
    '+9',
    '',
  ]) {
    const { valid: ok, errors } = validateTrialRequest({ ...valid, whatsappNumber: bad });
    assert.equal(ok, false, `${JSON.stringify(bad)} must be rejected`);
    assert.ok(errors.whatsappNumber, 'the error must be attached to the whatsappNumber field');
  }
});

test('E.164: an unallocatable number for its country is rejected', () => {
  // Right length, wrong number. Only the /max metadata catches this — the
  // default /min metadata reports it as valid.
  const { valid: ok, errors } = validateTrialRequest({ ...valid, whatsappNumber: '+911111111111' });
  assert.equal(ok, false);
  assert.ok(errors.whatsappNumber);
});

test('a landline is rejected up front, not left to fail at Meta', () => {
  const { valid: ok, errors } = validateTrialRequest({ ...valid, whatsappNumber: '+912222222222' });
  assert.equal(ok, false);
  assert.match(errors.whatsappNumber, /landline/i);
});

test('FIXED_LINE_OR_MOBILE and mobile numbers are still accepted', () => {
  for (const number of [
    '+12025550123',   // US — reports FIXED_LINE_OR_MOBILE
    '+919876543210',  // IN — MOBILE
    '+447712345678',  // GB — MOBILE
    '+971501234567',  // AE — MOBILE
  ]) {
    const { valid: ok, errors } = validateTrialRequest({ ...valid, whatsappNumber: number });
    assert.equal(ok, true, `${number} rejected: ${errors.whatsappNumber}`);
  }
});

test('email is normalised for lookup, never treated as an identifier', () => {
  const { data } = validateTrialRequest({ ...valid, email: '  Director@Institute.EDU  ' });
  assert.equal(data.email, 'director@institute.edu', 'lower-cased and trimmed for lookup');

  // Two different people at the same address are two valid, distinct payloads.
  const a = validateTrialRequest({ ...valid, email: 'shared@x.com', instituteName: 'Alpha' });
  const b = validateTrialRequest({ ...valid, email: 'shared@x.com', instituteName: 'Beta' });
  assert.equal(a.valid, true);
  assert.equal(b.valid, true);
  assert.notEqual(a.data.instituteName, b.data.instituteName);
});
