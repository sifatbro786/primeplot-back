import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg, createUser, loginAgent } from '../helpers/factory.js';

let app;
let Media;
let photo;
beforeAll(async () => {
  await startDb();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  ({ Media } = await import('#modules/media/media.model.js'));
  // 1200×800 JPEG, EXIF orientation 6 (rotated 90°) + camera metadata that must be stripped.
  photo = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#b4532a' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Make: 'SecretCam', Model: 'X1' } })
    .toBuffer();
});
afterAll(stopDb);

let org;
let admin;
let exec;
let manager;
let client;
beforeEach(async () => {
  await clearDb();
  org = await createOrg();
  admin = await createUser(org, { role: 'admin' });
  exec = await createUser(org, { role: 'sales_executive' });
  manager = await createUser(org, { role: 'sales_manager' });
  client = await createUser(org, { role: 'client' });
});

const uploadDir = () => process.env.UPLOAD_DIR;

describe('upload', () => {
  it('images: auto-rotated WebP variants, EXIF stripped, public URLs', async () => {
    const agent = await loginAgent(request, app, admin);
    const res = await agent
      .post('/api/v1/media')
      .field('purpose', 'project_image')
      .attach('file', photo, { filename: '../../evil name.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    const m = res.body.data;
    expect(m).toMatchObject({
      kind: 'image',
      visibility: 'public',
      mime: 'image/webp',
      width: 800,
      height: 1200,
    });
    expect(m.originalName).toBe('evil name.jpg');
    expect(m.blurDataUrl).toMatch(/^data:image\/webp;base64,/);
    expect(Object.keys(m.urls).sort()).toEqual(['card', 'full', 'thumb']);
    expect(m.urls.card).toMatch(
      /^http:\/\/localhost:5030\/uploads\/\d{4}\/\d{2}\/[\w-]+-card\.webp$/,
    );

    const doc = await Media.findOne({ orgId: org._id, _id: m.id }).lean();
    const fullPath = join(uploadDir(), 'public', doc.variants.full.key);
    expect(existsSync(fullPath)).toBe(true);
    const meta = await sharp(fullPath).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.width).toBe(800); // portrait after rotation
    expect(doc.variants.thumb.width).toBe(400);
  });

  it('serves public files statically with cross-origin CORP', async () => {
    const agent = await loginAgent(request, app, admin);
    const m = (await agent.post('/api/v1/media').attach('file', photo, 'a.jpg')).body.data;
    const path = new URL(m.urls.thumb).pathname;
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect((await request(app).get('/uploads/../.env')).status).toBe(404);
  });

  it('rejects files whose bytes are not an allowed type, whatever the name says', async () => {
    const agent = await loginAgent(request, app, admin);
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const res = await agent
      .post('/api/v1/media')
      .attach('file', html, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(415);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect((await agent.post('/api/v1/media').attach('file', svg, 'x.svg')).status).toBe(415);
  });

  it('rejects a corrupt image that has valid magic bytes', async () => {
    const agent = await loginAgent(request, app, admin);
    const broken = Buffer.concat([photo.subarray(0, 200), Buffer.alloc(500)]);
    const res = await agent.post('/api/v1/media').attach('file', broken, 'broken.jpg');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_IMAGE');
  });

  it('PDF documents are stored as-is', async () => {
    const agent = await loginAgent(request, app, admin);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const res = await agent
      .post('/api/v1/media')
      .field('purpose', 'brochure')
      .attach('file', pdf, 'b.pdf');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'document', mime: 'application/pdf' });
  });
});

describe('private files', () => {
  it('payment slips are forced private; clients cannot upload public media', async () => {
    const c = await loginAgent(request, app, client);
    const slip = await c
      .post('/api/v1/media')
      .field('purpose', 'payment_slip')
      .field('visibility', 'public')
      .attach('file', photo, 'slip.jpg');
    expect(slip.status).toBe(201);
    expect(slip.body.data.visibility).toBe('private');
    expect(slip.body.data.urls.full).toBe(`/api/v1/media/${slip.body.data.id}/file?variant=full`);
    const doc = await Media.findOne({ orgId: org._id, _id: slip.body.data.id }).lean();
    expect(existsSync(join(uploadDir(), 'private', doc.variants.full.key))).toBe(true);
    expect(existsSync(join(uploadDir(), 'public', doc.variants.full.key))).toBe(false);

    expect(
      (
        await c
          .post('/api/v1/media')
          .field('purpose', 'project_image')
          .attach('file', photo, 'p.jpg')
      ).status,
    ).toBe(403);
  });

  it('private file access: uploader and managers yes, other staff get 404', async () => {
    const c = await loginAgent(request, app, client);
    const id = (
      await c.post('/api/v1/media').field('purpose', 'payment_slip').attach('file', photo, 's.jpg')
    ).body.data.id;

    const own = await c.get(`/api/v1/media/${id}/file?variant=thumb`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('image/webp');
    expect(own.headers['cache-control']).toBe('private, no-store');

    expect(
      (await (await loginAgent(request, app, manager)).get(`/api/v1/media/${id}/file`)).status,
    ).toBe(200);
    expect(
      (await (await loginAgent(request, app, exec)).get(`/api/v1/media/${id}/file`)).status,
    ).toBe(404);
    expect((await (await loginAgent(request, app, exec)).get(`/api/v1/media/${id}`)).status).toBe(
      404,
    );
    expect((await request(app).get(`/api/v1/media/${id}/file`)).status).toBe(401);
  });

  it('delete is soft and limited to uploader or media:delete', async () => {
    const e = await loginAgent(request, app, exec);
    const id = (
      await (
        await loginAgent(request, app, admin)
      )
        .post('/api/v1/media')
        .attach('file', photo, 'a.jpg')
    ).body.data.id;
    expect((await e.delete(`/api/v1/media/${id}`)).status).toBe(403);
    expect(
      (await (await loginAgent(request, app, manager)).delete(`/api/v1/media/${id}`)).status,
    ).toBe(204);
    const doc = await Media.findOne({ orgId: org._id, _id: id })
      .setOptions({ withDeleted: true })
      .lean();
    expect(doc.deletedAt).toBeInstanceOf(Date);
  });

  it('purge job removes files 7 days after soft delete', async () => {
    const { purgeDeletedMedia } = await import('#modules/media/media.service.js');
    const id = (
      await (
        await loginAgent(request, app, admin)
      )
        .post('/api/v1/media')
        .attach('file', photo, 'a.jpg')
    ).body.data.id;
    const doc = await Media.findOne({ orgId: org._id, _id: id }).lean();
    await Media.collection.updateOne(
      { _id: doc._id },
      { $set: { deletedAt: new Date(Date.now() - 8 * 86_400_000) } },
    );
    expect(await purgeDeletedMedia(org._id)).toBe(1);
    expect(existsSync(join(uploadDir(), 'public', doc.variants.full.key))).toBe(false);
    expect(await Media.countDocuments({ orgId: org._id }).setOptions({ withDeleted: true })).toBe(
      0,
    );
  });
});
