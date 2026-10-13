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
