import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import logger from '../utils/logger.js';

/**
 * TrialRequest — a "Start Free Trial" lead captured from the marketing site.
 *
 * ============================================================================
 * SCHEMA CONSTRAINT — READ BEFORE MODIFYING
 * ----------------------------------------------------------------------------
 * `email` on this collection is a PLAIN, NON-UNIQUE ATTRIBUTE. It must never be
 * promoted to a primary key, a foreign key, or a unique index here.
 *
 * Why: email is the identity key for the `superadmin` and `institute_admin`
 * collections only. This collection holds unqualified inbound marketing leads.
 * The same person legitimately submits twice (two institutes, a typo and a
 * correction, a re-request after the trial lapses), and a unique constraint
 * would reject a real lead at the door. Reusing the admin identity key here
 * would also silently couple an unverified public form to the auth domain.
 *
 * The primary key is therefore an application-generated UUID v4 (`_id`),
 * independent of any business field.
 *
 * The index on `email` below is a non-unique, secondary lookup index used only
 * so the sales team can search leads by address. `unique` is pinned to `false`
 * explicitly, and a guard in `assertNoUniqueEmailIndex()` fails the boot if a
 * unique index ever appears on this field in the live database.
 * ============================================================================
 */

/** Outcome of the asynchronous WhatsApp notification for this lead. */
export const NOTIFICATION_STATUS = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped', // integration disabled by configuration
});

const whatsappNotificationSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: Object.values(NOTIFICATION_STATUS),
      default: NOTIFICATION_STATUS.PENDING,
      // No index here: the compound { status, createdAt } index declared on the
      // parent schema already covers status-only queries via its prefix.
    },
    /** Meta's wamid — the handle needed to correlate delivery webhooks. */
    messageId: { type: String, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    /** Human-readable failure reason. Never contains the access token. */
    lastError: { type: String, default: null },
    errorCode: { type: String, default: null },
  },
  { _id: false },
);

const trialRequestSchema = new mongoose.Schema(
  {
    // ---- Primary key: application-generated UUID, never a business field. ----
    _id: {
      type: String,
      default: () => randomUUID(),
      immutable: true,
    },

    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: 2,
      maxlength: 120,
    },

    instituteName: {
      type: String,
      required: [true, 'Institute name is required'],
      trim: true,
      minlength: 2,
      maxlength: 160,
    },

    address: {
      type: String,
      required: false,
      trim: true,
      maxlength: 400,
      default: '',
    },

    /**
     * WhatsApp number in strict E.164 form (leading '+', country code, 8-15
     * digits total). Stored exactly as the Cloud API expects it so the
     * notification service never has to reformat at send time.
     */
    whatsappNumber: {
      type: String,
      required: [true, 'WhatsApp number is required'],
      trim: true,
      match: [/^\+[1-9]\d{7,14}$/, 'WhatsApp number must be in E.164 format, e.g. +919876543210'],
      index: true, // non-unique: used for duplicate-click detection
    },

    /** ISO 3166-1 alpha-2 country derived from the number, for routing/reporting. */
    whatsappCountry: { type: String, trim: true, uppercase: true, maxlength: 2, default: null },

    // ---- NON-UNIQUE. See the schema constraint note at the top of this file. ----
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      maxlength: 254,
      unique: false, // explicit, and asserted at boot — do not change
      index: false, // the secondary lookup index is declared below instead
    },

    whatsappNotification: {
      type: whatsappNotificationSchema,
      default: () => ({}),
    },

    source: { type: String, trim: true, maxlength: 60, default: 'landing-page' },

    /** Light request provenance for spam triage. No fingerprinting. */
    meta: {
      ip: { type: String, default: null },
      userAgent: { type: String, maxlength: 400, default: null },
      referer: { type: String, maxlength: 500, default: null },
    },
  },
  {
    timestamps: true,
    collection: 'trial_requests',
    versionKey: false,
    // Create the collection (and its indexes) on model init, so the boot-time
    // constraint check below has a namespace to inspect on a fresh database.
    autoCreate: true,
    autoIndex: true,
    // `_id` is declared explicitly above as a string UUID, so Mongoose must not
    // add its own ObjectId `_id` on top of it.
    _id: false,
    id: false,
  },
);

// Secondary, explicitly NON-UNIQUE lookup index for sales search by email.
trialRequestSchema.index({ email: 1 }, { unique: false, name: 'email_lookup_idx' });

// Dashboard queries: newest leads first.
trialRequestSchema.index({ createdAt: -1 });

// Retry sweeper: find leads whose notification still needs attention.
trialRequestSchema.index({ 'whatsappNotification.status': 1, createdAt: -1 });

const TrialRequest = mongoose.model('TrialRequest', trialRequestSchema);

/**
 * Boot-time guard for the constraint documented above.
 *
 * A unique index can be introduced out-of-band — a stray `db.collection
 * .createIndex()`, a migration copied from the admin collections, a restored
 * dump. This turns that silent, data-losing mistake into a loud startup error.
 */
export async function assertNoUniqueEmailIndex() {
  // Wait for Mongoose to finish `autoCreate`/`autoIndex` for this model.
  // Without this the check races model initialisation on a cold start and can
  // inspect a namespace that does not exist yet.
  try {
    await TrialRequest.init();
  } catch (error) {
    // Index building is not this function's job — a failure here is surfaced by
    // the first write. Do not block boot on it.
    logger.warn('trial_request.init_incomplete', { error: error.message });
  }

  let indexes;
  try {
    indexes = await TrialRequest.collection.indexes();
  } catch (error) {
    // 26 = NamespaceNotFound. On a brand-new database the collection does not
    // exist until the first write, and an absent collection cannot be carrying
    // a forbidden index — so there is nothing to assert. Previously this threw
    // and refused to start the server against an empty database.
    if (error.code === 26 || /ns does not exist/i.test(error.message ?? '')) {
      logger.info('trial_request.constraint_check_skipped', {
        reason: 'collection not created yet; it will be created from this schema',
      });
      return;
    }
    throw error;
  }

  const offending = indexes.filter(
    (index) => index.unique === true && Object.keys(index.key ?? {}).includes('email'),
  );

  if (offending.length > 0) {
    const names = offending.map((index) => index.name).join(', ');
    throw new Error(
      `Schema constraint violated: a UNIQUE index on "email" exists on trial_requests (${names}). ` +
        'Email must remain a non-unique attribute on this collection — it is an identity key only ' +
        'for the superadmin and institute admin collections. Drop the index before starting.',
    );
  }
}

export default TrialRequest;
