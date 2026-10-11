# PrimePlot — Progress Tracker

> **This is the project's single source of truth for progress.** On a new chat or a new PC, read this file first, then `ARCHITECTURE.md`.
> At the end of every work session, update this file: tick the checkboxes, update "Current status" and "Next step", and add a Session Log entry.

---

## 📍 Current status

| | |
|---|---|
| **Current phase** | Phase 0: Foundation — code complete; **0.8 DB check pending on the owner's PC** |
| **Last completed** | Phase 0 code (backend + frontend foundation) (2026-10-11) |
| **Next step** | Owner verifies Phase 0 locally (see Session Log) → B1 Core platform |
| **Blocker** | None. D1/D3/D4/D5 still open (not blocking B1) |

---

## ❓ Open decisions (owner confirmation needed)

| # | Topic | Proposed default | Needed by |
|---|---|---|---|
| D1 | PDF approach in v1 | One HTML template → A4 print page + Puppeteer PDF on the VPS (email attachment) + QR verify | Before B4 |
| D2 | SMS gateway provider | Build `log` + BulkSMSBD + SSL Wireless drivers; the client's keys go in `.env` | When the client onboards (code ready in B3) |
| D3 | Frontend hosting | Vercel (free, easiest) or the same Hostinger VPS (Next standalone + PM2). Code works in both | Before deploy |
| D4 | v1/v2 split | See ARCHITECTURE §4 (proposed) | Before B2 |
| D5 | Payment channels | Manual payments (cash/cheque/PDC/bank transfer/pay order) are first-class; client can upload a bank-transfer slip in the portal for staff to verify; SSLCommerz optional; Stripe not in v1 (gateway adapter keeps it addable) | Before B4 |

## ✅ Resolved decisions
- 2026-10-11: single-tenant + `orgId`; apartment + plot; no Redis
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
- [~] 0.8 Both: verify (backend boots and connects to the DB; frontend proxies the health check), commit

### B1: Core platform (Backend)
- [ ] Organization model + seed script (default org + first Admin)
- [ ] User model, roles → permissions map, `authorize(permission)` middleware
- [ ] Auth: login, refresh rotation (sessions collection), logout, logout-all, me, password reset (email)
- [ ] Lockout on failed logins, rate limiting, helmet, CORS
- [ ] Audit log module (actor, action, entity, diff, ip)
- [ ] Storage adapter (local driver; S3 later) + media upload (sharp WebP variants, EXIF strip, magic-byte MIME check, private/public split)
- [ ] Integration config resolver (`getIntegrationConfig`) + email service (Nodemailer, SMTP env)
- [ ] Mongo job scheduler (in-process tick, atomic claim, retry/backoff) + `/internal/cron/tick` + job registry
- [ ] Tests: auth flows, RBAC, scheduler claim race
- [ ] API contracts → `docs/API.md`

### F1: Shell, i18n & Auth (Frontend)
- [ ] next-intl setup, BN/EN toggle (cookie-based), number/currency formatters (lakh-crore, bn digits)
- [ ] `lib/placeholders.js` + `<SmartImage>` (Unsplash/Pexels fallback, deterministic per entity)
- [ ] UI primitives (Button, Field, Select, Sheet/Drawer, Table, Tag, Toast, Empty/Error states)
- [ ] API client (server: cookie forwarding; client: fetch + refresh-on-401), React Query provider
- [ ] Login / forgot / reset pages, `proxy.js` route guards by role
- [ ] Dashboard shell (sidebar, topbar, command palette), Portal shell

### B2: Projects & Inventory (Backend)
- [ ] Project → Block/Building (Sector/Road) → Floor → Unit models (apartment + plot)
- [ ] Pricing strategies (apartment: sft rate + floor rise + facing + parking; plot: katha/decimal rate + corner + road width)
- [ ] Unit status machine + atomic hold/release + hold-expiry job
- [ ] Floor plan / master plan model + normalized hotspots
- [ ] Socket.IO (project rooms, `unit:status` deltas, socket token auth)
- [ ] Public read APIs (blocked units hidden) + revalidation webhook to the frontend
- [ ] Tests: concurrent hold race, status transitions

### F2: Public site (Frontend)
- [ ] Home, projects listing + filters
- [ ] Project detail (gallery/Embla, map, amenities)
- [ ] Floor plan & master plan viewer (live status chip)
- [ ] Unit detail, installment/EMI calculator
- [ ] Lead forms (honeypot, retry for cold start), SEO, JSON-LD, sitemap, `/api/revalidate`

### F3: Dashboard Inventory (Frontend)
- [ ] Projects/blocks/floors CRUD
- [ ] Unit grid (elevation view) + plot map view, real-time
- [ ] Hotspot editor (draw polygons, link units)
- [ ] Price matrix editor

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
