import mongoose from 'mongoose';
import { logger } from '#config/logger.js';
import { cursorFilter, cursorPage } from '#shared/utils/pagination.js';
import { AuditLog } from './audit.model.js';

const log = logger.child({ module: 'audit' });

/** Pull actor/ip/requestId from the request (works for authenticated and anonymous calls). */
export function auditContext(req) {
  return {
    orgId: req.orgId,
    actor: req.user
      ? { id: req.user.id, role: req.user.role, name: req.user.name, kind: 'user' }
      : { kind: 'anonymous' },
    ip: req.ip ?? null,
    userAgent: req.get?.('user-agent')?.slice(0, 400) ?? null,
    requestId: req.id ?? null,
  };
}

export const SYSTEM_ACTOR = Object.freeze({ kind: 'system' });

/**
 * Record an audit event.
 * - Inside a transaction pass `{ session }`: the entry commits/aborts with the business write
 *   and a failure propagates (money operations must never be un-audited).
 * - Without a session it is best-effort: a logging failure never fails the user's request.
 *
 *   await audit(auditContext(req), 'user.update', { entity: { type: 'User', id }, diff });
 */
export async function audit(ctx, action, { entity, diff, meta, session } = {}) {
  const doc = {
    orgId: ctx.orgId,
    action,
    actor: ctx.actor ?? SYSTEM_ACTOR,
    entity: entity ? { type: entity.type, id: entity.id ?? null } : undefined,
    diff,
    meta,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    requestId: ctx.requestId ?? null,
  };
  if (session) {
    await AuditLog.create([doc], { session });
    return;
  }
  try {
    await AuditLog.create(doc);
  } catch (err) {
    log.error({ err, action }, 'Failed to write audit log');
  }
}

/** Cursor-paginated listing, newest first. */
export async function listAudit(
  orgId,
  { cursor, limit, action, entityType, entityId, actorId, from, to },
) {
  const filter = { orgId, ...cursorFilter(cursor) };
  if (action) {
    // 'auth.' prefix → every auth action. Escaped: never a user-supplied regex.
    filter.action = action.endsWith('.')
      ? { $regex: `^${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }
      : action;
  }
  if (entityType) filter['entity.type'] = entityType;
  if (entityId) filter['entity.id'] = new mongoose.Types.ObjectId(entityId);
  if (actorId) filter['actor.id'] = new mongoose.Types.ObjectId(actorId);
  if (from || to) {
    // Combine with the cursor's createdAt bounds via $and so neither overwrites the other.
    filter.$and = [{ createdAt: { ...(from && { $gte: from }), ...(to && { $lte: to }) } }];
  }

  const rows = await AuditLog.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  return {
    items: items.map((r) => ({
      id: String(r._id),
      action: r.action,
      actor: { ...r.actor, id: r.actor?.id ? String(r.actor.id) : null },
      entity: r.entity?.type
        ? { type: r.entity.type, id: r.entity.id ? String(r.entity.id) : null }
        : null,
      diff: r.diff ?? null,
      meta: r.meta ?? null,
      ip: r.ip,
      requestId: r.requestId,
      createdAt: r.createdAt,
    })),
    meta,
  };
}
