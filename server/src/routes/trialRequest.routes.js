import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import env from '../config/env.js';
import { createTrialRequest } from '../controllers/trialRequest.controller.js';

const router = Router();

/**
 * Per-IP throttle on the public write endpoint. Generous enough that a shared
 * institute NAT will not trip it, tight enough to make scripted abuse pointless.
 */
const trialRequestLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest,
  message: {
    success: false,
    error: 'RATE_LIMITED',
    message: 'Too many requests. Please wait a few minutes and try again.',
  },
});

router.post('/trial-requests', trialRequestLimiter, createTrialRequest);

export default router;
