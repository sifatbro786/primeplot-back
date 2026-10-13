import mongoose from 'mongoose';
import { logger } from '#config/logger.js';
import { cursorFilter, cursorPage } from '#shared/utils/pagination.js';
import { emitToUser } from '#sockets/index.js';
import { Notification } from './notification.model.js';

const log = logger.child({ module: 'notifications' });
const { ObjectId } = mongoose.Types;

export function toNotification(n) {
  return {
    id: String(n._id),
    type: n.type,
    data: n.data ?? {},
    readAt: n.readAt ?? null,
    createdAt: n.createdAt,
  };
}

/**
 * Notify staff (best-effort: a failure is logged, never fails the business action).
 * Stored for the bell list and pushed live to the user's open dashboards over Socket.IO.
 */
export async function notify(orgId, userIds, type, data = {}) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return;
  try {
    const docs = await Notification.insertMany(
      ids.map((userId) => ({ orgId, userId: new ObjectId(userId), type, data })),
    );
    for (const d of docs) emitToUser(orgId, d.userId, 'notification', toNotification(d));
  } catch (err) {
    log.error({ err: { message: err.message }, type }, 'Failed to store notifications');
  }
}

export async function listNotifications(orgId, userId, { cursor, limit, unread }) {
  const filter = { orgId, userId, ...cursorFilter(cursor) };
  if (unread) filter.readAt = null;
  const rows = await Notification.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const { items, meta } = cursorPage(rows, limit);
  return { items: items.map(toNotification), meta };
}

export function unreadCount(orgId, userId) {
  return Notification.countDocuments({ orgId, userId, readAt: null });
}

/** Mark some (ids) or all of the user's notifications read. Returns how many changed. */
export async function markRead(orgId, userId, { ids, all }) {
  const filter = { orgId, userId, readAt: null };
  if (!all) filter._id = { $in: ids.map((id) => new ObjectId(id)) };
  const res = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
  return res.modifiedCount;
}
