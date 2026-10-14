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
`200 { name, nameBn, logoMediaId, logo: Media|null, phone, email, address, addressBn, website, tradeLicenseNo, rehabMemberNo, legalName, analytics: { ga4MeasurementId, metaPixelId }, defaultLocale, features: { onlinePayment } }` — for the login page and the public site header/footer, Privacy/Terms (`legalName`) and the consent-gated tracking tags (`analytics`, `null` = off; these IDs are public by nature) (`logo` = the public logo media with URLs). `PATCH /org` revalidates the website tag `org`.

### `GET /org` 🔒 `org:read`
`200 { …org, features }`

### `PATCH /org` 🔒 `org:update`
Body (any of): `name, nameBn, legalName, email, phone, address, addressBn, website, tradeLicenseNo, rehabMemberNo, logoMediaId, settings: { defaultLocale, fiscalYearStartMonth }, analytics: { ga4MeasurementId, metaPixelId }` → `200 org`. `ga4MeasurementId` = `G-` + 4–15 letters/digits (upper-cased), `metaPixelId` = 8–20 digits; `""` or `null` clears one, an omitted key is left as is. Nullable fields accept `null`. `website` must be an `http(s)://` URL (it is rendered as a link).

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

---

## B2 — Projects & Inventory

New error codes:

| Code | HTTP | When |
|---|---|---|
| `STALE_VERSION` | 409 | `version` in a PATCH/PUT is old — someone else changed the record (or a hold/booking happened). Reload and retry |
| `UNIT_STATE_CONFLICT` | 409 | Hold/release/block lost the race or the unit is in the wrong state. `details: { status, heldUntil }` |
| `HOLD_LIMIT` | 409 | You already hold `UNIT_HOLD_MAX_PER_USER` units. `details.limit` |
| `NOT_HOLDER` | 403 | Release by someone who is neither the holder nor `units:write` |
| `UNIT_LOCKED` | 409 | Price-affecting field edit on a sold unit (`details[].path`) |
| `UNIT_IN_USE` / `PROJECT_IN_USE` / `BLOCK_IN_USE` | 409 | Delete refused (held/sold units, or units still in the block) |
| `FIELD_NOT_ALLOWED` | 422 | In `details[].code`: apartment field on a plot (or the reverse) |
| `FLOOR_OUT_OF_RANGE` / `UNITS_OUTSIDE_RANGE` / `INVALID_FLOORS` | 400/409 | Floor outside the building's `lowestFloor…highestFloor` |
| `INVALID_BLOCK_KIND` | 400 | `building` on a plot project, `block`/`sector` on an apartment project |
| `INVALID_MEDIA` | 422 | Media id missing, private, or not an image where an image is needed |
| `INVALID_PLAN` / `INVALID_HOTSPOT_TARGET` / `FLOOR_NOT_IN_PLAN` | 400 | Floor-plan shape problems |

### Conventions for B2
- **Money** is integer **poisha** everywhere (`850000` = ৳8,500). Format on the client (lakh/crore).
- **Optimistic concurrency:** every editable record returns `version`. Send it back in `PATCH`/`PUT`; a mismatch → `409 STALE_VERSION`. Status actions (hold, release, block…) also bump the unit's `version`.
- **Area units** (owner decision 2026-10-12):
  - **Plot / land:** enter `{ value, unit: "katha" | "decimal" }` (≤ 4 decimals). Stored as entered (deed figure) **plus** derived `katha`, `decimal`, `sqft`, `sqm`:
    `LandArea = { value, unit, katha, decimal, sqft, sqm }`. Show the entered unit first and the other in brackets, e.g. `৩.৩০ শতাংশ (১.৯৯৬৫ কাঠা)`.
  - **Apartment:** `saleableSqft` (primary, ≤ 2 decimals) + derived `saleableSqm`; optional `carpetSqft` + `carpetSqm`. Show `১,২৫০ বর্গফুট (১১৬.১৩ বর্গমিটার)`.
  - Standards: 1 katha = 720 sq ft, 1 decimal = 435.6 sq ft (= 0.605 katha), 1 sq ft = 0.09290304 m². Conversions and prices use exact integer math (no float drift).
- **Effective status:** a hold whose time has passed is reported as `available` everywhere (a job also flips it in the DB every minute).

### Shapes
```jsonc
// Project
{ "id", "name", "nameBn", "slug", "kind": "apartment"|"plot", "stage": "upcoming"|"ongoing"|"ready"|"completed",
  "published", "publishedAt", "featured", "sortOrder", "tagline", "taglineBn", "description", "descriptionBn",
  "highlights": [{ "en", "bn" }], "amenities": ["lift", "generator"],
  "location": { "address", "addressBn", "area", "areaBn", "city", "district", "lat", "lng" },
  "landArea": LandArea | null, "approval": { "authority": "RAJUK|CDA|KDA|RDA|other", "number" } | null,
  "handoverAt": ISODate | null, "coverMediaId", "galleryMediaIds": [], "brochureMediaId",
  "media"?: { "cover": Media|null, "gallery": Media[], "brochure": Media|null },   // detail + list (cover only)
  "publicPricing": false, "pricing": RateCard, "pricingUpdatedAt",
  "inventory"?: { "total", "byStatus": { "available": 12, "held": 2, "booked": 5, … }, "availableFrom": poisha|null },
  "blocks"?: Block[],                                                              // detail only
  "version", "createdAt", "updatedAt" }

// Block (building for apartments; block/sector for plots)
{ "id", "projectId", "kind": "building"|"block"|"sector", "code": "A", "name", "nameBn",
  "lowestFloor": -2|null, "highestFloor": 14|null, "sortOrder", "version" }

// Unit (staff)
{ "id", "projectId", "blockId", "kind", "code": "A-5B",
  // apartment: "floor" (0 = ground, <0 basement), "position": "B", "typeLabel", "bedrooms", "bathrooms", "balconies",
  //            "saleableSqft", "saleableSqm", "carpetSqft", "carpetSqm", "parkingSlots"
  // plot:      "plotNo", "road", "roadWidthFt", "landArea": LandArea, "dimensions": { frontFt, backFt, leftFt, rightFt }
  "facing": "north|south|east|west|north_east|north_west|south_east|south_west"|null, "isCorner", "features": [],
  "layoutMediaId", "sortOrder", "rateOverride": poisha|null, "priceAdjustment": { "amount", "note" }|null,
  "listPrice": poisha|null,              // null = "price on request" (no rate card yet)
  "price"?: PriceBreakdown,              // GET /units/:id only
  "status": "available|held|booked|allotted|registered|handed_over|cancelled|blocked",
  "hold": { "by", "byName", "at", "until", "note", "leadId" } | null,
  "blockReason": "landowner_share|management_reserve|legal_issue|not_for_sale|other"|null, "blockNote",
  "statusChangedAt", "version", "createdAt", "updatedAt" }

// PriceBreakdown (what B4 will freeze into a booking)
{ "currency": "BDT", "strategy": "apartment_sqft"|"plot_land", "rateUnit": "sqft"|"katha"|"decimal",
  "lines": [{ "code": "base|floor_rise|facing|corner|road_width|parking|charge:<code>|adjustment",
              "amount", "qty"?, "qtyUnit"?, "rate"?, "label"?, "labelBn"?, "note"?, … }],
  "total" }
```

**RateCard** (`PUT /projects/:id/pricing`, full replacement; shape depends on the project kind):
```jsonc
// apartment
{ "ratePerSqft": 850000, "floorRise": { "fromFloor": 3, "perFloorPerSqft": 10000 },
  "facingPremiums": [{ "facing": "south", "perSqft": 20000 }],   // may be negative
  "cornerPerSqft": 15000, "parkingPerSlot": 40000000,
  "charges": [{ "code": "utility", "label": "Utility connection", "labelBn": "ইউটিলিটি সংযোগ", "amount": 15000000 }] }
// plot
{ "rateUnit": "katha"|"decimal", "rate": 250000000, "cornerPremiumBps": 1000,           // 10 % of base
  "roadWidthPremiums": [{ "minWidthFt": 25, "perUnit": 10000000 }, { "minWidthFt": 40, "perUnit": 25000000 }],
  "facingPremiums": [{ "facing": "south", "perUnit": 5000000 }], "charges": [ … ] }
```
Rules: floor rise applies from `fromFloor` upward (`(floor − fromFloor + 1) × perFloorPerSqft × sqft`); the best road tier with `minWidthFt ≤ roadWidthFt` applies; a unit's `rateOverride` replaces the base rate; `priceAdjustment` is a signed one-off line. Each line is rounded once; `total` = sum of lines.

### Projects 🔒
| Endpoint | Permission | Notes |
|---|---|---|
| `GET /projects?q&kind&stage&published=true\|false&page&limit` | `projects:read` | List + `inventory` + cover media |
| `POST /projects` | `projects:write` | Body: `name`, `kind` (required) + any project field. `slug` auto from the English name; a Bangla-only name needs `slug`. `landArea: { value, unit }`, `location.lat/lng` both or neither, `handoverAt: "YYYY-MM-DD"`. Media ids must be **public** images (brochure: public file) |
| `GET /projects/:id` | `projects:read` | Detail + `media`, `inventory`, `blocks` |
| `PATCH /projects/:id` | `projects:write` | Any field + `version`. `kind` cannot change. `published: true` puts it on the website |
| `DELETE /projects/:id` | `projects:write` | Soft delete (with blocks, units, floor plans). `409 PROJECT_IN_USE` if any unit is held or sold |
| `PUT /projects/:id/pricing` | `pricing:write` (admin) | `{ version, pricing: RateCard }` → project; `meta.repricedUnits`. Unsold units are re-priced; sold units never change |

### Blocks 🔒
`GET /projects/:id/blocks` (`projects:read`) · `POST /projects/:id/blocks` (`projects:write`; `{ kind, code, name, nameBn?, lowestFloor?, highestFloor?, sortOrder? }`) · `PATCH /projects/:id/blocks/:blockId` (`+ version`; narrowing floors with units outside → `409 UNITS_OUTSIDE_RANGE`) · `DELETE /projects/:id/blocks/:blockId` (`409 BLOCK_IN_USE` while it has units).

### Units 🔒
| Endpoint | Permission | Notes |
|---|---|---|
| `GET /projects/:id/units?blockId&floor&status&bedrooms&q&page&limit` | `units:read` | `status` also accepts `sold` (booked…handed over). `limit` up to 1000 (whole building for the grid). Sorted block → floor (top first) → sortOrder → code |
| `POST /projects/:id/units` | `units:write` | `blockId` required. Apartment: `floor` required; `code` defaults to `<block>-<floor><position>` (e.g. `A-5B`). Plot: `code` defaults to `<block>-<plotNo>`. `rateOverride`/`priceAdjustment` need `pricing:write` |
| `POST /projects/:id/units/bulk` | `units:write` | `{ units: [ …up to 500 ] }` → `201 Unit[]`, `meta.created`. All-or-nothing; errors point at `units.<i>.<field>` |
| `POST /projects/:id/units/prices` | `pricing:write` (admin) | **Price matrix** (F3.2). `{ dryRun?, items: [{ id, version, rateOverride?: poisha\|null, priceAdjustment?: { amount, note? }\|null }] }` (1–500, unique ids, each item sets at least one field; `null` clears). All-or-nothing. `dryRun: true` → `200 [{ id, code, rateOverride, priceAdjustment, previousListPrice, listPrice }]`, nothing written. Otherwise → `200 Unit[]` (same order) + `meta: { dryRun: false, changed }`; units get a new `version` and a `unit:status` delta (new `listPrice`) goes to staff sockets. Errors: unit of another project → `404` (`details[].path = items.<i>.id`); sold unit → `409 UNIT_LOCKED` (`items.<i>`); any old `version` → `409 STALE_VERSION` (`details[].path = items.<i>.version`, `message` = unit code). `rateOverride` is per sq ft (apartment) or per the rate card's `rateUnit` (plot) |
| `GET /units/:id` | `units:read` | Unit + `price` breakdown |
| `PATCH /units/:id` | `units:write` | Any unit field + `version`. Sold units: `blockId, floor, position, saleableSqft, landArea, parkingSlots, facing, isCorner, roadWidthFt, rateOverride, priceAdjustment` → `409 UNIT_LOCKED` |
| `DELETE /units/:id` | `units:write` | Only `available`/`blocked` (`409 UNIT_IN_USE`) |

**Status actions** (atomic — the losing request of a race gets `409 UNIT_STATE_CONFLICT`):
| Endpoint | Permission | Body → result |
|---|---|---|
| `POST /units/:id/hold` | `units:hold` | `{ hours? (default 24, max 72), note?, leadId? }` → held unit. From `available` (or an expired hold). `409 HOLD_LIMIT` |
| `POST /units/:id/hold/extend` | `units:write` | `{ hours }` → new expiry = now + hours |
| `POST /units/:id/release` | `units:hold` | Holder, or anyone with `units:write` (`403 NOT_HOLDER`) → `available` |
| `POST /units/:id/block` | `units:block` | `{ reason, note? }` (`note` required for `other`) → `blocked`. From `available` only |
| `POST /units/:id/unblock` | `units:block` | → `available` |
Booking/allotment/registration/hand-over/cancellation come with B4 (same machine: `available→held→booked→allotted→registered→handed_over`, `booked|allotted→cancelled→available`).

Audit actions: `project.create|update|pricing_update|delete`, `block.create|update|delete`, `unit.create|bulk_create|update|price_bulk_update|delete|hold|hold_extend|release|block|unblock|hold_expired`, `floorplan.create|update|delete`.

### Floor plans 🔒
Coordinates are **normalized 0–1** (x from left, y from top of the image), polygons of 3–100 points, ≤ 500 hotspots, stored to 5 decimals.
```jsonc
// FloorPlan
{ "id", "projectId", "kind": "floor"|"master", "blockId", "floors": [3,4,5], "title", "titleBn",
  "mediaId", "image": Media, "imageWidth", "imageHeight", "sortOrder", "version",
  "floor": 3,                                   // resolved floor (floor plans)
  "hotspots": [{ "key", "label", "unitId"|null, "position"|null, "blockId"|null, "points": [[0.1,0.2], …],
                 "target": { "type": "unit", "unit": Unit|null } | { "type": "block", "block": Block & { inventory } } | null }] }
```
- `kind: "floor"` (apartment): `blockId` + `floors[]` required. A **typical** plan covers many floors: hotspots use `position` (`"A"`) and are resolved to the unit at (block, floor, position) for the requested `?floor=`. A hotspot may also point at a fixed `unitId`.
- `kind: "master"` (plot layout / site plan): hotspots point at a `unitId` (plot) or a `blockId` (building/sector, with its inventory counts). No floors.
- A hotspot without a target is a label-only area (lift, stairs, park).

`GET /projects/:id/floorplans` (`projects:read`; list without hotspots, `hotspotCount`) · `POST /projects/:id/floorplans` (`projects:write`; `{ kind, blockId?, floors?, title, titleBn?, mediaId (public image), hotspots?, sortOrder? }`) · `GET /floorplans/:id?floor=` (`projects:read`; resolved) · `PATCH /floorplans/:id` (`projects:write`; any of `blockId, floors, title, titleBn, mediaId, hotspots, sortOrder` + `version`; `hotspots` replaces the whole list) · `DELETE /floorplans/:id`.

### Public catalogue (no auth) — `/public/*`
Published projects only. Blocked/cancelled units are never listed; hold details and internal prices are never sent. Public unit status: `available | held | sold | unavailable`. Responses carry `Cache-Control: public, max-age=30, stale-while-revalidate=60`.
| Endpoint | Returns |
|---|---|
| `GET /public/projects?q&kind&stage&city&area&featured&page&limit` | Cards: `{ id, slug, name, nameBn, kind, stage, featured, tagline(Bn), location, landArea, handoverAt, cover: Media, inventory: { total, available, held, sold, priceFrom } }` (`priceFrom` only when `publicPricing`) |
| `GET /public/projects/:slug` | Card + `description(Bn), highlights, amenities, approval, gallery, brochure, publicPricing, blocks[], floorPlans[]` |
| `GET /public/projects/:slug/units?blockId&floor&status=available\|held\|sold&bedrooms&page&limit≤500` | `PublicUnit[]` = unit fields without hold/price internals + `status` (public) + `price` (poisha, only when `publicPricing` and available/held) |
| `GET /public/units/:id` | `PublicUnit` + `layout: Media` + `project: { id, slug, name, nameBn, kind }` |
| `GET /public/floorplans/:id?floor=` | Resolved plan; a hidden unit's hotspot has `unitId: null` and `target.unit = { status: "unavailable" }` |

### Website leads — `POST /public/leads` (B3.1, live)
See **B3 › Website form** below.

### Real-time (Socket.IO)
- Connect **directly to the API host** (not through the Next.js rewrite): `io(NEXT_PUBLIC_SOCKET_URL, { auth: { token } })`, dev `http://localhost:5030`.
- `token` (staff only): `POST /auth/socket-token` 🔒 → `{ token, expiresIn: 60 }`. Use it right away; get a fresh one for every (re)connect. Public visitors connect without a token.
- Subscribe: `socket.emit('subscribe', { projectId, scope: 'public'|'staff' }, ack)` → `ack({ ok: true })` or `{ ok: false, code: VALIDATION_ERROR|FORBIDDEN|NOT_FOUND|TOO_MANY_SUBSCRIPTIONS }`. `public` = published projects; `staff` needs `units:read`. Re-subscribe after a reconnect. `unsubscribe` takes the same message.
- Event `unit:status`:
  - public: `{ unitId, projectId, status: "available|held|sold|unavailable" }`
  - staff: `{ unitId, projectId, code, status, hold: { byName, until } | null, listPrice, version, at }`
- Connection errors: `connect_error` with `err.data.code` (`INVALID_SOCKET_TOKEN`, `SESSION_INVALIDATED`, `ORG_NOT_CONFIGURED`).
- **Personal channel (B3):** a socket connected with a token joins its user's room automatically and receives `notification` events (same object as `GET /notifications` items). No subscribe call needed.

### Revalidation webhook (API → frontend)
When published content changes, the API calls the frontend (queued job, retried, bursts coalesced ~3 s):
```
POST <FRONTEND_REVALIDATE_URL, default CLIENT_URL/api/revalidate>
Content-Type: application/json
X-PrimePlot-Timestamp: 1791792000
X-PrimePlot-Signature: sha256=<hex HMAC-SHA256(REVALIDATE_SECRET, "<timestamp>.<raw body>")>

{ "tags": ["project:lake-view-residency", "projects"] }
```
The frontend route (F2) must: read the raw body, recompute the HMAC with the same `REVALIDATE_SECRET`, compare in constant time, reject timestamps older than 5 minutes, then `revalidateTag()` each tag. Tags: `projects` (listings), `project:<slug>` (detail, units, floor plans) and `org` (header/footer branding, sent after `PATCH /org`). Disabled when `REVALIDATE_SECRET` is empty.

---

## B3 — Leads & CRM

### Conventions for B3
- **Visibility:** `leads:read_own` (sales executive) sees only leads assigned to them — any other lead is **404**. `leads:read_all` (manager, admin) sees all. Filtering by another person's leads without `read_all` → `403`.
- **Phones** are stored in E.164. Input accepts BD mobiles in any common form (`01712-345678`, `+880…`, Bangla digits) and international numbers with a country code (`+971 50 123 4567`, `00971…`) for NRB buyers. Invalid → `400 INVALID_PHONE`.
- **One open lead per phone and type** (`buyer` / `landowner`). The website form and integrations add a repeat **enquiry** to the open lead; manual entry gets `409 DUPLICATE_LEAD` (`details[0].leadId` + `assigneeName` when you can see that lead). A closed (won/lost) lead doesn't block: a new one is created with `previousLeadId`.
- **Versions:** edits, moves, assignment, settings and tasks send the `version` they loaded; a mismatch → `409 STALE_VERSION`.
- **Money** (budgets) in poisha. Times are ISO UTC; "today" filters use Asia/Dhaka days.
- **Assignment** (owner decision 2026-10-13): round-robin among active **sales executives**; a project can have its own team (rotation inside the team). `manual` mode leaves new leads unassigned and notifies users with `leads:assign`. Executives creating a lead own it.
- **SLA** (owner decision): first response due **30 office minutes** after arrival (09:00–20:00 Dhaka, Friday off; editable). First response = the first call/SMS/email/WhatsApp/meeting/site-visit logged, or moving the lead out of the first stage. If nobody responds in time, every manager (`leads:assign`) gets one `lead.sla_breached` notification and the timeline gets `sla_escalated` (B3.2; job every minute; misses older than 7 days are not alerted). The lead's `slaEscalatedAt` is then set.

### Shapes
```jsonc
// Lead
{
  "id": "…", "version": 3, "type": "buyer",            // buyer | landowner
  "name": "Rahim Uddin", "phone": "+8801712345678", "altPhone": null, "email": null,
  "source": "website",   // website | facebook | instagram | manual | walk_in | phone | referral | other
  "sourceDetail": { "page": "/bn/projects/lake-view", "campaign": null, "medium": "google / cpc", "formName": null, "referrer": null },
  "message": "3 bed, south facing",
  "interest": { "projectId": "…", "project": { "id", "name", "nameBn", "slug", "kind" } | null,
                "unitId": null, "unitCode": null, "bedrooms": 3, "budgetMin": 800000000, "budgetMax": 1200000000 },
  "land": null | { "location", "area": LandArea, "roadWidthFt", "ownership": "sole|joint|inherited|company|other",
                   "mutation": "done|pending|not_started|unknown", "expectedShare": "50:50" },
  "stageId": "…", "stage": Stage,                      // stage included on detail/board/list
  "status": "open",                                    // open | won | lost (follows the stage kind)
  "rank": "a0V",                                       // Kanban order inside the stage
  "lostReason": null, "lostNote": null, "closedAt": null,
  "assigneeId": "…", "assigneeName": "Sumi", "assignedAt": "…",
  "slaDueAt": "…", "firstResponseAt": null, "slaBreached": false, "slaEscalatedAt": null,
  "lastActivityAt": null, "nextFollowUpAt": "…",       // earliest open task
  "enquiryCount": 2, "lastEnquiryAt": "…", "tags": ["vip"],
  "previousLeadId": null, "createdAt": "…", "updatedAt": "…"
}
// Stage
{ "id", "pipeline": "buyer", "key": "visit_scheduled", "name": "Site visit scheduled", "nameBn": "সাইট ভিজিট নির্ধারিত",
  "kind": "open|won|lost", "color": "neutral|sage|olive|sand|clay|sky|success|danger", "order": 2, "count"?: 14 }
// Activity (timeline, newest first)
{ "id", "leadId", "type", "body", "outcome", "durationSec", "at", "actorId", "actorName", "meta", "createdAt" }
//   staff types: note | call | sms | email | whatsapp | meeting | site_visit
//   system types: created | enquiry | stage_change | assigned | merged | task_created | task_done | updated
//                 | auto_reply | sla_escalated | meta_lead   (B3.2)
//   call outcome: connected | no_answer | busy | switched_off | wrong_number | call_back
//   meta examples: stage_change { from, to, status, lostReason } · assigned { from, to, fromName, toName, auto? }
//                  enquiry { source, page, projectId } · updated { fields: [...] } · merged { sourceId, sourceName, sourcePhone }
// Task
{ "id", "version", "leadId", "leadName", "leadPhone", "assigneeId", "assigneeName", "title",
  "type": "call|visit|meeting|follow_up|other", "dueAt", "remindAt", "status": "open|done|cancelled", "doneAt", "createdAt" }
```
Default stages — buyer: New → Contacted → Site visit scheduled → Visited → Negotiation → **Booked** (won) / **Lost**. Landowner: New → Contacted → Land inspection → Document check → Negotiation → **Agreement signed** (won) / **Dropped** (lost). Created on first use; editable.

### Leads 🔒
| Endpoint | Permission | Notes |
|---|---|---|
| `GET /leads` | read_own / read_all | Filters: `type, stageId, status, source, assignee=<id>\|me\|unassigned, projectId, tag, q` (name, email, ≥ 4 phone digits), `from, to` (createdAt), `followUp=overdue\|today\|upcoming\|none` (open leads), `slaBreached=true\|false`; cursor pagination (`cursor, limit ≤ 100`), newest first |
| `POST /leads` | `leads:write` | Body: `{ type?, name, phone, altPhone?, email?, source? (not website, default manual), sourceDetail?, message?, interest?, land?, tags?, assigneeId? }`. `assigneeId` omitted → executives own it, managers → round-robin; `null` → unassigned; another user needs `leads:assign`. → `201 Lead` · `409 DUPLICATE_LEAD` · `400 INVALID_PHONE / UNKNOWN_PROJECT / UNKNOWN_UNIT / UNIT_PROJECT_MISMATCH / INVALID_ASSIGNEE` |
| `GET /leads/board?type&assignee&projectId&source&tag&q&perStage≤100&closedDays≤365` | read | `{ type, stages: [Stage + { count, leads: Lead[] (by rank), hasMore }] }`. Won/lost columns: closed in the last `closedDays` (30) |
| `GET /leads/board/stages/:stageId?…&afterRank&afterId&limit` | read | Next cards of one column (same filters) → `Lead[]` + `meta { hasMore }` |
| `GET /leads/:id` | read | `Lead` (404 when not visible) |
| `PATCH /leads/:id` | `leads:write` | `{ version, name?, phone?, altPhone?, email?, source?, sourceDetail?, interest?, land? (landowner only), tags? }` → `Lead`; phone clash with another open lead → `409 DUPLICATE_LEAD` |
| `POST /leads/:id/move` | `leads:write` | `{ version, stageId, afterId?, beforeId?, lostReason? (required for a lost stage), lostNote? }` — `afterId` = card above, `beforeId` = card below (send both when known); none → top of the column. → `Lead`. Errors: `400 LOST_REASON_REQUIRED / UNKNOWN_STAGE`, `409 STALE_VERSION / STALE_POSITION` (reload the board) / `DUPLICATE_LEAD` (reopening while the phone has another open lead). Closing a lead cancels its open tasks |
| `POST /leads/:id/assign` | `leads:assign` | `{ version, assigneeId \| null }` → `Lead`. Open tasks move to the new owner, who is notified. Audited |
| `POST /leads/assign` | `leads:assign` | `{ ids ≤ 200, assigneeId \| null }` → `{ updated }` |
| `POST /leads/:id/merge` | `leads:assign` + `write` | `{ sourceId }` → target `Lead`: timeline + tasks move over, enquiry counts add up, empty fields are filled (`altPhone` ← source phone), source is hidden (404). Same type only (`400 TYPE_MISMATCH`) |
| `DELETE /leads/:id` | `leads:assign` + `write` | Soft delete, open tasks cancelled → `204` |
| `GET /leads/export?<list filters>` | `leads:read_all` | CSV (UTF-8 BOM for Excel/Bangla), ≤ 10,000 rows, formula-injection safe. Audited (`lead.export`) |
| `GET /leads/assignees` | read | `[{ id, name, role, locale }]` — active staff who can own leads (for pickers) |

Audit actions added: `lead.create` (manual), `lead.assign`, `lead.bulk_assign`, `lead.merge`, `lead.delete`, `lead.export`, `pipeline.update`, `lead_settings.update`.

### Activities & tasks 🔒
| Endpoint | Permission | Notes |
|---|---|---|
| `GET /leads/:id/activities?cursor&limit` | read | Timeline, newest first |
| `POST /leads/:id/activities` | `leads:write` | `{ type: note\|call\|sms\|email\|whatsapp\|meeting\|site_visit, body? (required for note), outcome? (calls only), durationSec?, at? (≤ 30 days back) }` → `201 Activity`. Any type except `note` sets `firstResponseAt` if empty |
| `GET /leads/:id/tasks?status&cursor&limit` | read | All tasks of a visible lead, by due time |
| `POST /leads/:id/tasks` | `leads:write` | `{ title, type?, dueAt, remindMinutesBefore? (0, 15 default, 30, 60, 120, 1440 or null), assigneeId? }` → `201 Task`. Default owner = the lead's owner; someone else needs `leads:assign`. Closed lead → `409 LEAD_CLOSED` |
| `PATCH /leads/tasks/:taskId` | `leads:write` | `{ version, title?, type?, dueAt?, remindMinutesBefore?, status? (open\|done\|cancelled), assigneeId? }` → `Task`. Owner or `read_all` only (else 404). Rescheduling re-arms the reminder |
| `GET /leads/tasks?scope=mine\|all&due=overdue\|today\|upcoming\|all&status=open&leadId&assigneeId&cursor&limit` | read (`all` needs read_all) | By due time; cursor = last (dueAt, id) |
| `GET /leads/tasks/counts` | read | `{ overdue, today }` for my open tasks |

Reminders: job `leads.taskReminders` (every minute) sends one `task.due` notification per task when `remindAt` passes.

### Pipeline & settings 🔒 `pipeline:manage` (manager, admin)
| Endpoint | Notes |
|---|---|
| `GET /leads/stages?type=buyer\|landowner` | `Stage[]` in order (`count` only for `leads:read_all`; readable by anyone with lead access) |
| `PUT /leads/stages` | `{ pipeline, stages: [{ id? (existing), name, nameBn?, kind, color? }] }` (3–15; array order = column order) → `Stage[]` with counts. Needs ≥ 1 open, exactly 1 won, ≥ 1 lost (`400 INVALID_PIPELINE`). Leaving out a stage removes it — `409 STAGE_IN_USE` if it holds leads; `409 STAGE_KIND_LOCKED` when a stage with leads changes kind. New leads land in the first open stage |
| `GET /leads/settings` | `{ version, assignment: { mode: round_robin\|manual, projectPools: [{ projectId, userIds }] }, sla: { enabled, firstResponseMinutes, officeStart: "09:00", officeEnd: "20:00", weekend: [5] }, autoReply: { enabled, textBn, textEn } }` |
| `PATCH /leads/settings` | Any part + `version`. `400 INVALID_OFFICE_HOURS / INVALID_ASSIGNEE / UNKNOWN_PROJECT`. Auto-reply placeholders: `{name}`, `{company}`. The filled-in text (with a long sample name) must fit **6 SMS** → else `400 AUTO_REPLY_TOO_LONG` (`details[].path` = `autoReply.textBn` / `textEn`). Check the length live with `POST /integrations/sms/preview` |

### Website form — `POST /public/leads` (no auth)
Body (strict): `{ type?: buyer|landowner, name, phone, email? ("" allowed), projectSlug?, unitId?, message?, land? (landowner), source: "website", page?, utm?: { source, medium, campaign }, hp, elapsedMs }`
- `201 { received: true }` for people **and** for bots (`hp` filled, or `elapsedMs` < 2500) — bots are dropped silently.
- `400 INVALID_PHONE`, `422 VALIDATION_ERROR`, `429` (5 per 10 minutes per IP). `Cache-Control: no-store`.
- An unknown/unpublished `projectSlug` is ignored (the lead is still saved). A repeat enquiry joins the open lead for that phone.

### Notifications 🔒 (own only)
| Endpoint | Notes |
|---|---|
| `GET /notifications?unread=true&cursor&limit` | `[{ id, type, data, readAt, createdAt }]` newest first. Kept 90 days |
| `GET /notifications/unread-count` | `{ count }` |
| `POST /notifications/read` | `{ all: true }` or `{ ids: [...] }` → `{ updated }` |

Types and `data` (the dashboard renders the text in the viewer's language):
- `lead.assigned` `{ leadId, name, type, source, by? }` — a lead was given to you
- `lead.enquiry` `{ leadId, name, type, source }` — your lead enquired again (unassigned → managers)
- `lead.unassigned` `{ leadId, name, type, source }` — new lead without an owner (to `leads:assign` users)
- `task.due` `{ taskId, leadId, title, dueAt, leadName, leadPhone }`
- `lead.sla_breached` `{ leadId, name, type, source, assigneeId, assigneeName, slaDueAt }` — first response overdue (to managers, once per lead) *(B3.2)*
- `integration.error` `{ integration: "meta"|"sms", code, message }` — Meta token expired / SMS key, sender ID or balance problem (to admins; at most once per 6 h per code) *(B3.2)*

---

## B3.2 — SMS, auto-reply, SLA escalation, Meta Lead Ads

### Auto-reply (customer SMS)
- Sent for a **new** lead from the website form or a Meta lead form — not for manual entry, not for a repeat enquiry on an open lead.
- At most **one per phone number in 24 hours**. Language: the website page (`/bn/…`, `/en/…`), else the company's default language. Text from `GET /leads/settings › autoReply` (`{name}` → the lead's name, max 40 chars; `{company}` → company name in that language).
- Queued, sent by job `sms.send` (4 attempts, ~3.5 min); not sent if still undelivered after **30 minutes**. Foreign numbers (NRB) are logged as `skipped` — Bangladesh gateways can't reach them.
- When settled, the lead's timeline gets `auto_reply` with `meta { smsId, status: sent|failed|skipped, segments, errorCode }`.

### SMS
- Drivers (env `SMS_DRIVER`): `log` (default — nothing leaves the server), `bulksmsbd` (form POST `https://bulksmsbd.net/api/smsapi`: `api_key, senderid, number, message`; `response_code 202` = accepted), `sslwireless` (JSON POST `https://smsplus.sslwireless.com/api/v3/send-sms`: `api_token, sid, msisdn, sms, csms_id`; our `csms_id` is unique per message so a retry can't bill twice). `SMS_API_URL` overrides the base URL. A real driver without `SMS_API_KEY` + `SMS_SENDER_ID` refuses to boot.
- Length: GSM-7 160 / 153 per part; anything outside GSM-7 (Bangla, emoji, curly quotes) → UCS-2 70 / 67 per part. Cost = segments × `SMS_COST_PER_SEGMENT_POISHA` (null when not set). Hard limit 8 segments per message (`400 SMS_TOO_LONG`).
- "Sent" = accepted by the gateway (handset delivery reports are not collected in v1). Setup errors (`AUTH_FAILED, SENDER_ID_INVALID, INSUFFICIENT_BALANCE, BALANCE_EXPIRED, IP_NOT_WHITELISTED, MASKING_NEEDS_BANGLA`) raise an `integration.error` notification to admins.

```jsonc
// SmsMessage
{ "id", "to": "+8801712345678", "body", "locale": "bn|en|null", "purpose": "lead_auto_reply|test", "leadId": null,
  "encoding": "gsm7|ucs2", "segments": 2, "costPoisha": 70, "driver": "log|bulksmsbd|sslwireless",
  "status": "queued|sent|failed|skipped", "attempts": 1, "error": { "code", "message" } | null,
  "sentAt", "failedAt", "createdAt" }
// error.code: UNSUPPORTED_DESTINATION · EXPIRED · INVALID_NUMBER · AUTH_FAILED · SENDER_ID_INVALID ·
//             INSUFFICIENT_BALANCE · BALANCE_EXPIRED · IP_NOT_WHITELISTED · MASKING_NEEDS_BANGLA ·
//             PROVIDER_REJECTED · PROVIDER_DOWN · PROVIDER_UNREACHABLE · PROVIDER_BAD_RESPONSE
```

### Integrations 🔒
`settings:integrations` = admin. Rows marked ★ also allow `pipeline:manage` (managers edit the auto-reply text).

| Endpoint | Notes |
|---|---|
| `GET /integrations` | `{ email: { enabled }, sms: { driver, live, senderId, costPerSegmentPoisha, thisMonth: { since, byStatus: { sent: { count, segments, costPoisha }, … } } }, meta: MetaStatus }` |
| `GET /integrations/sms/messages?status&purpose&leadId&cursor&limit` ★ | Delivery log, newest first → `SmsMessage[]` + cursor meta |
| `POST /integrations/sms/preview` ★ | `{ text ≤ 1600, locale?: bn\|en }` → `{ rendered, encoding, chars, units, segments, perSegment, remaining, costPoisha, maxSegments, driver, live, senderId, costPerSegmentPoisha }`. With `locale`, `{name}`/`{company}` are filled like the auto-reply (sample name "মোহাম্মদ রহিম উদ্দিন" / "Mohammad Rahim Uddin") |
| `POST /integrations/sms/test` | `{ to (BD mobile), text? ≤ 480 }` → `201 SmsMessage` (queued). `400 INVALID_PHONE`. Rate-limited (10 / 15 min). Audited `integration.sms.test` |
| `PUT /integrations/meta` | `{ pageId, accessToken }` — Page token, or a user / **system-user** token that manages the Page (the Page token is derived and stored AES-256-GCM encrypted; never returned). Subscribes the app to the Page's `leadgen` field and queues an import of the last 48 h → `MetaStatus`. Errors: `409 META_NOT_CONFIGURED` (env), `400 META_TOKEN_INVALID / META_PAGE_NOT_FOUND / META_PAGE_MISMATCH / META_SUBSCRIBE_FAILED` (`details[0]` has Meta's message), `409 META_PAGE_TAKEN`. Audited |
| `DELETE /integrations/meta` | Unsubscribes (best effort) and removes the Page → `204`; `404` when none |
| `GET /integrations/meta/forms` | Live from Meta: `[{ id, name, status, locale, createdTime, mapping: { type, projectId } \| null }]`. `409 META_TOKEN_UNREADABLE` when the server secret changed (connect again) |
| `PUT /integrations/meta/forms` | `{ version, mappings: [{ formId, formName?, type: buyer\|landowner, projectId? }] ≤ 200 }` → `MetaConnection`. Unmapped forms → buyer pipeline, no project. `400 UNKNOWN_PROJECT / DUPLICATE_FORM`, `409 STALE_VERSION` |
| `GET /integrations/meta/leads?status&cursor&limit` | Import log → `[{ id, leadgenId, formId, adId, via: webhook\|reconcile\|retry, status: received\|processing\|imported\|duplicate\|failed, attempts, leadId, leadName, error: { code, message, permanent } \| null, metaCreatedAt, processedAt, createdAt }]` |
| `POST /integrations/meta/leads/:id/retry` | A `failed` import → queued again → `{ queued: true }`; `404` otherwise |
| `POST /integrations/meta/sync` | Import the last 48 h now → `{ queued }` (false = one is already queued) |

```jsonc
// MetaStatus
{ "configured": true, "graphVersion": "v25.0", "webhookPath": "/api/v1/webhooks/meta",
  "connection": null | {
    "version": 3, "pageId": "1122334455", "pageName": "Acme Homes", "tokenHint": "…efgh",
    "status": "active|error", "lastError": { "code": "META_TOKEN_INVALID", "message", "at" } | null,
    "formMappings": [{ "formId", "formName", "type", "projectId" }],
    "connectedAt", "lastLeadAt", "lastReconciledAt", "lastReconcile": { "checked", "imported", "failed", "error" } },
  "last7Days": { "imported": 12, "duplicate": 3, "failed": 1 } }
```
Import error codes: `NO_PHONE` (permanent — the form has no usable phone question), `NOT_CONNECTED`, `META_TOKEN_INVALID` (connection → `error`, admins alerted; retry after reconnecting), `META_RATE_LIMITED`, `META_UNREACHABLE`, `META_GRAPH_ERROR`, `INTAKE_FAILED`.

### Meta webhook — `/webhooks/meta` (called by Meta, no auth)
- `GET ?hub.mode=subscribe&hub.verify_token=<META_VERIFY_TOKEN>&hub.challenge=<n>` → `200 text/plain <n>`; wrong token → `403`.
- `POST` (JSON, `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(META_APP_SECRET, raw body)>`) → `200 EVENT_RECEIVED`; bad/missing signature → `401`. Each `leadgen` change is stored once per leadgen id and imported by job `meta.fetchLead` (6 attempts). Pages that aren't connected are ignored.
- Whole route answers `404` while `META_APP_SECRET` / `META_VERIFY_TOKEN` are not set. Rate limit 600/min per IP.
- Imported leads go through the same intake as the website form: dedupe by phone (repeat → enquiry), round-robin, SLA clock, auto-reply. `source` = `facebook` or `instagram`; `sourceDetail { campaign: campaign name, medium: "meta / paid"|"meta / organic", formName }`; standard questions → name / phone / email, every other answer → a "Question: answer" line in `message`. Timeline: `meta_lead { leadgenId, formId, formName, adName, adsetName, campaign, organic, duplicate }`.
- Job `meta.reconcile`: once a night (02:00–06:00 Dhaka; any time if the last run is > 30 h old) it re-reads the last 48 h of every form and imports what is missing (or failed for a fixable reason).

Audit actions added: `integration.meta.connect`, `integration.meta.disconnect`, `integration.meta.forms`, `integration.meta.retry`, `integration.sms.test`.

---

## B2b — Site content, SEO & construction updates

Owner decisions 2026-10-14: **fixed sections** per page (edit, show/hide, reorder — no free page builder); **focus keyword + on-page check** instead of `meta keywords` (Google ignores them); **draft → preview → publish** with the last 20 published versions kept; all proposed Home/About sections.

New permission **`site:manage`** (admin, sales manager): page content, page SEO, site-wide SEO. Construction updates use `projects:write`.

New error codes:

| Code | HTTP | When |
|---|---|---|
| `UNKNOWN_PAGE` | 404 | Page key not in the list below |
| `UNKNOWN_SECTION` / `DUPLICATE_SECTION` | 400 | A section key that does not belong to the page, or the same key twice (`details[].path`) |
| `NO_CHANGES` | 409 | Publish with a draft identical to the live version |
| `REVISION_NOT_FOUND` | 404 | Restore of a version that is no longer kept |
| `INVALID_MEDIA` | 422 | Image id missing, private or not an image (same as B2) |

### Conventions
- **Bilingual text** `T = { "en": string, "bn": string }` (either may be `""`). The site shows the visitor's language and falls back to the other one when empty.
- **Placeholders:** `{company}` → the company name in that language. In titles, `*words*` → emphasis (italic accent). Long text: a blank line starts a new paragraph. No HTML anywhere.
- **Links** (`href`): a site path starting with `/` (no locale — the site adds it) or an `https://` URL.
- **Icons:** one of `shield-check, building, hammer, hard-hat, handshake, key, clock, receipt, map-pin, leaf, users, award, ruler, landmark, sparkles, eye, qr-code, home, file-check, phone, wallet, trees, sun, droplets, zap, lock`.
- **Images** are written as `…MediaId` (a **public** image uploaded via `POST /media`) and read back resolved as `Media` (with URLs) next to the id.
- A section is shown on the site when it is **enabled and has content** (lists need ≥ 1 item; the leader message needs text). Data-driven sections (featured / completed projects, areas, construction) also hide when there is nothing to show.

### Pages and sections
Section order = array order (editable). Keys are fixed per page; a key added in a later version is appended with its default content.

| Page key | Sections (key → type) |
|---|---|
| `home` | `hero`→hero · `stats`→stats · `featured`→heading · `whyUs`→cards · `trackRecord`→figures · `construction`→heading · `areas`→heading · `howItWorks`→steps · `testimonials`→testimonials · `landownerCta`→cta · `partners`→logos · `video`→video · `faq`→faq · `enquiry`→heading |
| `about` | `intro`→intro · `stats`→stats · `story`→story · `missionVision`→mission · `principles`→cards · `leaderMessage`→message · `team`→people · `quality`→cards · `completed`→heading · `credentials`→logos · `awards`→awards · `csr`→csr · `cta`→cta |
| `projects`, `contact`, `landowners`, `compare`, `privacy`, `terms` | none — SEO only |

```jsonc
// Section data by type (limits: titles ≤ 160, bodies ≤ 600, long text ≤ 5000 per language)
hero:         { eyebrow: T, title: T, body: T, primary: { label: T, href }, secondary: { label: T, href } }
stats:        { note: T }                                   // the numbers themselves are live from the catalogue
heading:      { eyebrow: T, title: T, body: T }
cards:        { eyebrow: T, title: T, body: T, items: [{ icon, title: T, body: T }] }          // ≤ 8
figures:      { eyebrow: T, title: T, body: T, items: [{ value: "15+", label: T }] }          // ≤ 6, value ≤ 12 chars
steps:        { eyebrow: T, title: T, items: [{ title: T, body: T }] }                        // ≤ 6
testimonials: { eyebrow: T, title: T, items: [{ name: T, role: T, quote: T, photoMediaId }] } // ≤ 12 — real customers only
cta:          { eyebrow: T, title: T, body: T, label: T, href }
logos:        { eyebrow: T, title: T, items: [{ name, group: "approval|membership|bank|partner", logoMediaId, url }] } // ≤ 24
video:        { eyebrow: T, title: T, body: T, youtubeUrl, posterMediaId }                    // youtube.com / youtu.be only
faq:          { eyebrow: T, title: T, items: [{ q: T, a: T }] }                               // ≤ 20 → FAQPage schema
intro:        { eyebrow: T, title: T, body: T (long), imageMediaId }
story:        { eyebrow: T, title: T, body: T (long), milestones: [{ year: "2012", title: T, body: T }] } // ≤ 20
mission:      { eyebrow: T, title: T, mission: T, vision: T, values: [{ title: T, body: T }] } // ≤ 8
message:      { eyebrow: T, name: T, designation: T, message: T (long), photoMediaId, signatureMediaId }
people:       { eyebrow: T, title: T, items: [{ name: T, designation: T, bio: T, photoMediaId }] } // ≤ 24
awards:       { eyebrow: T, title: T, items: [{ year, title: T, by: T, logoMediaId }] }        // ≤ 20
csr:          { eyebrow: T, title: T, body: T, items: [{ title: T, body: T, imageMediaId }] }  // ≤ 12
// On read every *MediaId has a sibling without "Id" holding Media|null, e.g. photoMediaId + photo.

// PageSeo (all optional — empty falls back to the site's automatic title/description)
{ "title": T, "description": T, "ogImageMediaId": null, "ogImage"?: Media|null, "noindex": false,
  "focusKeyword": T }   // focusKeyword is dashboard-only, never sent to the site
// Soft limits shown in the editor: title ≈ 60, description ≈ 160 characters. Hard: title ≤ 120, description ≤ 320.

// SitePage (dashboard)
{ "key": "home", "version": 4,
  "draft": { "sections": [{ "key": "hero", "type": "hero", "enabled": true, "data": { … } }], "seo": PageSeo },
  "hasChanges": true,                          // draft differs from the live version
  "publishedAt", "publishedByName", "draftUpdatedAt", "draftUpdatedByName",
  "defaults": { "<sectionKey>": data }         // for "reset this section to the default text"
}

// SiteSettings (site-wide SEO)
{ "version", "titleTemplate": T,               // must contain %s; default "%s | {company}"
  "defaultDescription": T, "defaultOgImageMediaId", "defaultOgImage"?: Media|null,
  "verification": { "google": "", "bing": "" }, // the content= value of the meta tag
  "social": { "facebook", "instagram", "youtube", "linkedin", "tiktok", "x" }, // https URLs or null → schema sameAs
  "indexing": true }                           // false → noindex on every page (staging)
```

### Content & SEO 🔒 `site:manage`
| Endpoint | Notes |
|---|---|
| `GET /site/pages` | `[{ key, sections (count), hasChanges, publishedAt, publishedByName, draftUpdatedAt, draftUpdatedByName }]` |
| `GET /site/pages/:key` | `SitePage` (draft + defaults, media resolved). First read creates it from the defaults |
| `PUT /site/pages/:key/draft` | `{ version, sections: [{ key, enabled, data }], seo }` → `SitePage`. Sending back the loaded data is fine — resolved image objects next to `…MediaId` are ignored. Full replacement of the draft; the site does not change. `409 STALE_VERSION`, `400 UNKNOWN_SECTION / DUPLICATE_SECTION`, `422 VALIDATION_ERROR` (`details[].path` e.g. `sections.3.data.items.0.title.bn`), `422 INVALID_MEDIA` |
| `GET /site/pages/:key/preview` | The draft in the **public** shape (below) — used by the site's preview mode |
| `POST /site/pages/:key/publish` | `{ version, note? ≤ 200 }` → `SitePage`. Draft becomes live, a version is kept (last 20), the site is revalidated (`site` tag). `409 NO_CHANGES`. Audited `site.publish` |
| `POST /site/pages/:key/discard` | `{ version }` → draft = live version (or the defaults if never published) |
| `GET /site/pages/:key/revisions` | `[{ n, note, publishedAt, publishedByName }]` newest first |
| `POST /site/pages/:key/revisions/:n/restore` | `{ version }` → `SitePage` with that version as the draft (publish to make it live). `404 REVISION_NOT_FOUND` |
| `GET /site/settings` · `PATCH /site/settings` | `SiteSettings`; PATCH: any part + `version` → live at once, revalidates `site`. Audited `site.settings_update` |

**Project SEO:** `Project.seo: PageSeo` (create/`PATCH /projects/:id`, same `version` rules). Public project detail returns `seo` without `focusKeyword`.

### Public (no auth)
| Endpoint | Returns |
|---|---|
| `GET /public/site` | `{ settings: SiteSettings (no version), pages: [{ key, publishedAt, noindex }] }` — layout metadata, schema, sitemap |
| `GET /public/site/pages/:key` | `{ key, publishedAt, sections: [{ key, type, data }], seo: { title, description, ogImage, noindex } }`. Only visible sections; media resolved; a `video` section also gets `data.youtubeId`; never-published pages return the defaults (`publishedAt: null`) |

The site caches both under the **`site`** tag (revalidated on publish / settings change).

**Draft preview (site ↔ API, server to server):** `GET /public/site/pages/:key?preview=1` with `X-PrimePlot-Timestamp` + `X-PrimePlot-Signature: sha256=<hex HMAC-SHA256(REVALIDATE_SECRET, "<timestamp>.preview:<key>")>` returns the **draft** in the public shape (`Cache-Control: no-store`); a missing/stale/wrong signature → `404`. The website calls it only in Next.js Draft Mode, which its `/api/preview` route turns on after checking the editor's session has `site:manage`.

### Construction updates
```jsonc
// ConstructionUpdate
{ "id", "version", "projectId", "blockId": null, "block"?: { "id", "code", "name", "nameBn" },
  "date": "2026-10-10", "title": T, "body": T, "percent": 45 | null,
  "milestone": "site_preparation|piling|foundation|basement|structure|roof|brickwork|finishing|handover" | null,
  "photos": [{ "mediaId", "media": Media, "caption": T }],     // ≤ 20, order = display order
  "published": false, "publishedAt", "createdByName", "createdAt", "updatedAt" }
```
| Endpoint | Permission | Notes |
|---|---|---|
| `GET /projects/:id/updates?published=true\|false&cursor&limit≤50` | `projects:read` | Newest `date` first |
| `POST /projects/:id/updates` | `projects:write` | `{ date (≤ tomorrow), title, body?, percent?, milestone?, blockId?, photos?, published? }` → `201` |
| `PATCH /construction-updates/:id` | `projects:write` | Any field + `version` |
| `DELETE /construction-updates/:id` | `projects:write` | Soft delete → `204` |
| `GET /public/projects/:slug/updates?cursor&limit≤20` | — | Published only, newest first (no version/author) |
| `GET /public/construction/latest?limit≤6` | — | The latest published update of each published project, newest first, with `project: { slug, name, nameBn, stage, cover }` |

Public project detail adds `construction: { percent, milestone, date, count } | null` (latest published update). Changes revalidate the project's tags and `site`.

---

## B4.1 — Customers, bookings, payment plans, receipts

Scope locked with the owner on 2026-10-14 (see PROGRESS › Resolved decisions). B4.2 adds cheques/PDC, transfer, cancellation, allotment/registration/handover, reschedule/charges and reports; B4.3 adds QR documents, PDF and the receipt e-mail.

### Conventions for B4
- **Money** in integer poisha. **Business dates** (booking, due, receipt dates) are calendar days in Dhaka time, sent and returned as `YYYY-MM-DD`.
- **Visibility:** `bookings:read` (executive) sees only bookings they sold, those bookings' receipts, and customers they created or sold to — anything else is **404**. `bookings:read_all` (manager, admin) sees everything.
- **Numbers:** booking `LVR-BK-00045` (per project), receipt `LVR-2627-000123` (per project per fiscal year, July–June from Company settings), customer `C-000123`. Booking and receipt numbers are taken inside the transaction → **gapless**; a reversed receipt keeps its number.
- **Project code** (`projects.code`, 2–6 letters/digits, unique, upper-cased) is required before the first booking: `422 PROJECT_CODE_REQUIRED`. Set it with `PATCH /projects/:id { code }`. Projects also carry `salesPolicy { cancellationDeductionBps (default 1000 = 10 %), transferFee (poisha, default 0) }` for B4.2.
- **Idempotency:** `POST /bookings` and `POST /bookings/:id/receipts` accept `Idempotency-Key` (8–100 chars `[A-Za-z0-9_-]`, a UUID fits). A retry with the same key returns the first result with `200` and `meta.replayed: true`; the same key from another user/booking → `409 IDEMPOTENCY_KEY_REUSED`; a malformed key → `400 INVALID_IDEMPOTENCY_KEY`.
- **Allocation:** a receipt pays the oldest unpaid schedule items first (dated items by due date, then items without a date — milestones/handover not called yet). Paying ahead pre-pays the next items; more than the outstanding balance → `422 OVERPAYMENT { outstanding }`.
- **Ledger:** receipts and reversals are append-only `ledger_entries`; `schedule[].paid` is a cache of it. `GET /bookings/:id/ledger` reports `integrity.ok`.

### Permissions
| Permission | Executive | Manager | Admin |
|---|---|---|---|
| `bookings:read` / `bookings:create` (incl. booking money at booking) | ✔ | ✔ | ✔ |
| `bookings:read_all`, `bookings:override` (waive booking money, custom schedule), `plans:manage`, `receipts:create` | | ✔ | ✔ |
| `receipts:reverse`, `bookings:discount_unlimited`, `accounts:settings` (settings, bank accounts) | | | ✔ |

Discount cap = `accounts settings.discountLimitBps[role]` × the unit's **base** price line (defaults: executive 1 %, manager 3 %). Above it → `403 DISCOUNT_LIMIT { capBps, maxAmount }`.

### Shapes
```jsonc
// Customer
{ "id", "customerNo": "C-000001", "name", "nameBn", "fatherName", "motherName", "spouseName",
  "dateOfBirth": "1985-04-12", "nationality": "Bangladeshi", "nid", "passportNo", "tin",
  "phone": "+8801712345678", "altPhone", "email", "presentAddress", "permanentAddress", "foreignAddress",
  "occupation", "organization", "locale": "bn|en|null", "photoMediaId", "documentMediaIds": [],
  "leadId", "notes", "hasPortalAccount": false, "version", "createdAt", "updatedAt" }
// Plan spec (template) — percent = basis points of the contract, fixed = poisha
{ "bookingMoney": { "type": "fixed", "value": 50000000 },
  "downPayment":  { "type": "percent", "value": 2000, "dueAfterDays": 15 } | null,
  "installments": { "count": 36, "everyMonths": 1|2|3|4|6|12, "firstDueAfterMonths"?: 1 } | null,
  "milestones":   [{ "key": "roof", "label": "Roof casting", "labelBn": "ছাদ ঢালাই", "type": "percent", "value": 500 }],
  "handover":     { "type": "percent"|"fixed", "value" } | { "type": "balance" } | null }
//   Exactly one part takes the balance: the installments, or (without installments) a handover of type balance.
//   Percent parts are rounded down to whole taka; installments are equal whole-taka amounts and the
//   last one absorbs the rounding — the schedule always equals the contract exactly.
// Schedule item
{ "id", "seq": 3, "code": "booking_money|down_payment|installment|milestone|handover|charge",
  "label": "Installment 1 of 36", "labelBn": "কিস্তি ১/৩৬", "dueDate": "2026-11-14" | null,
  "amount", "paid", "remaining", "status": "paid|partial|due|overdue|upcoming|not_called",
  "milestoneKey", "note" }
// Booking (detail; the list returns the summary part only)
{ "id", "bookingNo": "LVR-BK-00001", "project": { "id", "name", "nameBn", "slug", "kind", "code" },
  "unitId", "unitCode", "kind", "blockId", "customerId", "customerName",
  "customer": CustomerRef, "coApplicants": [CustomerRef], "nominees": [{ "name", "relation", "phone", "nid", "sharePct" }],
  "leadId", "soldBy": { "id", "name" }, "bookingDate": "2026-10-14",
  "price": { "strategy", "rateUnit", "lines": [PriceLine], "listTotal", "baseAmount",
             "discount": { "amount", "reason" }, "contractTotal" },
  "plan": { "id", "name", "custom": false }, "schedule": [ScheduleItem],
  "contractTotal", "totals": { "total", "paid", "outstanding", "dueNow", "overdue",
                               "nextDue": { "itemId", "dueDate", "amount" } | null },
  "bookingMoneyWaived": null | { "reason", "by": { "id", "name" } },
  "status": "active|cancelled", "note", "receipts": [Receipt], "version", "createdAt" }
// CustomerRef
{ "id", "customerNo", "name", "nameBn", "phone" }
// Receipt
{ "id", "receiptNo": "LVR-2627-000001", "fiscalYear": 2026, "projectId", "bookingId", "bookingNo",
  "unitId", "unitCode", "customerId", "customerName", "date": "2026-10-14",
  "amount", "amountText": "5,00,000.00",
  "amountInWords": { "en": "Five Lakh Taka Only", "bn": "পাঁচ লক্ষ টাকা মাত্র" },
  "mode": "cash|bank_transfer|pay_order|cheque|online|slip",
  "bankAccount": { "id", "name", "bankName", "accountNo" } | null, "reference", "instrumentNo",
  "instrumentBank", "instrumentDate", "context": "booking|payment",
  "allocations": [{ "itemId", "seq", "code", "label", "amount" }], "note",
  "receivedBy": { "id", "name" }, "status": "valid|reversed",
  "reversal": null | { "at", "by": { "id", "name" }, "reason" }, "createdAt" }
// Payment (request body for booking money and receipts)
{ "amount", "mode": "cash|bank_transfer|pay_order", "date"?: "YYYY-MM-DD",
  "bankAccountId"?, "reference"?, "instrumentNo"?, "instrumentBank"?, "instrumentDate"?, "note"? }
//   bank_transfer → bankAccountId + reference required; pay_order → instrumentNo + instrumentBank.
//   Cheques come with the cheque register (B4.2; receipt on clearing). Online/slip: B5.
```

### Customers 🔒 `/customers`
| Endpoint | Permission | Notes |
|---|---|---|
| `GET /customers?q&page&limit` | read / read_all | `q` matches name, customer no. prefix, exact NID/passport, phone in any form |
| `POST /customers` | `bookings:create` | → `201 Customer` · `409 DUPLICATE` (NID) · `400 INVALID_PHONE` · `422 INVALID_MEDIA` (photo/documents must be **private** uploads) · `404` lead not yours |
| `GET /customers/:id` | read / read_all | |
| `PATCH /customers/:id` | `bookings:create` | Body: any fields + `version` → `409 STALE_VERSION` |

### Payment plans 🔒 `/payment-plans`
| Endpoint | Permission | Notes |
|---|---|---|
| `GET /payment-plans?projectId&active` | read / read_all | With `projectId`: that project's plans + company-wide ones (`projectId: null`) |
| `POST /payment-plans` | `plans:manage` | `{ name, nameBn?, description?, projectId?, spec, active?, sortOrder? }` → `201` · `422` invalid spec |
| `PATCH /payment-plans/:id` | `plans:manage` | + `version`. Existing bookings keep their copy |
| `DELETE /payment-plans/:id` | `plans:manage` | Soft delete → `204` |

### Bookings 🔒 `/bookings`
| Endpoint | Permission | Notes |
|---|---|---|
| `POST /bookings/preview` | `bookings:create` | `{ unitId, planId \| schedule, bookingDate?, discount? }` → `{ unit { id, code, kind, status }, project { id, name, code }, price { lines, listTotal, baseAmount, discount, contractTotal }, discountCap { bps, maxAmount }, bookingDate, plan, schedule: [{ seq, code, label, labelBn, dueDate, amount, milestoneKey }], bookingMoney, bookingMoneyRequired, warnings: [PROJECT_CODE_REQUIRED \| UNIT_HELD_BY_OTHER \| UNIT_NOT_AVAILABLE] }`. Writes nothing |
| `POST /bookings` | `bookings:create` | See below → `201 Booking` |
| `GET /bookings` | read / read_all | Filters `projectId, status, soldBy (read_all), customerId (applicant or co-applicant), q (booking no. prefix, unit code, customer name), from, to (booking date)`; offset pagination; newest booking date first |
| `GET /bookings/:id` | read / read_all | Detail with receipts |
| `PATCH /bookings/:id` | `bookings:create` | `{ version, nominees?, note? }` |
| `GET /bookings/:id/ledger` | read / read_all | `{ entries: [{ id, date, type: receipt\|reversal, ref, receiptId, amount (signed), paidToDate, note, by }], schedule, totals, integrity { ok, paidTotal, ledgerTotal, mismatchedItems } }` |
| `POST /bookings/:id/receipts` | `receipts:create` | Body: Payment (`date` default today, ≤ today, ≥ booking date, at most `receiptBackdateDays` back) → `201 Receipt` |

**`POST /bookings` body:**
```jsonc
{ "unitId", "customerId", "coApplicantIds"?: [≤ 2], "nominees"?: [{ "name", "relation", "phone"?, "nid"?, "sharePct" }],  // shares = 100
  "leadId"?,                       // buyer lead visible to you → moved to the won stage + "booking" timeline entry
  "bookingDate"?: "YYYY-MM-DD",    // default today; not in the future; ≤ receiptBackdateDays back
  "planId" | "schedule": [{ "code", "label"?, "labelBn"?, "dueDate"?, "amount" }],  // custom: bookings:override, must equal the contract
  "discount"?: { "amount", "reason" },                // reason required when amount > 0
  "expectedTotal"?: 1030000000,    // list total the wizard showed → 409 PRICE_CHANGED if the rate card changed
  "payment"?: Payment,             // booking money, dated the booking date; ≥ the booking-money item
  "waiveReason"?: "…",             // instead of payment — bookings:override
  "note"? }
```
One transaction: unit → `booked` (from `available`, an expired hold, your own hold, or — with `units:write` — anyone's hold) + booking number + price snapshot + schedule + booking-money receipt + customer access for the seller + audit. After commit: unit socket delta + website revalidation, lead → won, receipt SMS (if switched on).

Errors: `409 UNIT_HELD_BY_OTHER · UNIT_STATE_CONFLICT { status } · PRICE_CHANGED { listTotal }` · `403 DISCOUNT_LIMIT · CUSTOM_SCHEDULE_NOT_ALLOWED · WAIVE_NOT_ALLOWED` · `422 PROJECT_CODE_REQUIRED · PRICE_NOT_SET · INVALID_DISCOUNT · BOOKING_MONEY_REQUIRED { required } · BOOKING_MONEY_SHORT { required } · OVERPAYMENT · INVALID_LEAD · PLAN_EXCEEDS_PRICE · INVALID_PLAN(spec) · SCHEDULE_TOTAL_MISMATCH { contract, scheduled, difference } · INVALID_SCHEDULE · BOOKING_DATE_IN_FUTURE · BOOKING_DATE_TOO_OLD` · `400 INVALID_PLAN (plan not available) · INVALID_BANK_ACCOUNT · INVALID_PHONE` · `404` unit/customer/lead not visible.

Receipt errors: `409 BOOKING_NOT_ACTIVE · BOOKING_BUSY (retry)` · `422 OVERPAYMENT · RECEIPT_DATE_IN_FUTURE · RECEIPT_DATE_TOO_OLD · RECEIPT_BEFORE_BOOKING · PROJECT_CODE_REQUIRED` · `400 INVALID_BANK_ACCOUNT`.

### Receipts 🔒 `/receipts`
| Endpoint | Permission | Notes |
|---|---|---|
| `GET /receipts` | read / read_all | Filters `projectId, bookingId, mode, status, receiptNo, from, to` (receipt date); cursor pagination, newest first |
| `GET /receipts/:id` | read / read_all | |
| `POST /receipts/:id/reverse` | `receipts:reverse` | `{ reason }` (≥ 3 chars) → reversed Receipt. Negative ledger entry with the same allocations; the number stays used. `409 ALREADY_REVERSED` |

### Accounts settings & bank accounts 🔒 `/accounts`
| Endpoint | Permission | Notes |
|---|---|---|
| `GET /accounts/settings` | `accounts:read` | `{ version, discountLimitBps { sales_executive, sales_manager }, bookingMoneyRequired, receiptBackdateDays, notify { receiptEmail, receiptSms } }` (defaults 100 / 300 / true / 31 / true / false) |
| `PATCH /accounts/settings` | `accounts:settings` | Partial + `version` |
| `GET /accounts/bank-accounts?active` | `accounts:read` | `[{ id, name, bankName, branch, accountName, accountNo, routingNo, active, version }]` |
| `POST /accounts/bank-accounts` | `accounts:settings` | `409 DUPLICATE` account no. |
| `PATCH /accounts/bank-accounts/:id` | `accounts:settings` | + `version`; deactivate with `active: false` (never deleted) |

Receipt SMS (`notify.receiptSms`, off by default): `প্রিয় {first name}, আপনার ৳{amount} পেমেন্ট গ্রহণ করা হয়েছে। রসিদ নং {receiptNo}। ধন্যবাদ — {company}` (English for customers with `locale: en`), SMS log purpose `receipt`. The receipt e-mail with the PDF arrives in B4.3.

---

## B4.2 — Cheques, sale stages, schedule changes, transfer, cancellation, reports

All writes run in one MongoDB transaction with the booking's version check; a concurrent change → `409 STALE_VERSION`. Event dates (`date`) default to today (Dhaka), cannot be in the future (`422 DATE_IN_FUTURE`) or before the booking (`422 DATE_TOO_EARLY`). Actions on a cancelled booking → `409 BOOKING_NOT_ACTIVE`; at the wrong stage → `409 BOOKING_STAGE_CONFLICT { stage }`.

### Permissions (additions)
| Permission | Executive | Manager | Admin |
|---|---|---|---|
| `cheques:manage` (register, deposit, clear, bounce, return) | | ✔ | ✔ |
| `bookings:override` — also: allot / register / handover, transfer, charges, call items, reschedule, change the cancellation deduction | | ✔ | ✔ |
| `bookings:cancel` (cancel, refunds) | | ✔ | ✔ |
| `reports:read` | | ✔ | ✔ |
| `documents:issue` (statement) | | ✔ | ✔ |

Executives can still take **booking money by cheque** inside `POST /bookings` (`payment.mode: "cheque"`).

### Shapes
```jsonc
// Cheque
{ "id", "bookingId", "bookingNo", "projectId", "unitCode", "customerId", "customerName",
  "chequeNo": "0045123", "bank": "BRAC Bank", "branch", "chequeDate": "2026-11-14", "amount",
  "receivedDate", "postDated": true,
  "status": "received|deposited|cleared|bounced|returned",
  "depositBankAccount": { "id", "name", "bankName", "accountNo" } | null, "depositedDate",
  "clearedDate", "receiptId", "bouncedDate", "bounceReason", "bounceCount", "returnedReason",
  "history": [{ "status", "date", "at", "by": { "id", "name" }, "note" }], "note", "createdAt" }
// Booking detail — additions
{ "stage": "booked|allotted|registered|handed_over",
  "allotment": { "date", "by", "note" } | null,
  "registration": { "date", "by", "note", "deedNo", "subRegistryOffice" } | null,
  "handover": { "date", "by", "note" } | null,
  "holders": [{ "id", "customerId", "customerName", "until", "toCustomerId", "fee", "feeWaivedReason", "by", "note" }],
  "cancellation": { "date", "by", "reason", "paid", "deductionBps", "deduction", "refundable",
                    "refunded", "refundDue", "overrideReason" } | null,
  "cheques": [Cheque],
  "schedule": [{ …ScheduleItem, "chargeKind": "delay|utility|registration|transfer_fee|cheque_bounce|other" | null }] }
// Booking summary (list) gains "stage". totals.total / outstanding include charges; contractTotal never does.
// POST /bookings payment by cheque
{ "mode": "cheque", "chequeNo", "bank", "branch"?, "chequeDate", "amount", "note"? }
//   → booking created, cheque `received`, no receipt yet (booking money counts as "taken").
// Ledger entry types: receipt | reversal | refund. GET /bookings/:id/ledger adds "refunded" and per-row "refundedToDate";
// integrity compares receipts + reversals with the schedule (refunds are not allocated).
```

### Cheques 🔒
| Endpoint | Permission | Notes |
|---|---|---|
| `POST /bookings/:id/cheques` | `cheques:manage` | `{ chequeNo, bank, branch?, chequeDate, amount, receivedDate?, note? }` → `201 Cheque` + cheque acknowledgement document. `409 DUPLICATE_CHEQUE` (same bank + number still open) · `422 OVERPAYMENT { outstanding, pendingCheques }` (open cheques count) · `422 CHEQUE_STALE` (dated > 6 months ago) |
| `GET /cheques` | read / read_all | `status, open=true, projectId, bookingId, dueFrom, dueTo (cheque date), q (cheque no. prefix)`; cursor, newest first. Executives: own bookings |
| `GET /cheques/:id` | read / read_all | |
| `POST /cheques/:id/deposit` | `cheques:manage` | `{ bankAccountId, date?, note? }` from `received` or `bounced` (re-presenting) |
| `POST /cheques/:id/clear` | `cheques:manage` | `{ date?, bankAccountId? (required if not deposited), note? }` from `received`/`deposited` → `{ cheque, receipt }`. The numbered receipt (mode `cheque`, instrument = cheque no./bank/date) and the allocation are made here. Receipt date rules apply (`RECEIPT_DATE_*`) · `422 OVERPAYMENT` if the balance dropped meanwhile · `409 BOOKING_NOT_ACTIVE` (cancelled → return the cheque) |
| `POST /cheques/:id/bounce` | `cheques:manage` | `{ reason, date?, fee? }` from `deposited`. Adds a `cheque_bounce` charge (default: accounts setting `chequeBounceFee`, 0 = none) and notifies the seller + cheque managers (`cheque.bounced`) |
| `POST /cheques/:id/return` | `cheques:manage` | `{ reason }` from `received`/`bounced`; voids the acknowledgement |
Wrong state → `409 CHEQUE_STATE_CONFLICT { status }`.

### Sale stages 🔒 `bookings:override` → `{ data: Booking, meta: { warnings: [...] } }`
| Endpoint | Body | Notes |
|---|---|---|
| `POST /bookings/:id/allot` | `{ date?, note? }` | booked → allotted (unit too) + allotment letter. Warnings (never blocks, owner Q6): `BOOKING_MONEY_UNPAID`, `DOWN_PAYMENT_UNPAID` |
| `POST /bookings/:id/register` | `{ deedNo, subRegistryOffice?, date?, note? }` | allotted → registered. Warning `DUES_OUTSTANDING` |
| `POST /bookings/:id/handover` | `{ date?, note? }` | registered → handed_over |

### Schedule changes 🔒 `bookings:override`
| Endpoint | Body | Notes |
|---|---|---|
| `POST /bookings/:id/charges` | `{ kind: delay\|utility\|registration\|other, label, labelBn?, amount, dueDate, note? }` | → `201 Booking`. Charges are outside the contract price (delay charge is manual in v1) |
| `POST /bookings/:id/charges/:itemId/waive` | `{ reason }` | Removes an **unpaid** charge (`409 ITEM_PAID_LOCKED` otherwise) |
| `POST /bookings/:id/schedule/:itemId/call` | `{ dueDate, note? }` | Give a milestone/handover (or any unpaid) item its due date |
| `PUT /bookings/:id/schedule` | `{ version, reason, items: [{ id?, code, label?, labelBn?, dueDate?, amount }] }` | Replaces the contract items (charges kept). Must equal the contract (`422 SCHEDULE_TOTAL_MISMATCH`). `422 INVALID_SCHEDULE` with details when: booking-money item not kept, an item with payments removed or below its paid amount, a fully paid item changed, a type changed, a date before the booking. Before/after go to the audit log |

### Transfer 🔒 `bookings:override`
`POST /bookings/:id/transfer` `{ toCustomerId, coApplicantIds?, nominees?, date?, note?, waiveFeeReason? }` — booked/allotted only. `409 OVERDUE_DUES { overdue }` · `409 OPEN_CHEQUES` · `422 SAME_HOLDER`. Adds `project.salesPolicy.transferFee` as a `transfer_fee` charge (unless waived with a reason), moves the previous holder to `holders[]`, voids the old booking form / allotment letter, issues a transfer letter and new ones for the new holder. Existing receipts keep the old name.

### Cancellation & refunds 🔒 `bookings:cancel`
| Endpoint | Body | Notes |
|---|---|---|
| `POST /bookings/:id/cancel/preview` | `{ deductionAmount? }` | `{ paid, deductionBps, policyDeduction, deduction, refundable, overridden, openCheques, blockers }` |
| `POST /bookings/:id/cancel` | `{ reason, date?, deductionAmount?, overrideReason? }` | booked/allotted only (`409 BOOKING_STAGE_CONFLICT` after registration). Default deduction = `salesPolicy.cancellationDeductionBps` × amount paid. A different amount needs `bookings:override` (`403 DEDUCTION_OVERRIDE_NOT_ALLOWED`) and `overrideReason` (`422 OVERRIDE_REASON_REQUIRED`); `422 INVALID_DEDUCTION` above the amount paid · `409 OPEN_CHEQUES`. Unit → cancelled → available (on sale again); booking `status: cancelled`; cancellation letter; booking form / allotment letter voided |
| `POST /bookings/:id/refunds` | `{ amount, mode: cash\|bank_transfer\|pay_order\|cheque, date?, bankAccountId?, reference?, instrumentNo?, note? }` | Cancelled bookings only (`409 BOOKING_NOT_CANCELLED`). Refunds in parts; `422 REFUND_EXCEEDS_DUE { refundDue }`. Ledger entry `refund` with ref `LVR-RF-00001` (gapless per project) → `201 { refund { id, ref, date, amount, mode, note }, refundDue }` |

### Reports 🔒 `reports:read`
| Endpoint | Query | Response |
|---|---|---|
| `GET /reports/dues` | `projectId, soldBy, asOf (default today), overdueOnly (default true), page, limit` | `{ asOf, totals { outstanding, dueNow, overdue, buckets { d1_30, d31_60, d61_90, d90_plus }, bookings }, items: [{ bookingId, bookingNo, project, unitCode, stage, customer { id, name, phone }, soldBy, contractTotal, outstanding, dueNow, overdue, buckets, oldestDueDate, nextDue }], meta }` — most overdue first |
| `GET /reports/collections` | `projectId, from, to (default this month), interval=day\|month` | `{ from, to, interval, total { count, amount }, byMode [{ mode, count, amount }], byProject [{ projectId, project, count, amount }], byPeriod [{ period, count, amount }], refunds { count, amount }, reversedReceipts }` — valid receipts by receipt date |
| `GET /reports/pdcs` | `projectId, from (default today − 1 year), to (default today + 30 days)` | `{ from, to, today, totals { dueNow, upcoming, bounced }, dueNow: [Cheque], upcoming: [Cheque], bounced: [Cheque] }` — open cheques by cheque date + bounced ones needing action |

### Settings (addition)
`accounts settings.chequeBounceFee` (poisha, default 0) — `PATCH /accounts/settings { version, chequeBounceFee }`.

---

## B4.3 — QR-verified documents & PDF

### How it works
- **Types:** `receipt`, `booking_form`, `allotment_letter`, `statement`, `cancellation_letter`, `transfer_letter`, `cheque_ack`.
- **Issued automatically** after the money/stage action commits: booking → booking form (+ receipt or cheque acknowledgement); receipt / cheque clearing → receipt; allotment → allotment letter; cancellation → cancellation letter; transfer → transfer letter + new booking form (+ allotment letter). Statements are issued on demand. A document that failed to issue is back-filled when the booking's document list is opened.
- **Frozen:** each document stores a snapshot of what it prints (company, project, unit, holder, amounts, schedule…) and `contentHash` = SHA-256 of `{ type, number, snapshot }`. Later edits never change an issued document. Only the logo is drawn live.
- **Void:** reversed receipt → its receipt document; returned cheque → acknowledgement; cancellation/transfer → booking form + allotment letter. A void document still opens, with a **VOID / বাতিল** watermark, and verifies as invalid.
- **Language:** the holder's `locale`, else the company default; every page/PDF can be asked for in `bn` or `en`.
- **Numbers:** receipt = receipt no.; booking form = booking no.; others `LVR-BK-00001/AL`, `/CN`, `/TR-1`, `/ST-20261014`, `/CQ-<cheque no.>`.
- **QR / link:** `<PUBLIC_SITE_URL or CLIENT_URL>/verify/<token>` (token: 24 random URL-safe chars).
- **PDF:** the same HTML printed by headless Chrome (Puppeteer, one shared browser, 2 pages at a time, `PDF_TIMEOUT_MS`). Valid documents are printed once per language and kept in private storage; void ones are printed fresh. Chrome missing → `503 PDF_UNAVAILABLE`.
- **Receipt e-mail** (setting `notify.receiptEmail`, on): job `documents.emailReceipt` sends the PDF to the customer's e-mail (BN/EN template `receipt`, verify button). Skipped when the receipt was reversed before sending.

### Shapes
```jsonc
// Document
{ "id", "type", "number", "bookingId", "refId", "locale": "bn|en", "date": "2026-10-14",
  "status": "valid|void", "voidReason", "voidedAt", "verifyUrl", "contentHash",
  "issuedBy": { "id", "name" } | null, "createdAt" }
// Public verification
{ "valid": true, "status": "valid|void", "voidReason", "type", "number", "date", "issuedAt",
  "organization": { "name", "nameBn" }, "project": { "name", "nameBn" }, "unitCode",
  "holder": "A**** R****",   // masked — no phone, NID or address
  "amount": 50000000 | null, // receipt, cheque ack, booking form (contract), cancellation (refundable)
  "fingerprint": "e3b0c44298fc1c14" }
```

### Endpoints
| Endpoint | Permission | Notes |
|---|---|---|
| `GET /bookings/:id/documents` | read / read_all | Newest first (back-fills missing ones) |
| `POST /bookings/:id/statement` | `documents:issue` | → `201 Document` (statement as of today) |
| `GET /documents/:id` | read / read_all | Seller scope like receipts (404 otherwise) |
| `GET /documents/:id/html?locale=bn\|en` | read / read_all | The A4 page, `text/html`, self-contained (fonts, QR, logo inlined; no scripts; CSP `default-src 'none'`). F5 shows it in an iframe and prints it |
| `GET /documents/:id/pdf?locale=&download=1` | read / read_all | `application/pdf`, `inline` (or `attachment` with `download=1`) |
| `GET /public/verify/:token` | none | Not cached. Unknown/malformed token → 404 |

### Env (new, optional)
`PUBLIC_SITE_URL` (QR base, default `CLIENT_URL`), `PDF_CHROME_PATH` (use an installed Chrome/Chromium; default: the one `npm install` downloaded), `PDF_NO_SANDBOX` (true only when Chrome runs as root on a VPS), `PDF_TIMEOUT_MS` (30000).
