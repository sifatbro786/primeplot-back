import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import apiRoutes from './routes.js';
import { storage } from '#integrations/storage/index.js';
import '#jobs/index.js'; // registers job handlers
import { errorHandler, notFound } from '#shared/middleware/errorHandler.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Behind Nginx (and the Next.js rewrite) — needed for req.ip / secure cookies.
  app.set('trust proxy', env.TRUST_PROXY);
  // Express 5 default, set explicitly: query values are plain strings, never nested objects,
  // which closes the `?status[$ne]=x` operator-injection route.
  app.set('query parser', 'simple');

  // Request id + structured access log. Accept an upstream id (Nginx/Next) if well-formed.
  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel(req, res, err) {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      // Keep health checks out of the logs (uptime monitors hit them constantly).
      autoLogging: {
        ignore: (req) => req.url.startsWith('/api/v1/health') || req.url.startsWith('/uploads/'),
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // No Origin header = same-origin, server-to-server, curl, Next.js rewrite → allow.
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(compression());
  app.use(
    express.json({
      limit: '1mb',
      // Signed webhooks (Meta) need the exact bytes that were signed.
      verify(req, res, buf) {
        if (req.originalUrl?.startsWith('/api/v1/webhooks/')) req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  // Public media (local driver). In production Nginx serves /uploads directly; this stays as
  // the dev server and a fallback. Private files live outside this directory.
  if (storage.localPublicDir) {
    app.use(
      '/uploads',
      express.static(storage.localPublicDir, {
        index: false,
        dotfiles: 'deny',
        redirect: false,
        maxAge: '365d',
        immutable: true, // keys are random and never reused
        setHeaders(res) {
          // helmet sets CORP same-origin; the frontend (another origin) must be able to embed.
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        },
      }),
    );
  }

  app.use('/api/v1', apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
