import env from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * WhatsApp Business Cloud API (Meta) notification service.
 *
 * Contract with the rest of the app: this module NEVER throws to its caller and
 * NEVER crashes the process. Every failure path resolves to a result object.
 * A lead is already safely persisted by the time we get here — a notification
 * failure must never be able to take the server down or lose the lead.
 *
 * ----------------------------------------------------------------------------
 * TEMPLATE SELECTION
 *
 * The template name and language come from the environment, so switching
 * between Meta's sample template and the branded one is a config change, never
 * a code change.
 *
 *   Default (today):  hello_world / en_US
 *     Meta's sample template. It exists in every WhatsApp Business account
 *     immediately, so sends work before anything is submitted for review.
 *     It declares NO body variables and its copy is fixed — the institute name
 *     does NOT appear in the message. Recipients get Meta's generic greeting.
 *
 *   Target (once approved):  the branded template below / en
 *     Set WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANGUAGE and
 *     WHATSAPP_TEMPLATE_HAS_BODY_PARAMS=true together. Its registered body must
 *     match TEMPLATE_BODY_REFERENCE exactly, whitespace included, or Meta
 *     rejects the send with 132000 (parameter mismatch) / 132001 (no such
 *     template in that language).
 * ----------------------------------------------------------------------------
 * BRANDED TEMPLATE — pending approval in WhatsApp Manager:
 *
 *   Hi {{1}},
 *
 *   Thank you for booking a free trial! We have received your details and are
 *   preparing your setup.
 *
 *   If you have any immediate questions or specific requirements for your
 *   students, you can reply directly to this message.
 *
 *   We look forward to working with you. Our team will reach out to you shortly
 *   with your access details.
 *
 * Variable mapping:  {{1}}  ->  instituteName
 * ----------------------------------------------------------------------------
 */

/** Canonical source of the {{1}} mapping for the branded template. */
export const TEMPLATE_VARIABLES = Object.freeze(['instituteName']);

/**
 * Templates known to declare no body variables.
 *
 * `hello_world` is the sample template Meta provisions with every WhatsApp
 * Business account. Sending it a body component is rejected with error 132000
 * ("number of parameters does not match"), so the component must be omitted
 * entirely rather than sent empty.
 */
const PARAMETERLESS_TEMPLATES = new Set(['hello_world']);

/**
 * Meta-provided templates and the ONE language each is published in.
 *
 * `hello_world` exists only as `en_US`. Sending it as `en` — the language the
 * branded template uses — fails with 132001 ("template does not exist in this
 * language"), which is the same error as a missing template and is easy to
 * misread as the code ignoring the new template name.
 */
const SANDBOX_TEMPLATE_LANGUAGES = new Map([['hello_world', 'en_US']]);

/**
 * Does the configured template take body variables?
 *
 * A known parameterless template always wins over the env flag, so a stale
 * `WHATSAPP_TEMPLATE_HAS_BODY_PARAMS=true` left over from the branded template
 * cannot produce an invalid payload.
 */
export function templateAcceptsBodyParams(
  templateName = env.whatsapp.templateName,
) {
  if (PARAMETERLESS_TEMPLATES.has(templateName)) return false;
  return env.whatsapp.templateHasBodyParams;
}

/**
 * The sibling locale to try when Meta says the template does not exist in the
 * configured language. "English" (`en`) and "English (US)" (`en_US`) are two
 * SEPARATE templates in WhatsApp Manager, and picking the wrong one is the most
 * common cause of 132001 — the two are trivially easy to confuse when creating
 * the template.
 */
export function siblingLanguage(code) {
  if (!code) return null;
  const base = code.split('_')[0];
  if (code === base) return `${base}_US`;   // en    -> en_US
  if (code === `${base}_US`) return base;   // en_US -> en
  return base === code ? null : base;       // en_GB -> en
}

let warnedAboutLanguageCorrection = false;

/**
 * Resolve the template actually sent, reading config fresh on every call.
 *
 * Nothing here is memoised: `env` is the single source of truth and a change to
 * it takes effect on the next send. (`.env` itself is read once by dotenv at
 * process start, so editing that file still requires a restart.)
 *
 * A partially-migrated `.env` — template name switched but language left
 * behind — is corrected rather than sent as-is, because that combination
 * produces the very 132001 the switch was meant to escape.
 */
export function resolveTemplate() {
  const name = env.whatsapp.templateName;
  const requiredLanguage = SANDBOX_TEMPLATE_LANGUAGES.get(name);
  let language = env.whatsapp.templateLanguage;

  if (requiredLanguage && language !== requiredLanguage) {
    if (!warnedAboutLanguageCorrection) {
      warnedAboutLanguageCorrection = true;
      logger.warn('whatsapp.template_language_corrected', {
        template: name,
        configured: language,
        used: requiredLanguage,
        reason: `"${name}" is published only as ${requiredLanguage}; sending it as ` +
          `"${language}" fails with Meta error 132001.`,
        action: `Set WHATSAPP_TEMPLATE_LANGUAGE=${requiredLanguage} in .env to silence this.`,
      });
    }
    language = requiredLanguage;
  }

  return { name, language, hasBodyParams: templateAcceptsBodyParams(name) };
}

/**
 * One-line summary of what will actually be sent. Logged at boot so the
 * effective template is visible without reading .env on the server.
 */
export function describeTemplateConfig() {
  const { name, language, hasBodyParams } = resolveTemplate();
  return {
    template: name,
    language,
    bodyParameters: hasBodyParams ? TEMPLATE_VARIABLES.length : 0,
    carriesInstituteName: hasBodyParams,
  };
}

/**
 * The approved body copy, kept in source purely for reference and for the
 * `npm run whatsapp:preview` style check. It is NOT sent — Meta renders the
 * registered template server-side; we only supply the variables.
 */
export const TEMPLATE_BODY_REFERENCE = [
  'Hi {{1}},',
  '',
  'Thank you for booking a free trial! We have received your details and are preparing your setup.',
  '',
  'If you have any immediate questions or specific requirements for your students, you can reply directly to this message.',
  '',
  'We look forward to working with you. Our team will reach out to you shortly with your access details.',
].join('\n');

/**
 * Meta error codes that will never succeed on retry — a bad token, an
 * unapproved template, a number that is not on WhatsApp. Retrying these just
 * burns rate limit and delays the failure being surfaced.
 */
const NON_RETRYABLE_CODES = new Set([
  100, // invalid parameter / malformed request
  131_008, // required parameter missing
  131_009, // parameter value not valid
  131_026, // recipient not a valid WhatsApp user
  132_000, // template param count mismatch
  132_001, // template does not exist in this language
  132_005, // translated template text too long
  132_007, // template format character policy violated
  132_012, // template parameter format mismatch
  133_010, // phone number not registered
  190, // access token expired / invalid
  200, // permission denied
]);

/** HTTP statuses worth another attempt: rate limit + transient server errors. */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Substitute variables into the reference body. Used for logging previews and
 * for local development when the integration is disabled.
 */
export function renderTemplatePreview(variables) {
  return variables.reduce(
    (body, value, index) => body.replaceAll(`{{${index + 1}}}`, value),
    TEMPLATE_BODY_REFERENCE,
  );
}

/**
 * Build the exact Cloud API request body.
 *
 * Exported so a unit test can assert the {{1}} -> instituteName mapping without
 * needing network access or credentials.
 */
export function buildTemplatePayload({ to, instituteName }) {
  // Read through resolveTemplate() on every call — never a value captured at
  // module load — so the payload always reflects the current configuration.
  const resolved = resolveTemplate();

  const template = {
    name: resolved.name,
    language: { code: resolved.language },
  };

  // `components` is omitted entirely for a template that declares no variables.
  // Meta rejects both a populated body component AND an empty one on such a
  // template (error 132000), so the key must be absent, not set to [].
  if (resolved.hasBodyParams) {
    template.components = [
      {
        type: 'body',
        parameters: [
          // {{1}} — Institute Name.
          { type: 'text', text: instituteName },
        ],
      },
    ];
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    // E.164 without the '+' is also accepted; we send the canonical form.
    to,
    type: 'template',
    template,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Full jitter exponential backoff — avoids retry storms when Meta rate-limits. */
function backoffDelay(attempt) {
  const ceiling = Math.min(env.whatsapp.retryBaseDelayMs * 2 ** (attempt - 1), 30_000);
  return Math.round(Math.random() * ceiling);
}

/** One HTTP attempt. Resolves to a normalised outcome; never throws. */
async function attemptSend(payload, attempt) {
  const url = `https://graph.facebook.com/${env.whatsapp.graphApiVersion}/${env.whatsapp.phoneNumberId}/messages`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.whatsapp.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const rawBody = await response.text();
    let parsed = null;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      parsed = null; // Meta returned HTML (gateway error page) — treat as opaque.
    }

    if (response.ok) {
      return {
        ok: true,
        messageId: parsed?.messages?.[0]?.id ?? null,
        attempt,
      };
    }

    const metaError = parsed?.error ?? {};
    const code = metaError.code ?? null;
    const retryable = isRetryableStatus(response.status) && !NON_RETRYABLE_CODES.has(code);

    return {
      ok: false,
      retryable,
      attempt,
      status: response.status,
      errorCode: code === null ? String(response.status) : String(code),
      // Meta's messages are safe to store: they describe the request, not the token.
      message:
        metaError.error_user_msg ||
        metaError.message ||
        `WhatsApp API responded ${response.status}`,
    };
  } catch (error) {
    // Network failure, DNS, TLS, or our own abort timeout. All worth retrying.
    const aborted = error.name === 'AbortError';
    return {
      ok: false,
      retryable: true,
      attempt,
      status: null,
      errorCode: aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: aborted
        ? `Request timed out after ${env.whatsapp.timeoutMs}ms`
        : `Network error: ${error.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send the free-trial confirmation template.
 *
 * @param {object} lead
 * @param {string} lead.id             TrialRequest UUID, for log correlation.
 * @param {string} lead.whatsappNumber Recipient in E.164.
 * @param {string} lead.instituteName  Mapped to template variable {{1}}.
 * @returns {Promise<{status:'sent'|'failed'|'skipped', messageId?:string|null,
 *                    attempts:number, error?:string, errorCode?:string}>}
 *          Always resolves. Never rejects.
 */
let warnedAboutPlaceholderTemplate = false;

/**
 * Warn once per process when the configured template drops the institute name.
 * Operationally important: leads still arrive, but the recipient sees Meta's
 * generic sample copy rather than the branded confirmation.
 */
function warnIfPlaceholderTemplate() {
  if (warnedAboutPlaceholderTemplate || templateAcceptsBodyParams()) return;
  warnedAboutPlaceholderTemplate = true;
  logger.warn('whatsapp.placeholder_template_in_use', {
    template: env.whatsapp.templateName,
    language: env.whatsapp.templateLanguage,
    impact:
      'This template declares no variables, so the institute name is NOT included ' +
      'in the message and recipients see fixed sample copy.',
    action:
      'Submit the branded template for approval, then set WHATSAPP_TEMPLATE_NAME, ' +
      'WHATSAPP_TEMPLATE_LANGUAGE and WHATSAPP_TEMPLATE_HAS_BODY_PARAMS=true.',
  });
}

export async function sendTrialConfirmation({ id, whatsappNumber, instituteName }) {
  warnIfPlaceholderTemplate();

  if (!env.whatsapp.enabled) {
    logger.info('whatsapp.skipped', {
      trialRequestId: id,
      reason: 'WHATSAPP_ENABLED is false',
      template: env.whatsapp.templateName,
      // Only meaningful for a template that actually interpolates variables.
      preview: templateAcceptsBodyParams()
        ? renderTemplatePreview([instituteName])
        : `(fixed copy — "${env.whatsapp.templateName}" takes no variables)`,
    });
    return { status: 'skipped', attempts: 0, messageId: null };
  }

  const payload = buildTemplatePayload({ to: whatsappNumber, instituteName });
  let last = null;
  let languageFallbackTried = false;

  for (let attempt = 1; attempt <= env.whatsapp.maxAttempts; attempt += 1) {
    last = await attemptSend(payload, attempt);

    if (last.ok) {
      logger.info('whatsapp.sent', {
        trialRequestId: id,
        messageId: last.messageId,
        attempts: attempt,
        whatsappNumber,
        template: payload.template.name,
        language: payload.template.language.code,
      });
      return { status: 'sent', messageId: last.messageId, attempts: attempt };
    }

    // 132001 = "template does not exist in this language". Before giving up,
    // try the sibling locale ONCE. If that works, the configured language is
    // simply the wrong one of the en / en_US pair, and the log below says
    // exactly what to put in .env.
    if (
      String(last.errorCode) === '132001' &&
      env.whatsapp.languageFallback &&
      !languageFallbackTried
    ) {
      const alternative = siblingLanguage(payload.template.language.code);
      if (alternative) {
        languageFallbackTried = true;
        const attempted = payload.template.language.code;
        logger.warn('whatsapp.language_fallback_attempt', {
          trialRequestId: id,
          template: payload.template.name,
          configured: attempted,
          trying: alternative,
          reason: 'Meta returned 132001 for the configured language.',
        });

        payload.template.language.code = alternative;
        const retry = await attemptSend(payload, attempt);

        if (retry.ok) {
          logger.error('whatsapp.wrong_language_configured', {
            trialRequestId: id,
            template: payload.template.name,
            configured: attempted,
            actuallyApproved: alternative,
            action: `Set WHATSAPP_TEMPLATE_LANGUAGE=${alternative} in .env and restart. ` +
              'Until then every send pays an extra failed request.',
          });
          return { status: 'sent', messageId: retry.messageId, attempts: attempt + 1 };
        }

        // Neither locale exists: the template itself is missing or unapproved.
        payload.template.language.code = attempted;
        logger.error('whatsapp.template_not_found_in_any_locale', {
          trialRequestId: id,
          template: payload.template.name,
          tried: [attempted, alternative],
          hint: 'Run `npm run whatsapp:verify` to list what is actually approved.',
        });
        last = retry;
      }
    }

    const willRetry = last.retryable && attempt < env.whatsapp.maxAttempts;

    logger.warn('whatsapp.attempt_failed', {
      trialRequestId: id,
      attempt,
      maxAttempts: env.whatsapp.maxAttempts,
      status: last.status,
      errorCode: last.errorCode,
      error: last.message,
      willRetry,
    });

    if (!willRetry) break;
    await sleep(backoffDelay(attempt));
  }

  // Terminal failure. Logged at error level so it pages/alerts, but returned
  // as a value — the caller records it on the lead and carries on.
  logger.error('whatsapp.send_failed', {
    trialRequestId: id,
    attempts: last?.attempt ?? 0,
    errorCode: last?.errorCode ?? 'UNKNOWN',
    error: last?.message ?? 'Unknown error',
    whatsappNumber,
    hint: 'Lead is saved. Follow up manually or replay via the retry sweeper.',
  });

  return {
    status: 'failed',
    attempts: last?.attempt ?? 0,
    messageId: null,
    error: last?.message ?? 'Unknown error',
    errorCode: last?.errorCode ?? 'UNKNOWN',
  };
}

export default { sendTrialConfirmation, buildTemplatePayload, renderTemplatePreview };
