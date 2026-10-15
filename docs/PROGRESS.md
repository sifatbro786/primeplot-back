# PrimePlot — Progress Tracker

> **This is the project's single source of truth for progress.** On a new chat or a new PC, read this file first, then `ARCHITECTURE.md`.
> At the end of every work session, update this file: tick the checkboxes, update "Current status" and "Next step", and add a Session Log entry.

---

## 📍 Current status

| | |
|---|---|
| **Current phase** | **B5 code complete** (B5.1 client logins + portal API + bank slips + profile requests, B5.2 SSLCommerz full flow, B5.3 reminder engine + analytics). Next: owner tests B5, then **F6** (portal UI, reminder settings + log, analytics dashboard) |
| **Last completed** | B5.1 + B5.2 + B5.3 together — 2026-10-15 |
| **Next step** | Owner: `npm install` is not needed (no new deps) → `npm run db:indexes` once (users e-mail index changed) → `npm test` (new `tests/integration/b5.test.js`, 17 cases) → SSLCommerz sandbox keys in `.env` + `docs/SSLCOMMERZ.md` (tunnel, `npm run sslcz:check`). Then **F6** scope proposal |
| **Blocker** | None. D3/D4 still open (not blocking) |

---

## ❓ Open decisions (owner confirmation needed)

| # | Topic | Proposed default | Needed by |
|---|---|---|---|
| D2 | SMS gateway provider | Build `log` + BulkSMSBD + SSL Wireless drivers; the client's keys go in `.env` | When the client onboards (code ready in B3) |
| D3 | Frontend hosting | Vercel (free, easiest) or the same Hostinger VPS (Next standalone + PM2). Code works in both | Before deploy |
| D4 | v1/v2 split | See ARCHITECTURE §4 (proposed) | Before B2 |

## ✅ Resolved decisions
- 2026-10-15: **B5 scope** (owner, previous chat; "complete B5 full together"). **Client login** by phone **or** e-mail — the client's e-mail is optional. **Created automatically at booking** (and for the new holder at a transfer); one-time setup link by **SMS and e-mail**. **Co-applicants** invited by staff (auto-invite is a setting, off). **Portal API**: bookings (holder + co-applicant), schedule, dues, receipts, documents. **Bank slip upload → verification queue → receipt** (staff may correct the amount/date; reject with reason). **Profile change requests** for contact details only (deed details change at the office). **SSLCommerz** fully built: init → success/fail/cancel → IPN → Order Validation API → idempotent receipt, **risk review** (high risk / mismatch / overpaid / inactive booking), **reconcile job**, `.env.example` keys, `npm run sslcz:check`, Cloudflare-tunnel IPN guide (`docs/SSLCOMMERZ.md`); owner only adds the sandbox Store ID + password. **Reminders** T−7 / T0 / T+3 / T+15 (editable), 10:00 Dhaka, SMS + e-mail BN/EN, delivery log; **basic analytics** (inventory, sales, collections + dues, pipeline, portal). Defaults chosen by Claude (change any in settings): online minimum ৳1,000, result SMS on, slips on, reminder catch-up 2 days, manual "remind now" once per booking per day. ARCHITECTURE §6.6b
- 2026-10-14: **B4 scope** (owner: "B4 scope OK" — all defaults accepted). **D1:** Puppeteer on the VPS, HTML templates owned by the backend (Bangla fonts local), the frontend print page loads the same HTML. **Q1:** cheque → unnumbered acknowledgement; receipt + allocation when it clears (bounce = fee, no reversal). **Q2:** booking money in the same step; manager may waive with a reason. **Q3:** discount cap executive 1 % / manager 3 % of the base price, admin none (settings). **Q4:** cancellation keeps 10 % of the amount paid (project setting), manager override with reason. **Q5:** transfer fee per project (default 0), no overdue dues. **Q6:** allotment by a manager, warning (not block) when the down payment is unpaid. **Q7:** receipt no. `LVR-2627-000123` → project `code`. **Q8:** receipt e-mail with PDF on, receipt SMS off (setting). **Q9:** B4.1 → B4.2 → B4.3, then F5. Extras accepted: company bank accounts, delay charge as a manual charge (auto penalty v2), statement of account as a QR document
- 2026-10-14: **B2b + F3b scope** (owner accepted) — dashboard-managed SEO (site-wide + per page + per project, SERP preview); **focus keyword + on-page check** instead of `meta keywords`; page content as **fixed sections** (edit / show-hide / reorder, no free page builder); **draft → preview → publish**, last 20 versions kept; all proposed sections — Home: why us, track record, construction progress, testimonials, landowner JV band, approvals & partner banks, video tour, FAQ; About: story + milestones, mission/vision/values, chairman/MD message, leadership team, construction quality, completed projects, memberships & awards, CSR. People/testimonial/award sections start empty (hidden) — never invented content
- 2026-10-13: **B3.2 defaults** (owner accepted) — auto-reply only for new website/Meta leads (not manual, not repeat enquiries), max 1 per phone per 24 h; SLA miss → one in-app notification to every manager (no SMS to managers); BN 70/67, EN 160/153 segments with a cost preview; Meta page token encrypted, nightly 48-hour reconcile. **Order:** B3.2 first, then the full F4. **F4 decisions:** saved views = preset views + filters in the URL (no backend); phone Kanban = one column at a time (tabs) + "Move to…" menu, drag on desktop
- 2026-10-13: **B3 scope** (owner) — new leads **round-robin** among active sales executives (per-project teams optional; `manual` mode = unassigned queue); first-response **SLA 30 office minutes** (09:00–20:00 Dhaka, Friday off, editable) with manager escalation; customer **auto-reply SMS on** (editable BN/EN text, can be switched off); B3 split into **B3.1** (core CRM + website form) and **B3.2** (SMS, auto-reply, SLA escalation, Meta Lead Ads)
- 2026-10-13: **Tracking IDs from the dashboard** (owner) — GA4 Measurement ID + Meta Pixel ID live on the Organization (`analytics`), edited in Company settings, not `.env`. Privacy/Terms use the settings' **legal name** (falls back to the company name); both pages linked from the footer
- 2026-10-11: single-tenant + `orgId`; apartment + plot; no Redis
- 2026-10-13: **Public-site extras accepted** (all 8): privacy/terms, WhatsApp button, analytics + consent, OG images, unit comparison → F2b; landowner/JV leads → B3 (+ page in F4); editable site content + construction updates → B2b/F3b. Owner feedback: public pages read too white — colour pass before F2b
- 2026-10-13: **F2 scope** — owner shared 3 reference sites for pattern only (never copied); hero video = Pexels stock for now; lead form = (খ) UI built, submit disabled until B3; production domain = `.env` placeholder (`NEXT_PUBLIC_SITE_URL`); calculator defaults 30 % / 36 months / no bank loan; About text drafted by Claude, no invented stats or testimonials
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
- [x] Home, projects listing + filters (home: hero video + poster, search card, real stats, featured, areas, buying steps, enquiry; F2.2)
  - Owner note (2026-10-12): the home page hero will use a **background video** — poster image, muted autoplay + `playsinline`, `prefers-reduced-motion` / Save-Data fallback to the poster. Owner decision 2026-10-13: a free Pexels stock video for now; the owner will later drop the real file into `public/`
- [x] Project detail (gallery/Embla + full-screen viewer, MapLibre map, amenities, unit-type table, live availability grid, plans, brochure, contact band)
- [x] Floor plan & master plan viewer (live status, floor switcher, zoom, accessible unit list)
- [x] Unit detail, installment calculator (defaults 30 % down / 36 months; bank-loan part built but off — `CALCULATOR.showLoan`)
- [x] SEO (metadata, canonical + hreflang, JSON-LD, sitemap, robots, indexing switch), signed `/api/revalidate`, About + Contact pages
- [~] Lead forms: UI + validation + honeypot + min fill time + retry built; submit off (`NEXT_PUBLIC_LEADS_ENABLED`) until B3 ships `POST /public/leads`

### F2b: Public site extras (Frontend) — owner-approved 2026-10-13
- [x] Privacy Policy + Terms pages (BN/EN, drafted; linked from footer and every lead form — also needed for Meta Lead Ads). **Owner: have a lawyer review the text** (`content/legal/*.json`)
- [x] Floating WhatsApp button (org phone, hidden when no phone; stacks with the comparison tray and cookie banner)
- [x] Analytics: GA4 + Meta Pixel — IDs from **Company settings** (owner change: not env), loaded only after cookie consent (banner, remembered choice, "Cookie settings" in the footer, re-asked when a new tool is switched on); lead-submit and call/WhatsApp click events
- [x] Per-project / per-unit OG share images (`opengraph-image.js`: cover + name + price; English text on both locales — the image renderer can't shape Bangla)
- [x] Unit comparison: "Add to compare" on unit pages → tray on every page → `/compare?u=…` (size, floor/road, facing, corner, parking, price, down payment, monthly); shareable URL, not indexed

### F3: Dashboard Inventory (Frontend)
- [x] Projects list/create/details (cover, location, land katha/decimal, approval, website flags, amenities), buildings/blocks CRUD
- [x] Unit grid (building elevation: floors × positions, ground line, basements) + plot strips by road, real-time over Socket.IO
- [x] Unit drawer: status + hold/release/extend/block/unblock, details (sft + sq m, katha + decimal), itemised price, edit, delete; bulk generator (floors × positions / plot ranges)
- [x] Rate card editor (apartment + plot)
- [x] Hotspot editor (rectangle + polygon tools, move/reshape, undo/redo, link to position/unit/building/plot or label) + floor/master plan viewer (live status colours, floor switcher, zoom)
- [x] Price list: per-unit rate overrides + adjustments in bulk with server dry-run preview (`POST /projects/:id/units/prices`) + gallery (multi-upload, reorder, cover) + brochure PDF

### B3: Leads & CRM (Backend)
**B3.1 — core CRM + website form (code complete 2026-10-13)**
- [x] Lead model (buyer + landowner), phone normalization (BD + international for NRB buyers), dedupe (one open lead per phone and type, race-safe), repeat enquiries, merge
- [x] Assignment: round-robin among sales executives, optional per-project teams, manual mode; bulk assign; open tasks follow the lead
- [x] SLA clock: `slaDueAt` in office hours, `firstResponseAt` (first contact or first move), `slaBreached` filter
- [x] Pipeline stages per type (configurable, guarded), fractional ranking (Kanban), optimistic concurrency
- [x] Activities (timeline), tasks, follow-up reminders job, in-app notifications (+ Socket.IO personal channel)
- [x] `POST /public/leads` (honeypot, min fill time, rate limit) — owner turns on `NEXT_PUBLIC_LEADS_ENABLED`
- [x] Landowner / joint-venture leads: type `landowner` with land fields, own pipeline (public `/landowners` page + form in F4)
- [x] CSV export (managers), API contract in `docs/API.md`
- [~] Tests: unit 18 new ✔ in sandbox; integration `tests/integration/leads.test.js` written — owner runs `npm test`

**B3.2 — integrations (code complete 2026-10-13)**
- [x] SMS adapter (log + BulkSMSBD + SSL Wireless drivers, env-driven), delivery log, segment/cost preview, customer auto-reply
- [x] SLA escalation job (notify managers when `slaDueAt` passes without a first response)
- [x] Meta Lead Ads webhook + Graph fetch job + nightly reconcile (page token encrypted), form → pipeline/project mapping, import log + retry
- [x] Integration admin API (`/integrations`), `npm run sms:check`, `npm run meta:connect`
- [~] Tests: unit 37 new ✔ in sandbox; integration `tests/integration/integrations.test.js` (18 cases) written — owner runs `npm test`

### F4: CRM UI (Frontend) — scope agreed 2026-10-13
- [x] F4.1 Leads table (filters in the URL, preset views: mine / unassigned / SLA missed / follow-up today, bulk assign, CSV) + Kanban per pipeline (dnd-kit, optimistic, stale → snap back; lost → reason; SLA chip; phone: column tabs + "Move to…") + manual lead drawer (duplicate → open existing)
- [x] F4.2 Lead drawer: header with call / WhatsApp (+ outcome prompt), details edit, timeline (incl. auto-reply / SLA / Meta entries), notes & calls, tasks, reassign / merge / reopen
- [x] F4.3 Notification bell (live), "My tasks", pipeline stage editor, CRM settings (assignment, teams, office hours, SLA, auto-reply text with live SMS length/cost), **integration settings** (Meta Page connect, form mapping, import log + retry, sync; SMS status, test SMS, delivery log)
- [x] F4.4 Public `/landowners` page + form; website lead forms switched on, end-to-end check

### B2b + F3b: Site content, SEO & construction updates — scope locked 2026-10-14
- [x] B2b.1 Backend: `SitePage` (fixed sections per page, draft / publish / 20 revisions / restore, defaults), `SiteSettings` (site-wide SEO), `Project.seo`, public `/public/site*`, `site:manage` permission, `site` revalidation tag (contract: API.md › B2b)
- [x] B2b.2 Backend: `ConstructionUpdate` (date, % , milestone, photos, publish), public updates + latest-per-project, project `construction` summary
- [x] F3b.1 Dashboard: page editor (sections, reorder, show/hide, reset to default, preview, publish, history), SEO editor (SERP preview, length + focus-keyword checks), site-wide SEO settings, project SEO tab, construction updates per project
- [x] F3b.2 Public: Home + About rebuilt from sections (new sections above), metadata + verification + JSON-LD (Organization sameAs, FAQPage) from the SEO settings, preview mode, construction timeline on the project page

### B4: Sales & Accounts (Backend) — scope locked 2026-10-14
**B4.1 — bookings & receipts (code complete 2026-10-14)**
- [x] Customers (buyer profile, joint applicants, private NID/photo media, visibility by seller)
- [x] Project `code` + `salesPolicy`; accounts settings (discount caps, booking money, back-dating, notify); company bank accounts
- [x] Plan templates + schedule generator (exact totals, rounding into the last installment, month-end clamping) + custom schedule (`bookings:override`)
- [x] Booking in one transaction (unit lock from available / own hold / any hold for managers, price snapshot, discount cap, booking money receipt, lead → won), preview, `Idempotency-Key`
- [x] Receipts: oldest-first allocation, advance, overpayment guard, gapless number per project per fiscal year, `Idempotency-Key`; reversal (admin); append-only ledger + integrity check; receipt SMS (setting, off)
- [~] Tests: unit 28 new ✔ in sandbox; integration `tests/integration/bookings.test.js` (15 cases incl. 5-way booking race and 4 parallel receipts) written — owner runs `npm test`

**B4.2 — cheques, transfer, cancellation, reports (code complete 2026-10-14)**
- [x] Cheque/PDC register (`received → deposited → cleared | bounced → re-deposit | returned`; acknowledgement, numbered receipt on clearing, bounce fee + alerts, duplicate guard, open cheques cap the amount) + booking money by cheque
- [x] Transfer (overdue/open-cheque guards, transfer fee or waiver, holder history, documents re-issued) & cancellation (policy deduction, manager override with reason, unit back on sale, refunds in parts with gapless `LVR-RF-` refs)
- [x] Allotment (warnings, not blocks) / registration (deed no.) / handover — unit status follows
- [x] Reschedule (contract total kept, paid items locked), call a milestone, manual charges + waiver
- [x] Reports: dues + aging buckets, collections (mode / project / day or month, refunds, reversals), PDC register
- [~] Tests: unit ✔ in sandbox; integration `tests/integration/b4-2-3.test.js` written — owner runs `npm test`

**B4.3 — documents (code complete 2026-10-14)**
- [x] `documents` module: frozen snapshot + SHA-256 hash, verify token, valid → void, one valid document per record, back-fill
- [x] Backend HTML templates (receipt, booking form, allotment letter, statement, cancellation/transfer letters, cheque acknowledgement), BN/EN, embedded OFL fonts (Hind Siliguri, Plus Jakarta Sans, Playfair Display), QR, VOID watermark
- [x] PDF via Puppeteer (shared browser, 2 pages, timeout, cached per language in private storage) + receipt e-mail with the PDF (job `documents.emailReceipt`) + public `GET /public/verify/:token` (masked)

### F5: Accounts UI + Documents (Frontend) — scope locked 2026-10-14 (owner: "F5 scope OK"; F5.1+F5.2 together, then F5.3+F5.4 together)
- [x] F5.1 Customers (list/search, create/edit drawer with private photo + NID/papers, profile with bookings), Accounts page (payment plan editor with sample breakdown, bank accounts, accounts settings), project **Sales** tab (code + sales policy; code locked once bookings exist)
- [x] F5.2 Booking wizard (`/dashboard/bookings/new`, unit → buyer → price & plan → booking money → review; entry from unit drawer, lead drawer, customer page), booking list + booking page (position strip, schedule, receipts, ledger + integrity, details/nominees edit), receipt entry with allocation preview, receipt reversal
- [x] F5.3 Cheque register + lifecycle (allot/register/handover, transfer, cancel + refunds, reschedule, charges, call milestone) + backend guard: project code frozen once numbers are issued (`PROJECT_CODE_LOCKED`)
- [x] F5.4 Documents (viewer/print/PDF/void/statement), public `/verify/[token]`, dues & collection & PDC reports
- [x] Demo sales data: `npm run seed:sales` (customers, bank accounts, plans, 15 bookings in every state)

### B5: Customer Portal & Reminder Engine (Backend) — scope locked 2026-10-15, code complete 2026-10-15
**B5.1 — client logins & portal**
- [x] Client accounts: login by phone or e-mail (e-mail optional, partial unique index), created at booking/transfer, setup link by SMS + e-mail, forgot-password by SMS, staff invite/resend/disable, co-applicant invite, contact changes flow to the login
- [x] Portal APIs: me, bookings (holder + co-applicant), booking detail (schedule, receipts, documents since holder, slips, payments, construction updates), dues, document HTML/PDF
- [x] Bank slip upload → verification queue (duplicate file/reference warnings) → approve = receipt `slip` in one transaction / reject with reason
- [x] Profile change requests (contact fields only) → approve (audited) / reject
**B5.2 — SSLCommerz**
- [x] init → success/fail/cancel → IPN → Order Validation API → idempotent receipt (`sslcz:<tran_id>`), risk review, reconcile job, staff recheck/approve/reject, `.env.example`, `npm run sslcz:check`, `docs/SSLCOMMERZ.md` (cloudflared)
- [ ] Sandbox tested end to end — owner (keys + tunnel)
**B5.3 — reminders & analytics**
- [x] Reminder rules (T−7, T0, T+3, T+15, editable), BN/EN SMS + e-mail templates, job `reminders.run` + delivery log, preview, run now, manual remind
- [x] Basic analytics aggregations (inventory, sales, collections + dues + expected, pipeline, portal)
- [~] Tests: unit 21 new ✔ in sandbox; integration `tests/integration/b5.test.js` (17 cases) written — owner runs `npm test`

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
3. Backend: `npm run seed` (first time), optional `npm run seed:demo` (sample projects), then `npm run dev`. Frontend: `npm run dev`.
4. Tell Claude: "Read docs/PROGRESS.md and ARCHITECTURE.md in primeplot-back and continue the PrimePlot project." The same docs are also saved in the claude.ai Project.

---

## 📝 Session Log (newest first)

### 2026-10-15 (17): B5 — customer portal, bank slips, SSLCommerz, reminders, analytics (B5.1 + B5.2 + B5.3 together)
- **Scope:** decisions from the previous chat (see Resolved decisions 2026-10-15); owner asked for all of B5 in one go. ARCHITECTURE §6.6b added.
- **Auth/users:** `POST /auth/login` and `/auth/password/forgot` take `identifier` (e-mail or phone; `email` still accepted). Phone shared by several logins → the password picks. `users.email` optional + **partial unique index** (needs `npm run db:indexes` on an existing DB — new script `scripts/sync-indexes.js`). Staff list hides clients (`?role=client` shows them); client logins can't change role; `POST /users` staff roles only. New `auth/authLinks.js`: setup/reset links by e-mail and/or SMS; SMS log keeps a redacted copy (`sensitive`, `redactedBody`; the body is wiped once sent). Token inspect adds masked phone + `role`.
- **Portal (`src/modules/portal/`):** `portalAccount.service` (create/link login, invite + 10-min resend throttle, auto-invite after booking & transfer, disable/enable, login sync on customer edits, client SMS/e-mail notices), `portal.service` (client reads, slips, profile requests), `review.service` (slip queue, approve via the shared `recordReceipt`, profile request approve/reject), models `PaymentSlip`, `ProfileRequest`, routes `/portal`, `/customers/:id/portal`, `/payment-slips`, `/profile-requests`. `booking.service`: `addPayment` now goes through the new exported `recordReceipt()` (one money path for staff, slips and SSLCommerz; `inTransaction` hook; `checkDate: false` for money dates).
- **SSLCommerz (`src/integrations/payments/sslcommerz.js`, `src/modules/payments/`):** session init, Order Validation, Transaction Query, `verify_sign` check (hint only), exact taka↔poisha. `OnlinePayment` model (unique `tranId`, events trail), start (min/max/attempt limits, Idempotency-Key), webhooks `/webhooks/sslcommerz/{success,fail,cancel,ipn}` before originGuard, review (risk / amount mismatch / overpaid / inactive booking), staff `/online-payments` recheck/approve/reject, job `payments.reconcile` (10 min). New env `API_PUBLIC_URL`; `npm run sslcz:check`; `docs/SSLCOMMERZ.md` (Bangla step-by-step with cloudflared).
- **Reminders (`src/modules/reminders/`):** pure planner (rule windows with 2-day catch-up), `ReminderLog` (unique booking+rule+due date), job `reminders.run` (30 min, after send hour), `/reminders/log|preview|run`, `POST /bookings/:id/remind`; SMS purpose `reminder` with `bookingId`; e-mail template `installment_reminder` + generic `notice`. Settings `portal` and `reminders` in accounts settings.
- **Analytics (`src/modules/analytics/`):** `/analytics/{overview,inventory,sales,collections,pipeline,portal}` (`analytics:read` or `reports:read`).
- **Permissions:** `portal:manage`, `online_payments:review`, `reminders:manage`, `analytics:read` (manager + admin). Notifications: `payment_slip.submitted`, `profile_request.submitted`, `online_payment.received`, `online_payment.review`. `seed:sales` turns portal auto-invite off while seeding (demo buyers get no links).
- **Verified in sandbox:** ESLint (whole repo), `npm run check` (234 files), app boot (220 routes, no import cycles), 203 unit tests incl. 21 new (identifier parsing, masking, taka↔poisha, `verify_sign`, reminder windows/planning/catch-up/texts, profile diff, slip + settings schemas, e-mail templates). `docs/API.md` B5.1–B5.3 contracts.
- **Not verified:** anything needing MongoDB — no MongoDB binary in the sandbox (download blocked). Owner: `npm test` (`b5.test.js` uses a fake SSLCommerz; covers auto-invite, phone login, isolation, disable, SMS reset, transfer, slips approve/reject/withdraw/limits, profile requests, pay → success + IPN race → one receipt, risk/mismatch review, fail → reconcile → paid, expiry, reminders T−7/T0/once/manual, analytics). Real sandbox payment: owner with keys + tunnel.
- **Owner's `npm test` (1st run):** 372 passed, 3 failed — all in `b5.test.js`: the test asked `/portal/dues?days=400` (max 365 → 422), and the SSLCommerz shape check wanted `val_id` ≥ 6 chars while the fake gateway used `V1`/`R1` (real ids are longer). Fixed: test uses 365; `val_id` check is now 1–80 safe chars (the Validation API is what decides).
- **Known limits:** no SSLCommerz refund API (refund in the panel); reminders go to the holder only; SMS delivery reports not collected; reminder texts are fixed BN/EN templates (rules/channels/hour are editable).

### 2026-10-14 (16): F5.3 + F5.4 — cheques, lifecycle, documents, verify, reports + code guard + sales seed
- **Backend guard (owner request):** `PATCH /projects/:id` refuses a code change with **409 `PROJECT_CODE_LOCKED`** once any booking/receipt/refund number was issued under the project (checks the `Counter` collection, read-only import from accounts). Same code + other fields still saves. `GET /projects/:id` returns `codeLocked`. Test added to `tests/integration/b4-2-3.test.js`; `docs/API.md` B4.1 conventions updated.
- **Seed (owner request):** `scripts/seed-sales.js` → `npm run seed:sales` (dev only; refuses on production). Through the real services and validation schemas: 2 bank accounts, 3 company-wide payment plans, 17 customers (`+8801888…`, one NRB `+447700900…` with passport), 15 bookings on LVR / UGC / PSC: paid-up + allotted (co-applicant, nominees, discount), overdue in each aging bucket, sold by Nadia/Sumi (if `seed:crm` ran), fully paid → allotted → registered → handed over, booking money by cheque (to bank now), PDC series (cleared → receipt, bounced + ৳500 fee, returned, post-dated), deposited cheque, cancelled + half refund, cancelled (deduction waived) + full refund, transferred, charges (added + waived) + called milestone, allotted with dues (warning). Lifts the receipt back-date limit to 366 days and turns receipt SMS/e-mail off while running, then restores both. Each scenario logs ✔/✖ and the rest continue. **No `--reset`**: receipts/ledger are permanent — use a fresh DB for a clean demo; a second run is skipped when demo customers exist.
- **Frontend F5.3:** booking **Actions** menu (next stage allot → register → handover, receive cheque, add charge, reschedule, transfer, statement, cancel; refund button on cancelled bookings with refund due), `meta.warnings` shown as toasts, stage timeline, cancellation panel (money strip hidden once cancelled), schedule row actions (Call for not-called items, Waive for unpaid charges). `/dashboard/cheques` register (views open/in hand/deposited/bounced/cleared/returned/all, URL filters, cursor "load more", PDC tag, deposit/clear/bounce (fee pre-filled from settings)/re-deposit/return). Cancel drawer with live settlement preview + manager override; refund drawer (cash/transfer/pay order/cheque); transfer drawer (new holder, co-applicants, nominees, project fee or waive reason); reschedule editor (paid rows locked, total must equal the contract). Bell: `cheque.bounced` notification links to the booking's receipts.
- **Frontend F5.4:** booking **Documents** tab (every issued paper, void ones marked, "Issue statement"), `/dashboard/documents/[id]` viewer (backend HTML in a sandboxed iframe, BN/EN switch, Print, Open/Download PDF — `PDF_UNAVAILABLE` 503 → toast "use Print", copy verification link, void banner); print links on receipts; dashboard chrome hidden when printing. Public **`/verify/[token]`** (noindex, no cache): genuine / void (with reason) / unknown, masked holder. `/dashboard/reports`: dues & aging (buckets, as-of, CSV of all pages), collections (daily/monthly, by period/mode/project, refunds, net, CSV), PDC register (to bank now / upcoming / bounced). CSV export is Excel-safe (BOM, CRLF, formula-injection guard). ~320 new BN/EN keys.
- **Verified in sandbox:** ESLint (whole front repo, backend changed files) + Prettier, i18n key check, `next build`; seed script `node --check` + ESLint + module graph loads (stops at the DB connect — no MongoDB in the sandbox). Playwright against the mock API: 44 new checks (cheque deposit → bounce + fee → re-deposit → clear → receipt; receive cheque from a booking; charge add/waive; milestone call; allot/register/handover; documents tab, statement → viewer, print, PDF 503 toast; cancel preview → cancel → refund; booking form voided; verify valid/void/unknown + noindex; reports tabs + CSV; executive sees no actions; BN at 390 px without overflow; no console errors) + the F5.1/F5.2 suite again (38 pass).
- **Not verified:** the real API end to end, the guard test and the seed against MongoDB (owner: `npm test`, `npm run seed:sales`). Known limits: no manual "void a document" endpoint (documents void automatically on reversal / cancellation / transfer); PDF needs Chrome on the server (Print works without it).

### 2026-10-14 (15): F5.1 + F5.2 — customers, accounts, booking wizard, booking page (frontend)
- **Scope:** owner accepted the F5 proposal (all defaults: full-page wizard, sessionStorage draft, customers in F5, no charts until F6) and asked for F5.1+F5.2 together, then F5.3+F5.4 together. Built only against existing B4 endpoints — **no backend change**.
- **New (frontend):** `lib/sales/` (`queries`, `errors` — maps every B4 error code with amounts, `money` — Dhaka dates, bps, allocation preview mirroring `allocation.js`, plan sample mirroring the generator's rounding, Idempotency-Key; `words` — amount in words BN/EN ported from `money.js`; `url`). `components/sales/`: `CustomersPage`, `CustomerProfile`, `CustomerDrawer`, `CustomerPicker`, `PrivateFiles` (private avatar/document uploads, 404 → "not available"), `AccountsPage` (+ `PlansPanel`, `BankAccountsPanel`, `AccountSettingsPanel`), `ProjectSalesTab`, `BookingsPage`, `BookingDetail`, `ReceiptDrawer`, `PaymentFields`, `BookingParts`, `parts` (MoneyInput with live amount-in-words), `wizard/*`. Routes: `/dashboard/customers`, `/customers/[id]`, `/bookings`, `/bookings/new`, `/bookings/[id]`, `/accounts`, `/projects/[id]/sales`. Nav: Bookings + Customers + Accounts live. "Book" in the unit drawer (available / own hold / any hold with `units:write`), "Open booking" on sold units, "Book a unit" in the lead drawer. ~330 new BN/EN keys (`sales.*`).
- **Wizard design notes:** one Idempotency-Key per booking attempt (kept in the draft, so a retry/reload replays instead of double-booking); live server preview (`/bookings/preview`, debounced) is the only price source, `expectedTotal` guards rate changes (`PRICE_CHANGED` → back to the price step); server errors land on the step that can fix them; held unit watched live over the socket (countdown, "no longer available" banner); booking money pre-filled from the plan, min = booking money, cheque at booking supported (receipt on clearing); custom schedule (override) with running total and "put the difference on the last row".
- **Verified in sandbox:** ESLint (whole repo) + esbuild on all changed files, `next build` (fonts stubbed); Playwright against a mock API that uses the backend's real `schedule.js`, `allocation.js`, `money.js`: 50 checks — plan create + sample, duplicate bank account, settings save, project code duplicate/save, customer duplicate NID + NID format + create, full admin booking (co-applicant, nominee, discount + reason, bank transfer, draft restored after reload, one POST with Idempotency-Key, payload), receipt with allocation preview + overpayment guard, reversal with reason, ledger, executive limits (held-by-other hidden, hold countdown, no custom schedule, discount cap error), BN at 390 px with no overflow (fixed one in the wizard grid), no console errors.
- **Not verified:** the real API end to end (owner). Known limits: receipt/booking print & PDF and the cheque register are F5.4/F5.3; the backend still accepts a project-code change after bookings (the UI locks it) — consider a server-side guard in B-side later.

### 2026-10-14 (14): B4.1 test fixes + B4.2 + B4.3 together
- **Owner's `npm test`:** 309 passed, 4 failed — all in my new `bookings.test.js`, none in the booking code: three tests read `Unit`/`Lead` with `findById` (no `orgId` → the tenant guard rightly threw), one used a 5-character phone that the schema rejects before the service (422 vs the expected 400). Fixed in the test.
- **Owner request:** B4.2 and B4.3 in one go.
- **B4.2:**
  - `accounts/cheque.model.js` (+ service helpers): register with history, atomic status changes, duplicate open cheque guard (unique partial index bank + number), PDC flag, report query. `bookings/cheque.service.js`: receive (stale > 6 months refused, open cheques count against the balance), deposit / re-deposit, clear (receipt + allocation + cheque → cleared in one transaction), bounce (fee charge from the new setting `chequeBounceFee`, `cheque.bounced` notification to the seller + cheque managers), return. Booking money by cheque in `POST /bookings`.
  - `bookings/lifecycle.service.js`: allot (warnings `BOOKING_MONEY_UNPAID` / `DOWN_PAYMENT_UNPAID`), register (deed no., warning `DUES_OUTSTANDING`), handover — unit status moves in the same transaction; charges + waiver; call an item; reschedule (total kept, paid items locked, before/after audited); transfer (overdue + open-cheque guards, fee or waiver, `holders[]` history); cancel (policy deduction, override needs `bookings:override` + reason, unit cancelled → available) + preview; refunds (ledger type `refund`, refs `LVR-RF-00001`).
  - `bookings/report.service.js`: dues + aging buckets (1–30 / 31–60 / 61–90 / 90+), collections (`$facet`, Dhaka-time grouping), PDC register.
  - Booking model: `stage`, `allotment`, `registration`, `handover`, `holders`, `cancellation`, schedule `chargeKind`; ledger integrity now ignores refunds (they are not allocated).
- **B4.3:**
  - `documents/` module: `Document` (snapshot, hash, token, void, PDF cache; immutable otherwise), service (issue, void, list, render, PDF, public verify with masked holder name), `render/templates.js` (7 A4 templates, BN/EN, escaped), `render/fonts.js` (base64 @font-face from Fontsource OFL packages), `pdf.js` (Puppeteer pool, network blocked inside the page, closed on shutdown).
  - `bookings/documentData.js` builds every snapshot (bookings → documents, one-way) and issues after commits; `bookings/document.routes.js` (list + back-fill, statement, HTML, PDF, public verify). Job `documents.emailReceipt` + e-mail template `receipt` (BN/EN).
  - New deps: `puppeteer@25.12.0`, `qrcode@1.5.4`, `@fontsource/hind-siliguri`, `@fontsource/plus-jakarta-sans`, `@fontsource/playfair-display` (5.3.0). New env (optional): `PUBLIC_SITE_URL`, `PDF_CHROME_PATH`, `PDF_NO_SANDBOX`, `PDF_TIMEOUT_MS`.
- **Verified in sandbox:** ESLint, `npm run check` (208 files), app boot (171 routes, no import cycles), 182 unit tests (14 new: hashing, masking, templates incl. escaping/void/Bangla digits, aging buckets, B4.2 schemas, model validation, document immutability). **Real PDFs rendered** through the actual templates + headless Chromium for all types in BN and EN, checked as images: Bangla conjuncts shape correctly, tables repeat headers across pages, VOID watermark shows.
- **Not verified:** anything needing MongoDB → owner runs `npm test` (`b4-2-3.test.js`, 16 cases: cheque at booking → clear, PDC register + bounce + re-deposit, stages, charges/call/reschedule, transfer, cancellation + refunds, open-cheque block, reports, documents HTML/PDF/verify/void/statement). The PDF test needs the Chrome that `npm install` downloads.
- Known limits: delay charge is manual (auto penalty v2); registration/handover warn but don't block on dues; documents are issued after the commit (back-filled on the next document list if that step failed).

### 2026-10-14 (13): B4 scope locked + B4.1 — customers, plans, bookings, receipts
- **Scope:** owner accepted every B4 default and D1 (see Resolved decisions). B4 split into B4.1 / B4.2 / B4.3. ARCHITECTURE §3/§5/§6.6 updated (cheque receipt on clearing, booking rules, backend-owned PDF templates).
- **New modules:**
  - `customers/` — `Customer` (customer no. `C-000001`, NID unique, private media only, `accessUserIds` for executive visibility), CRUD + search (name, number, NID/passport, phone in any form).
  - `bookings/` — `PaymentPlan` (spec validated by `zPlanSpec`), `schedule.js` (pure generator + custom schedule), `Booking` (price snapshot, embedded schedule with a `paid` cache, one active booking per unit — unique partial index), `booking.service.js` (preview, create, edit nominees/note, add payment, reverse, ledger), routes `/bookings`, `/payment-plans`.
  - `accounts/` — `Counter` (gapless numbers inside the transaction; counters pre-created outside it so racing inserts can't hit a duplicate key), `AccountSettings`, `BankAccount`, `Receipt` (immutable except the reversal stamp), `LedgerEntry` (append-only), `allocation.js` (pure), receipt SMS, routes `/receipts`, `/accounts`.
- **Shared:** `shared/utils/money.js` (lakh/crore format, amount in words EN + BN, BigInt `bpsOf`), `shared/utils/dhakaDate.js` (Dhaka calendar dates, month clamping, fiscal year), `shared/middleware/idempotency.js`.
- **Touched:** permissions (`bookings:read_all`, `bookings:override`, `bookings:discount_unlimited`, `plans:manage`, `accounts:settings`), `projects` (`code`, `salesPolicy`, `projectSummaries` returns `code`), `units.transitionUnit` (optional `match`), `getUnitForSale`/`priceForSale`, `leads.markLeadWon` + activity type `booking`, `media.assertPrivateMedia`, SMS purpose `receipt`, routes, `seed --sync-indexes` (8 new collections), `seed:demo` (project codes LVR/UGC/PSC/DLS; `--reset` refuses when bookings exist — receipts are permanent).
- **Design notes:** booking = one transaction (booking no. → unit `booked` via the atomic status filter → booking → receipt + ledger → customer access → audit); side effects after commit. Receipts re-read the booking inside the transaction and write the schedule cache with a version check. Executives can take booking money at booking but not later receipts (`receipts:create` is manager-level).
- **Verified in sandbox:** ESLint, Prettier (new files), `npm run check` (192 files), app boot with all routes, 168 unit tests (28 new: amount in words EN/BN incl. crore > 99, lakh grouping, BigInt bps, Dhaka dates + fiscal year, schedule totals + 2,000-plan fuzz, custom schedule rules, allocation order/partial/advance/overpayment, totals + statuses, request schemas, permission bundles, discount caps, Idempotency-Key, receipt/ledger immutability, booking document validation).
- **Not verified:** anything needing MongoDB (the sandbox still can't download `mongod`) → owner runs `npm test` (`bookings.test.js`: customers, preview, booking + lead won, booking money rules, discount caps, held units, 5-way race, idempotency, guards, allocation, 4 parallel receipts, idempotent receipt, reversal, register scoping, settings/plans).
- Known limits: receipt e-mail/PDF waits for B4.3; cheques (incl. at booking) wait for B4.2; co-applicants are fixed at booking (changes go through transfer in B4.2).

### 2026-10-14 (12): Fix — `seed:demo --reset` failed on floor plans
- **Owner report:** `npm run seed:demo -- --reset` printed repeated "Could not queue revalidation … Unknown job type: frontend.revalidate" warnings, then stopped with a ZodError (`mediaId` undefined) at the first floor plan.
- **Cause 1:** `uploadDrawing()` returned `m.id`, but `createMedia()` returns a plain object (`toObject()`), which has `_id` and no `id` virtual. → returns `String(m._id)`.
- **Cause 2:** scripts never imported `#jobs/index.js`, so the `frontend.revalidate` job type was not registered. → `scripts/seed-demo.js` imports it; website revalidation jobs are now queued and the API process runs them.
- **Partial data:** the failed run left a half-built "Lake View Residency"; `--reset` matches by slug and cleans it on the next run.

### 2026-10-14 (11): Fix — /landowners metadata blocked prefetch in dev
- **Owner report:** `next dev` printed "Route /[locale]/landowners: Next.js encountered URL data in generateMetadata()" (+ two browser messages).
- **Cause:** page SEO was read with the short `CATALOG` cache profile (stale 60 s). Next treats short-lived caches as request-time while prerendering; `/landowners` is otherwise fully static, so its metadata would have blocked the static shell. Reproduced with client-side navigation in `next dev`.
- **Fix** (`lib/public/api.js`): site page reads use the long `BRANDING` profile (content changes only on publish and is pushed by the `site` tag anyway); metadata reads the published page through a separate `getPublishedSitePage()` that never touches Draft Mode. Re-checked: 0 errors across Landowners/About/Contact/Projects navigations; build OK.
- **Not ours:** "React instrumentation encountered an error" comes from the React DevTools browser extension; the LCP `loading="eager"` note is a dev hint about a below-the-fold placeholder photo.

### 2026-10-14 (10): B2b + F3b — website content, SEO, construction updates
- **Scope locked with the owner:** fixed sections (no free page builder), focus keyword + checks instead of `meta keywords`, draft → preview → publish with 20 versions, all proposed Home/About sections (see Resolved decisions).
- **Backend** (`src/modules/site/`, `src/modules/construction/`; contract API.md › B2b):
  - `SitePage` (+ `SitePageRevision`) with 27 section keys over 17 typed schemas, defaults BN/EN, compare-and-set versions, publish / discard / restore, visibility rule (empty → hidden), `SiteSettings` (title template, defaults, Google/Bing verification — accepts the pasted meta tag, social links, indexing switch), `Project.seo`, permission `site:manage` (admin, manager).
  - `ConstructionUpdate` (date, %, milestone, block, ≤ 20 photos with captions, publish) with staff CRUD, public timeline (cursor), latest-per-project for the home page, `construction` summary on the public project.
  - Public `/public/site`, `/public/site/pages/:key` (+ signed draft preview), `site` revalidation tag. `seed:demo` adds 3 published updates to the ongoing demo project; `--sync-indexes` covers the new collections.
  - Two Zod 4 traps found and fixed: `.default({})` returns `{}` without inner defaults (→ `.prefault`), and `.optional()` on a defaulted field still fills it — a PATCH would have blanked an update's title (→ default-free `zTObj` for PATCH bodies; regression tests added).
- **Frontend:**
  - Public Home + About rebuilt from sections: why us, track record, construction progress, testimonials, landowner band, approvals/partner logos, click-to-load YouTube tour (youtube-nocookie), FAQ (+ FAQPage JSON-LD); About: story timeline, mission/vision/values, leader message, team, construction standards, completed projects, licences + logos, awards, CSR. Hero frame stays static (LCP); copy streams in.
  - Metadata from SEO (`lib/public/seo.js`): titles, descriptions, share images, title template, verification tags, noindex, Organization `sameAs`; sitemap uses publish dates and skips noindex pages.
  - Draft Mode preview (`/api/preview`, banner + exit); revalidation webhook accepts the `site` tag.
  - Project page: construction timeline with progress bar and photo viewer.
  - Dashboard: **Website** (nav) → page editor (sections: edit, show/hide, reorder, reset to default; SEO tab with search preview and checks; save draft, preview, publish with note, history/restore, discard), **Site-wide SEO**; project tabs **Construction** and **SEO**. ~300 new BN/EN message keys.
- **Checks:** backend 140 unit tests; site + construction HTTP flows run on FerretDB (MongoDB wire protocol — real MongoDB was not reachable here; `$cond`/`$first` aggregations are a FerretDB gap, covered by `site.test.js` for the owner). Frontend ESLint + `next build`; Playwright against a mock API that uses the backend's real section schemas: BN/EN desktop + 390 px — editing, signed preview, publish → revalidate → live, verification meta, sameAs, FAQ schema, construction create, project SEO; no console errors or overflow.

### 2026-10-14 (9): CRM demo data — `npm run seed:crm`
- **Owner request:** typing test data by hand takes too long → seed it.
- **`scripts/seed-crm.js`** (dev only, refuses `NODE_ENV=production`): 3 demo staff (`nadia@` manager, `sumi@` / `rakib@` executives `@demo.primeplot.test`, password printed once or `--password`); 83 buyer + 7 landowner leads in every stage (buyer "New" > 50 cards → "show more"; table > 50 rows → "load more"), timelines (created, Meta form, auto-assign, auto-reply, calls with outcomes, notes, stage changes, repeat enquiries, SLA escalation, tasks), 23 tasks (overdue / later today / tomorrow / next days, one reminder ~3 min after seeding → bell), 10 notifications (every type), 49 SMS (auto-replies sent / failed / skipped for a UK number, test SMS sent / failed). Links leads to `seed:demo` projects when they exist.
- Named test scenarios printed at the end (SLA running / missed / escalated, overdue task, merge pair, lost → reopen, duplicate phone, NRB number, executive view).
- Demo leads are recognised by phone (`+8801999…`, `+447700900…`); `--reset` deletes only those leads and their activities, tasks, notifications and SMS (staff kept). Times are relative to the run → `--reset` refreshes "today / overdue / SLA". Documents pass schema validation, then go in with raw inserts so back-dated `createdAt` stays.
- **Checked:** ESLint + `node --check`; run end to end against stubbed Mongoose (no MongoDB here) — 90 leads / 438 activities / 23 tasks / 49 SMS / 10 notifications validated; unique ranks and open keys, SLA states, reminder timing, closed leads end on their stage, reset path; leads pass the real `toLead()` serializer.

### 2026-10-13 (8): F4 — CRM UI (F4.1–F4.4 together)
- **F4.1 Leads + Kanban:** `/dashboard/leads` (table, filters + preset views in the URL — all / mine / unassigned / response overdue / follow-up today / follow-up overdue, multi-select bulk assign, CSV export for `leads:read_all`, cursor "load more") and `/dashboard/pipeline` (buyer / landowner tabs, `@dnd-kit/core` drag between and within columns with optimistic update; `STALE_VERSION`/`STALE_POSITION` → snap back + reload; lost stage → lost-reason dialog; per-column "show more"; phone: one column at a time via tabs + each card's "Move to…" menu). SLA chip (time left / late, text + tone), source icon, owner, next follow-up on every card/row. Manual lead create drawer (`DUPLICATE_LEAD` → "open that lead").
- **F4.2 Lead drawer** (`?lead=<id>` in the URL, opens over the table, board, tasks and integrations pages): call / WhatsApp links, stage + owner selects, edit details (buyer interest or land fields), merge (search another lead of the same type), delete; tabs: activity (composer for note / call with outcome + duration / WhatsApp / SMS / email / meeting / site visit; timeline with system entries incl. auto-reply, SLA escalation, Meta import), tasks (add, complete, reopen, done list), details.
- **F4.3:** notification bell in the header (unread badge, live via the socket `notification` event, mark read / all read, click → lead drawer); `/dashboard/tasks` (mine / all, overdue / today / upcoming, counts); `/dashboard/crm-settings` (`pipeline:manage`: stage editor per pipeline with order / kind / colour / Bangla name, assignment mode + project pools, SLA + office hours + weekend, auto-reply BN/EN with live SMS length / segments / cost preview); `/dashboard/integrations` (Meta Page connect / replace token / disconnect, form → pipeline + project mapping, import log with retry, sync now; SMS status, this month's usage, test SMS, delivery log). Nav: My tasks, CRM settings, Integrations; F4 badges removed.
- **F4.4:** public `/landowners` page (hero, form, four-step process) + `LandownerForm` (`POST /public/leads`, type `landowner`, land fields, same honeypot / min-fill time / quiet retries as the buyer form); header, footer and sitemap links. `.env.example` → `NEXT_PUBLIC_LEADS_ENABLED=true`.
- **Shared:** `lib/crm/` (queries, constants, URL state, error mapping), `components/ui/Menu.js`, `Dialog.js`, `lib/hooks/useMediaQuery.js`, `useStaffEvent()` in `lib/socket.js`; ~800 new message keys in `bn.json` / `en.json` (Bangla digits via `Intl.NumberFormat`).
- **Checks:** ESLint clean, `next build` OK; Playwright smoke against a mock API (BN + EN, 1440 px + 390 px): all CRM pages, drawer, bell, desktop drag, phone tabs, landowner page — no console / page errors, no horizontal overflow (fixed one on Integrations at 390 px).
- **Owner end-to-end check:** create a lead manually → drag across the board → lost reason → reopen; website enquiry + `/landowners` form → lead appears, auto-reply in the SMS log (driver `log`); task with a due time 2 min ahead → bell; CRM settings save (try a too-long auto-reply → error on the field); Integrations → test SMS.

### 2026-10-13 (7): B3.1 test fixes + B3.2 — SMS, auto-reply, SLA escalation, Meta Lead Ads
- **B3.1 fixes (owner's `npm test`):** two leads tests used a one-letter name (schema needs ≥ 2) → fixed in the test; `rankBetween()` now refuses out-of-order neighbours itself (`fractional-indexing` ≥ 3.3 silently swaps them); `LeadSettings` had a duplicate `orgId` index (the unique one was never applied) → one unique index via `path('orgId').index({ unique: true })` — **run `npm run seed -- --sync-indexes`**.
- **Owner decisions:** B3.2 defaults accepted, B3.2 before the full F4; F4 saved views = presets + URL; phone Kanban = tabs + "Move to…" (see Resolved decisions).
- **SMS** (`src/integrations/sms/`): `segments.js` (GSM-7/UCS-2, extension chars, never splits an escape or surrogate pair), drivers `log` / `bulksmsbd` (form POST, `response_code` 202, code table) / `sslwireless` (API v3 JSON with a unique `csms_id`), credentials only in the body, timeouts, retryable vs permanent errors. Formats checked against the providers' published client libraries. Env: `SMS_API_URL`, `SMS_COST_PER_SEGMENT_POISHA`; a real driver without key + sender ID refuses to boot.
- **Delivery log** (`src/modules/sms/`): `SmsMessage` (queued → sent | failed | skipped), job `sms.send` (4 attempts), expiry, foreign numbers skipped, setup errors alert admins (`integration.error`, throttled 6 h — `src/modules/integrations/alerts.js`).
- **Auto-reply** (`leads/autoReply.js`, `autoReplyText.js`): new website/Meta leads only, once per phone per 24 h, language from the page or the company default, `{name}`/`{company}`, given up after 30 min, timeline `auto_reply`. Settings refuse a text longer than 6 SMS (`AUTO_REPLY_TOO_LONG`).
- **SLA escalation:** `escalateSlaBreaches()` + job `leads.slaEscalation` (every minute) → `lead.sla_breached` to every manager once per lead (`Lead.slaEscalatedAt`), timeline `sla_escalated`, misses older than 7 days ignored.
- **Meta Lead Ads** (`src/integrations/meta/`, `src/modules/meta/`): Graph client (Bearer token + `appsecret_proof`, error classes, field fallback), `MetaConnection` (Page token AES-256-GCM — `encryptSecret`/`decryptSecret` in `shared/crypto/secrets.js`), `MetaLeadEvent` (idempotency per leadgen id + import log), webhook `/api/v1/webhooks/meta` (verify echo, `X-Hub-Signature-256` over the raw body — `app.js` keeps it for `/webhooks/*`), jobs `meta.fetchLead` + `meta.reconcile` (nightly 02–06 Dhaka, 48 h), form → pipeline/project mapping, import into the normal intake (dedupe, round-robin, SLA, auto-reply), retry, sync. Graph `v25.0` (env `META_GRAPH_VERSION`).
- **Admin API** `/api/v1/integrations` (+ `docs/API.md` B3.2 section). New notification types `lead.sla_breached`, `integration.error`; new activity types `auto_reply`, `sla_escalated`, `meta_lead`. Scripts `npm run sms:check`, `npm run meta:connect`. Seed `--sync-indexes` covers the 3 new collections.
- **Verified in sandbox:** ESLint, Prettier, esbuild + `node --check` on every changed file, 118 unit tests (37 new: segment maths, both drivers' request/response/error mapping with mocked HTTP, log driver, csms_id length, token encryption + tamper, webhook signature, leadgen parsing, Graph auth/proof/error classes/field fallback/paging, lead field mapping, reconcile window, schemas), env cross-checks, webhook smoke test through the real app (verify 200/403, signature 401/200, tampered body 401), Mongoose validation of the new documents.
- **Not verified:** anything needing MongoDB (`tests/integration/integrations.test.js`, 18 cases: auto-reply rules, delivery, expiry, foreign numbers, settings length check, SLA escalation, admin permissions, preview, test SMS, Meta connect/bad token, webhook dedupe, import, repeat enquiry, NO_PHONE, form mapping, expired token + retry, reconcile, disconnect) → owner runs `npm test`. Real BulkSMSBD / SSL Wireless sends and real Meta calls need the owner's accounts.
- Known limits: "sent" = accepted by the gateway (no handset delivery reports); BulkSMSBD has no request id, so a timeout after it accepted a message can send it twice (SSL Wireless dedupes on `csms_id`); Meta webhooks need a public HTTPS URL (dev: a tunnel such as `cloudflared`); the Meta Page is connected with a pasted token (no Facebook Login button in v1).

### 2026-10-13 (6): B3.1 — core CRM + website form
- **Owner decisions:** round-robin, 30-minute office-hours SLA, auto-reply SMS on (setting), B3 split into B3.1/B3.2 (see Resolved decisions).
- **New modules:** `src/modules/leads/` (`lead.model`, `leadStage.model`, `leadActivity.model`, `leadTask.model`, `leadSettings.model`, `lead.service`, `followup.service`, `pipeline.service`, `sla.js`, `lead.validation`, `lead.routes`, `publicLead.routes`), `src/modules/notifications/` (model, service, routes). Job `leads.taskReminders` (every minute).
- **Shared:** `shared/utils/rank.js` (fractional ranks via the `fractional-indexing` package — new dependency), `normalizePhone()` in `shared/utils/phone.js` (international numbers), `emitToUser()` + personal socket room in `sockets/index.js`, lookup helpers `listActiveStaffWith`/`userNames` (users), `projectSummaries` (projects), `unitRefs` (units). Routes mounted in `src/routes.js` (`/leads`, `/notifications`, `/public/leads` before the cached `/public`). New collections registered for `seed --sync-indexes`.
- **Design notes:** dedupe uses an `openKey` (`type:phone`) with a unique partial index — two identical enquiries at the same instant make one lead; the loser becomes an enquiry. Round-robin moves its cursor with compare-and-set. Kanban moves write one document (rank between neighbours); same-instant ties are split on the next move. Executives get 404 for leads that aren't theirs. CSV export neutralises spreadsheet formulas.
- **Verified in sandbox:** ESLint/Prettier, `npm run check`, 81 unit tests (18 new: rank fuzz 3,000 random inserts + 20,000 top-inserts stay ≤ 6 chars, SLA office-hours cases incl. Friday and evening spill-over, BD/international phones, request schemas, permissions), app boot with the new routes, Mongoose validation of every new document shape.
- **Not verified:** anything needing MongoDB (sandbox still can't download `mongod`) → owner runs `npm test` (`tests/integration/leads.test.js`, 24 cases: intake, round-robin, repeat enquiry, 6 simultaneous submissions → 1 lead, bots, landowner, manual mode, visibility, duplicates, NRB numbers, moves/lost/reopen, ordering, stale versions, edits, activities, tasks + reminders, task privacy, reassign, bulk assign, merge, stage edits, settings, CSV, notifications).
- Known limits: under heavy contention the round-robin cursor can skip a person once (the lead still gets an owner, or goes to the unassigned queue); a socket keeps its personal notification room until it disconnects, even after logout (token checked at connect, same as B2).

### 2026-10-13 (5): forgot-password email not arriving — diagnostics
- Email has existed since B1 (Nodemailer + `email.send` job, BN/EN templates `password_reset`, `account_setup`, `password_changed`). The code path checks out; the cause is on the owner's side (SMTP login, an email that is not a user, or the API not running) and couldn't be seen from the sandbox (no Atlas/Gmail access).
- **New:** `npm run email:check [-- --to you@x.com] [-- --user login@x.com]` (`scripts/email-check.js`): shows SMTP config (masked), tests the SMTP login with a plain-language fix hint (Gmail App Password, port/secure mismatch, network), optionally sends a test email, lists the last 10 `email.send` jobs with status/attempts/lastError, and checks whether a login email exists.
- **Fix:** reset/setup links now include the user's locale (`/bn/reset-password?token=…`), so they open in the right language without a redirect.
- Open: the email templates still use the early placeholder colours (terracotta/stone), no logo — a brand pass (olive/sage, logo, BN fonts) is proposed, awaiting owner OK.

### 2026-10-13 (4): F2b — public-site extras
- **Owner decisions:** GA4 / Meta Pixel IDs are managed from the dashboard (not `.env`); Privacy + Terms both in the footer; legal name from Company settings.
- **Backend:** `Organization.analytics { ga4MeasurementId, metaPixelId }` (format-checked, upper-cased GA4, `""`/`null` clears one key, audit diff + website revalidation through the existing `PATCH /org`); `GET /org/public` now also returns `legalName` and `analytics`. Files: `organizations/organization.{model,service,routes}.js`, `tests/integration/rbac-users.test.js` (+1 case), `docs/API.md`.
- **Frontend:**
  - Company settings: new "Website analytics" section (GA4 + Pixel, same format rules as the API); legal-name hint says it is used on Privacy/Terms.
  - `/privacy`, `/terms` (`components/site/LegalPage.js`): long text in `content/legal/{bn,en}.json` (server-only — kept out of `messages/` because messages ship to the browser on every page); company/legal name, address, phone, email from settings; privacy names the tools actually switched on; numbered TOC; "Last updated" from `LEGAL_UPDATED`. In the footer bottom bar + the enquiry form note + sitemap.
  - `components/site/SiteDock.js` (in the site layout): cookie banner (equal-weight Accept / Only essential, link to privacy), tag loader (GA4 gtag + Meta Pixel via `next/script`, only after consent, IDs re-validated before going into inline scripts), Pixel PageView on client navigation, call/WhatsApp click events (delegated listener), floating WhatsApp button, comparison tray. Consent cookie `pp_consent = granted.<g|p> | denied` (180 days); withdrawing deletes `_ga*`/`_fbp`/`_fbc` and reloads. No IDs → no banner and no "Cookie settings" link. `lib/analytics/{consent,track}.js`; `LeadForm` sends `generate_lead` on success.
  - OG cards (`projects/[slug]/opengraph-image.js`, `units/[unitId]/opengraph-image.js`, `lib/public/og.js`): olive card, Playfair/Jakarta from Google Fonts (cached; falls back to the built-in font), cover photo converted from WebP with sharp (cached; card without photo if it fails), "Tk" prices. English on both locales by design.
  - Compare: `CompareToggle` on the unit page, shortlist in localStorage (`lib/public/compare.js`, max 3, synced across tabs), `/compare?u=` server page (invalid/duplicate ids ignored, "Lowest" price / "Largest" size markers — size only among the same kind, estimates with the calculator defaults, remove column, `noindex`).
- **Verified in sandbox** (mock API, production build with fonts stubbed): `next build`, ESLint, 41 Playwright checks on the public site (consent flow incl. reject/reopen/accept/withdraw, tags only after consent, events in dataLayer/fbq queue, re-ask on a new tool, footer links, legal pages BN/EN, compare flow + URL sync, empty state, 390 px no overflow), 9 on Company settings (load, client validation, PATCH body, clear, Bangla 390 px), "no IDs" case, OG PNGs (200, project + unit + plot, WebP cover via sharp). Backend: ESLint/Prettier, `npm run check`, 63 unit tests, model validation.
- **Not verified:** the new integration test against MongoDB (owner runs `npm test`); real Google Fonts in OG cards and real GA4/Pixel hits (sandbox has no access).
- Known limits: OG images are English-only; the comparison tray is per browser (the `/compare` URL is what you share).

### 2026-10-13 (3): roadmap additions + public-site colour pass
- **Roadmap:** owner accepted all 8 public-site extras → new **F2b** (privacy/terms, WhatsApp button, GA4 + Meta Pixel with consent, OG images, unit comparison), **B3** (+ `POST /public/leads`, landowner/joint-venture leads; `/landowners` page in F4), new **B2b + F3b** (editable site content, construction updates with public timeline).
- **Colour pass** (owner: "too white"): new tokens `paper` #F2EDE3, `sage-tint` #E3E6D8, `sage-line` #C9CDB8, `primary-deep` #23271F; utilities `grain` (paper texture), `band-dark`, `stamp`. Public pages now alternate warm paper · sage bands · dark olive bands: header/page on paper; listing header sage with the filter bar overlapping it; project page facts band, gallery and amenities dark, availability sage, contact band sage; home stats + buying steps dark, areas sage, a "Live stock" stamp on the search card; unit price card dark; plan header sage; about principles dark; contact header sage. Inside `.site` the accent and muted-text tokens step one shade darker so small text keeps AA (≥ 4.5) on paper/sage. Dashboard unchanged.
- Verified: build, ESLint, all 43 Playwright checks, no overflow at 390 px.

### 2026-10-13 (2): F2 step 2 — home, about, contact + demo seed
- **Backend:** `scripts/seed-demo.js` (`npm run seed:demo`, `-- --reset` to recreate; refuses `NODE_ENV=production`). Through the real services: 4 published projects — Lake View Residency (2 buildings, 4 types, rate card with floor rise/facing/corner/parking/charges, held/booked/blocked units, typical floor plan for floors 1–10, site plan with building hotspots), Uttara Green Court (ready, mostly booked), Purbachal Shapla City (plots on 3 roads, katha deeds, road-width tiers, corner %, layout plan with a hotspot per plot), Dhanmondi Lakeside (upcoming, no units, prices hidden). Plan drawings are rendered with sharp and stored through the media pipeline. Not run in the sandbox (no MongoDB).
- **Frontend:**
  - Home `/` (moved into the `(site)` group; the Phase 0 page is gone): hero with background video (poster first, video only after paint, never with reduced motion / Save-Data / 2G, pause button), "find a home" GET search card, real stats band, featured row + cards, areas with live counts, four buying steps, enquiry form. Video = Pexels clip 7578541 (HD, UHD fallback); own file later via `NEXT_PUBLIC_HERO_VIDEO` / `NEXT_PUBLIC_HERO_POSTER`.
  - `/about` (drafted copy in `messages/*.json › site.about`, licences from company settings, real stats), `/contact` (phone, WhatsApp, email, office → Google Maps, enquiry form).
  - `LeadForm`: react-hook-form + zod (BD mobile), honeypot, 2.5 s minimum fill, quiet retry on network/5xx, values kept on failure; submit disabled with a call/WhatsApp prompt while `NEXT_PUBLIC_LEADS_ENABLED` is not `true`.
  - `Reveal` (GSAP ScrollTrigger, once, off with reduced motion, content visible without JS). Nav/footer: About + Contact. Page titles now "<page> · <company name>". Sitemap adds /about, /contact.
  - **Build no longer needs the API:** catalogue/branding reads postpone to request time during `next build` (`NEXT_PHASE`), request data is awaited before any fetch. Verified: `next build` passes with the API down.
- New dependency: `gsap` 3.15. New env (optional): `NEXT_PUBLIC_LEADS_ENABLED`, `NEXT_PUBLIC_HERO_VIDEO`, `NEXT_PUBLIC_HERO_POSTER`.
- **Verified in sandbox:** build (API down and up), ESLint, 14 new Playwright checks (title, video sources + pause, stats, hero search → filtered listing, disabled form + call link, area links, About active nav + licence, contact cards, reduced motion → no video, sitemap) + the 29 F2.1 checks again, no dev-overlay issues, no overflow at 390 px.
- **Not verified:** the Pexels HD file URL (UHD URL confirmed from the Pexels page; the browser falls back to it), real fonts/photos, the demo seed against MongoDB.

### 2026-10-13: F2 step 1 — public catalogue
- **Fixed first:** the F3.2 price-matrix test read units without `orgId` (tenant guard) → `inventory.test.js` lines 313/336 now filter by `orgId`.
- **Backend:** `GET /org/public` now also returns `logo` (public Media), `tradeLicenseNo`, `rehabMemberNo`; `PATCH /org` queues the website revalidation tag `org`. Files: `organizations/organization.routes.js`, `tests/integration/rbac-users.test.js`, `docs/API.md`.
- **Frontend — routes** (`app/[locale]/(site)/`, own header/footer layout, `error.js`, `not-found.js`):
  - `/projects` — filters in the URL (search, type, status, area, starting-price bands, sort), grid with editorial rows for featured projects, map view; a real GET form (works without JS).
  - `/projects/[slug]` — diagonal hero, facts band, overview + numbered highlights, Embla gallery + full-screen viewer (keyboard/swipe), unit-type table, **live** building elevation / plot tiles per road (public Socket.IO room), plan cards, amenities, MapLibre map (lazy, cooperative gestures) + Google Maps link, contact band.
  - `/projects/[slug]/plans/[planId]?floor=` — public plan viewer (same SVG engine as the dashboard), floor switcher without a server round-trip, live colours, zoom, list of homes on the floor.
  - `/projects/[slug]/units/[unitId]` — facts, layout or sample image, price, payment calculator, "see it on the plan", similar available homes; a wrong project slug redirects (308) to the canonical URL.
- **Data:** `lib/public/api.js` — `use cache` reads tagged `projects` / `project:<slug>` / `org` (5 min background refresh as a safety net); a 404 → `notFound()`, errors are never cached. Branding uses `getSiteOrgOrNull()` (postpones to request time if the API is down during a build).
- **`/api/revalidate`:** raw-body HMAC-SHA256 check in constant time, ±5 min timestamp, tag allow-list, `revalidateTag(tag, { expire: 0 })`.
- **SEO:** per-page title/description, canonical + hreflang (bn, en, x-default), OG image, JSON-LD (ApartmentComplex/Place, Apartment + Offer, BreadcrumbList), `app/sitemap.js` (both languages, plans, available/reserved units), `app/robots.js`. **Indexing is off unless `NEXT_PUBLIC_ALLOW_INDEXING=true`** (robots disallow + noindex).
- **Shared changes:** `lib/socket.js` has a separate token-less public pool (visitors never call `/auth/socket-token`); `PlanCanvas` keeps native pinch-zoom in view mode; `SmartImage` no longer collapses when given `absolute inset-0`; `.caps` utility + Bangla override (no letter-spacing on Bangla labels, incl. `.eyebrow`).
- **New deps:** `embla-carousel-react` 8.6, `maplibre-gl` 6.11.2 (worker copied to `public/vendor/maplibre/` by `scripts/vendor-maplibre.mjs` on `predev`/`prebuild`; git-ignored). **New env:** `NEXT_PUBLIC_ALLOW_INDEXING`, `NEXT_PUBLIC_MAP_STYLE_URL` (default OpenFreeMap, no key).
- **Verified in sandbox** against a mock public API + Socket.IO: `next build` (fonts stubbed) clean, ESLint + esbuild clean, 29 Playwright checks (filters/search/budget/map view, live recolour on project + plan pages, gallery keyboard, building tabs, floor switch + URL, hotspot → unit, calculator, slug redirect, 404, Bangla plot page, no prices when `publicPricing` is off, no socket-token calls, revalidate 200/401/401/400) + webhook → fresh HTML, no horizontal scroll at 390 px, no dev-overlay issues.
- **Not verified:** real fonts, map tiles and Unsplash photos (sandbox has no access), real API end to end.
- Known limits: the "Available now" fact on the project page is server data (the grid below it is live); the listing has no size filter (the API's project cards carry no unit sizes); plan hotspot labels are shown as staff typed them.

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
