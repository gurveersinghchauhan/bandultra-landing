import TrialRequest, { NOTIFICATION_STATUS } from '../models/TrialRequest.js';
import { sendTrialConfirmation } from './whatsapp.service.js';
import logger from '../utils/logger.js';

/**
 * Fire-and-forget dispatcher for the WhatsApp confirmation.
 *
 * The API responds to the browser as soon as the lead is durably stored; the
 * send then runs off the response path so a slow or down Meta endpoint never
 * shows up as a slow form for the user.
 *
 * In-flight sends are tracked so a deploy can drain them instead of killing
 * them mid-retry (see `drain()`, called from the shutdown handler).
 */

const inFlight = new Set();

/**
 * Persist the outcome. Wrapped in its own try/catch: if the database write
 * fails we have still sent the message, and losing the status field is not a
 * reason to take the process down.
 */
async function recordOutcome(trialRequestId, result) {
  const now = new Date();
  try {
    await TrialRequest.updateOne(
      { _id: trialRequestId },
      {
        $set: {
          'whatsappNotification.status':
            result.status === 'sent'
              ? NOTIFICATION_STATUS.SENT
              : result.status === 'skipped'
                ? NOTIFICATION_STATUS.SKIPPED
                : NOTIFICATION_STATUS.FAILED,
          'whatsappNotification.messageId': result.messageId ?? null,
          'whatsappNotification.attempts': result.attempts ?? 0,
          'whatsappNotification.lastAttemptAt': now,
          'whatsappNotification.sentAt': result.status === 'sent' ? now : null,
          'whatsappNotification.lastError': result.error ?? null,
          'whatsappNotification.errorCode': result.errorCode ?? null,
        },
      },
    );
  } catch (error) {
    logger.error('notification.status_persist_failed', {
      trialRequestId,
      error: error.message,
    });
  }
}

/**
 * Queue the confirmation for a saved lead. Returns immediately.
 *
 * @param {{id:string, whatsappNumber:string, instituteName:string}} lead
 * @returns {Promise<void>} the tracked task — awaited only by tests and `drain()`.
 */
export function dispatchTrialConfirmation(lead) {
  const task = (async () => {
    try {
      const result = await sendTrialConfirmation(lead);
      await recordOutcome(lead.id, result);
    } catch (error) {
      // sendTrialConfirmation is contractually non-throwing, so reaching here
      // means a genuine bug. Log it loudly, but keep the process alive.
      logger.error('notification.dispatch_unexpected_error', {
        trialRequestId: lead.id,
        error: error.message,
        stack: error.stack,
      });
      await recordOutcome(lead.id, {
        status: 'failed',
        attempts: 0,
        error: `Dispatcher error: ${error.message}`,
        errorCode: 'DISPATCHER_ERROR',
      });
    } finally {
      inFlight.delete(task);
    }
  })();

  inFlight.add(task);

  // Belt and braces: an unhandled rejection here would terminate Node under
  // --unhandled-rejections=throw (the default since Node 15).
  task.catch(() => {});

  return task;
}

/** Wait for outstanding sends during graceful shutdown. */
export async function drain(timeoutMs = 15_000) {
  if (inFlight.size === 0) return;
  logger.info('notification.draining', { pending: inFlight.size });
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export function pendingCount() {
  return inFlight.size;
}
