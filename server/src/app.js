import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import mongoose from 'mongoose';
import env from './config/env.js';
import logger from './utils/logger.js';
import trialRequestRoutes from './routes/trialRequest.routes.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { pendingCount } from './services/notificationDispatcher.js';

export function createApp() {
  const app = express();

  // Required for correct req.ip (and therefore rate limiting) behind a proxy.
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(compression());

  // ---- CORS ----
  // The landing page is served as a static file, often from a different origin
  // (S3/Netlify) than the API. An explicit allowlist in production; permissive
  // in development so the page can be opened from file:// or any local port.
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // curl, same-origin, file://
        if (env.CORS_ORIGINS.length === 0) {
          if (env.isProduction) {
            logger.warn('cors.unconfigured_in_production', { origin });
            return callback(null, false);
          }
          return callback(null, true);
        }
        return callback(null, env.CORS_ORIGINS.includes(origin));
      },
      methods: ['POST', 'GET', 'OPTIONS'],
      maxAge: 86_400,
    }),
  );

  // Small cap: this endpoint accepts five short text fields and nothing else.
  app.use(express.json({ limit: '16kb' }));

  // ---- Health / readiness ----
  app.get('/health', (req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({
      status: dbUp ? 'ok' : 'degraded',
      database: dbUp ? 'connected' : 'disconnected',
      whatsapp: env.whatsapp.enabled ? 'enabled' : 'disabled',
      pendingNotifications: pendingCount(),
      uptime: Math.round(process.uptime()),
    });
  });

  app.use('/api/v1', trialRequestRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
