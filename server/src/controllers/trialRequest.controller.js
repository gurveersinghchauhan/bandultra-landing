import mongoose from 'mongoose';
import env from '../config/env.js';
import TrialRequest from '../models/TrialRequest.js';
import { validateTrialRequest } from '../validators/trialRequest.validator.js';
import { dispatchTrialConfirmation } from '../services/notificationDispatcher.js';
import { toSafeString } from '../utils/sanitize.js';
import logger from '../utils/logger.js';

/**
 * POST /api/v1/trial-requests
 *
 * Captures a Start Free Trial lead, then triggers the WhatsApp confirmation
 * asynchronously so the response is not blocked on Meta's API.
 */
export async function createTrialRequest(req, res, next) {
  try {
    const body = req.body ?? {};

    // ---- Honeypot -----------------------------------------------------
    // A hidden field no human ever fills. Bots complete it. We answer 202 so
    // the scraper sees success and does not adapt, but store nothing.
    if (toSafeString(body.website, 100)) {
      logger.warn('trial_request.honeypot_triggered', { ip: req.ip });
      return res.status(202).json({
        success: true,
        message: 'Thanks! Your free trial request has been received.',
      });
    }

    // ---- Validation ---------------------------------------------------
    const { valid, errors, data } = validateTrialRequest(body);
    if (!valid) {
      return res.status(422).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Please correct the highlighted fields and try again.',
        errors,
      });
    }

    // ---- Duplicate-click guard ----------------------------------------
    // Not a uniqueness constraint — a short window that stops a double-tap or
    // an impatient re-submit from creating two leads and two WhatsApp messages.
    // Keyed on the WhatsApp number, never on email.
    //
    // `mongoose.trusted()` is REQUIRED here and must not be removed.
    // config/db.js sets `sanitizeFilter: true` globally to neutralise injected
    // query operators from user input. That setting wraps ANY object-valued
    // filter — including our own `{ $gte: <Date> }` — in `$eq`, producing
    // `{ createdAt: { $eq: { $gte: <Date> } } }`, which then fails to cast with:
    //   CastError: Cast to date failed for value "{ '$gte': ... }" (type Object)
    //              at path "createdAt" for model "TrialRequest"
    // `trusted()` marks this operator object as ours, not user input, so
    // sanitizeFilter leaves it alone while still guarding every other filter.
    // `since` is a Date instance; sanitizeFilter, not the value, was the cause.
    const since = new Date(Date.now() - env.DUPLICATE_WINDOW_MS);
    const recent = await TrialRequest.findOne({
      whatsappNumber: data.whatsappNumber,
      createdAt: mongoose.trusted({ $gte: since }),
    })
      .select('_id')
      .lean();

    if (recent) {
      logger.info('trial_request.duplicate_suppressed', {
        trialRequestId: recent._id,
        whatsappNumber: data.whatsappNumber,
      });
      return res.status(200).json({
        success: true,
        data: { id: recent._id, duplicate: true },
        message: 'We already have your request — our team will be in touch shortly.',
      });
    }

    // ---- Persist ------------------------------------------------------
    const trialRequest = await TrialRequest.create({
      ...data,
      meta: {
        ip: req.ip ?? null,
        userAgent: toSafeString(req.get('user-agent'), 400) || null,
        referer: toSafeString(req.get('referer'), 500) || null,
      },
    });

    logger.info('trial_request.created', {
      trialRequestId: trialRequest._id,
      instituteName: trialRequest.instituteName,
      whatsappCountry: trialRequest.whatsappCountry,
    });

    // ---- Respond first, notify after ----------------------------------
    // The lead is durable at this point. Everything below is best-effort.
    res.status(201).json({
      success: true,
      data: { id: trialRequest._id, createdAt: trialRequest.createdAt },
      message:
        'Thanks! Your free trial request has been received — we have sent a confirmation to your WhatsApp.',
    });

    // Queued after the response is flushed so it can never add latency to it.
    dispatchTrialConfirmation({
      id: trialRequest._id,
      whatsappNumber: trialRequest.whatsappNumber,
      instituteName: trialRequest.instituteName,
    });
  } catch (error) {
    // Normally only reachable before the response is sent (validation/DB
    // failures). But the dispatch call below the response is inside this try,
    // so guard against a double-send: calling next() after res.json() would
    // trigger "Cannot set headers after they are sent" and mask the real error.
    if (res.headersSent) {
      logger.error('trial_request.post_response_error', {
        error: error.message,
        stack: error.stack,
      });
      return;
    }
    next(error);
  }
}

export default { createTrialRequest };
