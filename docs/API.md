# PrimePlot API — Contracts

Base URL: `/api/v1`. In the browser, always call the frontend origin (the Next.js rewrite proxies to Express on `:5030`).

## Conventions
- **Success:** `{ "success": true, "data": …, "meta"?: … }`
- **Error:** `{ "success": false, "error": { "code", "message", "details"?, "requestId" } }`
- Every response carries an `X-Request-Id` header. An incoming `X-Request-Id` (8–64 chars `[A-Za-z0-9._-]`) is reused.
- **Error codes:**

| Code | HTTP status |
|---|---|
| `BAD_REQUEST` | 400 |
| `INVALID_JSON` | 400 |
| `UNAUTHORIZED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `DUPLICATE` | 409 |
| `STALE_VERSION` | 409 |
| `PAYLOAD_TOO_LARGE` | 413 |
| `VALIDATION_ERROR` | 422 |
| `RATE_LIMITED` | 429 |
| `INTERNAL_ERROR` | 500 |

  - `VALIDATION_ERROR` details: `[{ path, message, code }]`

## Health (Phase 0)

### `GET /health`: liveness (never touches the DB)
`200` → `{ success: true, data: { status: "ok", app, env, uptimeSec, startedAt } }`

### `GET /health/ready`: readiness
- `200` → `{ success: true, data: { status: "ready", checks: { database: "up" } } }`
- `503` → `{ success: false, data: { status: "not_ready", checks: { database: "down" } } }`
