/**
 * Exercises scripts/verify-template.mjs against a stubbed Meta API.
 *
 * Not part of `npm test` (it spawns child processes); run directly:
 *   node tests/verify-script.probe.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let templates = [];
const stub = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: templates }));
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const port = stub.address().port;

// Redirect graph.facebook.com at the child process.
const shimPath = path.join(here, '.verify-shim.mjs');
const { writeFileSync, unlinkSync } = await import('node:fs');
writeFileSync(
  shimPath,
  `const real = globalThis.fetch;
   globalThis.fetch = (u, o) =>
     real(String(u).replace('https://graph.facebook.com', 'http://127.0.0.1:${port}'), o);\n`,
);

const BODY =
  'Hi {{1}},\n\nThank you for booking a free trial! We have received your details and are preparing your setup.' +
  '\n\nIf you have any immediate questions or specific requirements for your students, you can reply directly to this message.' +
  '\n\nWe look forward to working with you. Our team will reach out to you shortly with your access details.';

const run = (envOverrides = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', shimPath, 'scripts/verify-template.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        MONGODB_URI: 'mongodb://127.0.0.1:27017/x',
        WHATSAPP_ENABLED: 'true',
        WHATSAPP_PHONE_NUMBER_ID: '123',
        WHATSAPP_ACCESS_TOKEN: 'stub-token',
        WHATSAPP_BUSINESS_ACCOUNT_ID: '999',
        WHATSAPP_TEMPLATE_NAME: 'free_trial_booking_confirmation',
        WHATSAPP_TEMPLATE_LANGUAGE: 'en_US',
        WHATSAPP_TEMPLATE_HAS_BODY_PARAMS: 'true',
        ...envOverrides,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') }));
  });

const scenarios = [
  {
    name: 'approved in the configured language, one body param',
    templates: [{ name: 'free_trial_booking_confirmation', language: 'en_US', status: 'APPROVED',
                  category: 'UTILITY', components: [{ type: 'BODY', text: BODY }] }],
    expectCode: 0,
    expect: ['Approved in the configured language', 'Body parameter count matches',
             'matches TEMPLATE_BODY_REFERENCE exactly', 'Configuration matches'],
  },
  {
    name: 'THE en / en_US MIX-UP: approved as en, configured en_US',
    templates: [{ name: 'free_trial_booking_confirmation', language: 'en', status: 'APPROVED',
                  category: 'UTILITY', components: [{ type: 'BODY', text: BODY }] }],
    expectCode: 1,
    expect: ['Not approved as "en_US"', 'classic en / en_US mix-up',
             'WHATSAPP_TEMPLATE_LANGUAGE=en'],
  },
  {
    name: 'template does not exist at all (the raw 132001)',
    templates: [{ name: 'hello_world', language: 'en_US', status: 'APPROVED', components: [] }],
    expectCode: 1,
    expect: ['No template named', 'This is your 132001', 'Available names: hello_world'],
  },
  {
    name: 'template exists but is still PENDING review',
    templates: [{ name: 'free_trial_booking_confirmation', language: 'en_US', status: 'PENDING',
                  components: [{ type: 'BODY', text: BODY }] }],
    expectCode: 1,
    expect: ['not APPROVED in any language', 'hello_world'],
  },
  {
    name: 'parameter count mismatch (approved body has no variables)',
    templates: [{ name: 'free_trial_booking_confirmation', language: 'en_US', status: 'APPROVED',
                  components: [{ type: 'BODY', text: 'Thanks for booking a free trial!' }] }],
    expectCode: 1,
    expect: ['Body parameter MISMATCH', 'expects 0, payload sends 1', 'This is a 132000',
             'WHATSAPP_TEMPLATE_HAS_BODY_PARAMS=false'],
  },
  {
    name: 'approved body declares TWO variables but we send one',
    templates: [{ name: 'free_trial_booking_confirmation', language: 'en_US', status: 'APPROVED',
                  components: [{ type: 'BODY', text: 'Hi {{1}}, your trial starts {{2}}.' }] }],
    expectCode: 1,
    expect: ['expects 2, payload sends 1', 'supply 2 value(s)'],
  },
  {
    name: 'header carries a variable the payload never sends',
    templates: [{ name: 'free_trial_booking_confirmation', language: 'en_US', status: 'APPROVED',
                  components: [{ type: 'HEADER', text: 'Welcome {{1}}' }, { type: 'BODY', text: BODY }] }],
    expectCode: 1,
    expect: ['HEADER declares 1 variable', 'buildTemplatePayload'],
  },
  {
    name: 'dynamic URL button the payload never sends',
    templates: [{ name: 'free_trial_booking_confirmation', language: 'en_US', status: 'APPROVED',
                  components: [{ type: 'BODY', text: BODY },
                               { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x.com/{{1}}' }] }] }],
    expectCode: 1,
    expect: ['button(s) have dynamic URLs', 'sub_type: "url"'],
  },
  {
    name: 'WABA id missing — cannot verify, exits 2 rather than guessing',
    templates: [],
    env: { WHATSAPP_BUSINESS_ACCOUNT_ID: '' },
    expectCode: 2,
    expect: ['WHATSAPP_BUSINESS_ACCOUNT_ID is not set'],
  },
];

let failures = 0;
for (const s of scenarios) {
  templates = s.templates;
  const { code, out } = await run(s.env);
  const missing = s.expect.filter((phrase) => !out.includes(phrase));
  const codeOk = code === s.expectCode;

  if (codeOk && missing.length === 0) {
    console.log(`PASS  ${s.name}  (exit ${code})`);
  } else {
    failures += 1;
    console.log(`FAIL  ${s.name}`);
    if (!codeOk) console.log(`        exit ${code}, expected ${s.expectCode}`);
    for (const m of missing) console.log(`        missing phrase: ${JSON.stringify(m)}`);
    console.log(out.split('\n').map((l) => `      | ${l}`).join('\n'));
  }
}

unlinkSync(shimPath);
await new Promise((r) => stub.close(r));
console.log(`\n${scenarios.length - failures}/${scenarios.length} verifier scenarios passed`);
process.exit(failures ? 1 : 0);
