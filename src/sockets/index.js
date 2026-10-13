import { Server } from 'socket.io';
import { z } from 'zod';
import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { P } from '#shared/auth/permissions.js';
import { zid } from '#shared/middleware/validate.js';
import { getCurrentOrg } from '#modules/organizations/organization.service.js';
import { authenticateSocketToken } from '#modules/auth/auth.middleware.js';
import { getProjectAccess } from '#modules/projects/project.service.js';

/**
 * Real-time inventory (ARCHITECTURE §6.2, B2).
 *
 * Connect:   io(API_URL, { auth: { token } })   token optional (POST /auth/socket-token)
 * Subscribe: socket.emit('subscribe', { projectId, scope: 'public' | 'staff' }, ack)
 *            ack → { ok: true } | { ok: false, code }
 *   public — anyone, published projects only; receives { unitId, projectId, status } with the
 *            public vocabulary (available | held | sold | unavailable). No hold details.
 *   staff  — needs a socket token with units:read; receives the full delta (hold, listPrice,
 *            version).
 * Event:     'unit:status'  (one per changed unit)
 *
 * Personal channel (B3): a socket with a token joins its user room automatically and receives
 *            'notification' events (the same objects GET /notifications returns).
 *
 * Rooms are org-scoped. Emitting is a no-op until initSockets() runs (tests, scripts).
 */
const log = logger.child({ module: 'sockets' });
const MAX_ROOMS_PER_SOCKET = 20;

let io = null;

const room = (orgId, projectId, scope) => `o:${orgId}:p:${projectId}:${scope}`;
const userRoom = (orgId, userId) => `o:${orgId}:u:${userId}`;

const subscribeMsg = z
  .object({ projectId: zid, scope: z.enum(['public', 'staff']).default('public') })
  .strict();

function socketError(code, message) {
  const err = new Error(message);
  err.data = { code };
  return err;
}

export function initSockets(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: false },
    serveClient: false,
    maxHttpBufferSize: 16 * 1024, // clients only send tiny subscribe messages
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.use(async (socket, next) => {
    try {
      const org = await getCurrentOrg();
      socket.data.orgId = String(org._id);
      const token = socket.handshake.auth?.token;
      if (typeof token === 'string' && token) {
        socket.data.user = await authenticateSocketToken(token, org._id);
      }
      next();
    } catch (err) {
      next(socketError(err.code ?? 'UNAUTHORIZED', err.message ?? 'Connection refused'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.data.user) socket.join(userRoom(socket.data.orgId, socket.data.user.id));

    socket.on('subscribe', async (raw, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const parsed = subscribeMsg.safeParse(raw ?? {});
        if (!parsed.success) return reply({ ok: false, code: 'VALIDATION_ERROR' });
        const { projectId, scope } = parsed.data;
        // Own socket room + personal room don't count towards the limit.
        if (socket.rooms.size - (socket.data.user ? 2 : 1) >= MAX_ROOMS_PER_SOCKET) {
          return reply({ ok: false, code: 'TOO_MANY_SUBSCRIPTIONS' });
        }

        const { orgId, user } = socket.data;
        if (scope === 'staff' && !user?.permissions.has(P.UNITS_READ)) {
          return reply({ ok: false, code: 'FORBIDDEN' });
        }
        const access = await getProjectAccess(orgId, projectId);
        if (!access || (scope === 'public' && !access.published)) {
          return reply({ ok: false, code: 'NOT_FOUND' });
        }
        await socket.join(room(orgId, projectId, scope));
        return reply({ ok: true });
      } catch (err) {
        log.warn({ err: { message: err.message } }, 'subscribe failed');
        return reply({ ok: false, code: 'INTERNAL_ERROR' });
      }
    });

    socket.on('unsubscribe', async (raw, ack) => {
      const parsed = subscribeMsg.safeParse(raw ?? {});
      if (parsed.success) {
        await socket.leave(room(socket.data.orgId, parsed.data.projectId, parsed.data.scope));
      }
      if (typeof ack === 'function') ack({ ok: parsed.success });
    });
  });

  log.info('Socket.IO ready');
  return io;
}

export async function closeSockets() {
  if (!io) return;
  const server = io;
  io = null;
  await new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Broadcast unit status deltas. `changes` = [{ staff, public }] payloads prepared by the units
 * service (it owns the serialization rules).
 */
export function emitUnitStatus(orgId, projectId, changes) {
  if (!io || !changes.length) return;
  const staffRoom = io.to(room(String(orgId), String(projectId), 'staff'));
  const publicRoom = io.to(room(String(orgId), String(projectId), 'public'));
  for (const c of changes) {
    staffRoom.emit('unit:status', c.staff);
    publicRoom.emit('unit:status', c.public);
  }
}

/** Push an event to every open socket of one user (no-op before initSockets / in tests). */
export function emitToUser(orgId, userId, event, payload) {
  if (!io) return;
  io.to(userRoom(String(orgId), String(userId))).emit(event, payload);
}
