import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { P } from '#shared/auth/permissions.js';
import { randomToken } from '#shared/crypto/secrets.js';
import { AppError, ForbiddenError, NotFoundError } from '#shared/errors/AppError.js';
import { storage } from '#integrations/storage/index.js';
import { audit } from '#modules/audit/audit.service.js';
import { Media } from './media.model.js';

const log = logger.child({ module: 'media' });

// Memory: libvips cache off (we never re-read the same image) — matters on a small VPS.
sharp.cache(false);

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);
const DOC_MIMES = new Set(['application/pdf']);
const VARIANTS = [
  { name: 'thumb', width: 400, quality: 72 },
  { name: 'card', width: 960, quality: 80 },
  { name: 'full', width: 1920, quality: 82 },
];
// Decompression-bomb guard: a 50-megapixel input is far beyond any real photo/floor plan.
const MAX_INPUT_PIXELS = 50_000_000;
const PRIVATE_ONLY_PURPOSES = new Set(['document', 'payment_slip']);
const CLIENT_PURPOSES = new Set(['document', 'payment_slip', 'avatar']);
const MB = 1024 * 1024;

/** At most 2 images are decoded at once — bounds peak RAM on the VPS. */
const MAX_CONCURRENT = 2;
let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const unsupported = (msg = 'Unsupported file type. Allowed: JPEG, PNG, WebP, AVIF, GIF, PDF.') =>
  new AppError(msg, { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
const tooLarge = (limitMb) =>
  new AppError(`File is too large (max ${limitMb} MB)`, {
    statusCode: 413,
    code: 'FILE_TOO_LARGE',
  });

/** Decide visibility/purpose from what the caller asked for and what they may do. */
export function resolveUploadPolicy(user, { visibility, purpose }) {
  const can = (p) => user.permissions.has(p);
  if (!can(P.MEDIA_UPLOAD) && !can(P.MEDIA_UPLOAD_PRIVATE)) throw new ForbiddenError();

  let vis = visibility ?? 'public';
  if (PRIVATE_ONLY_PURPOSES.has(purpose)) vis = 'private';
  if (!can(P.MEDIA_UPLOAD)) {
    // Clients: private only, limited purposes.
    if (!CLIENT_PURPOSES.has(purpose))
      throw new ForbiddenError('You cannot upload this kind of file');
    vis = 'private';
  }
  return { visibility: vis, purpose };
}

function datedBase() {
  const d = new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}/${mm}/${randomToken(12)}`;
}

async function processImage(buffer, base, visibility, written) {
  const input = sharp(buffer, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: 'error',
    animated: false, // first frame of animated GIF/WebP
  }).rotate(); // apply EXIF orientation; output carries no metadata (EXIF/GPS stripped)

  const meta = await input.metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;

  const variants = {};
  let bytes = 0;
  for (const v of VARIANTS) {
    const { data, info } = await input
      .clone()
      .resize({ width: v.width, withoutEnlargement: true })
      .webp({ quality: v.quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    const key = `${base}-${v.name}.webp`;
    await storage.put({ key, body: data, visibility });
    written.push(key);
    variants[v.name] = { key, width: info.width, height: info.height, bytes: info.size };
    bytes += info.size;
  }
  const blur = await input.clone().resize({ width: 16 }).webp({ quality: 40 }).toBuffer();
  return {
    kind: 'image',
    mime: 'image/webp',
    variants,
    bytes,
    width,
    height,
    blurDataUrl: `data:image/webp;base64,${blur.toString('base64')}`,
  };
}

/**
 * Validate (magic bytes, size), transform and store an upload, then record it.
 * The client-sent MIME type and filename are never trusted.
 */
export async function createMedia({ orgId, user, file, visibility, purpose, alt, ctx }) {
  const policy = resolveUploadPolicy(user, { visibility, purpose });
  if (!file?.buffer?.length)
    throw new AppError('No file uploaded', { statusCode: 400, code: 'FILE_REQUIRED' });

  const type = await fileTypeFromBuffer(file.buffer);
  const isImage = type && IMAGE_MIMES.has(type.mime);
  const isDoc = type && DOC_MIMES.has(type.mime);
  if (!isImage && !isDoc) throw unsupported();

  const limitMb = isImage ? env.MEDIA_MAX_IMAGE_MB : env.MEDIA_MAX_DOC_MB;
  if (file.buffer.length > limitMb * MB) throw tooLarge(limitMb);

  const base = datedBase();
  const written = [];
  try {
    const stored = isImage
      ? await withSlot(() => processImage(file.buffer, base, policy.visibility, written))
      : await (async () => {
          const key = `${base}.pdf`;
          await storage.put({ key, body: file.buffer, visibility: policy.visibility });
          written.push(key);
          return {
            kind: 'document',
            mime: type.mime,
            variants: { file: { key, bytes: file.buffer.length } },
            bytes: file.buffer.length,
          };
        })();

    const media = await Media.create({
      orgId,
      driver: storage.driver,
      visibility: policy.visibility,
      purpose: policy.purpose,
      sourceMime: type.mime,
      originalName: sanitizeName(file.originalname),
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      alt,
      uploadedBy: user.id,
      ...stored,
    });
    await audit(ctx, 'media.upload', {
      entity: { type: 'Media', id: media._id },
      meta: { purpose: media.purpose, visibility: media.visibility, bytes: media.bytes },
    });
    return media.toObject();
  } catch (err) {
    await Promise.all(
      written.map((key) => storage.remove({ key, visibility: policy.visibility }).catch(() => {})),
    );
    // sharp/libvips decode errors → the file claims to be an image but isn't a valid one.
    if (
      isImage &&
      !(err instanceof AppError) &&
      /Input|pixel|corrupt|unsupported|VipsJpeg|vips/i.test(err.message)
    ) {
      throw new AppError(
        /pixel/i.test(err.message)
          ? 'Image dimensions are too large'
          : 'The image file is damaged or unreadable',
        { statusCode: 422, code: 'INVALID_IMAGE' },
      );
    }
    throw err;
  }
}

function sanitizeName(name) {
  if (typeof name !== 'string') return undefined;
  // Display only. Strip path parts and control chars; keep Bangla etc.
  return (
    name
      .split(/[\\/]/)
      .pop()
      .replace(/[\p{Cc}"<>]/gu, '')
      .slice(0, 200) || undefined
  );
}

export function toPublicMedia(m) {
  const variants = m.variants instanceof Map ? Object.fromEntries(m.variants) : (m.variants ?? {});
  const urls = {};
  for (const [name, v] of Object.entries(variants)) {
    urls[name] =
      m.visibility === 'public'
        ? storage.publicUrl(v.key)
        : `/api/v1/media/${m._id}/file?variant=${name}`; // same-origin via the Next.js rewrite
  }
  return {
    id: String(m._id),
    kind: m.kind,
    purpose: m.purpose,
    visibility: m.visibility,
    mime: m.mime,
    bytes: m.bytes,
    width: m.width ?? null,
    height: m.height ?? null,
    blurDataUrl: m.blurDataUrl ?? null,
    alt: m.alt ?? null,
    originalName: m.originalName ?? null,
    urls,
    uploadedBy: String(m.uploadedBy),
    createdAt: m.createdAt,
  };
}

/** Object-level access: public → any staff; private → uploader or MEDIA_READ_PRIVATE. */
function assertCanRead(user, m) {
  if (m.visibility === 'public' && user.permissions.has(P.MEDIA_UPLOAD)) return;
  if (String(m.uploadedBy) === String(user.id)) return;
  if (m.visibility === 'private' && user.permissions.has(P.MEDIA_READ_PRIVATE)) return;
  // Same answer as "doesn't exist" — never confirm a private file's existence.
  throw new NotFoundError('Media not found');
}

export async function getMedia({ orgId, user, id }) {
  const m = await Media.findOne({ orgId, _id: id }).lean();
  if (!m) throw new NotFoundError('Media not found');
  assertCanRead(user, m);
  return m;
}

/** For streaming a private (or public) file through the API. */
export async function openMediaFile({ orgId, user, id, variant }) {
  const m = await getMedia({ orgId, user, id });
  const variants = m.variants ?? {};
  const v = variants[variant] ?? variants.file ?? variants.full;
  if (!v) throw new NotFoundError('Media not found');
  return {
    media: m,
    stream: storage.createReadStream({ key: v.key, visibility: m.visibility }),
    bytes: v.bytes,
  };
}

/** Soft delete; files are removed later by the media.purgeDeleted job (undo window). */
export async function deleteMedia({ orgId, user, id, ctx }) {
  const m = await Media.findOne({ orgId, _id: id });
  if (!m) throw new NotFoundError('Media not found');
  const own = String(m.uploadedBy) === String(user.id);
  if (!own && !user.permissions.has(P.MEDIA_DELETE)) {
    if (m.visibility === 'private' && !user.permissions.has(P.MEDIA_READ_PRIVATE)) {
      throw new NotFoundError('Media not found');
    }
    throw new ForbiddenError();
  }
  await m.softDelete(user.id);
  await audit(ctx, 'media.delete', { entity: { type: 'Media', id: m._id } });
}

const PURGE_AFTER_MS = 7 * 86_400_000;

/** Job: hard-delete media soft-deleted more than 7 days ago (files first, then the record). */
export async function purgeDeletedMedia(orgId, { batch = 100 } = {}) {
  const rows = await Media.find({
    orgId,
    deletedAt: { $lt: new Date(Date.now() - PURGE_AFTER_MS) },
  })
    .setOptions({ withDeleted: true })
    .limit(batch)
    .lean();
  let purged = 0;
  for (const m of rows) {
    const variants = Object.values(m.variants ?? {});
    await Promise.all(
      variants.map((v) => storage.remove({ key: v.key, visibility: m.visibility })),
    );
    await Media.deleteOne({ orgId, _id: m._id });
    purged++;
  }
  if (purged) log.info({ purged }, 'Purged deleted media');
  return purged;
}

/**
 * For modules that attach media to public-facing records (projects, floor plans — B2):
 * every id must be a live PUBLIC file of this org (optionally of one kind). Private files can
 * never be wired onto the website this way.
 */
export async function assertPublicMedia(orgId, ids, { kind } = {}) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const rows = await Media.find({ orgId, _id: { $in: unique }, visibility: 'public' }).lean();
  const found = new Map(rows.map((m) => [String(m._id), m]));
  const bad = unique.filter((id) => !found.has(id) || (kind && found.get(id).kind !== kind));
  if (bad.length) {
    throw new AppError('Some media were not found, are private, or are the wrong type', {
      statusCode: 422,
      code: 'INVALID_MEDIA',
      details: bad.map((id) => ({ path: 'mediaId', message: id })),
    });
  }
  return found;
}

/**
 * For records that hold personal documents (customer NID/photo — B4): every id must be a live
 * PRIVATE file of this org. Private files are only ever streamed through the authenticated route.
 */
export async function assertPrivateMedia(orgId, ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const rows = await Media.find({ orgId, _id: { $in: unique }, visibility: 'private' }).lean();
  const found = new Map(rows.map((m) => [String(m._id), m]));
  const bad = unique.filter((id) => !found.has(id));
  if (bad.length) {
    throw new AppError('Some files were not found or are not private uploads', {
      statusCode: 422,
      code: 'INVALID_MEDIA',
      details: bad.map((id) => ({ path: 'mediaId', message: id })),
    });
  }
  return found;
}

/**
 * B4.3: an image variant's bytes as a data: URI (company logo on printed documents), or null
 * when the media is missing. Small files only — logos are a few KB as WebP.
 */
export async function mediaDataUri(orgId, id, variant = 'card') {
  if (!id) return null;
  const m = await Media.findOne({ orgId, _id: id, kind: 'image' }).lean();
  const variants = m?.variants ?? {};
  const v = variants[variant] ?? variants.thumb ?? variants.full;
  if (!v) return null;
  const chunks = [];
  for await (const c of storage.createReadStream({ key: v.key, visibility: m.visibility })) {
    chunks.push(c);
  }
  return `data:${m.mime};base64,${Buffer.concat(chunks).toString('base64')}`;
}

/** id → public media JSON for the given ids (missing/deleted/private ids are skipped). */
export async function publicMediaMap(orgId, ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const rows = await Media.find({ orgId, _id: { $in: unique }, visibility: 'public' }).lean();
  return new Map(rows.map((m) => [String(m._id), toPublicMedia(m)]));
}
