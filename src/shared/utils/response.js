/**
 * Success envelope: { success: true, data, meta? }
 * Error envelope is produced only by errorHandler: { success: false, error: { code, message, details?, requestId } }
 */
export function ok(res, data = null, { status = 200, meta } = {}) {
  return res.status(status).json({ success: true, data, ...(meta && { meta }) });
}

export function created(res, data, opts = {}) {
  return ok(res, data, { ...opts, status: 201 });
}

export function noContent(res) {
  return res.status(204).end();
}
