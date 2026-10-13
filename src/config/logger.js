import pino from 'pino';
import { env } from './env.js';

const usePretty = env.isDev;

export const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  base: { app: env.APP_NAME, env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Never log secrets or personal tokens.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
      '*.access_token',
      '*.api_key',
      '*.api_token',
    ],
    censor: '[redacted]',
  },
  ...(usePretty && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,app,env' },
    },
  }),
});
