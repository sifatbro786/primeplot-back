import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg, createUser, loginAgent, ORIGIN } from '../helpers/factory.js';

let app;
let Media;
let SitePageRevision;
beforeAll(async () => {
  await startDb();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  ({ Media } = await import('#modules/media/media.model.js'));
  ({ SitePageRevision } = await import('#modules/site/sitePage.model.js'));
});
afterAll(stopDb);

let org;
let admin;
let A;
let M;
let E;
beforeEach(async () => {
  await clearDb();
  org = await createOrg();
  admin = await createUser(org, { role: 'admin' });
  const manager = await createUser(org, { role: 'sales_manager' });
  const exec = await createUser(org, { role: 'sales_executive' });
  [A, M, E] = await Promise.all([admin, manager, exec].map((u) => loginAgent(request, app, u)));
});

const image = (visibility = 'public') =>
  Media.create({
    orgId: org._id,
    driver: 'local',
    visibility,
    kind: 'image',
    purpose: 'general',
    mime: 'image/webp',
    sourceMime: 'image/png',
    bytes: 1000,
    sha256: 'x'.repeat(64),
    variants: {
      full: { key: `${visibility}/2026/10/a.webp`, width: 800, height: 800, bytes: 1000 },
    },
    uploadedBy: admin._id,
  });

const put = (agent, key, body) =>
  agent.put(`/api/v1/site/pages/${key}/draft`).set('Origin', ORIGIN).send(body);
const post = (agent, path, body) => agent.post(`/api/v1${path}`).set('Origin', ORIGIN).send(body);
const pub = (path) => request(app).get(`/api/v1/public${path}`);

/** The editor's round trip: send back what was loaded (resolved images are ignored). */
const strip = (sections) => sections.map(({ key, enabled, data }) => ({ key, enabled, data }));

describe('site pages', () => {
  it('permission: admin and manager yes, executive no', async () => {
    expect((await A.get('/api/v1/site/pages')).status).toBe(200);
    expect((await M.get('/api/v1/site/pages/home')).status).toBe(200);
    expect((await E.get('/api/v1/site/pages/home')).status).toBe(403);
    expect((await A.get('/api/v1/site/pages/nope')).body.error.code).toBe('UNKNOWN_PAGE');
  });

  it('draft → public unchanged until publish → revision kept → no-op publish refused', async () => {
    const page = (await A.get('/api/v1/site/pages/home')).body.data;
    expect(page.version).toBe(0);
    expect(page.hasChanges).toBe(true); // never published
    expect(page.draft.sections.map((s) => s.key)).toContain('faq');
    expect(page.defaults.hero.title.en).toMatch(/seen clearly/);

    const before = (await pub('/site/pages/home')).body.data;
    expect(before.publishedAt).toBeNull();
    expect(before.sections.find((s) => s.key === 'testimonials')).toBeUndefined(); // empty → hidden

    const sections = strip(page.draft.sections);
    sections.find((s) => s.key === 'hero').data.title = { en: 'New *hero*', bn: 'নতুন' };
    sections.find((s) => s.key === 'testimonials').data.items = [
      { name: { en: 'Rahim' }, quote: { en: 'Smooth handover.' } },
    ];
    const saved = await put(A, 'home', {
      version: 0,
      sections,
      seo: { title: { en: 'Flats in Dhaka' }, focusKeyword: { en: 'flats dhaka' } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.version).toBe(1);

    // stale version
    expect((await put(A, 'home', { version: 0, sections, seo: {} })).body.error.code).toBe(
      'STALE_VERSION',
    );
    // the site has not changed yet
    expect((await pub('/site/pages/home')).body.data.sections[0].data.title.en).not.toBe(
      'New *hero*',
    );

    const published = await post(A, '/site/pages/home/publish', { version: 1, note: 'first' });
    expect(published.status).toBe(200);
    expect(published.body.data.hasChanges).toBe(false);

    const live = (await pub('/site/pages/home')).body.data;
    expect(live.publishedAt).not.toBeNull();
    expect(live.sections.find((s) => s.key === 'hero').data.title.en).toBe('New *hero*');
    expect(live.sections.find((s) => s.key === 'testimonials').data.items).toHaveLength(1);
    expect(live.seo.title.en).toBe('Flats in Dhaka');
    expect(live.seo.focusKeyword).toBeUndefined();

    const again = await post(A, '/site/pages/home/publish', { version: 2 });
    expect(again.body.error.code).toBe('NO_CHANGES');

    const revs = (await A.get('/api/v1/site/pages/home/revisions')).body.data;
    expect(revs).toEqual([
      expect.objectContaining({ n: 1, note: 'first', publishedByName: admin.name }),
    ]);
  });

  it('rejects unknown/duplicate sections, bad links and private images', async () => {
    const bad = (sections) => put(A, 'about', { version: 0, sections, seo: {} });
    await A.get('/api/v1/site/pages/about');
    expect((await bad([{ key: 'faq', data: {} }])).body.error.code).toBe('UNKNOWN_SECTION');
    expect((await bad([{ key: 'cta' }, { key: 'cta' }])).body.error.code).toBe('DUPLICATE_SECTION');
    const link = await bad([{ key: 'cta', data: { href: 'javascript:alert(1)' } }]);
    expect(link.status).toBe(422);
    expect(link.body.error.details[0].path).toBe('sections.0.data.href');
    const secret = await image('private');
    const priv = await bad([
      { key: 'team', data: { items: [{ name: { en: 'X' }, photoMediaId: String(secret._id) }] } },
    ]);
    expect(priv.body.error.code).toBe('INVALID_MEDIA');
  });

  it('resolves images, restores a revision and discards a draft', async () => {
    const img = await image();
    await A.get('/api/v1/site/pages/about');
    const team = [
      { name: { en: 'Ayesha' }, designation: { en: 'MD' }, photoMediaId: String(img._id) },
    ];
    let r = await put(A, 'about', {
      version: 0,
      sections: [{ key: 'team', data: { items: team } }],
      seo: {},
    });
    const t = r.body.data.draft.sections.find((s) => s.key === 'team');
    expect(t.data.items[0].photo.id).toBe(String(img._id));
    r = await post(A, '/site/pages/about/publish', { version: 1 });
    expect(r.status).toBe(200);
    expect(
      (await pub('/site/pages/about')).body.data.sections.find((s) => s.key === 'team').data
        .items[0].photo.urls.full,
    ).toBeTruthy();

    // change the draft, then restore version 1
    r = await put(A, 'about', {
      version: 2,
      sections: [{ key: 'team', data: { items: [] } }],
      seo: {},
    });
    expect(r.body.data.hasChanges).toBe(true);
    r = await post(A, '/site/pages/about/revisions/1/restore', { version: 3 });
    expect(r.body.data.hasChanges).toBe(false);
    expect(
      (await post(A, '/site/pages/about/revisions/9/restore', { version: 4 })).body.error.code,
    ).toBe('REVISION_NOT_FOUND');

    // discard returns the draft to the live version
    r = await put(A, 'about', { version: 4, sections: [{ key: 'cta', enabled: false }], seo: {} });
    expect(r.body.data.hasChanges).toBe(true);
    r = await post(A, '/site/pages/about/discard', { version: 5 });
    expect(r.body.data.hasChanges).toBe(false);
  });

  it('keeps only the last 20 published versions', async () => {
    let v = (await A.get('/api/v1/site/pages/contact')).body.data.version;
    for (let i = 0; i < 22; i += 1) {
      const r = await put(A, 'contact', {
        version: v,
        sections: [],
        seo: { title: { en: `T${i}` } },
      });
      v = r.body.data.version;
      v = (await post(A, '/site/pages/contact/publish', { version: v })).body.data.version;
    }
    const kept = await SitePageRevision.find({ orgId: org._id, pageKey: 'contact' })
      .sort({ n: 1 })
      .lean();
    expect(kept).toHaveLength(20);
    expect(kept[0].n).toBe(3);
  });

  it('preview shows the draft in the public shape (staff only)', async () => {
    const page = (await A.get('/api/v1/site/pages/home')).body.data;
    const sections = strip(page.draft.sections);
    sections.find((s) => s.key === 'faq').enabled = false;
    await put(A, 'home', { version: 0, sections, seo: {} });
    const prev = (await A.get('/api/v1/site/pages/home/preview')).body.data;
    expect(prev.sections.find((s) => s.key === 'faq')).toBeUndefined();
    expect(
      (await pub('/site/pages/home')).body.data.sections.find((s) => s.key === 'faq'),
    ).toBeTruthy();
    expect((await request(app).get('/api/v1/site/pages/home/preview')).status).toBe(401);
  });
});

describe('site-wide SEO settings', () => {
  it('validates, extracts verification codes, and is public without the version', async () => {
    const s = (await A.get('/api/v1/site/settings')).body.data;
    expect(s.titleTemplate.en).toBe('%s | {company}');
    const bad = await A.patch('/api/v1/site/settings')
      .set('Origin', ORIGIN)
      .send({
        version: s.version,
        titleTemplate: { en: 'No placeholder' },
      });
    expect(bad.status).toBe(422);
    const r = await A.patch('/api/v1/site/settings')
      .set('Origin', ORIGIN)
      .send({
        version: s.version,
        verification: { google: '<meta name="google-site-verification" content="AbC-123_x" />' },
        social: { facebook: 'https://facebook.com/acme', x: '' },
        indexing: false,
      });
    expect(r.status).toBe(200);
    expect(r.body.data.verification.google).toBe('AbC-123_x');
    expect(r.body.data.social).toMatchObject({ facebook: 'https://facebook.com/acme', x: null });

    const site = (await pub('/site')).body.data;
    expect(site.settings.indexing).toBe(false);
    expect(site.settings.version).toBeUndefined();
    expect(site.pages.map((p) => p.key)).toEqual(
      expect.arrayContaining(['home', 'about', 'projects', 'privacy']),
    );
    expect(
      (
        await A.patch('/api/v1/site/settings')
          .set('Origin', ORIGIN)
          .send({ version: s.version, indexing: true })
      ).body.error.code,
    ).toBe('STALE_VERSION');
  });
});

describe('project SEO', () => {
  it('is saved on the project and public without the focus keyword', async () => {
    const created = await A.post('/api/v1/projects')
      .set('Origin', ORIGIN)
      .send({ name: 'Lake View', kind: 'apartment', published: true });
    const p = created.body.data;
    const r = await A.patch(`/api/v1/projects/${p.id}`)
      .set('Origin', ORIGIN)
      .send({
        version: p.version,
        seo: { title: { en: 'Lake View flats' }, focusKeyword: { en: 'lake view' } },
      });
    expect(r.status).toBe(200);
    expect(r.body.data.seo.focusKeyword.en).toBe('lake view');
    const detail = (await pub(`/projects/${p.slug}`)).body.data;
    expect(detail.seo).toEqual({
      title: { en: 'Lake View flats', bn: '' },
      description: { en: '', bn: '' },
      ogImage: null,
      noindex: false,
    });
  });
});

describe('construction updates', () => {
  async function project(body = {}) {
    const r = await A.post('/api/v1/projects')
      .set('Origin', ORIGIN)
      .send({ name: 'Green Court', kind: 'apartment', published: true, stage: 'ongoing', ...body });
    return r.body.data;
  }

  it('create → draft hidden → publish → public timeline, summary and latest', async () => {
    const p = await project();
    const img = await image();
    const create = (body) =>
      A.post(`/api/v1/projects/${p.id}/updates`).set('Origin', ORIGIN).send(body);

    expect((await create({ date: '2026-09-01' })).status).toBe(422); // title required
    const future = await create({ date: '2099-01-01', title: { en: 'x' } });
    expect(future.status).toBe(422);

    const a = await create({
      date: '2026-09-01',
      title: { en: 'Piling done', bn: 'পাইলিং শেষ' },
      percent: 15,
      milestone: 'piling',
      photos: [{ mediaId: String(img._id), caption: { en: 'Rig' } }],
      published: true,
    });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ date: '2026-09-01', percent: 15, published: true });
    expect(a.body.data.photos[0].media.id).toBe(String(img._id));

    const b = (await create({ date: '2026-10-05', title: { en: '3rd slab cast' }, percent: 30 }))
      .body.data;
    expect(b.published).toBe(false);

    let pub1 = (await pub(`/projects/${p.slug}/updates`)).body;
    expect(pub1.data.map((u) => u.title.en)).toEqual(['Piling done']);
    expect(pub1.data[0].version).toBeUndefined();

    const r = await A.patch(`/api/v1/construction-updates/${b.id}`)
      .set('Origin', ORIGIN)
      .send({ version: b.version, published: true });
    expect(r.body.data.publishedAt).toBeTruthy();
    expect(
      (
        await A.patch(`/api/v1/construction-updates/${b.id}`)
          .set('Origin', ORIGIN)
          .send({ version: b.version, percent: 1 })
      ).body.error.code,
    ).toBe('STALE_VERSION');

    pub1 = (await pub(`/projects/${p.slug}/updates?limit=1`)).body;
    expect(pub1.data[0].title.en).toBe('3rd slab cast');
    const next = (await pub(`/projects/${p.slug}/updates?limit=1&cursor=${pub1.meta.nextCursor}`))
      .body;
    expect(next.data[0].title.en).toBe('Piling done');
    expect(next.meta.nextCursor).toBeNull();

    const detail = (await pub(`/projects/${p.slug}`)).body.data;
    expect(detail.construction).toEqual({
      percent: 30,
      milestone: null,
      date: '2026-10-05',
      count: 2,
    });

    const latest = (await pub('/construction/latest')).body.data;
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({
      title: { en: '3rd slab cast', bn: '' },
      project: { slug: p.slug },
    });

    expect(
      (await A.delete(`/api/v1/construction-updates/${b.id}`).set('Origin', ORIGIN)).status,
    ).toBe(204);
    expect((await pub(`/projects/${p.slug}`)).body.data.construction.count).toBe(1);
  });

  it('checks block ownership, private photos and permissions', async () => {
    const p = await project();
    const other = await project({ name: 'Other' });
    const blk = await A.post(`/api/v1/projects/${other.id}/blocks`)
      .set('Origin', ORIGIN)
      .send({ kind: 'building', code: 'A', name: 'Building A', lowestFloor: 0, highestFloor: 5 });
    const create = (agent, body) =>
      agent.post(`/api/v1/projects/${p.id}/updates`).set('Origin', ORIGIN).send(body);
    expect(
      (await create(A, { date: '2026-09-01', title: { en: 'x' }, blockId: blk.body.data.id }))
        .status,
    ).toBe(404);
    const secret = await image('private');
    expect(
      (
        await create(A, {
          date: '2026-09-01',
          title: { en: 'x' },
          photos: [{ mediaId: String(secret._id) }],
        })
      ).body.error.code,
    ).toBe('INVALID_MEDIA');
    expect((await create(E, { date: '2026-09-01', title: { en: 'x' } })).status).toBe(403);
    expect((await E.get(`/api/v1/projects/${p.id}/updates`)).status).toBe(200);
  });
});
