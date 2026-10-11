import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '#config/env.js';
import { P } from '#shared/auth/permissions.js';
import { limits } from '#shared/middleware/rateLimit.js';
import { validate, zid } from '#shared/middleware/validate.js';
import { created, noContent, ok } from '#shared/utils/response.js';
import { authenticate, authorizeAny } from '#modules/auth/auth.middleware.js';
import { auditContext } from '#modules/audit/audit.service.js';
import { MEDIA_PURPOSES } from './media.model.js';
import * as media from './media.service.js';

const router = Router();
router.use(authenticate);

// Memory storage: the buffer is validated (magic bytes) and re-encoded before anything
// touches disk. Hard cap = the larger per-kind limit; the service applies the exact one.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.max(env.MEDIA_MAX_IMAGE_MB, env.MEDIA_MAX_DOC_MB) * 1024 * 1024,
    files: 1,
    fields: 5,
    fieldSize: 2048,
    parts: 6,
  },
});

router.post(
  '/',
  authorizeAny(P.MEDIA_UPLOAD, P.MEDIA_UPLOAD_PRIVATE),
  limits.upload,
  upload.single('file'),
  validate({
    body: {
      visibility: z.enum(['public', 'private']).optional(),
      purpose: z.enum(MEDIA_PURPOSES).default('general'),
      alt: z.string().trim().max(300).optional(),
    },
  }),
  async (req, res) => {
    const m = await media.createMedia({
      orgId: req.orgId,
      user: req.user,
      file: req.file,
      ...req.valid.body,
      ctx: auditContext(req),
    });
    created(res, media.toPublicMedia(m));
  },
);

router.get('/:id', validate({ params: { id: zid } }), async (req, res) => {
  const m = await media.getMedia({ orgId: req.orgId, user: req.user, id: req.valid.params.id });
  ok(res, media.toPublicMedia(m));
});

/** Authenticated file stream — the only way private files leave the server. */
router.get(
  '/:id/file',
  validate({
    params: { id: zid },
    query: { variant: z.enum(['thumb', 'card', 'full', 'file']).default('full') },
  }),
  async (req, res) => {
    const { media: m, stream } = await media.openMediaFile({
      orgId: req.orgId,
      user: req.user,
      id: req.valid.params.id,
      variant: req.valid.query.variant,
    });
    const ext = m.mime === 'application/pdf' ? 'pdf' : 'webp';
    const asciiName = (m.originalName ?? 'file').replace(/[^\w.-]+/g, '_').replace(/\.[^.]*$/, '');
    res.setHeader('Content-Type', m.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${asciiName}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${m.originalName?.replace(/\.[^.]*$/, '') ?? 'file'}.${ext}`)}`,
    );
    try {
      await pipeline(stream, res);
    } catch (err) {
      if (err.code === 'ENOENT' && !res.headersSent) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'File missing', requestId: req.id },
        });
        return;
      }
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err; // client aborted → ignore
    }
  },
);

router.delete('/:id', validate({ params: { id: zid } }), async (req, res) => {
  await media.deleteMedia({
    orgId: req.orgId,
    user: req.user,
    id: req.valid.params.id,
    ctx: auditContext(req),
  });
  noContent(res);
});

export default router;
