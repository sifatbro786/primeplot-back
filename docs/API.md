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

B1 adds these codes:

| Code | HTTP | When |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | Wrong email/password (also unknown email and not-yet-activated users — same answer) |
| `TOKEN_EXPIRED` | 401 | Access token expired → call `POST /auth/refresh`, then retry |
| `SESSION_REVOKED` / `SESSION_INVALIDATED` | 401 | Logged out elsewhere, password/role changed, user disabled → go to login |
| `INVALID_REFRESH` / `SESSION_EXPIRED` / `REFRESH_REUSED` | 401 | Refresh failed → go to login (cookies are cleared) |
| `REFRESH_SUPERSEDED` | 409 | Another tab refreshed at the same moment → just retry the original request |
| `ACCOUNT_LOCKED` | 429 | 5 wrong passwords. `details.retryAfterSec` |
| `ACCOUNT_DISABLED` | 403 | Correct password, but the admin disabled the account |
| `INVALID_TOKEN` | 400 | Reset/setup link invalid, used or expired |
| `INVALID_CURRENT_PASSWORD` / `PASSWORD_UNCHANGED` | 400 | Change password |
| `BAD_ORIGIN` | 403 | State-changing request from a non-allowed `Origin` |
| `SELF_CHANGE` | 403 | Admin tried to change their own role/status |
| `LAST_ADMIN` | 409 | Would leave the org with no active admin |
| `ALREADY_ACTIVE` / `INVITE_PENDING` | 409 / 400 | Invite resend / manual activation |
| `INVALID_PHONE` | 400 | Not a valid BD mobile number |
| `INVALID_CURSOR` | 400 | Bad `cursor` query value |
| `FILE_REQUIRED` / `BAD_UPLOAD` | 400 | Upload problems |
| `FILE_TOO_LARGE` | 413 | Image > 15 MB, PDF > 10 MB (env) |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | File bytes are not JPEG/PNG/WebP/AVIF/GIF/PDF (the filename/MIME sent is ignored) |
| `INVALID_IMAGE` | 422 | Damaged image or > 50 megapixels |
| `ORG_NOT_CONFIGURED` | 503 | `npm run seed` has not been run |

- **Pagination**
  - offset (small admin tables): `?page=1&limit=20` → `meta: { page, limit, total, pages }`
  - cursor (large lists): `?limit=30&cursor=<meta.nextCursor>` → `meta: { limit, nextCursor }` (`null` = last page)
- **Rate limits** (per IP, in memory): API 300/min · login 50 per 15 min per IP and 10 per 15 min per IP+email · refresh 30/min · reset/setup/forgot/change-password 10 per 15 min · upload 30/min. Over the limit → `429 RATE_LIMITED` with a `Retry-After` header.
- **Unknown fields** in a body or query → `422` (every schema is strict).

  - `VALIDATION_ERROR` details: `[{ path, message, code }]`

## Health (Phase 0)

### `GET /health`: liveness (never touches the DB)
`200` → `{ success: true, data: { status: "ok", app, env, uptimeSec, startedAt } }`

### `GET /health/ready`: readiness
- `200` → `{ success: true, data: { status: "ready", checks: { database: "up" } } }`
- `503` → `{ success: false, data: { status: "not_ready", checks: { database: "down" } } }`

---

## B1 — Auth, users, organization, audit, media

### Auth model (what the frontend must know)
- Browser calls go to the **frontend origin** (`/api/v1/*`, proxied by the Next.js rewrite). Cookies are HttpOnly, so JS never sees tokens.
  - `pp_at` — access token, 15 min, `SameSite=Lax`, `Path=/`
  - `pp_rt` — refresh token, 7 days (30 with `remember`), `SameSite=Strict`, `Path=/api/v1/auth`
- **401 handling (single-flight):** on `401 TOKEN_EXPIRED`, call `POST /auth/refresh` once (share one in-flight promise across all requests), then retry. If refresh returns 401 → go to `/login`. If it returns `409 REFRESH_SUPERSEDED` → just retry the original request (another tab already refreshed; the cookie jar already has the new token).
- Any other 401 code → go to `/login`.
- State-changing requests must carry the browser's normal `Origin` header (automatic). Foreign origins get `403 BAD_ORIGIN`.
- Server components can send the cookie through (`cookie` header) or use `Authorization: Bearer <pp_at>`.
- **Roles:** `admin`, `sales_manager`, `sales_executive`, `client`. The UI must gate on `user.permissions` (strings like `users:manage`), never on role names.

`User` shape (used below):
```json
{ "id", "name", "email", "phone": "+8801712345678" | null, "role", "status": "invited|active|disabled",
  "locale": "bn|en", "avatarMediaId": null, "lastLoginAt", "createdAt", "permissions"?: ["users:manage", …] }
```
`permissions` is included only in `/auth/login`, `/auth/refresh` and `/auth/me` responses.

### `POST /auth/login`
Body `{ email, password, remember?: boolean }` → `200 { user }` + both cookies.
Errors: `401 INVALID_CREDENTIALS`, `429 ACCOUNT_LOCKED` (5 failures → 15 min, then 30, 60, 120, 240), `403 ACCOUNT_DISABLED`.

### `POST /auth/refresh`
No body (uses the `pp_rt` cookie) → `200 { user }` + both cookies rotated.
Errors: `401 INVALID_REFRESH | SESSION_EXPIRED | REFRESH_REUSED` (cookies cleared), `409 REFRESH_SUPERSEDED` (retry).
A refresh token used twice (outside a 30 s multi-tab grace window) is treated as theft: the whole session is revoked.

### `POST /auth/logout` → `204`
Ends this device's session (works even with an expired access token). Clears cookies.

### `POST /auth/logout-all` 🔒 → `204`
Ends every session of the user on every device, immediately.

### `GET /auth/me` 🔒
`200 { user, org, features }`
- `org`: `{ id, name, nameBn, slug, legalName, email, phone, address, addressBn, website, tradeLicenseNo, rehabMemberNo, logoMediaId, settings: { defaultLocale, timezone, currency, fiscalYearStartMonth } }`
- `features`: `{ email, sms, onlinePayment, metaLeads }` (booleans) — hide UI for disabled features.

### `PATCH /auth/me` 🔒
Body (any of) `{ name, phone (BD mobile, any format) | null, locale: "bn"|"en" }` → `200 { user }`.

### `POST /auth/password/forgot`
Body `{ email }` → always `202 { message }` (no hint whether the email exists).
Active user → email with `${CLIENT_URL}/reset-password?token=…` (30 min). Invited user → a fresh setup link instead.

### `POST /auth/token/inspect`
Body `{ token, purpose: "password_reset"|"account_setup" }` → `200 { valid: false }` or `{ valid: true, email: "su•••@example.com", expiresAt }`.
Call it when the reset/setup page loads, to show "link expired" before the user types a password.

### `POST /auth/password/reset`
Body `{ token, password }` → `204`. All sessions end, so send the user to login.
Errors: `400 INVALID_TOKEN`, `422` (password policy). A weak password does **not** use up the link.

### `POST /auth/setup-account`
Body `{ token, password }` → `204` (account becomes `active`; then log in). Used for staff invites and, from B5, client portal activation.

> Reset/setup pages: read `token` from the URL, then remove it with `history.replaceState`, and set `<meta name="referrer" content="no-referrer">` so the token never leaks through the Referer header.

### `POST /auth/password/change` 🔒
Body `{ currentPassword, newPassword }` → `204`. Other sessions end; this one stays (a new `pp_at` cookie is set).
Errors: `400 INVALID_CURRENT_PASSWORD | PASSWORD_UNCHANGED`, `422`.

**Password policy** (when a password is set): 10–128 characters; not a common password; not one repeated character; must not contain the email name or first name (if 4+ letters). Login accepts any length up to 128.

### `GET /auth/sessions` 🔒
`200 [{ id, current, ip, userAgent, createdAt, lastUsedAt, expiresAt, remember }]`

### `DELETE /auth/sessions/:id` 🔒 → `204`
Revokes one of **your own** sessions (`404` otherwise). Revoking the current one also clears cookies.

---

### `GET /org/public` (no auth)
`200 { name, nameBn, logoMediaId, phone, email, address, addressBn, website, defaultLocale, features: { onlinePayment } }` — for the login page and public site header.

### `GET /org` 🔒 `org:read`
`200 { …org, features }`

### `PATCH /org` 🔒 `org:update`
Body (any of): `name, nameBn, legalName, email, phone, address, addressBn, website, tradeLicenseNo, rehabMemberNo, logoMediaId, settings: { defaultLocale, fiscalYearStartMonth }` → `200 org`. Nullable fields accept `null`.

---

### `GET /users` 🔒 `users:read`
Query `q?` (name/email/phone), `role?`, `status?`, `page`, `limit` → `200 User[]` + offset `meta`.

### `GET /users/:id` 🔒 `users:read` → `200 User`

### `POST /users` 🔒 `users:manage`
Body `{ name, email, role, phone?, locale? }` → `201 User` with `status: "invited"`. An account-setup email (72 h link) goes out. Duplicate email → `409 DUPLICATE`.

### `PATCH /users/:id` 🔒 `users:manage`
Body (any of) `{ name, phone | null, role, status: "active"|"disabled", locale }` → `200 User`.
- A role or status change logs the user out everywhere immediately.
- `403 SELF_CHANGE` (own role/status), `409 LAST_ADMIN`, `400 INVITE_PENDING` (can't activate an invited user by hand).

### `POST /users/:id/resend-invite` 🔒 `users:manage` → `204` (`409 ALREADY_ACTIVE` if already activated)

---

### `GET /audit` 🔒 `audit:read`
Query: `limit`, `cursor`, `action` (exact, or a prefix ending with `.`, e.g. `auth.`), `entityType`, `entityId`, `actorId`, `from`, `to` (ISO dates).
`200 [{ id, action, actor: { id, role, name, kind: "user"|"system"|"anonymous" }, entity: { type, id } | null, diff, meta, ip, requestId, createdAt }]` + cursor `meta`.
`diff` is `{ field: { from, to } }`; secret fields show only `{ changed: true }`. Entries are kept for `AUDIT_RETENTION_DAYS` (365).

Actions recorded so far: `auth.login`, `auth.logout`, `auth.logout_all`, `auth.account_locked`, `auth.refresh_reuse_detected`, `auth.password_reset_requested`, `auth.account_setup_requested`, `auth.password_reset`, `auth.account_setup`, `auth.password_change`, `user.create`, `user.update`, `user.profile_update`, `user.invite_resent`, `org.update`, `media.upload`, `media.delete`, `system.seed`.

---

### Media

`Media` shape:
```json
{ "id", "kind": "image"|"document", "purpose", "visibility": "public"|"private", "mime": "image/webp"|"application/pdf",
  "bytes", "width", "height", "blurDataUrl": "data:image/webp;base64,…" | null, "alt", "originalName",
  "urls": { "thumb", "card", "full" } | { "file" }, "uploadedBy", "createdAt" }
```
- **Public** URLs are absolute (`http://localhost:5030/uploads/2026/10/…-card.webp`) and cacheable forever. Add the backend media host to `images.remotePatterns`.
- **Private** URLs are relative API paths (`/api/v1/media/:id/file?variant=card`); the browser sends the cookie automatically. Not cacheable.
- Image variants (WebP): `thumb` 400 px, `card` 960 px, `full` 1920 px wide (never upscaled). Use `blurDataUrl` as the `<Image placeholder="blur">`.
- `purpose`: `general | logo | avatar | project_image | floor_plan | master_plan | brochure | document | payment_slip`.

### `POST /media` 🔒 `media:upload` or `media:upload_private`
`multipart/form-data`: `file` (required), `visibility?` (`public` default), `purpose?`, `alt?` → `201 Media`.
- `document` and `payment_slip` are always stored **private**.
- Clients may only upload `payment_slip`, `document` or `avatar`, always private.
- Images: EXIF orientation applied, all metadata (GPS, camera) removed.
- Errors: `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `422 INVALID_IMAGE`.

### `GET /media/:id` 🔒 → `200 Media`
### `GET /media/:id/file?variant=thumb|card|full|file` 🔒 → the file stream
Private files: only the uploader or `media:read_private`; everyone else gets `404` (existence is never confirmed).

### `DELETE /media/:id` 🔒 → `204`
Uploader or `media:delete`. Soft delete; the files are removed 7 days later by a background job.

---

### `POST /internal/cron/tick` (header `X-Cron-Secret: <CRON_SECRET>`)
`200 { processed }`. Runs due background jobs now. `404` when `CRON_SECRET` is not set. Not for the frontend.
