import { describe, expect, it } from 'vitest';

const {
  PAGES,
  SECTION_TYPES,
  parseSections,
  completeSections,
  hasContent,
  collectMediaIds,
  withMedia,
  youtubeId,
  zDraftBody,
  zHref,
  zSeoObject,
  parseSeo,
  publicSeo,
} = await import('#modules/site/site.schema.js');
const { DEFAULTS, defaultSections } = await import('#modules/site/site.defaults.js');
const { permissionsFor } = await import('#shared/auth/permissions.js');

const ID = 'a'.repeat(24);

describe('site pages & defaults', () => {
  it('every page section has a known type and complete defaults', () => {
    for (const [page, sections] of Object.entries(PAGES)) {
      const keys = sections.map(([k]) => k);
      expect(new Set(keys).size).toBe(keys.length);
      for (const [key, type] of sections) {
        expect(SECTION_TYPES[type], `${page}.${key}`).toBeTruthy();
        // defaults already parsed → parsing again is a no-op
        expect(SECTION_TYPES[type].parse(DEFAULTS[page][key])).toEqual(DEFAULTS[page][key]);
      }
    }
  });

  it('people, quotes, numbers and awards start empty (never invented)', () => {
    expect(DEFAULTS.home.testimonials.items).toEqual([]);
    expect(DEFAULTS.home.trackRecord.items).toEqual([]);
    expect(DEFAULTS.about.team.items).toEqual([]);
    expect(DEFAULTS.about.awards.items).toEqual([]);
    expect(DEFAULTS.about.leaderMessage.message).toEqual({ en: '', bn: '' });
    const visible = (page) =>
      defaultSections(page)
        .filter((s) => hasContent(s.key, PAGES[page].find(([k]) => k === s.key)[1], s.data))
        .map((s) => s.key);
    expect(visible('home')).not.toContain('testimonials');
    expect(visible('home')).not.toContain('trackRecord');
    expect(visible('home')).not.toContain('video');
    expect(visible('about')).not.toContain('team');
    expect(visible('about')).not.toContain('leaderMessage');
    expect(visible('about')).toContain('credentials'); // shows the org licence numbers
    expect(visible('home')).toContain('faq');
  });

  it('defaults are bilingual where they have text', () => {
    for (const [key, data] of Object.entries(DEFAULTS.home)) {
      const t = data.title;
      if (t && (t.en || t.bn)) expect(Boolean(t.en && t.bn), `home.${key}.title`).toBe(true);
    }
  });
});

describe('parseSections', () => {
  it('keeps order, validates per type, appends missing keys with defaults', () => {
    const out = parseSections(
      'home',
      [
        { key: 'faq', enabled: true, data: { items: [{ q: { en: 'Q?' }, a: { bn: 'উ' } }] } },
        { key: 'hero', enabled: false, data: {} },
      ],
      DEFAULTS.home,
    );
    expect(out[0].key).toBe('faq');
    expect(out[0].data.items[0]).toEqual({ q: { en: 'Q?', bn: '' }, a: { en: '', bn: 'উ' } });
    expect(out[1]).toMatchObject({ key: 'hero', enabled: false });
    expect(out).toHaveLength(PAGES.home.length);
    expect(out.at(-1).enabled).toBe(true);
  });

  it('rejects unknown and duplicate keys with codes', () => {
    expect(() => parseSections('home', [{ key: 'team', data: {} }], DEFAULTS.home)).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_SECTION', statusCode: 400 }),
    );
    expect(() =>
      parseSections(
        'home',
        [
          { key: 'faq', data: {} },
          { key: 'faq', data: {} },
        ],
        DEFAULTS.home,
      ),
    ).toThrow(expect.objectContaining({ code: 'DUPLICATE_SECTION' }));
  });

  it('reports the full path of a bad field', () => {
    try {
      parseSections(
        'home',
        [{ key: 'whyUs', data: { items: [{ icon: 'rocket' }] } }],
        DEFAULTS.home,
      );
      throw new Error('should fail');
    } catch (err) {
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.details[0].path).toBe('sections.0.data.items.0.icon');
    }
  });

  it('enforces list limits, text limits and strict objects', () => {
    const nine = Array.from({ length: 9 }, () => ({}));
    expect(() =>
      parseSections('home', [{ key: 'whyUs', data: { items: nine } }], DEFAULTS.home),
    ).toThrow();
    expect(() =>
      parseSections(
        'home',
        [{ key: 'hero', data: { title: { en: 'x'.repeat(161) } } }],
        DEFAULTS.home,
      ),
    ).toThrow();
    expect(() =>
      parseSections('home', [{ key: 'hero', data: { html: '<b>' } }], DEFAULTS.home),
    ).toThrow();
  });

  it('strips control characters and normalises newlines', () => {
    const [s] = parseSections(
      'about',
      [{ key: 'intro', data: { body: { en: ' a\u0000b\r\n\r\nc ' } } }],
      DEFAULTS.about,
    );
    expect(s.data.body.en).toBe('ab\n\nc');
  });
});

describe('completeSections', () => {
  it('drops removed keys, appends new ones and survives bad stored data', () => {
    const out = completeSections(
      'about',
      [
        { key: 'removedInV2', enabled: true, data: {} },
        { key: 'cta', enabled: false, data: { title: { en: 'Hi' } } },
        { key: 'team', enabled: true, data: { items: 'not-an-array' } },
      ],
      DEFAULTS.about,
    );
    expect(out[0]).toMatchObject({ key: 'cta', enabled: false });
    expect(out[0].data.title.en).toBe('Hi');
    expect(out[1].data).toEqual(DEFAULTS.about.team); // fell back to the default
    expect(out).toHaveLength(PAGES.about.length);
  });
});

describe('links, video, media', () => {
  it('href accepts site paths and https only', () => {
    expect(zHref.parse('/landowners')).toBe('/landowners');
    expect(zHref.parse('https://example.com/x')).toBe('https://example.com/x');
    for (const bad of [
      'javascript:alert(1)',
      '//evil.com',
      'http://x.com',
      '/a b',
      'mailto:x@y.z',
    ]) {
      expect(zHref.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('extracts YouTube ids from common link forms', () => {
    const id = 'dQw4w9WgXcQ';
    for (const url of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}?t=10`,
      `https://www.youtube.com/shorts/${id}`,
      `https://m.youtube.com/watch?feature=share&v=${id}`,
    ]) {
      expect(youtubeId(url), url).toBe(id);
    }
    expect(youtubeId('https://vimeo.com/123')).toBeNull();
    expect(SECTION_TYPES.video.safeParse({ youtubeUrl: 'https://vimeo.com/1' }).success).toBe(
      false,
    );
  });

  it('round-trips: resolved images sent back are dropped before validation', () => {
    const media = new Map([[ID, { id: ID }]]);
    const loaded = withMedia({ items: [{ name: { en: 'A' }, photoMediaId: ID }] }, media);
    const [s] = parseSections('about', [{ key: 'team', data: loaded }], DEFAULTS.about);
    expect(s.data.items[0]).toMatchObject({ photoMediaId: ID });
    expect(s.data.items[0].photo).toBeUndefined();
    expect(
      zDraftBody.parse({
        version: 1,
        sections: [],
        seo: { ogImageMediaId: ID, ogImage: { id: ID } },
      }).seo.ogImageMediaId,
    ).toBe(ID);
  });

  it('collects every *MediaId and resolves siblings', () => {
    const data = {
      items: [{ photoMediaId: ID }, { photoMediaId: null }],
      seo: { ogImageMediaId: ID },
    };
    expect(collectMediaIds(data)).toEqual([ID, ID]);
    const media = new Map([[ID, { id: ID, urls: {} }]]);
    const out = withMedia(data, media);
    expect(out.items[0].photo).toEqual({ id: ID, urls: {} });
    expect(out.items[1].photo).toBeNull();
    expect(out.seo.ogImage.id).toBe(ID);
  });
});

describe('SEO', () => {
  it('fills defaults, keeps the focus keyword out of the public shape', () => {
    const seo = zSeoObject.parse({
      title: { en: 'Flats in Dhaka' },
      focusKeyword: { en: 'flats dhaka' },
    });
    expect(seo).toMatchObject({ noindex: false, ogImageMediaId: null });
    const pub = publicSeo(seo, new Map());
    expect(pub).toEqual({
      title: { en: 'Flats in Dhaka', bn: '' },
      description: { en: '', bn: '' },
      ogImage: null,
      noindex: false,
    });
    expect(parseSeo({ junk: true }).title).toEqual({ en: '', bn: '' });
    expect(zSeoObject.safeParse({ title: { en: 'x'.repeat(121) } }).success).toBe(false);
  });

  it('draft body requires a version and caps sections', () => {
    expect(zDraftBody.safeParse({ sections: [], seo: {} }).success).toBe(false);
    expect(zDraftBody.parse({ version: 0, sections: [] }).seo.noindex).toBe(false);
  });

  it('site:manage belongs to admin and sales manager only', () => {
    expect(permissionsFor('admin').has('site:manage')).toBe(true);
    expect(permissionsFor('sales_manager').has('site:manage')).toBe(true);
    expect(permissionsFor('sales_executive').has('site:manage')).toBe(false);
    expect(permissionsFor('client').has('site:manage')).toBe(false);
  });
});

describe('construction update validation', async () => {
  const { zUpdateCreate, zUpdatePatch, dhakaToday } =
    await import('#modules/construction/construction.validation.js');
  it('needs a title and a date not in the future', () => {
    expect(zUpdateCreate.safeParse({ date: '2026-01-01' }).success).toBe(false);
    expect(zUpdateCreate.safeParse({ date: '2026-01-01', title: { bn: 'পাইলিং' } }).success).toBe(
      true,
    );
    expect(zUpdateCreate.safeParse({ date: '2999-01-01', title: { en: 'x' } }).success).toBe(false);
    expect(zUpdateCreate.safeParse({ date: dhakaToday(), title: { en: 'x' } }).success).toBe(true);
  });
  it('limits percent, photos and duplicates', () => {
    const base = { date: '2026-01-01', title: { en: 'x' } };
    expect(zUpdateCreate.safeParse({ ...base, percent: 101 }).success).toBe(false);
    expect(
      zUpdateCreate.safeParse({ ...base, photos: [{ mediaId: ID }, { mediaId: ID }] }).success,
    ).toBe(false);
    expect(zUpdateCreate.safeParse({ ...base, milestone: 'roofing' }).success).toBe(false);
    expect(zUpdatePatch.safeParse({ version: 1 }).success).toBe(false); // nothing to update
    // a PATCH that does not mention the text must not blank it
    expect(zUpdatePatch.parse({ version: 1, published: true })).toEqual({
      version: 1,
      published: true,
    });
  });
  it('Dhaka date rolls over at 18:00 UTC', () => {
    expect(dhakaToday(Date.parse('2026-10-14T17:59:00Z'))).toBe('2026-10-14');
    expect(dhakaToday(Date.parse('2026-10-14T18:00:00Z'))).toBe('2026-10-15');
  });
});

describe('project SEO', async () => {
  const { zProjectPatch } = await import('#modules/projects/project.validation.js');
  const { toProject } = await import('#modules/projects/project.service.js');
  it('PATCH accepts seo, leaves it alone when absent, null resets', () => {
    expect(zProjectPatch.parse({ version: 1, featured: true }).seo).toBeUndefined();
    expect(zProjectPatch.parse({ version: 1, seo: null }).seo).toBeNull();
    const p = zProjectPatch.parse({ version: 1, seo: { title: { en: 'Flats' } } });
    expect(p.seo).toMatchObject({ title: { en: 'Flats', bn: '' }, noindex: false });
  });
  it('serialises seo with the resolved share image', () => {
    const out = toProject(
      { _id: ID, name: 'X', slug: 'x', seo: { title: { en: 'T' }, ogImageMediaId: ID } },
      { media: new Map([[ID, { id: ID }]]) },
    );
    expect(out.seo).toMatchObject({ title: { en: 'T', bn: '' }, ogImage: { id: ID } });
    expect(toProject({ _id: ID, name: 'X', slug: 'x' }).seo.ogImage).toBeNull();
  });
});

describe('signed draft preview', async () => {
  const { verifySiteSignature, signRevalidation } =
    await import('#integrations/revalidate/index.js');
  const secret = 's'.repeat(40);
  it('accepts a fresh signature for the same page only', () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signRevalidation('preview:home', ts, secret);
    expect(verifySiteSignature('preview:home', ts, sig, secret)).toBe(true);
    expect(verifySiteSignature('preview:about', ts, sig, secret)).toBe(false);
    expect(
      verifySiteSignature(
        'preview:home',
        ts - 301,
        signRevalidation('preview:home', ts - 301, secret),
        secret,
      ),
    ).toBe(false);
    expect(verifySiteSignature('preview:home', ts, sig, '')).toBe(false);
    expect(verifySiteSignature('preview:home', 'abc', sig, secret)).toBe(false);
  });
});
