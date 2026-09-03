/**
 * Centralised, validated environment configuration.
 *
 * Every secret in this service is read here and nowhere else. Nothing else in
 * the codebase touches `process.env` directly, so there is exactly one place to
 * audit when rotating credentials.
 *
 * Config errors are fatal at boot (fail fast, loudly) rather than at the moment
 * a lead comes in — we would rather the deploy fail than silently drop leads.
 */
import 'dotenv/config';

const errors = [];

/** Read a required string, recording an error instead of throwing immediately. */
function required(key, { when = true } = {}) {
  const value = process.env[key];
  if (!when) return value ?? '';
  if (!value || !value.trim()) {
    errors.push(`Missing required environment variable: ${key}`);
    return '';
  }
  return value.trim();
}

function optional(key, fallback = '') {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : String(value).trim();
}

function integer(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    errors.push(`Environment variable ${key} must be an integer, received "${raw}"`);
    return fallback;
  }
  return parsed;
}

function boolean(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** Comma-separated list -> trimmed array, empties removed. */
function list(key, fallback = []) {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

const NODE_ENV = optional('NODE_ENV', 'development');
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

// The WhatsApp integration is intentionally optional so the lead-capture flow
// can be developed and deployed before the Meta Business account is approved.
// When disabled, leads are still stored and the send is recorded as "skipped".
const whatsappEnabled = boolean('WHATSAPP_ENABLED', !isTest);

const env = {
  NODE_ENV,
  isProduction,
  isTest,
  PORT: integer('PORT', 4000),
  TRUST_PROXY: optional('TRUST_PROXY', isProduction ? '1' : ''),

  // Origins allowed to POST the form. Empty in development = reflect any origin.
  CORS_ORIGINS: list('CORS_ORIGINS'),

  MONGODB_URI: isTest
    ? optional('MONGODB_URI', 'mongodb://127.0.0.1:27017/bandultra_test')
    : required('MONGODB_URI'),
  MONGODB_DB_NAME: optional('MONGODB_DB_NAME', ''),

  RATE_LIMIT_WINDOW_MS: integer('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  RATE_LIMIT_MAX: integer('RATE_LIMIT_MAX', 10),

  // Window in which a repeat submission from the same WhatsApp number is
  // treated as a duplicate click rather than a new lead.
  DUPLICATE_WINDOW_MS: integer('DUPLICATE_WINDOW_MS', 10 * 60 * 1000),

  LOG_LEVEL: optional('LOG_LEVEL', isTest ? 'silent' : 'info'),

  whatsapp: {
    enabled: whatsappEnabled,
    graphApiVersion: optional('WHATSAPP_GRAPH_API_VERSION', 'v22.0'),
    phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID', { when: whatsappEnabled }),
    // Optional: only `npm run whatsapp:verify` needs it (to list templates).
    businessAccountId: optional('WHATSAPP_BUSINESS_ACCOUNT_ID', ''),
    accessToken: required('WHATSAPP_ACCESS_TOKEN', { when: whatsappEnabled }),
    // The branded template. `hello_world` remains fully supported as a
    // fallback — set WHATSAPP_TEMPLATE_NAME=hello_world (language en_US) to
    // drop back to Meta's sample template without a code change.
    templateName: optional('WHATSAPP_TEMPLATE_NAME', 'free_trial_booking_confirmation'),
    // MUST match the language the template was APPROVED under in WhatsApp
    // Manager. "English" is `en`; "English (US)" is `en_US` — they are two
    // different templates to Meta, and the wrong one fails with 132001.
    // Run `npm run whatsapp:verify` to read the approved value from Meta.
    templateLanguage: optional('WHATSAPP_TEMPLATE_LANGUAGE', 'en_US'),
    // Whether the template declares body variables. The branded template
    // declares one ({{1}} = institute name), so this defaults to true.
    // Sending parameters to a template that takes none is rejected with error
    // 132000; known parameterless templates (hello_world) are detected
    // automatically and always override this flag.
    templateHasBodyParams: boolean('WHATSAPP_TEMPLATE_HAS_BODY_PARAMS', true),
    // On Meta error 132001 ("no such template in this language"), try the
    // sibling locale once — en <-> en_US — and log which one worked. Guards
    // the single most common cause of a silently undelivered confirmation.
    languageFallback: boolean('WHATSAPP_TEMPLATE_LANGUAGE_FALLBACK', true),
    timeoutMs: integer('WHATSAPP_TIMEOUT_MS', 10_000),
    maxAttempts: integer('WHATSAPP_MAX_ATTEMPTS', 4),
    retryBaseDelayMs: integer('WHATSAPP_RETRY_BASE_DELAY_MS', 1_000),
  },
};

if (errors.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `\n[config] Refusing to start — invalid environment:\n${errors.map((e) => `  · ${e}`).join('\n')}\n\n` +
      'See .env.example for the full list of required variables.\n',
  );
  process.exit(1);
}

export default env;
