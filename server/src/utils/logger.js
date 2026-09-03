/**
 * Minimal structured logger.
 *
 * Emits one JSON object per line so the output drops straight into CloudWatch /
 * Loki / Datadog without a parsing rule. Deliberately dependency-free.
 *
 * `redact()` is applied to every payload: lead PII and access tokens must never
 * reach the log stream in full.
 */
import env from '../config/env.js';

const LEVELS = { silent: 100, error: 40, warn: 30, info: 20, debug: 10 };
const threshold = LEVELS[env.LOG_LEVEL] ?? LEVELS.info;

const SECRET_KEYS = /^(authorization|access_?token|token|password|secret|apikey|api_?key)$/i;
const PII_KEYS = /^(email|whatsappnumber|phone|address|name)$/i;

/** Show enough of a value to debug with, never enough to identify someone. */
function maskValue(key, value) {
  if (typeof value !== 'string') return value;
  if (SECRET_KEYS.test(key)) return '[redacted]';
  if (!PII_KEYS.test(key)) return value;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function redact(input, depth = 0) {
  if (input === null || typeof input !== 'object' || depth > 6) return input;
  if (Array.isArray(input)) return input.map((item) => redact(item, depth + 1));
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] =
      value && typeof value === 'object' ? redact(value, depth + 1) : maskValue(key, value);
  }
  return output;
}

function emit(level, message, meta = {}) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...redact(meta),
  });
  // stderr for error/warn so log shippers can split streams; stdout otherwise.
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

const logger = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta),
  redact,
};

export default logger;
