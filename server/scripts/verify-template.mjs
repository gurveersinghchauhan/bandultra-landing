#!/usr/bin/env node
/**
 * Verify the configured WhatsApp template against what Meta actually has.
 *
 *   npm run whatsapp:verify
 *
 * Answers, from the source of truth rather than assumption:
 *   · Does the template exist at all?
 *   · Under which language code(s) — `en`, `en_US`, both?
 *   · Is it APPROVED, PENDING or REJECTED?
 *   · How many body variables does the APPROVED body declare?
 *   · Does any header or button also declare variables (which our payload
 *     would need to supply, and currently does not)?
 *
 * Then it compares that against local config and prints the exact .env lines to
 * use. Exits non-zero on a mismatch so it can gate a deploy.
 *
 * Requires WHATSAPP_BUSINESS_ACCOUNT_ID (WhatsApp Manager → API Setup, listed
 * next to the Phone number ID). Read-only: it performs a single GET.
 */
import env from '../src/config/env.js';
import {
  TEMPLATE_BODY_REFERENCE,
  TEMPLATE_VARIABLES,
  templateAcceptsBodyParams,
  siblingLanguage,
} from '../src/services/whatsapp.service.js';

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const ok = (m) => console.log(`${GREEN}✓${OFF} ${m}`);
const bad = (m) => console.log(`${RED}✗${OFF} ${m}`);
const warn = (m) => console.log(`${YELLOW}!${OFF} ${m}`);
const info = (m) => console.log(`  ${DIM}${m}${OFF}`);

let failed = false;
const fail = (m) => {
  failed = true;
  bad(m);
};

/** Count distinct {{n}} placeholders in a template body string. */
const countPlaceholders = (text = '') =>
  new Set(text.match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;

const configured = {
  name: env.whatsapp.templateName,
  language: env.whatsapp.templateLanguage,
  hasBodyParams: templateAcceptsBodyParams(),
};

console.log(`\n${BOLD}WhatsApp template verification${OFF}`);
console.log(`${DIM}Graph ${env.whatsapp.graphApiVersion} · phone number id ${env.whatsapp.phoneNumberId || '(unset)'}${OFF}\n`);
console.log(`${BOLD}Local configuration${OFF}`);
info(`WHATSAPP_TEMPLATE_NAME            = ${configured.name}`);
info(`WHATSAPP_TEMPLATE_LANGUAGE        = ${configured.language}`);
info(`WHATSAPP_TEMPLATE_HAS_BODY_PARAMS = ${configured.hasBodyParams}`);
info(`payload will send ${configured.hasBodyParams ? TEMPLATE_VARIABLES.length : 0} body parameter(s)\n`);

if (!env.whatsapp.businessAccountId) {
  warn('WHATSAPP_BUSINESS_ACCOUNT_ID is not set — cannot query Meta.');
  info('Find it in WhatsApp Manager → API Setup, beside the Phone number ID,');
  info('then add it to .env:  WHATSAPP_BUSINESS_ACCOUNT_ID=1234567890');
  process.exit(2);
}
if (!env.whatsapp.accessToken) {
  warn('WHATSAPP_ACCESS_TOKEN is not set — cannot query Meta.');
  process.exit(2);
}

const url =
  `https://graph.facebook.com/${env.whatsapp.graphApiVersion}` +
  `/${env.whatsapp.businessAccountId}/message_templates` +
  `?fields=name,language,status,category,components&limit=200`;

let payload;
try {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${env.whatsapp.accessToken}` },
  });
  const text = await response.text();
  payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const e = payload.error ?? {};
    fail(`Meta returned ${response.status}: ${e.message ?? 'unknown error'} (code ${e.code ?? '?'})`);
    if (e.code === 190) info('The access token is invalid or expired — generate a new System User token.');
    if (e.code === 100) info('Check WHATSAPP_BUSINESS_ACCOUNT_ID: it must be the WABA id, not the phone number id.');
    process.exit(1);
  }
} catch (error) {
  fail(`Could not reach Meta: ${error.message}`);
  process.exit(1);
}

const all = payload.data ?? [];
const matches = all.filter((t) => t.name === configured.name);

console.log(`${BOLD}What Meta has${OFF}`);
info(`${all.length} template(s) on this WhatsApp Business Account`);

if (matches.length === 0) {
  fail(`No template named "${configured.name}" exists. This is your 132001.`);
  const names = [...new Set(all.map((t) => t.name))].sort();
  if (names.length) {
    info(`Available names: ${names.join(', ')}`);
  }
  info('Create and submit the template in WhatsApp Manager, or set');
  info('WHATSAPP_TEMPLATE_NAME to one of the names above.');
  process.exit(1);
}

console.log('');
for (const t of matches) {
  const flag = t.status === 'APPROVED' ? GREEN : t.status === 'REJECTED' ? RED : YELLOW;
  const body = (t.components ?? []).find((c) => c.type === 'BODY');
  const params = countPlaceholders(body?.text);
  console.log(
    `  ${flag}${t.status.padEnd(9)}${OFF} language=${BOLD}${t.language}${OFF}` +
      `  body variables=${params}  category=${t.category ?? '?'}`,
  );
}
console.log('');

const approved = matches.filter((t) => t.status === 'APPROVED');
if (approved.length === 0) {
  fail(`"${configured.name}" exists but is not APPROVED in any language.`);
  info('Sending an unapproved template fails with 132001. Wait for review, or');
  info('set WHATSAPP_TEMPLATE_NAME=hello_world (language en_US) meanwhile.');
  process.exit(1);
}

// ---- language ----
const exact = approved.find((t) => t.language === configured.language);
if (exact) {
  ok(`Approved in the configured language "${configured.language}".`);
} else {
  const langs = approved.map((t) => t.language);
  const sibling = siblingLanguage(configured.language);
  fail(`Not approved as "${configured.language}" — approved as: ${langs.join(', ')}.`);
  if (sibling && langs.includes(sibling)) {
    info(`This is the classic en / en_US mix-up. Set:`);
    info(`  WHATSAPP_TEMPLATE_LANGUAGE=${sibling}`);
  } else {
    info(`Set WHATSAPP_TEMPLATE_LANGUAGE=${langs[0]}`);
  }
}

// ---- parameter alignment (the point of this script) ----
const target = exact ?? approved[0];
const body = (target.components ?? []).find((c) => c.type === 'BODY');
const expected = countPlaceholders(body?.text);
const sending = configured.hasBodyParams ? TEMPLATE_VARIABLES.length : 0;

if (expected === sending) {
  ok(`Body parameter count matches: template expects ${expected}, payload sends ${sending}.`);
} else {
  fail(`Body parameter MISMATCH — template expects ${expected}, payload sends ${sending}. This is a 132000.`);
  if (expected === 0) info('Set WHATSAPP_TEMPLATE_HAS_BODY_PARAMS=false');
  else if (sending === 0) info('Set WHATSAPP_TEMPLATE_HAS_BODY_PARAMS=true');
  else info(`Update TEMPLATE_VARIABLES in whatsapp.service.js to supply ${expected} value(s).`);
}

// ---- components we do not currently populate ----
for (const component of target.components ?? []) {
  if (component.type === 'HEADER' && countPlaceholders(component.text) > 0) {
    fail(`The HEADER declares ${countPlaceholders(component.text)} variable(s), which the payload does not send.`);
    info('Add a { type: "header", parameters: [...] } component in buildTemplatePayload().');
  }
  if (component.type === 'BUTTONS') {
    const dynamic = (component.buttons ?? []).filter(
      (b) => b.type === 'URL' && countPlaceholders(b.url) > 0,
    );
    if (dynamic.length) {
      fail(`${dynamic.length} button(s) have dynamic URLs, which the payload does not send.`);
      info('Add a { type: "button", sub_type: "url", index: "0", parameters: [...] } component.');
    }
  }
}

// ---- body copy drift ----
if (body?.text) {
  const normalise = (t) => t.replace(/\r\n/g, '\n').trim();
  if (normalise(body.text) === normalise(TEMPLATE_BODY_REFERENCE)) {
    ok('Approved body matches TEMPLATE_BODY_REFERENCE exactly.');
  } else {
    warn('Approved body differs from TEMPLATE_BODY_REFERENCE in the source.');
    info('Not an error — Meta renders its own copy — but the reference is now');
    info('misleading for anyone reading the code. Approved body:');
    console.log(`${DIM}${body.text.split('\n').map((l) => `    ${l}`).join('\n')}${OFF}`);
  }
}

console.log('');
if (failed) {
  console.log(`${RED}${BOLD}Configuration does not match Meta — sends will fail.${OFF}\n`);
  process.exit(1);
}
console.log(`${GREEN}${BOLD}Configuration matches the approved template.${OFF}\n`);
