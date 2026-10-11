import mongoose from 'mongoose';
import { z } from 'zod';
import { BadRequestError } from '#shared/errors/AppError.js';

/** Offset pagination — small admin tables. */
export const offsetQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export function offsetMeta({ page, limit }, total) {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}

/**
 * Cursor pagination — large append-heavy lists (audit, leads, receipts).
 * Sort is always { createdAt: -1, _id: -1 }; the cursor is the last row's (createdAt, _id).
 */
export const cursorQuery = {
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
};

export function encodeCursor(doc) {
  return Buffer.from(JSON.stringify([doc.createdAt.getTime(), String(doc._id)])).toString(
    'base64url',
  );
}

export function decodeCursor(cursor) {
  try {
    const [ts, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isFinite(ts) || !mongoose.isValidObjectId(id)) throw new Error('bad');
    return { createdAt: new Date(ts), _id: new mongoose.Types.ObjectId(id) };
  } catch {
    throw new BadRequestError('Invalid cursor', { code: 'INVALID_CURSOR' });
  }
}

/** Filter fragment for "rows after the cursor" in createdAt desc, _id desc order. */
export function cursorFilter(cursor) {
  if (!cursor) return {};
  const c = decodeCursor(cursor);
  return {
    $or: [{ createdAt: { $lt: c.createdAt } }, { createdAt: c.createdAt, _id: { $lt: c._id } }],
  };
}

/** Fetch limit+1 rows, then call this to split page / nextCursor. */
export function cursorPage(rows, limit) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, meta: { limit, nextCursor: hasMore ? encodeCursor(items.at(-1)) : null } };
}
