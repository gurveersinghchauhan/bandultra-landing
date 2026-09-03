import env from './config/env.js';
import logger from './utils/logger.js';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { assertNoUniqueEmailIndex } from './models/TrialRequest.js';
import { drain } from './services/notificationDispatcher.js';
import { describeTemplateConfig } from './services/whatsapp.service.js';

/**
 * Process entry point: connect, verify schema invariants, listen, shut down
 * cleanly.
 */
async function main() {
  await connectDatabase();

  // Fail the boot if a unique index on `email` has appeared on trial_requests.
  // See the constraint note in models/TrialRequest.js.
  await assertNoUniqueEmailIndex();

  // Log the template that will actually be sent. `.env` overrides every
  // default, so this is the only reliable way to see the effective config
  // without reading .env on the server — and the fastest way to diagnose a
  // 132001 ("no such template in that language").
  if (env.whatsapp.enabled) {
    logger.info('whatsapp.effective_template', describeTemplateConfig());
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info('server.listening', {
      port: env.PORT,
      env: env.NODE_ENV,
      whatsapp: env.whatsapp.enabled ? 'enabled' : 'disabled',
    });
  });

  // Slightly above a typical ALB/nginx 60s idle timeout to avoid 502s on
  // connections the proxy still considers open.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutdown_started', { signal });

    server.close(async () => {
      try {
        await drain();               // let in-flight WhatsApp sends finish
        await disconnectDatabase();
        logger.info('server.shutdown_complete');
        process.exit(0);
      } catch (error) {
        logger.error('server.shutdown_error', { error: error.message });
        process.exit(1);
      }
    });

    // Hard stop if a connection refuses to close.
    setTimeout(() => {
      logger.error('server.shutdown_forced');
      process.exit(1);
    }, 30_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Last-resort guards. An async notification failure must never reach here —
  // if one does, it is a bug worth a loud log, but not worth dropping traffic.
  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on('uncaughtException', (error) => {
    logger.error('process.uncaught_exception', { error: error.message, stack: error.stack });
    shutdown('uncaughtException');
  });
}

main().catch((error) => {
  logger.error('server.boot_failed', { error: error.message, stack: error.stack });
  process.exit(1);
});
