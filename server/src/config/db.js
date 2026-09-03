/**
 * Mongoose connection lifecycle.
 */
import mongoose from 'mongoose';
import env from './env.js';
import logger from '../utils/logger.js';

export async function connectDatabase(uri = env.MONGODB_URI) {
  // Neutralise query operators ($gt, $ne, ...) arriving from user input by
  // wrapping object-valued filters in $eq. Defence in depth: the validator
  // already rejects operator-shaped payloads and coerces non-strings.
  //
  // CAUTION: this applies to OUR filters too. Any query that deliberately uses
  // an operator (e.g. `{ createdAt: { $gte: date } }`) must wrap it in
  // `mongoose.trusted(...)`, or it is rewritten to `{ $eq: { $gte: date } }`
  // and fails to cast. See the duplicate-click guard in
  // controllers/trialRequest.controller.js.
  mongoose.set('sanitizeFilter', true);
  mongoose.set('strictQuery', true);

  mongoose.connection.on('error', (error) => {
    logger.error('mongodb.connection_error', { error: error.message });
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('mongodb.disconnected');
  });

  await mongoose.connect(uri, {
    ...(env.MONGODB_DB_NAME ? { dbName: env.MONGODB_DB_NAME } : {}),
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 10,
  });

  logger.info('mongodb.connected', { database: mongoose.connection.name });
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
}
