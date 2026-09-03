# BandUltra — Trial Request API

Lead capture and WhatsApp notification service behind the **Start Free Trial**
button on the BandUltra landing page.

```
Landing page (modal form)
        │  POST /api/v1/trial-requests
        ▼
   Express API ──▶ validate ──▶ sanitize ──▶ MongoDB (trial_requests)
        │
        └──▶ 201 response to the browser
                    │
                    └──▶ (async, off the response path)
                              WhatsApp Cloud API template send
                              → retries with backoff
                              → outcome written back onto the lead
```

---

## Quick start

```bash
cd server
npm install
cp .env.example .env      # then fill in the WhatsApp credentials
npm run dev               # http://localhost:4000
```

Open `bandultra-landing (2).html` in a browser and click any **Start Free
Trial** button. The form posts to `http://localhost:4000` by default.

To point the page at a deployed API, set the base URL on the `<html>` element:

```html
<html lang="en" data-api-base="https://api.bandultra.com">
```

…or define `window.BANDULTRA_API_BASE` before the page's inline script runs.

---

## The database constraint

> **`email` is a plain, non-unique attribute on `trial_requests`. It is never a
> primary key, a foreign key, or a unique index here.**

Email is the identity key for the `superadmin` and `institute_admin`
collections **only**. This collection holds unqualified inbound leads, where the
same address legitimately appears many times — two institutes under one owner, a
typo and a correction, a re-request after a trial lapses. A unique constraint
would reject real leads at the door, and reusing the admin identity key would
silently couple an unverified public form to the auth domain.

The primary key is therefore an application-generated **UUID v4** on `_id`,
independent of every business field.

This is enforced in four places, so it cannot regress quietly:

| Where | What it does |
|---|---|
| `src/models/TrialRequest.js` | Declares `unique: false` on `email`; the only email index is the explicitly non-unique `email_lookup_idx`. |
| `assertNoUniqueEmailIndex()` | Runs at boot against the **live** collection and refuses to start if a unique email index exists. |
| `tests/schema.test.js` | Asserts no schema path but `_id` is unique, `_id` is a UUID string, and no field is a `ref`. |
| `tests/api.test.js` + `tests/integration.mongo.test.js` | Submit the same email three times and assert three distinct records. |

The error handler also maps an unexpected `E11000` on this collection to a
loud, specific log rather than a generic 500.

---

## API

### `POST /api/v1/trial-requests`

```jsonc
{
  "name": "Priya Sharma",                    // required, 2–120 chars
  "instituteName": "Bright Future IELTS",    // required, 2–160 chars — maps to {{1}}
  "address": "Sector 17, Chandigarh",        // optional, ≤400 chars
  "whatsappNumber": "+919876543210",         // required, strict E.164, mobile
  "email": "priya@brightfuture.edu",         // required, non-unique
  "source": "landing-page"                   // optional
}
```

| Status | Meaning |
|---|---|
| `201` | Lead stored; WhatsApp send queued. Returns `{ data: { id, createdAt } }`. |
| `200` | Duplicate click — same WhatsApp number inside `DUPLICATE_WINDOW_MS`. Returns the existing id. |
| `202` | Honeypot triggered. Bot sees success; nothing is stored. |
| `422` | Validation failed. Returns `errors` as a `field → message` map. |
| `400` / `413` | Malformed JSON / body over 16 kB. |
| `429` | Rate limit (`RATE_LIMIT_MAX` per IP per window). |
| `503` | Database unreachable. |

`GET /health` reports database state, whether the WhatsApp integration is
enabled, and the count of in-flight notifications.

---

## WhatsApp integration

`src/services/whatsapp.service.js` sends an approved template through the Meta
Cloud API. Which template it sends is **configuration, not code**.

### Verify before you trust it

```bash
npm run whatsapp:verify
```

Reads the actual template list from Meta and reports: whether the template
exists, **which language codes it is approved under**, its review status, how
many body variables the approved body declares, and whether any header or
button carries variables the payload does not send. It then compares that with
local config and prints the exact `.env` line to change. Exits non-zero on a
mismatch, so it can gate a deploy.

Needs `WHATSAPP_BUSINESS_ACCOUNT_ID` (WhatsApp Manager → API Setup, beside the
Phone number ID). Read-only — a single GET.

### `en` is not `en_US`

The single most common cause of error `132001` is the language code. In WhatsApp
Manager, **"English" is `en` and "English (US)" is `en_US`** — Meta treats them
as two *different* templates, and asking for the wrong one fails exactly as if
the template did not exist. `npm run whatsapp:verify` tells you which you have.

As a safety net, a `132001` triggers **one** retry with the sibling locale
(`en` ⇄ `en_US`). If that succeeds the message is delivered and the log says
precisely what to fix:

```
whatsapp.wrong_language_configured
  configured: en_US   actuallyApproved: en
  action: Set WHATSAPP_TEMPLATE_LANGUAGE=en in .env and restart.
```

That is a diagnostic, not a fix — every send pays an extra failed request until
`.env` is corrected. Disable it with `WHATSAPP_TEMPLATE_LANGUAGE_FALLBACK=false`
once the language is confirmed.

### Current configuration

```bash
WHATSAPP_TEMPLATE_NAME=free_trial_booking_confirmation
WHATSAPP_TEMPLATE_LANGUAGE=en_US        # or `en` — verify which
WHATSAPP_TEMPLATE_HAS_BODY_PARAMS=true
```

The payload binds `{{1}}` to the institute name:

```jsonc
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+919876543210",
  "type": "template",
  "template": {
    "name": "free_trial_booking_confirmation",
    "language": { "code": "en_US" },
    "components": [
      { "type": "body",
        "parameters": [ { "type": "text", "text": "Bright Future IELTS Academy" } ] }
    ]
  }
}
```

The registered body must declare exactly one variable and match
`TEMPLATE_BODY_REFERENCE`:

```
Hi {{1}},

Thank you for booking a free trial! We have received your details and are preparing your setup.

If you have any immediate questions or specific requirements for your students, you can reply directly to this message.

We look forward to working with you. Our team will reach out to you shortly with your access details.
```

A count mismatch fails with `132000`, a name/language mismatch with `132001`.
A test asserts the payload's parameter count always equals the number of `{{n}}`
placeholders in `TEMPLATE_BODY_REFERENCE`, so adding a `{{2}}` to the copy
without supplying it fails the build rather than production.

### Falling back to the sandbox template

If the branded template is ever withdrawn or unapproved, switch back with no
code change:

```bash
WHATSAPP_TEMPLATE_NAME=hello_world
WHATSAPP_TEMPLATE_LANGUAGE=en_US
WHATSAPP_TEMPLATE_HAS_BODY_PARAMS=false
```

`hello_world` is hard-coded as parameterless and pinned to `en_US`, so those two
values are enforced even if `.env` disagrees — a stale
`WHATSAPP_TEMPLATE_HAS_BODY_PARAMS=true` cannot produce a payload Meta rejects.
Note that it carries no variables, so the institute name does not reach the
recipient.

**Reliability contract.** `sendTrialConfirmation()` never throws and never
crashes the process — every failure resolves to a result object. Transient
failures (5xx, 429, timeouts, network errors) are retried up to
`WHATSAPP_MAX_ATTEMPTS` with full-jitter exponential backoff. Permanent failures
(bad token, unapproved template, recipient not on WhatsApp) are **not** retried.
Either way the outcome is written to `whatsappNotification` on the lead:

```jsonc
"whatsappNotification": {
  "status": "sent",              // pending | sent | failed | skipped
  "messageId": "wamid.HBg...",   // Meta's handle, for delivery webhooks
  "attempts": 1,
  "sentAt": "2026-09-02T…",
  "lastError": null,
  "errorCode": null
}
```

Set `WHATSAPP_ENABLED=false` to store leads without sending — useful before the
Meta Business account is approved. Sends are then recorded as `skipped` and the
rendered message is logged for inspection.

**Failed sends are recoverable.** Query and replay them:

```js
db.trial_requests.find({ 'whatsappNotification.status': 'failed' })
```

---

## Phone number validation

`whatsappNumber` is validated with **`libphonenumber-js/max`**, not the default
`/min` metadata. The default trades accuracy for bundle size and reports
unallocatable numbers as valid (`+911111111111` passes under `/min`), and it
cannot report line type — neither trade-off is worth making server-side.

The field is enforced in three steps:

1. After separators are stripped, only `+` and digits may remain — so
   `+919876543210abc` is rejected rather than silently truncated.
2. The number must be valid **for its country code**, then normalised to
   canonical E.164 (`parsed.number`) before storage.
3. A number whose type is definitively `FIXED_LINE` is rejected, because a
   landline can never receive a WhatsApp message. This is deliberately narrow:
   `FIXED_LINE_OR_MOBILE` and unknown types pass, since whole countries (the US
   among them) report the former.

Step 3 turns what would be a silent async failure — Meta error `131026`, raised
long after the user was told we had messaged them — into an immediate field
error. To drop it, remove the `FIXED_LINE` branch in
`validators/trialRequest.validator.js`; nothing else depends on it.

## Security

- **NoSQL injection** — operator-shaped payloads (`{"email":{"$ne":null}}`) and
  dotted keys are rejected before validation; non-string values coerce to `''`;
  `mongoose.set('sanitizeFilter', true)` is a second layer.

  > **`sanitizeFilter` applies to our own queries too.** It rewrites any
  > object-valued filter to `{ $eq: ... }`, so a deliberate operator must be
  > wrapped in `mongoose.trusted(...)`. Without it,
  > `{ createdAt: { $gte: date } }` becomes `{ createdAt: { $eq: { $gte: date } } }`
  > and fails with *"Cast to date failed for value `{ '$gte': ... }` (type
  > Object) at path `createdAt`"*. The duplicate-click guard in
  > `trialRequest.controller.js` is wrapped for exactly this reason — see
  > `tests/query.test.js`, which asserts both the fix and the failure it prevents.
- **Input sanitisation** — control characters, zero-width characters and
  bidirectional overrides are stripped; every field is length-capped.
- **Secrets** — read only in `src/config/env.js`; missing ones fail the boot,
  not the first lead. Never logged: the logger redacts token-like keys and masks
  PII.
- **Abuse** — per-IP rate limit, hidden honeypot field, 16 kB body cap,
  duplicate-click suppression, `helmet` headers, explicit CORS allowlist.
- **Error responses** — driver and stack detail never reach the client in
  production.

---

## Tests

```bash
npm test              # full suite
npm run test:mongo    # integration suite only; fails (not skips) without mongod
```

| Suite | Covers |
|---|---|
| `query.test.js` | Filter casting under production `sanitizeFilter`, including a regression test for the `createdAt` CastError. |
| `schema.test.js` | The email/PK constraint, at the schema level. No database needed. |
| `validator.test.js` | E.164 normalisation across countries, email rules, injection payloads, sanitisation. |
| `whatsapp.test.js` | Payload construction in both template modes, parameter/placeholder alignment, and the approved copy. |
| `whatsapp-delivery.test.js` | Real HTTP against a local stub of Meta's API: retries, backoff, non-retryable codes, timeouts, dropped connections. |
| `api.test.js` | Full Express stack with the persistence boundary stubbed. |
| `integration.mongo.test.js` | End-to-end against a real MongoDB. **Self-skips** where `fastdl.mongodb.org` is unreachable; force with `REQUIRE_MONGO=1`. |

---

## Deploying

1. Set every variable in `.env.example`. `CORS_ORIGINS` is **required** in
   production — an empty allowlist rejects all browser origins there.
2. Set `TRUST_PROXY=1` behind nginx / an ALB / Heroku, so `req.ip` and the rate
   limiter see the real client address.
3. Use a **System User permanent token**, not the 24-hour dashboard token.
4. Point your health check at `GET /health`.
5. `SIGTERM` drains in-flight WhatsApp sends (up to 15s) before exiting — give
   your orchestrator a termination grace period of at least 30s.

### Worth adding next

- A **delivery-status webhook** from Meta to move leads from `sent` to
  `delivered`/`read` (needs a public callback URL and signature verification).
- A **retry sweeper** — a cron over `whatsappNotification.status: 'failed'` for
  sends that failed while Meta was down. The index for it already exists.
- **Internal notification** (email or Slack) to the sales team on each new lead.
