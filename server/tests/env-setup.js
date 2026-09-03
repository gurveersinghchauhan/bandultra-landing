/**
 * Test environment bootstrap.
 *
 * MUST be the first import in every test file. ESM evaluates imports
 * depth-first in source order, so importing this ahead of anything under
 * src/ guarantees these variables are set before config/env.js reads them.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// Exercise the real send path only against an explicit opt-in. Left off, the
// service records "skipped" and no network call is made.
process.env.WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED ?? 'false';
// Mirror the shipped defaults in .env.example: the branded template with one
// body variable ({{1}} = institute name).
process.env.WHATSAPP_TEMPLATE_NAME ??= 'free_trial_booking_confirmation';
process.env.WHATSAPP_TEMPLATE_LANGUAGE ??= 'en_US';
process.env.WHATSAPP_TEMPLATE_HAS_BODY_PARAMS ??= 'true';
process.env.WHATSAPP_PHONE_NUMBER_ID ??= 'test-phone-number-id';
process.env.WHATSAPP_ACCESS_TOKEN ??= 'test-access-token';

// mongodb-memory-server supplies the real URI at runtime; this just satisfies
// the boot-time config check.
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/bandultra_test';
