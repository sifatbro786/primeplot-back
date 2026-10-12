# PrimePlot — Progress Tracker

> **This is the project's single source of truth for progress.** On a new chat or a new PC, read this file first, then `ARCHITECTURE.md`.
> At the end of every work session, update this file: tick the checkboxes, update "Current status" and "Next step", and add a Session Log entry.

---

## 📍 Current status

| | |
|---|---|
| **Current phase** | F3: Dashboard Inventory — **code complete** (step 1 + step 2). Next: F2 public site or B3 Leads & CRM (owner picks) |
| **Last completed** | F3.2 plans (hotspot editor + live plan viewer), price list (bulk per-unit prices), gallery + brochure; backend `POST /projects/:id/units/prices` (2026-10-12) |
| **Next step** | Owner: `npm test` (backend — new price-matrix integration tests), restart both servers, try Plans / Price list / Gallery against the real API → then choose F2 or B3 |
| **Blocker** | None. D1/D3/D4 still open (not blocking F2/F3) |

---

## ❓ Open decisions (owner confirmation needed)

| # | Topic | Proposed default | Needed by |
|---|---|---|---|
| D1 | PDF approach in v1 | One HTML template → A4 print page + Puppeteer PDF on the VPS (email attachment) + QR verify | Before B4 |
| D2 | SMS gateway provider | Build `log` + BulkSMSBD + SSL Wireless drivers; the client's keys go in `.env` | When the client onboards (code ready in B3) |
| D3 | Frontend hosting | Vercel (free, easiest) or the same Hostinger VPS (Next standalone + PM2). Code works in both | Before deploy |
| D4 | v1/v2 split | See ARCHITECTURE §4 (proposed) | Before B2 |

## ✅ Resolved decisions
- 2026-10-11: single-tenant + `orgId`; apartment + plot; no Redis
- 2026-10-12: **Area units** — plots/land take **katha or decimal (শতাংশ)** as entered (deed figure kept as the source of truth) and the backend stores both (+ sq ft, sq m), with exact auto-conversion (1 katha = 720 sft, 1 decimal = 435.6 sft). Apartments: **sq ft primary**, sq m derived and stored so views can show both.
- 2026-10-12: **D5 accepted** — manual payments (cash/cheque/PDC/bank transfer/pay order) are first-class; the client can upload a bank-transfer slip in the portal and staff verify it (verified slip → normal receipt); SSLCommerz optional; Stripe not in v1 (gateway adapter keeps it addable). Slip storage (private `payment_slip` media) is built in B1; the slip workflow lands in B4/B5.
- 2026-10-11 (rev): dev-only for now, backend on the Hostinger VPS at the end; **Cloudinary dropped → local `uploads/`**; SSLCommerz + SMS fully built and env-driven; Unsplash/Pexels placeholders; Node ≥ 24; `PORT=5030`; Atlas URI and SMTP set in `.env`

---

## 🗺️ Roadmap & checklist

Legend: `[x]` done · `[~]` in progress · `[ ]` not started

### Phase 0: Foundation (both)
- [x] 0.1 Backend: declare missing deps in `package.json`, `"engines": {"node": ">=24"}`, drop dotenv/nodemon (`process.loadEnvFile` + `node --watch`), `.env.example`
- [x] 0.2 Backend: ESLint + Prettier, `src/` skeleton, Express 5 `app.js`, health check `/api/v1/health`, graceful shutdown
- [x] 0.3 Backend: Zod-validated `config/env.js` (fail-fast), pino logger, request ID
- [x] 0.4 Backend: `config/db.js` (Atlas M0) + `shared/plugins/baseSchema.js` (orgId, timestamps, soft delete)
- [x] 0.5 Backend: `AppError` hierarchy, central error handler, 404, response shape
- [x] 0.6 Frontend: `next.config.mjs` rewrites (`/api/*` → `localhost:5030`), `images.remotePatterns` (Unsplash/Pexels/backend), `.env.example`, `engines >=24`
- [x] 0.7 Frontend: design tokens (Tailwind v4 `@theme`), fonts (EN + BN), base layout
- [~] 0.8 Both: verify (backend boots and connects to the DB; frontend proxies the health check), commit — owner checks together with B1 (`npm run seed` proves the DB connection)

### B1: Core platform (Backend)
- [x] Organization model + seed script (default org + first Admin)
- [x] User model, roles → permissions map, `authorize(permission)` middleware
- [x] Auth: login, refresh rotation (sessions collection), logout, logout-all, me, password reset (email)
- [x] Lockout on failed logins, rate limiting, helmet, CORS
- [x] Audit log module (actor, action, entity, diff, ip)
- [x] Storage adapter (local driver; S3 later) + media upload (sharp WebP variants, EXIF strip, magic-byte MIME check, private/public split)
- [x] Integration config resolver (`getIntegrationConfig`) + email service (Nodemailer, SMTP env)
- [x] Mongo job scheduler (in-process tick, atomic claim, retry/backoff) + `/internal/cron/tick` + job registry
- [~] Tests: auth flows, RBAC, scheduler claim race — written (unit 41 ✔ in sandbox; integration needs MongoDB → owner runs `npm test`)
- [x] API contracts → `docs/API.md`
- [x] Extras: account invite/setup flow, session list/revoke, admin user management, private-file streaming, media purge job

### F1: Shell, i18n & Auth (Frontend)
- [x] Design system: tokens (`styles/theme.css`), fonts (Playfair, Plus Jakarta Sans, Hind Siliguri, Noto Serif Bengali, Geist Mono), living style guide `/[locale]/dev/design`
- [x] next-intl setup, BN/EN toggle (URL segment + `pp_locale` cookie — see ARCHITECTURE §7), number/currency formatters (lakh-crore, bn digits)
- [x] `lib/placeholders.js` + `<SmartImage>` (Unsplash/Pexels fallback, deterministic per entity)
- [x] UI primitives (Button, Field, Input/Textarea, Select, Checkbox, Drawer, Table, Tag, StatusChip, Toast, Empty/Error/Skeleton)
- [x] API client (server: cookie forwarding; client: fetch + single-flight refresh-on-401), React Query provider
- [x] Login / forgot / reset / setup-account pages, `proxy.js` route guards by role (+ `/session` silent-refresh hop)
- [x] Dashboard shell (sidebar, topbar, command palette), Portal shell (mobile tab bar), account page (profile, password, sessions)

### F1b: Admin screens (Frontend) — backend ready since B1
- [x] Team: list / search / filter / invite / edit role & status / resend invite (`/users`)
- [x] Audit log viewer with area + date filters, expandable diffs, cursor "load more" (`/audit`)
- [x] Organization settings (identity, contact, registration, logo upload via `/media`, fiscal year, default language)

### B2: Projects & Inventory (Backend)
- [x] Project → Block/Building (Sector) → Unit models (apartment + plot). Floors are a range on the building + `unit.floor` (no Floor collection); plot road is a unit field (`road`, `roadWidthFt`)
- [x] Pricing strategies (apartment: sft rate + floor rise + facing + corner + parking + charges; plot: katha/decimal rate + road-width tiers + facing + corner % + charges), exact integer math, itemised breakdown
- [x] Area units: katha ↔ decimal ↔ sq ft ↔ sq m (stored + derived), owner decision 2026-10-12
- [x] Unit status machine + atomic hold/release/extend/block/unblock + per-user hold cap + hold-expiry job (+ lazy expiry on read)
- [x] Floor plan / master plan model + normalized hotspots (typical floor plans by position)
- [x] Socket.IO (project rooms, `unit:status` deltas, socket token auth)
- [x] Public read APIs (blocked units hidden) + signed revalidation webhook to the frontend
- [~] Tests: unit 62 ✔ in sandbox; integration (`inventory.test.js` — hold race, transitions, pricing, public, floor plans; `sockets.test.js`) written — owner runs `npm test`

### F2: Public site (Frontend)
- [ ] Home, projects listing + filters
  - Owner note (2026-10-12): the home page hero will use a **background video** — plan for a poster image, muted autoplay + `playsinline`, `prefers-reduced-motion` / Save-Data fallback to the poster, and video upload support in media (or an external CDN/YouTube source) — confirm source before F2
- [ ] Project detail (gallery/Embla, map, amenities)
- [ ] Floor plan & master plan viewer (live status chip)
- [ ] Unit detail, installment/EMI calculator
- [ ] Lead forms (honeypot, retry for cold start), SEO, JSON-LD, sitemap, `/api/revalidate`

### F3: Dashboard Inventory (Frontend)
- [x] Projects list/create/details (cover, location, land katha/decimal, approval, website flags, amenities), buildings/blocks CRUD
- [x] Unit grid (building elevation: floors × positions, ground line, basements) + plot strips by road, real-time over Socket.IO
- [x] Unit drawer: status + hold/release/extend/block/unblock, details (sft + sq m, katha + decimal), itemised price, edit, delete; bulk generator (floors × positions / plot ranges)
- [x] Rate card editor (apartment + plot)
- [x] Hotspot editor (rectangle + polygon tools, move/reshape, undo/redo, link to position/unit/building/plot or label) + floor/master plan viewer (live status colours, floor switcher, zoom)
- [x] Price list: per-unit rate overrides + adjustments in bulk with server dry-run preview (`POST /projects/:id/units/prices`) + gallery (multi-upload, reorder, cover) + brochure PDF

### B3: Leads & CRM (Backend)
- [ ] Lead model, phone normalization, dedupe/merge
- [ ] Assignment rules (round-robin / project / source), SLA (`firstResponseAt`) + escalation job
- [ ] Pipeline stages (configurable), fractional ranking, optimistic concurrency
- [ ] Activities, tasks, follow-up reminders
- [ ] Meta Lead Ads webhook + Graph fetch job + nightly reconcile
- [ ] SMS adapter (log + BulkSMSBD + SSL Wireless drivers, env-driven), delivery log, auto-reply

### F4: CRM UI (Frontend)
- [ ] Leads table (filters, saved views)
- [ ] Kanban (dnd-kit, optimistic)
- [ ] Lead drawer: timeline, notes/calls, tasks
- [ ] Integration settings (Meta page connect, SMS), templates

### B4: Sales & Accounts (Backend)
- [ ] Booking (unit lock + price snapshot, transaction)
- [ ] Plan templates + schedule generator
- [ ] Receipts + allocations + reversals + gapless counter
- [ ] Cheque/PDC register + bounce handling
- [ ] Transfer & cancellation (deduction policy)
- [ ] Documents: verifyToken + hash, `/verify/:token` public API
- [ ] PDF job (Puppeteer pool) from the HTML templates + email attachment
- [ ] Discount limit per role
- [ ] Tests: allocation math, rounding, bounce reversal

### F5: Accounts UI + Documents (Frontend)
- [ ] Booking wizard
- [ ] Schedule & ledger view, receipt entry, cheque register
- [ ] A4 print pages (receipt, booking form, allotment letter) with QR, BN/EN
- [ ] `/verify/[token]` public page
- [ ] Dues & collection reports

### B5: Customer Portal & Reminder Engine (Backend)
- [ ] Client accounts (created at booking, one-time setup link)
- [ ] Portal APIs: my units, schedule, dues, receipts, documents
- [ ] SSLCommerz: init → callbacks → IPN → validation API → idempotent receipt (sandbox tested)
- [ ] Reminder rules (T-7, T-0, T+3, T+15), templates BN/EN, job + delivery log
- [ ] Basic analytics aggregations (pipeline, inventory, collections)

### F6: Portal + Reminders + Analytics (Frontend)
- [ ] Portal UI (mobile-first) + Pay Now (SSLCommerz, shown only when enabled)
- [ ] Reminder settings & delivery log
- [ ] Analytics dashboard (Recharts)

### Phase H: Hardening & Deploy
- [ ] Index review, load test (hold race), backup plan
- [ ] Deploy: Hostinger VPS (Node 24 via nvm, PM2, Nginx, Let's Encrypt, Chrome deps for Puppeteer), frontend per D3, env vars
- [ ] Backups: nightly `mongodump` + `uploads/` archive
- [ ] Playwright e2e (critical flows), Lighthouse, a11y

---

## 🔄 Resuming on a new PC / new chat

1. Clone `primeplot-back` and `primeplot-front` into the same parent folder (`PrimePlot/`).
2. In each, run `npm install`, then copy `.env.example` to `.env` and fill in the values (Atlas URI, SMTP, secrets; SSLCommerz/SMS keys optional). Node ≥ 24 required.
3. Backend: `npm run dev`. Frontend: `npm run dev`.
4. Tell Claude: "Read docs/PROGRESS.md and ARCHITECTURE.md in primeplot-back and continue the PrimePlot project." The same docs are also saved in the claude.ai Project.

---

## 📝 Session Log (newest first)

### 2026-10-12 (7): F3 step 2 — plans, price list, gallery
- **Backend (new endpoint):** `POST /projects/:id/units/prices` (`pricing:write`) — set/clear `rateOverride` and `priceAdjustment` on ≤ 500 units in one transaction; every item carries the unit `version` (`409 STALE_VERSION` lists the unit codes), sold units → `409 UNIT_LOCKED`, `dryRun: true` returns the would-be prices without writing. Writes bump `version`, send `unit:status` deltas (new `listPrice`) and revalidate the website. Audit `unit.price_bulk_update`. Files: `units/unit.validation.js` (`zUnitPrices`), `units/unit.service.js` (`setUnitPrices`), `projects/project.routes.js`, `docs/API.md`. Tests: 2 integration cases in `inventory.test.js`, 1 schema case in `b2-contracts.test.js`.
- **Frontend — Plans tab** (`/dashboard/projects/[id]/plans`, `/plans/[planId]`):
  - List grouped as site/layout plans + floor plans per building; create/edit drawer (drawing upload as public `floor_plan`/`master_plan` media, title EN/BN, building, floor picker with Shift-range and "already covered" dots). Abandoned uploads are deleted.
  - Live view: one SVG (image + shapes share the image's pixel space), status colours from the same tokens as the grid, hatched blocked units, tooltip (code, status, size, price, holder), floor switcher for typical plans, zoom, click → unit drawer, building hotspot → inventory tab (`?block=`). Live recolour from the existing Socket.IO subscription (no refetch).
  - Editor: Select / Shape / Rectangle tools (V/P/R), drag to move, corner handles, double-click edge adds a corner, Alt-click removes, Ctrl+D duplicate, Delete, Ctrl+Z / Ctrl+Shift+Z (100 steps), new floor-plan areas auto-link to the next free position; side panel to link (position · unit · building/plot · label only), "not on the plan yet" chips, warnings for unlinked/duplicate links, save with `version`, unsaved-changes guard.
- **Frontend — Price list tab** (`/prices`): per building/sector table (rate override + adjustment + note per unit), Shift-click range select, bulk actions (set rate, rate ± %, adjustment, back to card), live dry-run preview with ± difference, stale-unit reload that drops only those edits, sold rows locked, read-only for non-admins, other tabs locked while there are edits.
- **Frontend — Gallery tab** (`/gallery`): drag-and-drop multi-upload (2 at a time), reorder by drag or arrows, set cover, remove, brochure PDF; one PATCH with `version`; discarded uploads deleted.
- Shared: `components/media/upload.js`, `SmartImage` `fit="contain"`, `useAllUnits` / `useFloorPlans` / `useFloorPlan` queries, BN/EN strings (`plans`, `priceMatrix`, `gallery`, `media`); Bangla counts use Bangla digits.
- **Verified in sandbox** against a mock API that reuses the real pricing/area/permission modules + Socket.IO: 4 Playwright suites, 67 checks (plan create → editor, rectangle/polygon drawing, auto-link, undo/redo, move, save + normalized coords, live recolour on another user's hold, hatched blocked unit, building → inventory link, plot layout plan, price-matrix +5 % preview and exact totals, stale-version reload, clear back to card, executive read-only, gallery upload/reorder/cover/brochure/discard, BN at 390 px without overflow). ESLint, esbuild, `next build` (fonts stubbed) clean; backend ESLint + Prettier clean, 63 unit tests pass.
- **Not verified:** the new backend endpoint against real MongoDB (sandbox still can't download `mongod`) → owner runs `npm test`.
- Known limits: the audit log viewer doesn't have labels/filters for project/unit/plan actions yet (raw action names show); plan drawings must be images (export a PDF page to PNG/JPG first); a typical plan's areas follow the position, so floors with a different layout need their own plan.

### 2026-10-12 (6): seed fix + F3 step 1 — Dashboard Inventory
- **Backend:** `npm run seed -- --sync-indexes` alone now only syncs indexes (no org/admin arguments needed).
- **Frontend (new):** `/dashboard/projects` (list with inventory strip, filters, create drawer with slug preview), `/dashboard/projects/[id]` (tabs: Inventory · Details · Rate card), `/dashboard/units` (live inventory index). Nav: Projects and Inventory are live.
  - Inventory: building tabs, status filter with counts, live badge; apartment elevation grid (empty slots → add unit there), plot strips grouped by road; unit drawer (hold with duration/note, release by holder or `units:write`, extend, block with reason, unblock, sold-field locks, itemised price lines, delete with inline confirm); building/block drawer; bulk generator (floors × positions with per-position template / plot number range with road + area; skip existing; ≤ 500).
  - Details form (dirty fields only + `version`), cover upload (public WebP), land area in katha/decimal with live conversion preview. Rate card editor in taka → poisha, road tiers, facing premiums, corner (sft or %), parking, fixed charges.
  - `lib/socket.js` (one shared Socket.IO connection, fresh 60 s token on every connect, resubscribe + refetch after reconnect), `components/inventory/queries.js` (query keys, live delta → cache), `lib/format` area + taka helpers, `Segmented` primitive, `api.put`. New dependency `socket.io-client`; new env `NEXT_PUBLIC_SOCKET_URL`.
  - BN/EN strings for projects, inventory and pricing.
- **Bug found and fixed in testing:** clicking "Edit" in the unit drawer submitted the form at once (React reused the clicked button as the new submit button) → footer buttons now have distinct keys.
- **Verified in sandbox** against a mock API that reuses the real backend pricing/area/status modules + Socket.IO: 19 Playwright flows (create apartment + plot projects, buildings, bulk 30 units, single unit from an empty slot, rate card → 31 units re-priced, price breakdown, hold/release/block/unblock, live update from another user, sold-field lock + edit, details/publish with katha↔decimal preview, plots per decimal priced per katha, English locale, 390 px no overflow, executive permissions). ESLint, esbuild, `next build` (fonts stubbed) clean.
- **Not verified:** the real API end to end (sandbox has no MongoDB) — owner checks.
- Known limit: two components subscribing to the same project share one room; unsubscribing one drops the other (only one subscriber exists today).

### 2026-10-12 (5): B2 Projects & Inventory — code complete
**Owner decisions:** area units (see Resolved decisions). D4 still open — B2 follows the proposed v1 scope.

**New dependency:** `socket.io` 4.8 (dev: `socket.io-client`). New subpath import `#sockets/*`.
**New env (all optional):** `UNIT_HOLD_DEFAULT_HOURS=24`, `UNIT_HOLD_MAX_HOURS=72`, `UNIT_HOLD_MAX_PER_USER=10`, `REVALIDATE_SECRET` (same value as the frontend's), `FRONTEND_REVALIDATE_URL`.

**Modules**
- `shared/utils/area.js` — katha/decimal/sq ft/sq m on scaled BigInt (exact: "3.30 decimal at ৳X/katha" never drifts a poisha); `shared/db/areaSchema.js` (stored `{ value, unit, katha, decimal, sqft, sqm }`).
- `projects/` — Project (kind immutable, slug unique among live docs, location GeoJSON, land area, approval, media ids checked as public images, `publicPricing`, rate card), Block (building | block | sector, floor range), CRUD, `PUT /pricing` re-prices unsold units, cascade soft delete (refused while held/sold).
- `units/` — Unit model (apartment/plot fields, derived areas, `listPrice`, hold subdoc), `pricing.js` (two strategies → itemised breakdown for the B4 snapshot), `unitStatus.js` (transition table, effective status, public vocabulary), service: CRUD + bulk (one transaction, ≤ 500), code auto-generation, kind-field guard, `pricing:write` guard for overrides, price-field lock on sold units, atomic `transition()` (status in the filter + `__v` bump), hold cap, `transitionUnit()` for B4 (session-aware; announce after commit).
- `floorplans/` — floor/master plans, 0–1 polygons (≤ 100 points, ≤ 500 hotspots), targets unit | position | block, typical-floor resolution, public view hides blocked units (no id).
- `public/` — `/public/projects`, `/projects/:slug`, `/projects/:slug/units`, `/units/:id`, `/floorplans/:id` (published only, blocked/cancelled hidden, prices only with `publicPricing`, short `Cache-Control`).
- `sockets/` — Socket.IO on the API server, handshake token (`POST /auth/socket-token`, 60 s, separate key/audience), org-scoped project rooms `public`/`staff`, `unit:status` deltas; closed first on shutdown.
- `integrations/revalidate/` + job `frontend.revalidate` (HMAC-SHA256 over `ts.body`, coalesced, retried); job `units.expireHolds` (every minute per org).
- `media.service`: `assertPublicMedia`, `publicMediaMap`. Seed `--sync-indexes` covers the new collections.
- `docs/API.md`: full B2 contract (shapes, rate card, endpoints, socket protocol, webhook).

**Verified in sandbox:** ESLint + Prettier clean, `npm run check`, 62 unit tests (area conversion and exact cross-unit pricing, both pricing strategies, status machine, request schemas, socket-token separation, webhook signature), app + Socket.IO boot, Mongoose casting/validation of the new models.
**Not verified:** anything needing MongoDB (the sandbox still cannot download `mongod`): `tests/integration/inventory.test.js` (19 cases incl. 10-way concurrent hold race) and `sockets.test.js` → owner runs `npm test`.

**Known limits (accepted for v1):** the per-user hold cap is checked before the atomic hold (two simultaneous holds by the same person can exceed it by one); a staff socket stays subscribed until disconnect even if the user logs out (the token is only checked at connect); public responses share the API rate limit (Next.js server fetches are cached by tag, so volume is low — revisit in Phase H).

### 2026-10-12 (4): F1b — admin screens
- **Team** (`/dashboard/users`, `users:read`; edit `users:manage`): debounced search, role/status filters, offset pagination, invite drawer (duplicate email → field error), edit drawer sends only changed fields; own role/status locked; resend invite for invited members; SELF_CHANGE / LAST_ADMIN / INVITE_PENDING shown inline.
- **Audit log** (`/dashboard/audit`, `audit:read`): area filter (auth/user/org/media/system), Dhaka-time date range, translated action labels, expandable from→to diff (secret fields show "changed"), meta + request id, infinite "load older".
- **Company settings** (`/dashboard/settings`, `org:update`): sections for identity (logo upload → public WebP media), contact, registration (trade licence, REHAB), preferences (default language, fiscal-year month with a receipt-numbering warning); sticky save bar, discard, only dirty fields are sent; refreshes `/auth/me` org data.
- New shared pieces: `PageHeader`, `RequirePermission` (calm no-access panel), `Pagination`, `useDebounced`. Table wrapper made `relative` (fixed a 473px mobile overflow from an `sr-only` header).
- **Backend:** org `website` now accepts only `http(s)` URLs (blocked `javascript:` links on receipts/public site). API.md updated.
- **Verified** against the mock API: 8 Playwright flows (list/search, invite duplicate + success, self-edit lock, audit expand + load more, website validation + save, Bangla pages, 390px widths). ESLint, esbuild, `next build` clean.

### 2026-10-12 (3): F1 step 2 — auth UI, route guards, shells
- **Auth pages** (`app/[locale]/(auth)/`): login (lockout minutes, disabled, expired/reset/setup notices, `next` redirect), forgot (same answer for every email, resend), reset & setup-account (one shared `TokenPasswordForm`: token read once then stripped from the URL, `referrer: no-referrer`, token pre-checked via `/auth/token/inspect`, weak password never burns the link). react-hook-form + zod 4.
- **proxy.js**: next-intl first, then area guard. Reads the access-token claims unsigned (routing only; API verifies). No/expired access cookie → `/session?next=…` (the refresh cookie is path-scoped to `/api/v1/auth`, so only the browser can refresh) → back to `next` or to login. Client ↔ staff areas can't be crossed; guest pages bounce signed-in users home. `safeNext()` blocks open redirects (`//evil`, schemes, backslashes, cross-area).
- **Shells**: dashboard (olive sidebar filtered by permissions, topbar, Ctrl/⌘K command palette, user menu, mobile off-canvas nav), portal (mobile bottom tab bar). Unbuilt modules open a "coming in phase X" page instead of 404. Overview = honest setup checklist (no invented stats). Account page: profile, change password, sessions with per-device sign-out and sign-out-everywhere.
- Session data loads client-side (`useSession` → `/auth/me`), gated until hydration to avoid streamed-boundary mismatches; `pp:session-expired` → login with `reason=expired`.
- **Verified in sandbox** against a mock API: 13 E2E flows (Playwright) — unauth redirect via /session, wrong password, login, palette navigation, account page, silent refresh after the access cookie is deleted, guest-page bounce, logout, client blocked from dashboard, portal on 390px, reset token stripped + invalid link, open-redirect blocked, lockout message. `next build` (fonts stubbed), ESLint, esbuild — clean. Fixed during testing: `usePathname` outside Suspense on the catch-all route; hydration mismatch from shared query cache; malformed tokens hanging on a skeleton.
- Owner note: home hero will be a video (recorded under F2).

### 2026-10-12 (2): F1 step 1 — design system, i18n, primitives
- Owner supplied 3 references + design rules; approved the system (palette with contrast fixes, type roles, Noto Serif Bengali for BN display, new status colours, mono for codes/money). Recorded in ARCHITECTURE §7.
- **i18n:** locale as root segment `app/[locale]/` (next-intl 4 + `next/root-params`), `proxy.js` handles locale redirect, `pp_locale` cookie. Old `app/layout.js` and `app/page.js` replaced by `app/[locale]/…` (owner deletes the old two files).
- **New:** `styles/theme.css` (tokens), `app/globals.css` (eyebrow / blueprint / hatch utilities, motion), `components/ui/*`, `components/media/SmartImage.js`, `components/i18n/LocaleSwitcher.js`, `components/providers/Providers.js`, `lib/format`, `lib/placeholders.js`, `lib/unitStatus.js`, `lib/api/{client,server,errors}.js`, `messages/{bn,en}.json`, `i18n/*`.
- Backend media render `unoptimized` (already WebP variants + blur); stock placeholders use the Unsplash CDN loader — no Next image optimizer, so no local-IP issue.
- **Verified in sandbox:** `next build` (fonts stubbed — sandbox has no Google Fonts), ESLint clean, `/bn` + `/en` dev/design render with no runtime errors, no horizontal scroll at 390px. Found and fixed: a constant exported from a client module was a client reference in a Server Component (moved to `lib/unitStatus.js`).
- **Not verified:** real font rendering and the Unsplash photo IDs (sandbox can't reach either) — owner checks on `/dev/design`.
- B1: owner ran `npm test` — 76 passed; `auth.test.js` timed out in `beforeAll` while the MongoDB binary downloaded. Fixed with `tests/global-setup.js` (pre-download, no timeout). Re-run pending.

### 2026-10-12: B1 Core platform — code complete
**Decision:** D5 accepted (bank-slip upload; see Resolved decisions).

**New dependencies:** jsonwebtoken, express-rate-limit 8, multer 2, sharp, file-type, nodemailer. Dev: vitest, supertest, mongodb-memory-server.
Password hashing uses Node's built-in **scrypt** (N=2^15, r=8, p=3) — no native addon to compile on Windows or the VPS.

**Modules** (`src/modules/`)
- `organizations/` — model, cached single-tenant resolver (`ORG_SLUG` or the only org), `GET /org/public`, `GET|PATCH /org`.
- `users/` — model (authVersion, lockout fields, `select:false` secrets), admin CRUD + invite, self profile. Guards: no self role/status change, last-admin protection.
- `auth/` — sessions collection (one doc per refresh family, HMAC-hashed token, CAS rotation, 30 s multi-tab grace, reuse ⇒ revoke), single-use `auth_tokens` (reset 30 min, setup 72 h), lockout (5 fails → 15/30/60/120/240 min), JWT HS256 with HKDF-derived key, `authVersion` in the token for instant revocation, 30 s in-process user cache + revoked-session set, cookie helpers, password policy.
- `audit/` — append-only model (update/delete hooks throw), TTL `AUDIT_RETENTION_DAYS`, `audit()` helper (transaction-aware), cursor-paginated `GET /audit`.
- `media/` — magic-byte check, sharp (rotate, strip EXIF/GPS, thumb/card/full WebP + blur), decompression-bomb cap, 2-image concurrency cap, private/public split, authenticated streaming, soft delete + purge job.

**Shared / infra**
- `shared/auth/permissions.js` — the single permission catalogue + role bundles (B2–B5 permissions declared up front).
- `shared/middleware/` — `validate` (strict Zod → `req.valid`), `rateLimit`, `originGuard` (CSRF defence-in-depth), `resolveOrg`.
- `shared/crypto/` (HKDF keys, HMAC token hashing, scrypt); `shared/utils/` (`phone` BD→E.164, `pagination`, `diff`).
- `integrations/` — `config.js` resolver, `storage/` (local driver, atomic writes, path-escape guard), `email/` (Nodemailer pool, BN/EN templates, queue helper; dev logs links when SMTP is off).
- `jobs/` — model, registry, scheduler (atomic claim, backoff + jitter, dead after max, stale-lock recovery, dedupeKey, sensitive payload wipe, recurring jobs, debounced nudge), handlers `email.send` and `media.purgeDeleted`, `POST /internal/cron/tick`.
- `app.js` serves `uploads/public` at `/uploads` (CORP cross-origin); `server.js` starts/stops the scheduler; error handler maps multer errors.
- `scripts/seed.js` (idempotent; `--sync-indexes` for production), `vitest.config.js`, `tests/` (unit + integration).

**Verified in sandbox:** ESLint + Prettier clean, `npm run check` (all files), 41 unit tests (scrypt, policy, BD phone, RBAC bundles, JWT tamper/alg-none/expiry, token hashing, email escaping/Bangla, storage path traversal), app boot + DB-free routes (health, origin guard, cron 404, uploads 404), sharp pipeline (orientation, EXIF strip, corrupt JPEG rejection), file-type (SVG/HTML rejected), rate limiter 429.
**Not verified:** anything that needs MongoDB (sandbox can't download mongod). The integration suites in `tests/integration/` (auth, RBAC/users/org, audit, scheduler claim race, media) run on the owner's PC with `npm test`.

**Known limits (accepted for v1):** rate-limit counters and the revoked-session set are in memory (single PM2 instance); the last-admin guard is not transactional (two admins disabling each other at the same instant).

### 2026-10-11 (3): Phase 0 Foundation — code complete
**Backend**
- `package.json`: Node ≥ 24 engines; dotenv/nodemon removed (`process.loadEnvFile`, `node --watch`).
  - Deps: express 5.3, mongoose 9, zod 4, pino 10, helmet, cors, compression, cookie-parser.
  - Subpath imports `#config/*` `#shared/*` `#modules/*`.
  - Scripts: `dev`, `start`, `lint`, `format`, `check`.
- `src/config/env.js`: Zod-validated, fail-fast with key-only messages. An empty value counts as unset. `env.features` flags for email, SSLCommerz and SMS.
- `src/config/logger.js`: pino, pretty in dev, redacts secrets.
- `src/config/db.js`: bounded retry, connection events, `isDBReady()`.
- `src/app.js`: request ID, access log, helmet, strict CORS, compression, 1 MB body limit, `simple` query parser, trust proxy.
- `src/shared/`:
  - `AppError` hierarchy, `errorHandler` (maps Zod, Mongoose, duplicate key, version and JSON errors), `notFound`
  - `response.js` helpers
  - `baseSchema` plugin (orgId + tenant guard + soft delete + timestamps)
  - `withTransaction`
- `/api/v1/health` (liveness), `/api/v1/health/ready` (readiness, DB ping). Contracts in `docs/API.md`.
- Tooling: ESLint flat config, Prettier, `.editorconfig`, `.env.example`, `scripts/check-syntax.js`. `.gitignore` gained `!.env.example`, `/uploads/` and `/logs/`.
- Decision: global Mongoose `sanitizeFilter` stays off; injection is blocked by Zod plus the simple query parser (ARCHITECTURE §6.1).

**Frontend**
- `next.config.mjs`: `poweredByHeader: false`.
  - `/api/v1/*` rewrite → `BACKEND_URL` (default `http://localhost:5030`).
  - `images.remotePatterns` for Unsplash/Pexels, AVIF/WebP.
  - Existing Next 16 flags (`cacheComponents`, `reactCompiler`, …) kept.
- `styles/theme.css`: semantic tokens (canvas/surface/ink/line/accent, feedback, unit-status colours), 1–6 px radii, easing. **Palette is TEMP.**
- `app/layout.js`: Geist + Geist Mono + Noto Sans Bengali (one font stack renders mixed BN/EN), metadata template.
- `app/page.js` + `components/dev/SystemStatus.js`: temporary Phase 0 system-check page.
- `.env.example`, `engines >=24`, `.gitignore` `!.env.example`.

**Verified (in sandbox):**
- syntax check (14 files), ESLint and Prettier on the backend; ESLint on the frontend
- HTTP smoke tests: health, ready=503 without DB, 404, malformed JSON, CORS allow/deny, request-ID reuse/sanitizing, no `x-powered-by`
- baseSchema tests: tenant guard on find/update/delete/aggregate, soft-delete filter, `$geoNear` ordering, orgId required
- env validation messages
- `next build` OK (fonts stubbed: sandbox can't reach Google Fonts)
- end-to-end: browser path `/api/v1/*` → Next rewrite → Express

**Not verified:** a live Atlas connection (sandbox has no DNS to Atlas). The owner checks this on their PC.

### 2026-10-11 (2): Owner revisions + v1/v2 recommendation
- Owner: dev-only for now, backend on the Hostinger VPS at the end; Cloudinary dropped → local `uploads/`; SSLCommerz + SMS fully built and env-driven; Unsplash/Pexels placeholders; Node ≥ 24; `PORT=5030`; `MONGODB_URI` and SMTP set (verified key names only, replica set present).
- ARCHITECTURE updated: storage, jobs (always-on VPS), integrations resolver, SSLCommerz flow, Puppeteer PDF, placeholders (§7.1), industry patterns (§9).
- Proposed v1/v2 split (D4). **No code written yet.**

### 2026-10-11: Architecture lock & tracking setup
- Domain analysis, module architecture and roadmap proposal (shared in chat).
- Owner locked the decisions: single-tenant + `orgId`; apartment + plot; no Redis (Mongo scheduler); Cloudinary via adapter; Vercel + Render + Atlas M0; v1 must-haves (i18n, QR docs, Customer Portal, reminder engine).
- Defined v2-deferred items (partners, maker-checker, construction billing, online payment, server PDF).
- Created `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`, and `CLAUDE.md` in both repos.
- Found: backend `package.json` does not declare `express`/`dotenv` (they are only in node_modules). Fix in 0.1.
- **No code written yet.**
