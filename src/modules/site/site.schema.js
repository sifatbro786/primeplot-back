import { z } from 'zod';
import { zid } from '#shared/middleware/validate.js';
import { BadRequestError, ValidationError } from '#shared/errors/AppError.js';

/**
 * Site content (B2b): fixed sections per page. A page is an ordered list of
 * `{ key, enabled, data }`; the key decides the section type and its data schema.
 * Contract: docs/API.md › B2b.
 *
 * Text is plain (no HTML): `{company}` is replaced with the company name, `*words*` in titles
 * becomes emphasis, a blank line starts a new paragraph. The site renders text, never markup.
 */

export const ICONS = Object.freeze([
  'shield-check',
  'building',
  'hammer',
  'hard-hat',
  'handshake',
  'key',
  'clock',
  'receipt',
  'map-pin',
  'leaf',
  'users',
  'award',
  'ruler',
  'landmark',
  'sparkles',
  'eye',
  'qr-code',
  'home',
  'file-check',
  'phone',
  'wallet',
  'trees',
  'sun',
  'droplets',
  'zap',
  'lock',
]);

export const LOGO_GROUPS = Object.freeze(['approval', 'membership', 'bank', 'partner']);

// ── field schemas ───────────────────────────────────────────────────────────────

// Control characters other than newline/tab never belong in site text.
const stripControl = (v) =>
  [...v]
    .filter((c) => {
      const n = c.charCodeAt(0);
      return n === 9 || n === 10 || n === 13 || (n >= 32 && n !== 127);
    })
    .join('');
const text = (max) =>
  z
    .string()
    .transform((v) => stripControl(v).replace(/\r\n?/g, '\n').trim())
    .pipe(z.string().max(max, `At most ${max} characters`));

/**
 * Bilingual text `{ en, bn }` — either may be empty. `zTObj` has no default of its own: use it
 * where "absent" must stay absent (PATCH bodies); `zT` fills `{ en: '', bn: '' }` when absent.
 */
export const zTObj = (max = 160) =>
  z.object({ en: text(max).default(''), bn: text(max).default('') }).strict();
export const zT = (max = 160) => zTObj(max).default({ en: '', bn: '' });

/** Site path ("/projects", no locale) or an https URL; '' = none. */
export const zHref = z
  .string()
  .trim()
  .max(300)
  .refine(
    (v) => v === '' || /^\/(?!\/)[^\s<>"']*$/.test(v) || /^https:\/\/[^\s<>"']+$/.test(v),
    'Use a site path like /projects or an https:// link',
  )
  .default('');

const zUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https:\/\/[^\s<>"']+$/.test(v), 'Use an https:// link')
  .default('');

const YT =
  /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})(?:[?&#].*)?$/;
const zYoutube = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || YT.test(v), 'Paste a YouTube link (youtube.com or youtu.be)')
  .default('');

/** 11-character video id from a YouTube link, or null. */
export const youtubeId = (url) => YT.exec(url ?? '')?.[1] ?? null;

const zMedia = zid.nullable().default(null);
const zIcon = z.enum(ICONS).default('sparkles');
const list = (item, max) => z.array(item).max(max, `At most ${max} items`).default([]);
const obj = (shape) => z.object(shape).strict();

const heading = { eyebrow: zT(80), title: zT(160), body: zT(600) };
const LONG = 5000;

export const SECTION_TYPES = Object.freeze({
  hero: obj({
    eyebrow: zT(80),
    title: zT(160),
    body: zT(400),
    primary: obj({ label: zT(40), href: zHref }).prefault({}),
    secondary: obj({ label: zT(40), href: zHref }).prefault({}),
  }),
  stats: obj({ note: zT(300) }),
  heading: obj(heading),
  cards: obj({
    ...heading,
    items: list(obj({ icon: zIcon, title: zT(120), body: zT(400) }), 8),
  }),
  figures: obj({
    ...heading,
    items: list(obj({ value: text(12).default(''), label: zT(80) }), 6),
  }),
  steps: obj({
    eyebrow: zT(80),
    title: zT(160),
    items: list(obj({ title: zT(120), body: zT(400) }), 6),
  }),
  testimonials: obj({
    eyebrow: zT(80),
    title: zT(160),
    items: list(obj({ name: zT(80), role: zT(120), quote: zT(800), photoMediaId: zMedia }), 12),
  }),
  cta: obj({ ...heading, label: zT(40), href: zHref }),
  logos: obj({
    eyebrow: zT(80),
    title: zT(160),
    items: list(
      obj({
        name: text(120).default(''),
        group: z.enum(LOGO_GROUPS).default('partner'),
        logoMediaId: zMedia,
        url: zUrl,
      }),
      24,
    ),
  }),
  video: obj({ ...heading, youtubeUrl: zYoutube, posterMediaId: zMedia }),
  faq: obj({ eyebrow: zT(80), title: zT(160), items: list(obj({ q: zT(200), a: zT(1500) }), 20) }),
  intro: obj({ eyebrow: zT(80), title: zT(160), body: zT(LONG), imageMediaId: zMedia }),
  story: obj({
    eyebrow: zT(80),
    title: zT(160),
    body: zT(LONG),
    milestones: list(obj({ year: text(10).default(''), title: zT(120), body: zT(400) }), 20),
  }),
  mission: obj({
    eyebrow: zT(80),
    title: zT(160),
    mission: zT(800),
    vision: zT(800),
    values: list(obj({ title: zT(80), body: zT(300) }), 8),
  }),
  message: obj({
    eyebrow: zT(80),
    name: zT(80),
    designation: zT(120),
    message: zT(LONG),
    photoMediaId: zMedia,
    signatureMediaId: zMedia,
  }),
  people: obj({
    eyebrow: zT(80),
    title: zT(160),
    items: list(
      obj({ name: zT(80), designation: zT(120), bio: zT(500), photoMediaId: zMedia }),
      24,
    ),
  }),
  awards: obj({
    eyebrow: zT(80),
    title: zT(160),
    items: list(
      obj({ year: text(10).default(''), title: zT(160), by: zT(120), logoMediaId: zMedia }),
      20,
    ),
  }),
  csr: obj({
    ...heading,
    items: list(obj({ title: zT(120), body: zT(500), imageMediaId: zMedia }), 12),
  }),
});

/** Page key → ordered [sectionKey, type]. Pages with no sections are SEO-only. */
export const PAGES = Object.freeze({
  home: [
    ['hero', 'hero'],
    ['stats', 'stats'],
    ['featured', 'heading'],
    ['whyUs', 'cards'],
    ['trackRecord', 'figures'],
    ['construction', 'heading'],
    ['areas', 'heading'],
    ['howItWorks', 'steps'],
    ['testimonials', 'testimonials'],
    ['landownerCta', 'cta'],
    ['partners', 'logos'],
    ['video', 'video'],
    ['faq', 'faq'],
    ['enquiry', 'heading'],
  ],
  about: [
    ['intro', 'intro'],
    ['stats', 'stats'],
    ['story', 'story'],
    ['missionVision', 'mission'],
    ['principles', 'cards'],
    ['leaderMessage', 'message'],
    ['team', 'people'],
    ['quality', 'cards'],
    ['completed', 'heading'],
    ['credentials', 'logos'],
    ['awards', 'awards'],
    ['csr', 'csr'],
    ['cta', 'cta'],
  ],
  projects: [],
  contact: [],
  landowners: [],
  compare: [],
  privacy: [],
  terms: [],
});

export const PAGE_KEYS = Object.freeze(Object.keys(PAGES));

export const typeOf = (page, key) => PAGES[page]?.find(([k]) => k === key)?.[1] ?? null;

// ── SEO ─────────────────────────────────────────────────────────────────────────

/** Page / project SEO. Every field has a default, so `{}` is a valid (empty) value. */
export const zSeoObject = obj({
  title: zT(120),
  description: zT(320),
  ogImageMediaId: zMedia,
  noindex: z.boolean().default(false),
  focusKeyword: zT(60),
});
export const zPageSeo = zSeoObject.prefault({});

/** Stored SEO (possibly from an older shape) → current shape; never throws. */
export function parseSeo(seo) {
  const r = zSeoObject.safeParse(seo ?? {});
  return r.success ? r.data : zSeoObject.parse({});
}

/** What the website gets (focus keyword is dashboard-only). */
export function publicSeo(seo, media) {
  const s = parseSeo(seo);
  return {
    title: s.title,
    description: s.description,
    ogImage: s.ogImageMediaId ? (media.get(String(s.ogImageMediaId)) ?? null) : null,
    noindex: s.noindex,
  };
}

// ── parsing a page's sections ───────────────────────────────────────────────────

/** Body shape for PUT …/draft (section data is checked per key by `parseSections`). */
export const zDraftBody = obj({
  version: z.number().int().min(0),
  sections: z
    .array(
      z
        .object({
          key: z.string().trim().min(1).max(40),
          enabled: z.boolean().default(true),
          data: z.unknown().optional(),
        })
        .strict(),
    )
    .max(30),
  seo: z.preprocess((v) => stripResolved(v ?? {}), zPageSeo),
});

/**
 * Validate each section against its type; returns the stored form
 * `[{ key, enabled, data }]` in the given order. Section keys of the page that are missing
 * from the input are appended with their defaults, so a page is always complete.
 */
export function parseSections(page, input, defaults) {
  const allowed = PAGES[page];
  const seen = new Set();
  const out = [];
  input.forEach((s, i) => {
    const type = typeOf(page, s.key);
    if (!type) {
      throw new BadRequestError(`"${s.key}" is not a section of this page`, {
        code: 'UNKNOWN_SECTION',
        details: [{ path: `sections.${i}.key`, message: s.key }],
      });
    }
    if (seen.has(s.key)) {
      throw new BadRequestError(`Section "${s.key}" appears twice`, {
        code: 'DUPLICATE_SECTION',
        details: [{ path: `sections.${i}.key`, message: s.key }],
      });
    }
    seen.add(s.key);
    const r = SECTION_TYPES[type].safeParse(stripResolved(s.data ?? {}));
    if (!r.success) {
      throw new ValidationError(
        r.error.issues.map((iss) => ({
          path: ['sections', i, 'data', ...iss.path].join('.'),
          message: iss.message,
          code: iss.code,
        })),
      );
    }
    out.push({ key: s.key, enabled: s.enabled !== false, data: r.data });
  });
  // A key the client did not send (e.g. an older dashboard build) keeps its default and stays on.
  for (const [key] of allowed) {
    if (!seen.has(key)) out.push({ key, enabled: true, data: defaults[key] });
  }
  return out;
}

/**
 * Stored sections → complete list for this version of the code: unknown keys (removed in a
 * newer version) are dropped, new keys are appended enabled with their defaults, and stored
 * data is re-parsed so fields added later get their defaults.
 */
export function completeSections(page, stored, defaults) {
  const keys = new Set(PAGES[page].map(([k]) => k));
  const out = [];
  const seen = new Set();
  for (const s of stored ?? []) {
    if (!keys.has(s.key) || seen.has(s.key)) continue;
    seen.add(s.key);
    const r = SECTION_TYPES[typeOf(page, s.key)].safeParse(s.data ?? {});
    out.push({
      key: s.key,
      enabled: s.enabled !== false,
      data: r.success ? r.data : defaults[s.key],
    });
  }
  for (const [key] of PAGES[page]) {
    if (!seen.has(key)) out.push({ key, enabled: true, data: defaults[key] });
  }
  return out;
}

// ── visibility ──────────────────────────────────────────────────────────────────

const has = (t) => Boolean(t?.en?.trim() || t?.bn?.trim());

/** Shown on the site = enabled and has something to show (contract: API.md › B2b). */
export function hasContent(key, type, data) {
  switch (type) {
    case 'cards':
    case 'figures':
    case 'steps':
    case 'testimonials':
    case 'faq':
    case 'people':
    case 'awards':
      return data.items.length > 0;
    case 'logos':
      // The credentials section also shows the trade licence / REHAB number from the org.
      return key === 'credentials' || data.items.length > 0;
    case 'video':
      return Boolean(youtubeId(data.youtubeUrl));
    case 'message':
      return has(data.message);
    case 'story':
      return has(data.body) || data.milestones.length > 0;
    case 'mission':
      return has(data.mission) || has(data.vision) || data.values.length > 0;
    case 'csr':
      return has(data.body) || data.items.length > 0;
    default:
      return true;
  }
}

// ── media references ────────────────────────────────────────────────────────────

/** Every `…MediaId` value anywhere in the data (sections + SEO). */
export function collectMediaIds(value, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) collectMediaIds(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k.endsWith('MediaId')) {
        if (v) out.push(String(v));
      } else collectMediaIds(v, out);
    }
  }
  return out;
}

/**
 * Undo `withMedia`: drop each resolved sibling `x` next to an `xMediaId`, so the dashboard can
 * send back what it loaded (ids are what count; the resolved objects are display-only).
 */
export function stripResolved(value) {
  if (Array.isArray(value)) return value.map(stripResolved);
  if (!value || typeof value !== 'object') return value;
  const drop = new Set(
    Object.keys(value)
      .filter((k) => k.endsWith('MediaId'))
      .map((k) => k.slice(0, -'MediaId'.length)),
  );
  const out = {};
  for (const [k, v] of Object.entries(value)) if (!drop.has(k)) out[k] = stripResolved(v);
  return out;
}

/** Copy of `value` where each `xMediaId` gets a sibling `x` = Media | null. */
export function withMedia(value, media) {
  if (Array.isArray(value)) return value.map((v) => withMedia(v, media));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.endsWith('MediaId')) {
      out[k] = v ? String(v) : null;
      out[k.slice(0, -'MediaId'.length)] = v ? (media.get(String(v)) ?? null) : null;
    } else out[k] = withMedia(v, media);
  }
  return out;
}
