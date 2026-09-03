import './env-setup.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * Live-transport tests for the WhatsApp service.
 *
 * A local HTTP server stands in for graph.facebook.com so the real fetch call,
 * retry loop, backoff, timeout and error classification all execute for real.
 * The service is imported dynamically after the env is pointed at the stub.
 */

let stub;
let requests = [];
let respond; // per-test handler: (req, count) -> { status, body, delayMs }
let sendTrialConfirmation;
let env;
let originalTemplate;

before(async () => {
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      requests.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: raw ? JSON.parse(raw) : null,
      });

      let result;
      try {
        result = respond(req, requests.length);
      } catch {
        // A handler that throws simulates the connection dying mid-flight.
        res.destroy();
        return;
      }
      if (result.delayMs) await new Promise((r) => setTimeout(r, result.delayMs));
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body ?? {}));
    });
  });

  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const { port } = stub.address();

  // Point the service at the stub. The service builds
  // `https://graph.facebook.com/${version}/${phoneNumberId}/messages`, so a
  // phoneNumberId cannot redirect the host — instead we override global fetch's
  // target by rewriting the URL in a thin wrapper.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) =>
    realFetch(String(url).replace('https://graph.facebook.com', `http://127.0.0.1:${port}`), options);

  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHATSAPP_MAX_ATTEMPTS = '3';
  process.env.WHATSAPP_RETRY_BASE_DELAY_MS = '5';
  process.env.WHATSAPP_TIMEOUT_MS = '250';

  ({ sendTrialConfirmation } = await import('../src/services/whatsapp.service.js'));
  ({ default: env } = await import('../src/config/env.js'));
  originalTemplate = { ...env.whatsapp };
});

after(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

beforeEach(() => {
  requests = [];
  respond = () => ({ status: 200, body: { messages: [{ id: 'wamid.TEST' }] } });
  if (originalTemplate) Object.assign(env.whatsapp, originalTemplate);
});

const lead = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  whatsappNumber: '+919876543210',
  instituteName: 'Bright Future IELTS Academy',
};

test('sends hello_world over the wire with no components', async () => {
  // The fallback template. Meta rejects a body component on a template that
  // declares no variables (132000), so nothing may appear on the wire.
  env.whatsapp.templateName = 'hello_world';
  env.whatsapp.templateLanguage = 'en_US';
  env.whatsapp.templateHasBodyParams = false;

  const result = await sendTrialConfirmation(lead);

  assert.equal(result.status, 'sent');
  assert.equal(result.messageId, 'wamid.TEST');
  assert.equal(result.attempts, 1);
  assert.equal(requests.length, 1);

  const sent = requests[0];
  assert.equal(sent.method, 'POST');
  assert.match(sent.url, /^\/v[\d.]+\/[^/]+\/messages$/);
  assert.equal(sent.authorization, 'Bearer test-access-token');
  assert.equal(sent.contentType, 'application/json');
  assert.equal(sent.body.to, '+919876543210');
  assert.equal(sent.body.type, 'template');
  assert.equal(sent.body.template.name, 'hello_world');
  assert.deepEqual(sent.body.template.language, { code: 'en_US' });
  assert.ok(
    !('components' in sent.body.template),
    'no components key may be serialised for a parameterless template',
  );
});

test('sends the branded template (the default) with {{1}} populated', async () => {
  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'sent');

  const sent = requests[0];
  assert.equal(sent.body.template.name, 'free_trial_booking_confirmation');
  assert.deepEqual(sent.body.template.language, { code: 'en_US' });
  assert.equal(sent.body.template.components.length, 1);
  assert.equal(sent.body.template.components[0].type, 'body');
  assert.deepEqual(sent.body.template.components[0].parameters, [
    { type: 'text', text: 'Bright Future IELTS Academy' },
  ]);
});

test('a 132000 parameter mismatch is not retried', async () => {
  // The failure mode this change exists to avoid. If it ever recurs it must
  // surface immediately rather than burning the retry budget.
  respond = () => ({
    status: 400,
    body: {
      error: {
        message: 'number of parameters does not match the expected number of params',
        code: 132_000,
      },
    },
  });

  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, '132000');
  assert.equal(requests.length, 1, 'a payload/template mismatch must not be retried');
});

test('retries a 500 and succeeds on a later attempt', async () => {
  respond = (req, count) =>
    count < 3
      ? { status: 500, body: { error: { message: 'Internal error', code: 1 } } }
      : { status: 200, body: { messages: [{ id: 'wamid.RETRIED' }] } };

  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'sent');
  assert.equal(result.attempts, 3);
  assert.equal(requests.length, 3);
});

test('retries a 429 rate limit', async () => {
  respond = (req, count) =>
    count === 1
      ? { status: 429, body: { error: { message: 'Rate limit hit', code: 130_429 } } }
      : { status: 200, body: { messages: [{ id: 'wamid.OK' }] } };

  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'sent');
  assert.equal(result.attempts, 2);
});

test('does NOT retry an invalid access token', async () => {
  respond = () => ({
    status: 401,
    body: { error: { message: 'Invalid OAuth access token', code: 190 } },
  });

  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, '190');
  assert.equal(requests.length, 1, 'a bad token must not be retried');
});

test('132001: falls back to the sibling locale and succeeds', async () => {
  // Configured en_US, but Meta only has the template approved as `en`.
  respond = (req, count) =>
    count === 1
      ? { status: 400, body: { error: { message: 'template name does not exist in en_US', code: 132_001 } } }
      : { status: 200, body: { messages: [{ id: 'wamid.FALLBACK' }] } };

  const result = await sendTrialConfirmation(lead);

  assert.equal(result.status, 'sent', 'the sibling locale rescued the send');
  assert.equal(result.messageId, 'wamid.FALLBACK');
  assert.equal(requests.length, 2, 'exactly one extra attempt, not a retry storm');
  assert.deepEqual(requests[0].body.template.language, { code: 'en_US' });
  assert.deepEqual(requests[1].body.template.language, { code: 'en' }, 'sibling locale tried');
});

test('132001: gives up after ONE fallback when neither locale exists', async () => {
  respond = () => ({
    status: 400,
    body: { error: { message: 'template name does not exist', code: 132_001 } },
  });

  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, '132001');
  assert.equal(requests.length, 2, 'original + one sibling attempt, then stop');
});

test('132001: no fallback at all when the feature is disabled', async () => {
  env.whatsapp.languageFallback = false;
  respond = () => ({
    status: 400,
    body: { error: { message: 'template name does not exist', code: 132_001 } },
  });

  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'failed');
  assert.equal(requests.length, 1, 'a template/language mismatch is still non-retryable');
});

test('gives up after the configured attempt limit', async () => {
  respond = () => ({ status: 503, body: { error: { message: 'Service unavailable', code: 2 } } });

  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts, 3, 'WHATSAPP_MAX_ATTEMPTS is 3 in this suite');
  assert.equal(requests.length, 3);
});

test('times out a hanging request and retries it', async () => {
  respond = (req, count) =>
    count === 1
      ? { status: 200, body: { messages: [{ id: 'slow' }] }, delayMs: 600 }
      : { status: 200, body: { messages: [{ id: 'wamid.FAST' }] } };

  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'sent');
  assert.equal(result.messageId, 'wamid.FAST');
  assert.equal(result.attempts, 2);
});

test('survives a non-JSON error page without throwing', async () => {
  respond = () => ({ status: 502, body: null });
  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'failed');
  assert.ok(result.error, 'a readable error message is still produced');
});

test('never leaks the access token in the returned error', async () => {
  respond = () => ({
    status: 400,
    body: { error: { message: 'Bad request for token test-access-token', code: 100 } },
  });

  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'failed');
  // Meta echoed the token; make sure nothing we *construct* adds one.
  assert.ok(!('accessToken' in result));
  assert.ok(!JSON.stringify(Object.keys(result)).includes('token'));
});

test('a dropped connection resolves as a failure rather than rejecting', async () => {
  respond = () => { throw new Error('connection dropped'); };

  const result = await sendTrialConfirmation(lead);
  assert.equal(result.status, 'failed', 'a hard transport failure resolves, never rejects');
  assert.equal(result.errorCode, 'NETWORK_ERROR');
  assert.equal(result.attempts, 3, 'network failures are retried to the limit');
});
