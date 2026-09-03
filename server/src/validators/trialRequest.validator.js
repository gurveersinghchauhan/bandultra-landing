// `/max` metadata, not the default `/min`. The default trades accuracy for
// bundle size and accepts unallocatable numbers (e.g. +911111111111 parses as a
// valid Indian number under `/min`). It also cannot report line type. Neither
// trade-off is worth making server-side for the one field that must be
// deliverable by WhatsApp.
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { toSafeString, toSafeMultiline, hasSuspiciousKeys } from '../utils/sanitize.js';

/**
 * Validation + normalisation for the Start Free Trial payload.
 *
 * Pure and synchronous by design: no I/O, so it is cheap to unit test and can
 * run before we touch the database.
 *
 * Returns `{ valid, errors, data }`. `errors` is a field -> message map so the
 * frontend can attach each message to the right input.
 */

const LIMITS = Object.freeze({
  name: 120,
  instituteName: 160,
  address: 400,
  email: 254,
  whatsappNumber: 24,
  source: 60,
});

/**
 * Pragmatic RFC 5322 subset. Deliberately stricter than the spec: it rejects
 * quoted local parts and IP-literal domains, which are valid but are never a
 * real institute's contact address and are a reliable spam signal.
 */
const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** Letters (any script), spaces, and the punctuation that appears in real names. */
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .'’\-&(),/]*$/u;

export function validateTrialRequest(body) {
  const errors = {};

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: { _: 'Request body must be a JSON object.' }, data: null };
  }

  // Reject operator-shaped payloads outright rather than trying to clean them.
  if (hasSuspiciousKeys(body)) {
    return { valid: false, errors: { _: 'Request body contains disallowed keys.' }, data: null };
  }

  // ---------------------------------------------------------------- name ----
  const name = toSafeString(body.name, LIMITS.name);
  if (!name) {
    errors.name = 'Please enter your name.';
  } else if (name.length < 2) {
    errors.name = 'Name must be at least 2 characters.';
  } else if (!NAME_PATTERN.test(name)) {
    errors.name = 'Name contains characters we cannot accept.';
  }

  // ------------------------------------------------------- instituteName ----
  const instituteName = toSafeString(body.instituteName, LIMITS.instituteName);
  if (!instituteName) {
    errors.instituteName = 'Please enter your institute name.';
  } else if (instituteName.length < 2) {
    errors.instituteName = 'Institute name must be at least 2 characters.';
  } else if (!NAME_PATTERN.test(instituteName)) {
    errors.instituteName = 'Institute name contains characters we cannot accept.';
  }

  // ------------------------------------------------------------- address ----
  // Optional. Present-but-invalid is still an error; absent is fine.
  const address = toSafeMultiline(body.address, LIMITS.address);
  if (address && address.length < 4) {
    errors.address = 'Address looks too short — leave it blank if you would rather skip it.';
  }

  // ------------------------------------------------------------- email ----
  const email = toSafeString(body.email, LIMITS.email).toLowerCase();
  if (!email) {
    errors.email = 'Please enter your email address.';
  } else if (email.length > LIMITS.email || !EMAIL_PATTERN.test(email)) {
    errors.email = 'Please enter a valid email address.';
  }

  // ------------------------------------------------------ whatsappNumber ----
  // Strict E.164: the Cloud API rejects anything else, so we normalise here
  // rather than letting a malformed number fail asynchronously after we have
  // already told the user their request went through.
  const rawNumber = toSafeString(body.whatsappNumber, LIMITS.whatsappNumber).replace(/[\s()\-.]/g, '');
  let whatsappNumber = '';
  let whatsappCountry = null;

  if (!rawNumber) {
    errors.whatsappNumber = 'Please enter your WhatsApp number.';
  } else if (!rawNumber.startsWith('+')) {
    errors.whatsappNumber = 'Include your country code, starting with + (for example +91).';
  } else if (!/^\+\d+$/.test(rawNumber)) {
    // Strict: after separators are stripped, only '+' and digits may remain.
    // libphonenumber parses leniently and would silently truncate trailing
    // junk ("+919876543210abc" -> "+919876543210"), which hides a typo in the
    // one field we must get exactly right for the Cloud API.
    errors.whatsappNumber = 'Use only digits and a leading + — no letters or other characters.';
  } else {
    const parsed = parsePhoneNumberFromString(rawNumber);
    if (!parsed || !parsed.isValid()) {
      errors.whatsappNumber = 'That does not look like a valid number for the country code given.';
    } else {
      whatsappNumber = parsed.number; // canonical E.164, e.g. +919876543210
      whatsappCountry = parsed.country ?? null;

      if (!/^\+[1-9]\d{7,14}$/.test(whatsappNumber)) {
        errors.whatsappNumber = 'Please enter a valid WhatsApp number with country code.';
      } else if (parsed.getType() === 'FIXED_LINE') {
        // A landline can never receive a WhatsApp message. Catching it here
        // turns a silent async failure (Meta error 131026, raised long after we
        // told the user we had messaged them) into an immediate, fixable
        // field error. Deliberately narrow: only a DEFINITIVE fixed line is
        // rejected — FIXED_LINE_OR_MOBILE and unknown types are allowed
        // through, since whole countries (e.g. the US) report the former.
        errors.whatsappNumber =
          'That looks like a landline. Please enter a mobile number that can receive WhatsApp.';
      }
    }
  }

  // ------------------------------------------------------------- source ----
  const source = toSafeString(body.source, LIMITS.source) || 'landing-page';

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors, data: null };
  }

  return {
    valid: true,
    errors: {},
    data: { name, instituteName, address, email, whatsappNumber, whatsappCountry, source },
  };
}

export { LIMITS, EMAIL_PATTERN };
