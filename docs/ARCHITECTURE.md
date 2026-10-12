# PrimePlot — Locked Architecture (v1)

> **Status:** Scope locked on 2026-10-11 (owner: Sifat).
> Changing anything in this file requires the owner's approval. Every change must be logged in the Session Log of `PROGRESS.md`.
> Progress is tracked in `docs/PROGRESS.md`.

---

## 1. Product

PrimePlot is a real-estate management and CRM platform for Bangladeshi real-estate developers and agencies. It has four parts:

- a public property showcase
- a CRM pipeline
- inventory tracking
- accounts: installments, receipts and QR-verified documents

## 2. Stack (fixed)

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router), **pure JavaScript** (no TypeScript), Tailwind CSS v4, React 19 with React Compiler |
| Backend | **Node.js ≥ 24** (`engines`), Express 5, ESM (`"type": "module"`), modular MVC |
| Database | MongoDB Atlas **M0 (free)** with Mongoose. M0 is a replica set, so transactions work. DB name `real-estate`. |
| File storage | **Local disk (`uploads/`)** behind a storage adapter. Served by `express.static` in dev and Nginx in prod. Cloudinary is not used. |
| Background jobs | **No Redis/BullMQ.** A MongoDB-backed scheduler (see §6.3) |
| Hosting | **Dev-only for now.** When complete, the backend goes on the owner's **existing Hostinger VPS** (PM2 + Nginx + Let's Encrypt). Frontend: Vercel or the same VPS (decision D3). |
| Backend port | `5030` |

## 3. Locked decisions

1. **Tenancy:** each deployment serves one company (single-tenant). **Every schema must have `orgId`** (base plugin, §6.1), for future SaaS.
2. **Inventory:** v1 supports both **Apartment** and **Plot**. One `Unit` model with `kind: 'apartment' | 'plot'` and a separate pricing strategy per kind.
   - Hierarchy *(B2)*: Project → Block (`building` for apartments; `block`/`sector` for plots) → Unit. A building declares its floor range; each unit carries `floor` (0 = ground, negative = basement) and `position` ('A', 'B'…), so there is no Floor collection. A plot's road is a unit field (`road`, `roadWidthFt`).
3. **Queue:** no Redis. MongoDB `jobs` collection plus a tick.
4. **Storage:** local `uploads/` (adapter pattern: `STORAGE_DRIVER=local`, with S3-compatible drivers possible later).
5. **Hosting:** dev now; at the end, Hostinger VPS (backend) + Atlas M0. *(Updated 2026-10-11: Render/Cloudinary dropped.)*
5a. **Third-party integrations are fully built but env-driven:**
   - SSLCommerz and the SMS gateway are fully implemented.
   - When a client is onboarded, putting their API keys in `.env` makes them work. No code changes needed.
   - If keys are missing, the feature degrades gracefully: SMS goes to the `log` driver, and the payment button is hidden.
5b. **Placeholder images:**
   - Until real media is uploaded, the whole project shows curated free stock images from Unsplash/Pexels (§7.1).
5c. **SMTP email** is configured (`SMTP_*` env). Email is a first-class channel: password reset, receipt delivery, reminders.
6. **v1 must-haves:**
   - Bangla/English i18n toggle
   - QR-verifiable digital documents and money receipts
   - Customer Portal (Client role: installments and due list)
   - Automated installment reminder engine
7. **Roles (RBAC):** Admin, Sales Manager, Sales Executive, Client. Access is permission-based; a role is a bundle of permissions.

## 4. v1 scope vs v2 (deferred)

> Final v1/v2 split is pending owner confirmation of the recommendation (D4 in PROGRESS.md).

**In v1 (proposed):**

- Public showcase with floor plan and master plan viewer
- Lead capture: website forms, Meta Lead Ads, manual entry
- Kanban CRM
- Inventory tracker for apartments and plots, with real-time status
- Booking, payment schedules, receipts, cheque/PDC handling, transfer and cancellation
- QR-verified documents + server PDF (Puppeteer on the VPS) + email delivery
- Customer Portal: units, schedule, dues, receipts, documents, plus **SSLCommerz online payment**
- Manual payment channels first-class (cash, cheque/PDC, bank transfer, pay order); the client can upload a **bank-transfer slip** in the portal, staff verify it, and a verified slip becomes a normal receipt *(D5, accepted 2026-10-12)*
- Reminder engine (SMS + email)
- Discount limit per role (permission-based; not a full approval workflow)
- Milestone-type schedule items that staff mark due manually
- Basic audit log
- Basic analytics
- Bangla/English

**Deferred to v2 (proposed):**

- Channel partner (broker) module and commissions
- Full maker–checker approval workflow
- Construction progress feed + automatic milestone billing
- WhatsApp Cloud API (needs Meta business verification)
- Advanced analytics and forecasting
- Multi-tenant SaaS mode
- Redis/BullMQ and multi-instance scaling

## 5. Domain rules (business rules, must be followed)

- **Area units** *(owner decision 2026-10-12)*:
  - Plot/land: entered in **katha or decimal (শতাংশ)**; the entered figure is kept (deed = source of truth) and katha, decimal, sq ft and sq m are derived and stored. 1 katha = 720 sq ft, 1 decimal = 435.6 sq ft (= 0.605 katha).
  - Apartment: **sq ft is primary** (`saleableSqft`, optional `carpetSqft`); sq m is derived and stored so every view can show both.
  - Conversions and area × rate prices use exact scaled-integer math (`src/shared/utils/area.js`).
- **Money:** always stored as **integer poisha** (`Number`, ৳1 = 100). Never use floats. Format only for display.
  - Lakh/crore grouping: `৳ 1,25,50,000`.
  - Amount in words in English and Bangla.
- **Phone:** stored in E.164 format (`+8801XXXXXXXXX`). It is the key for lead dedupe.
- **Unit status machine:**
  - Transitions: `available → held → booked → allotted → registered → handed_over`, plus `blocked`, plus `cancelled → available`.
  - Transitions are enforced in the service layer.
  - `blocked` takes a `reason` (`landowner_share`, `management_reserve`, …). Blocked units are never shown publicly.
- **Hold:**
  - Applied atomically: `findOneAndUpdate({_id, status:'available'}, …)`.
  - Expiry is enforced two ways: a scheduled job, and a lazy check on read.
- **Price snapshot:** the price breakdown is frozen into the booking at booking time. Changing a rate later never changes existing dues.
- **Ledger is append-only:**
  - Corrections are made only with reversal entries.
  - Receipt → allocations against the oldest unpaid schedule items. This handles partial and advance payments.
- **Cheque/PDC:** `received → deposited → cleared | bounced`. A bounce reverses the allocations and adds a fee.
- **Receipt number:** gapless, per project, per fiscal year (July–June). Generated with an atomic `$inc` counter inside the transaction.
- **Schedule rounding:** the rounding remainder goes into the last installment. The total must match the contract exactly.
- Booking, receipt, cancellation and transfer each run in a **MongoDB transaction**.

## 6. Backend architecture

### 6.1 Conventions

- **Layering:** Route → Controller (HTTP only) → Service (business rules, transactions) → Model.
  - Add a `*.repository.js` only for heavy aggregations.
- **Base schema plugin** (`src/shared/plugins/baseSchema.js`), applied to every model:
  - adds `orgId` (required, indexed), `timestamps` and soft delete (`deletedAt`)
  - unique and compound indexes always start with `orgId`
  - **tenant guard:** any query/aggregate without an `orgId` filter throws `TENANT_SCOPE_MISSING`, unless `{ skipTenant: true }` is set explicitly (seeds, system jobs)
  - soft-deleted docs are hidden unless `{ withDeleted: true }`
- **Validation:** Zod (`.strict()`, primitives only) on every request + Express 5 `simple` query parser — this is the NoSQL-injection boundary.
  - Global Mongoose `sanitizeFilter` is **off** (decided in Phase 0): it would force every internal `$in`/`$gte` through `mongoose.trusted()`.
  - Do not use `express-mongo-sanitize`: it is incompatible with Express 5.
- **Module imports:** Node subpath imports `#config/*`, `#shared/*`, `#modules/*` (see `package.json` → `imports`).
- **Errors:** `AppError` hierarchy plus a central error handler. Response shape:
  - success: `{ success: true, data, meta? }`
  - error: `{ success: false, error: { code, message, details? } }`
- **Logging:** pino and pino-http, with a request ID.
- Express 5 handles async errors itself, so no `asyncHandler` is needed.

### 6.2 Auth & security

- Access JWT valid for 15 minutes, in an HttpOnly cookie.
- Refresh token:
  - rotated on every use
  - stored hashed in a `sessions` collection
  - reusing an old token revokes the whole session family
- Brute-force protection: failed attempts are counted on the user document and trigger a lockout. This is durable; the rate limit is not.
- Passwords: Node's built-in **scrypt** (N=2^15, r=8, p=3), self-describing hash format so parameters can be raised later (rehash on next login). *(B1)*
- Access tokens carry the user's `authVersion`; password/role/status change and logout-all bump it, so every outstanding token dies at once. A 30 s in-process cache keeps this check off the DB for most requests. *(B1)*
- Single-use emailed tokens (password reset 30 min, account setup 72 h) are stored only as HMAC hashes. *(B1)*
- `helmet`, strict CORS (credentials), and `express-rate-limit` with an **in-memory store**. That is fine for a single instance, but it resets on restart.
- **Cookies across frontend and backend hosts:** the frontend proxies `/api/*` to the backend through **Next.js `rewrites`**, so cookies stay first-party on the frontend domain.
  - This works on Vercel, on the VPS, and in dev (`localhost:3000` → `localhost:5030`).
  - Never set a `Domain` attribute on the cookie.
  - Socket.IO connects to the backend directly using a short-lived socket token.

### 6.3 Background jobs (no Redis)

- A `jobs` collection with fields `{ orgId, type, payload, runAt, status, lockedUntil, attempts, lastError }`.
- A worker claims a due job atomically with `findOneAndUpdate`. Retries use exponential backoff.
- Ticks come from an in-process `setInterval` (every ~30 s). The VPS process is always on under PM2.
  - Jobs live in MongoDB, so a restart or deploy loses nothing; missed jobs run on the next tick.
- `POST /internal/cron/tick` (secret header) is kept for manual and ops triggering.
- Run PM2 in **fork mode with a single instance**. That way the Socket.IO and in-memory rate limit stay consistent; the atomic claim keeps things safe even with multiple instances.
- Users: hold expiry, the reminder engine, Meta lead reconciliation, and notification sending.

### 6.4 Storage adapter

- Interface: `storage.upload(buffer|stream, { folder, kind }) → { key, url, bytes, mime }`, plus `storage.remove(key)` and `storage.url(key, variant)`.
- Drivers: `local` (v1). An S3-compatible driver (R2/Spaces) can be added later without touching modules.
- The database stores **only `key` and the driver name**, never an absolute URL. URLs are built from `PUBLIC_MEDIA_BASE_URL`.
- Images go through **sharp** on upload: auto-rotate, strip EXIF/GPS, convert to WebP variants (`thumb` 400, `card` 960, `full` 1920), plus a blur placeholder.
- Validation:
  - magic-byte MIME check (not the extension)
  - size cap
  - random filenames; the user's filename is never used in the path
- Private documents (NID scans, deeds) go in `uploads/private/`. They are served only through an authenticated route, never statically.
- **Backups:** `uploads/` must be backed up on the VPS (nightly rsync/tar). Atlas M0 has **no automated backups**, so a nightly `mongodump` cron job runs on the VPS.

### 6.5 Integrations

- **Meta Lead Ads:**
  - verify the `X-Hub-Signature-256` raw body
  - return 200 immediately, then queue a job
  - fetch the lead from the Graph API
  - idempotency through a unique index on `meta.leadgenId`
  - nightly reconciliation
  - the page token is stored AES-GCM encrypted
- **Integration config resolver:** `getIntegrationConfig(orgId, 'sms' | 'payment' | 'email' | 'meta')`.
  - v1 reads from env.
  - In future SaaS it will read encrypted per-org settings from the DB, with no module changes.
  - Each integration reports `isEnabled()`; the frontend hides features that are disabled.
- **SMS:**
  - `SMS_DRIVER=log | bulksmsbd | sslwireless`. Driver API formats are verified against provider docs at build time.
  - Unicode (Bangla) segments are 70 characters, so there is a cost preview.
  - Every send is written to a delivery log.
- **SSLCommerz (full flow):**
  - init session → redirect → success, fail and cancel callbacks → **IPN** → **server-side validation API** (`val_id`)
  - The amount, currency and `tran_id` must match before a payment is accepted.
  - Idempotent: the IPN and the success redirect can both arrive, and only one receipt gets created.
  - Config: `SSLCZ_STORE_ID`, `SSLCZ_STORE_PASS`, `SSLCZ_IS_LIVE`. A free sandbox store is used for dev.
  - A successful payment becomes a regular receipt, with mode `online` and allocation through the same ledger.
- **Email:** Nodemailer with `SMTP_*`. Templates in BN and EN; PDF attachments for receipts.

### 6.6 Documents & QR verification

- Each document (receipt, booking form, allotment letter, etc.) has a `verifyToken` (random, unguessable) and a content hash.
- The QR code points to `https://<frontend>/verify/<token>`. That public page shows the document's key information and a valid/invalid result.
- **PDF in v1 (proposed, D1):**
  - One HTML template per document, with embedded Bangla fonts. It is used two ways:
    - (a) as the A4 print page (browser preview and print)
    - (b) rendered by **Puppeteer** on the VPS into a PDF (email attachment and download)
  - Puppeteer runs in a job: one shared browser, a page pool, and a timeout.
  - PDFKit and react-pdf are not used, because they break Bangla conjuncts.
  - Generated PDFs are stored through the storage adapter (private) along with their hash.

### 6.7 Backend folder structure

```
primeplot-back/
├─ server.js            # bootstrap: env → db → http + socket → scheduler → graceful shutdown
├─ src/
│  ├─ app.js
│  ├─ config/           # env.js (zod), db.js, logger.js
│  ├─ modules/
│  │  ├─ auth/ users/ organizations/ audit/
│  │  ├─ projects/ units/ floorplans/
│  │  ├─ leads/ pipeline/ activities/
│  │  ├─ bookings/ accounts/ documents/
│  │  ├─ portal/ notifications/ reminders/
│  │  ├─ media/ analytics/
│  │  └─ <module>/ <name>.routes.js .controller.js .service.js .model.js .validation.js
│  ├─ integrations/     # meta/, sms/, email/, storage/ (local, s3 later), payments/sslcommerz/, pdf/
│  ├─ jobs/             # scheduler.js, registry.js, handlers/*.js
│  ├─ sockets/
│  └─ shared/           # middleware/, errors/, plugins/ (baseSchema), utils/ (money, phone, bnNumber, amountInWords)
├─ docs/                # ARCHITECTURE.md, PROGRESS.md, API.md (contracts)
└─ tests/               # vitest + supertest + mongodb-memory-server (replSet)
```

## 7. Frontend architecture

- **Public site:**
  - Server Components with tag-based caching
  - the backend calls the signed `/api/revalidate` route for on-demand revalidation
  - the live unit status chip is a client island
- **Dashboard and portal:** TanStack Query, TanStack Table, react-hook-form + zod.
- **Packages:**
  - Motion (UI) and GSAP (public scroll storytelling only)
  - dnd-kit (Kanban; RBD is deprecated)
  - Embla (carousel)
  - Recharts
  - Lucide
  - react-zoom-pan-pinch (floor plans)
  - MapLibre/Leaflet
  - next-intl (i18n)
- **Floor plan hotspots:** polygon coordinates are normalized to 0–1. The same engine serves the plot master plan.
- **Next 16 note:** read `AGENTS.md` and `node_modules/next/dist/docs/` before writing any code. `middleware` has been renamed to `proxy.js`; verify this.
- **Design language** *(owner-approved 2026-10-12; replaces the earlier terracotta draft)*: luxury earthy minimalist.
  - Palette: canvas `#F9F8F6`, surface `#FFFFFF` with `#E5E3DF` hairlines, ink `#1C1D1A` / muted `#666861`, primary olive charcoal `#2D3228`, sage accent `#6B705C`, form-control borders `#8F8C82` (3:1). All text pairs pass WCAG AA.
  - Unit status: available `#3F7D58`, held `#8A6A1C`, booked `#3E6A8A`, allotted/registered/handed over `#7A4E3A`, blocked `#8C8A82` + hatch. Always with a text label.
  - Type: Playfair Display (display, ≥28px only) + Noto Serif Bengali for Bangla display; Plus Jakarta Sans for all UI/body; Hind Siliguri for Bangla UI/body; Geist Mono for unit codes, receipt numbers and money columns.
  - Shape: radii 2px (tags, images) / 4px (controls) / 6px (cards). No pills except avatars and filter chips. Eyebrow labels (letter-spaced, no leading rule — owner rejected the rule as AI-template), hairline dividers, faint blueprint grid.
  - Motion: short ease-out-quint transitions; GSAP only for public-site scroll; `prefers-reduced-motion` respected.
  - Tokens live in `styles/theme.css`; the living style guide is `/[locale]/dev/design` (dev only).
- **i18n routing** *(F1)*: locale is a root URL segment (`/bn/…`, `/en/…`, default `bn`) via next-intl + `next/root-params`, remembered in the `pp_locale` cookie. Reason: with `cacheComponents`, a cookie-driven `<html lang>` would make every page request-bound; URL locales also give crawlable hreflang pages.

```
primeplot-front/
├─ app/[locale]/ (public)/ (auth)/ (dashboard)/dashboard/ (portal)/portal/ verify/[token]/ dev/design/   + app/api/revalidate/
├─ features/            # inventory/ floorplan/ leads/ pipeline/ accounts/ portal/ …
├─ components/          # ui/ layout/ motion/
├─ lib/                 # api, auth, format (bdt, lakh-crore, bn digits), query-client, socket
├─ i18n/                # routing.js, request.js, navigation.js (next-intl)
├─ messages/            # bn.json, en.json
├─ styles/
└─ proxy.js
```

### 7.1 Placeholder images (before real uploads)

- `lib/placeholders.js` holds a curated list of image URLs grouped by category: `apartment-exterior`, `interior`, `plot-land`, `city`, `amenity`, `hero`, `avatar`. Sources are Unsplash (`images.unsplash.com`) and Pexels (`images.pexels.com`).
- No API key is needed, so there is no rate limit.
- **Pixabay is excluded:** its terms do not allow permanent hotlinking.
- The `<SmartImage>` component logic:
  - if real media exists, show it
  - otherwise pick a deterministic placeholder by entity id and category (the same project always gets the same photo)
- `next.config` `images.remotePatterns` allows these hosts plus the backend media host.
- A small "Sample image" badge shows only in the dashboard, so admins can tell placeholder from real. It is hidden on the public site.
- One-line kill switch: `NEXT_PUBLIC_USE_PLACEHOLDERS=false`.

## 8. Infra constraints and their workarounds

| Constraint | Workaround |
|---|---|
| Atlas M0 has 512 MB storage and no backups | Media is on the VPS disk; logs are not stored in the DB; old job and notification documents get a TTL; nightly `mongodump` on the VPS |
| Cross-domain cookies | Next.js rewrites proxy `/api/*` |
| Puppeteer is memory-heavy | Single shared browser, a page pool, jobs run one or two at a time; the VPS needs Chrome dependencies |
| SMS is not free | `log` driver by default; email fallback |
| Single VPS | PM2 single instance, Nginx serves `/uploads` + gzip/brotli, Let's Encrypt |

## 9. Industry-standard patterns we follow

**Architecture**
- **Modular monolith:** one deployable unit, with clear module boundaries.
  - A module never touches another module's model directly; it goes through the other module's service.
  - This keeps a later split into services possible.
- **12-factor config:** all config comes from env, validated with Zod at boot. `.env.example` is always kept up to date.
- **Env loading:** Node 24's built-in `process.loadEnvFile()`, so dotenv is not needed. Dev uses `node --watch`, so nodemon is not needed.

**API design**
- **Versioning:** everything lives under `/api/v1`. Resource-oriented REST, with consistent response and error shapes.
- **Pagination:**
  - cursor-based for big lists (leads, receipts)
  - offset-based for small admin tables
- **Idempotency:**
  - money endpoints (receipt create, booking, payment callbacks) accept an `Idempotency-Key` header, or use a natural unique key (`tran_id`, `leadgenId`)
- **Concurrency:**
  - optimistic, via Mongoose `__v` / `updatedAt` precondition, for edits
  - atomic conditional updates for state transitions (unit hold, job claim)

**Data integrity**
- **Transactions:** every multi-document money operation runs in a MongoDB transaction, wrapped in a `withTransaction(fn)` helper with retry on transient errors.
- **Soft delete + audit log:** business entities are never hard-deleted, and the audit log records who did what and when.
- **Security:**
  - OWASP API Top 10 checklist
  - least-privilege permissions
  - object-level authorization: every query is checked for ownership and org, not just the role (prevents IDOR)

**Operations**
- **Health:** `/api/v1/health` (liveness) and `/api/v1/health/ready` (DB connected).
- **Observability:** structured JSON logs (pino) with a request ID that is also returned in the error response for support.

**Process**
- **Contracts and testing:**
  - write the API contract in `docs/API.md` before the UI
  - Vitest + Supertest integration tests on critical money and inventory flows
- **Git:**
  - Conventional Commits (`feat:`, `fix:`, `chore:`, …)
  - one feature per branch, merged to `main` after verification
