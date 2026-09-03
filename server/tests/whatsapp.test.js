import './env-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import env from '../src/config/env.js';
import {
  buildTemplatePayload,
  describeTemplateConfig,
  renderTemplatePreview,
  resolveTemplate,
  siblingLanguage,
  templateAcceptsBodyParams,
  TEMPLATE_BODY_REFERENCE,
  TEMPLATE_VARIABLES,
} from '../src/services/whatsapp.service.js';

/**
 * Payload construction for both template modes.
 *
 * The service reads the template name/language from config at call time, so a
 * test can switch modes by mutating `env.whatsapp` — no module reloading.
 */

const original = { ...env.whatsapp };
const useTemplate = (name, language, hasParams) => {
  env.whatsapp.templateName = name;
  env.whatsapp.templateLanguage = language;
  env.whatsapp.templateHasBodyParams = hasParams;
};
const restore = () => Object.assign(env.whatsapp, original);

const lead = { to: '+919876543210', instituteName: 'Bright Future IELTS Academy' };

/* ------------------------------------------------- hello_world (default) -- */

test('hello_world: sends name and language, and NO components at all', () => {
  useTemplate('hello_world', 'en_US', false);
  const payload = buildTemplatePayload(lead);

  assert.equal(payload.messaging_product, 'whatsapp');
  assert.equal(payload.type, 'template');
  assert.equal(payload.to, '+919876543210');
  assert.equal(payload.template.name, 'hello_world');
  assert.deepEqual(payload.template.language, { code: 'en_US' });

  // Meta rejects a populated body AND an empty one on a template that declares
  // no variables (error 132000). The key must be absent, not [].
  assert.ok(
    !('components' in payload.template),
    'the components key must be omitted entirely, not set to an empty array',
  );
  assert.equal(JSON.stringify(payload).includes('components'), false);
  restore();
});

test('hello_world: the institute name is not sent anywhere in the payload', () => {
  useTemplate('hello_world', 'en_US', false);
  const payload = buildTemplatePayload(lead);
  assert.ok(
    !JSON.stringify(payload).includes('Bright Future'),
    'a parameterless template cannot carry the institute name',
  );
  restore();
});

test('hello_world is treated as parameterless even if the env flag says otherwise', () => {
  // Guards against a stale WHATSAPP_TEMPLATE_HAS_BODY_PARAMS=true left behind
  // after switching back from the branded template — that combination would
  // otherwise build a payload Meta rejects with 132000.
  useTemplate('hello_world', 'en_US', true);
  assert.equal(templateAcceptsBodyParams(), false);
  assert.ok(!('components' in buildTemplatePayload(lead).template));
  restore();
});

/* ------------------------------------------------------ branded template -- */

test('branded template: {{1}} is bound to the institute name', () => {
  useTemplate('free_trial_booking_confirmation', 'en', true);
  const payload = buildTemplatePayload(lead);

  assert.equal(payload.template.name, 'free_trial_booking_confirmation');
  assert.deepEqual(payload.template.language, { code: 'en' });

  const body = payload.template.components.find((c) => c.type === 'body');
  assert.ok(body, 'payload must contain a body component');
  assert.equal(body.parameters.length, 1, 'the template declares exactly one variable');
  assert.deepEqual(body.parameters[0], {
    type: 'text',
    text: 'Bright Future IELTS Academy',
  });
  restore();
});

test('a custom template can be declared parameterless via the env flag', () => {
  useTemplate('some_other_static_template', 'en', false);
  assert.equal(templateAcceptsBodyParams(), false);
  assert.ok(!('components' in buildTemplatePayload(lead).template));
  restore();
});

/* --------------------------------------------------- branded copy fidelity */

test('{{1}} is documented as mapping to instituteName', () => {
  assert.deepEqual(TEMPLATE_VARIABLES, ['instituteName']);
});

test('branded template body still matches the approved copy exactly', () => {
  const expected =
    'Hi {{1}},\n\n' +
    'Thank you for booking a free trial! We have received your details and are preparing your setup.\n\n' +
    'If you have any immediate questions or specific requirements for your students, you can reply directly to this message.\n\n' +
    'We look forward to working with you. Our team will reach out to you shortly with your access details.';
  assert.equal(TEMPLATE_BODY_REFERENCE, expected);
});

test('the branded template declares exactly one placeholder', () => {
  const placeholders = TEMPLATE_BODY_REFERENCE.match(/\{\{\d+\}\}/g) ?? [];
  assert.deepEqual(placeholders, ['{{1}}']);
});

test('preview substitutes the institute name into the greeting', () => {
  const preview = renderTemplatePreview(['Bright Future IELTS Academy']);
  assert.ok(preview.startsWith('Hi Bright Future IELTS Academy,'));
  assert.ok(!preview.includes('{{1}}'), 'no placeholder should survive substitution');
});

/* ------------------------------------------------------------ defaults ---- */

/* ------------------------------------ config freshness + 132001 guards ---- */

test('REGRESSION: hello_world is forced to en_US even if .env still says en', () => {
  // The exact half-migrated state that caused 132001: template name switched to
  // the sandbox template, language left behind on the branded template's value.
  useTemplate('hello_world', 'en', false);

  const resolved = resolveTemplate();
  assert.equal(resolved.language, 'en_US', 'hello_world is published only as en_US');

  const payload = buildTemplatePayload(lead);
  assert.deepEqual(payload.template.language, { code: 'en_US' });
  assert.equal(payload.template.name, 'hello_world');
  restore();
});

test('a non-sandbox template keeps whatever language is configured', () => {
  useTemplate('free_trial_booking_confirmation', 'en', true);
  assert.equal(resolveTemplate().language, 'en', 'only sandbox templates are corrected');
  restore();
});

test('the payload builder reads config fresh, never a value cached at import', () => {
  useTemplate('hello_world', 'en_US', false);
  assert.equal(buildTemplatePayload(lead).template.name, 'hello_world');

  // Change config mid-process; the very next build must reflect it.
  useTemplate('free_trial_booking_confirmation', 'en', true);
  const after = buildTemplatePayload(lead);
  assert.equal(after.template.name, 'free_trial_booking_confirmation');
  assert.deepEqual(after.template.language, { code: 'en' });
  assert.ok(after.template.components, 'components appear once params are enabled');

  // And back again, to prove nothing is memoised in either direction.
  useTemplate('hello_world', 'en_US', false);
  const back = buildTemplatePayload(lead);
  assert.equal(back.template.name, 'hello_world');
  assert.ok(!('components' in back.template));
  restore();
});

test('describeTemplateConfig reports what will actually be sent', () => {
  useTemplate('hello_world', 'en', false);
  assert.deepEqual(describeTemplateConfig(), {
    template: 'hello_world',
    language: 'en_US',        // corrected, not the configured 'en'
    bodyParameters: 0,
    carriesInstituteName: false,
  });

  useTemplate('free_trial_booking_confirmation', 'en', true);
  assert.deepEqual(describeTemplateConfig(), {
    template: 'free_trial_booking_confirmation',
    language: 'en',
    bodyParameters: 1,
    carriesInstituteName: true,
  });
  restore();
});

test('the shipped defaults are the branded template with one body variable', () => {
  // env-setup.js pins these to match .env.example, so a change to the default
  // template shows up here rather than as a surprise 132001 in production.
  assert.equal(original.templateName, 'free_trial_booking_confirmation');
  assert.equal(original.templateLanguage, 'en_US');
  assert.equal(original.templateHasBodyParams, true);
});

test('the default config sends exactly one body parameter, the institute name', () => {
  // The end state the switch is for: parameter binding under shipped defaults.
  const payload = buildTemplatePayload(lead);
  assert.equal(payload.template.name, 'free_trial_booking_confirmation');
  assert.deepEqual(payload.template.language, { code: 'en_US' });

  const components = payload.template.components;
  assert.equal(components.length, 1, 'only a body component — no header, no buttons');
  assert.equal(components[0].type, 'body');
  assert.deepEqual(components[0].parameters, [
    { type: 'text', text: 'Bright Future IELTS Academy' },
  ]);
});

test('the parameter count matches the placeholders in the reference body', () => {
  // Guards the 132000 class: if someone edits TEMPLATE_BODY_REFERENCE to add a
  // {{2}}, this fails until the payload supplies it too.
  const placeholders = new Set(TEMPLATE_BODY_REFERENCE.match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;
  const sent = buildTemplatePayload(lead).template.components[0].parameters.length;
  assert.equal(
    sent,
    placeholders,
    `body declares ${placeholders} placeholder(s) but the payload sends ${sent}`,
  );
  assert.equal(sent, TEMPLATE_VARIABLES.length);
});

test('every parameter is a plain text object with a non-empty string', () => {
  // Meta rejects null/undefined/non-string parameter values (131009 / 132012).
  for (const param of buildTemplatePayload(lead).template.components[0].parameters) {
    assert.equal(param.type, 'text');
    assert.equal(typeof param.text, 'string');
    assert.ok(param.text.length > 0);
    assert.deepEqual(Object.keys(param).sort(), ['text', 'type']);
  }
});

/* --------------------------------------------- en / en_US sibling locale -- */

test('siblingLanguage maps the en <-> en_US pair both ways', () => {
  assert.equal(siblingLanguage('en'), 'en_US');
  assert.equal(siblingLanguage('en_US'), 'en');
  assert.equal(siblingLanguage('en_GB'), 'en');
  assert.equal(siblingLanguage(''), null);
});

test('hello_world remains available as a fallback template', () => {
  // Switching back must still work without touching code.
  useTemplate('hello_world', 'en_US', false);
  const payload = buildTemplatePayload(lead);
  assert.equal(payload.template.name, 'hello_world');
  assert.ok(!('components' in payload.template));
  restore();
});
