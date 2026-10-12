import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDb, startDb, stopDb } from '../helpers/db.js';
import { createOrg, createUser, loginAgent } from '../helpers/factory.js';

const TK = 100;
let app;
let Unit;
let Media;
let unitService;
beforeAll(async () => {
  await startDb();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  ({ Unit } = await import('#modules/units/unit.model.js'));
  ({ Media } = await import('#modules/media/media.model.js'));
  unitService = await import('#modules/units/unit.service.js');
});
afterAll(stopDb);

let org;
let admin;
let manager;
let exec;
let client;
let A; // admin agent
beforeEach(async () => {
  await clearDb();
  org = await createOrg();
  admin = await createUser(org, { role: 'admin' });
  manager = await createUser(org, { role: 'sales_manager' });
  exec = await createUser(org, { role: 'sales_executive' });
  client = await createUser(org, { role: 'client' });
  A = await loginAgent(request, app, admin);
});

async function apartmentProject(extra = {}) {
  const p = await A.post('/api/v1/projects').send({
    name: 'Lake View Residency',
    kind: 'apartment',
    landArea: { value: 10, unit: 'katha' },
    ...extra,
  });
  expect(p.status).toBe(201);
  const b = await A.post(`/api/v1/projects/${p.body.data.id}/blocks`).send({
    kind: 'building',
    code: 'A',
    name: 'Tower A',
    lowestFloor: 0,
    highestFloor: 10,
  });
  expect(b.status).toBe(201);
  return { project: p.body.data, block: b.body.data };
}

async function setApartmentPricing(projectId) {
  const cur = await A.get(`/api/v1/projects/${projectId}`);
  const res = await A.put(`/api/v1/projects/${projectId}/pricing`).send({
    version: cur.body.data.version,
    pricing: {
      ratePerSqft: 8_500 * TK,
      floorRise: { fromFloor: 3, perFloorPerSqft: 100 * TK },
      parkingPerSlot: 400_000 * TK,
    },
  });
  expect(res.status).toBe(200);
  return res;
}

async function unit(projectId, blockId, body = {}) {
  const res = await A.post(`/api/v1/projects/${projectId}/units`).send({
    blockId,
    floor: 5,
    position: 'B',
    saleableSqft: 1250,
    ...body,
  });
  expect(res.status).toBe(201);
  return res.body.data;
}

async function publicImage() {
  return Media.create({
    orgId: org._id,
    driver: 'local',
    visibility: 'public',
    kind: 'image',
    purpose: 'floor_plan',
    mime: 'image/webp',
    sourceMime: 'image/png',
    bytes: 1000,
    sha256: 'x'.repeat(64),
    width: 1600,
    height: 1000,
    variants: {
      full: { key: 'public/2026/10/fp-full.webp', width: 1600, height: 1000, bytes: 1000 },
    },
    uploadedBy: admin._id,
  });
}

describe('projects & blocks', () => {
  it('RBAC: executives read, managers write, only admin sets prices', async () => {
    const ex = await loginAgent(request, app, exec);
    const mg = await loginAgent(request, app, manager);
    const cl = await loginAgent(request, app, client);
    expect(
      (await ex.post('/api/v1/projects').send({ name: 'X Tower', kind: 'apartment' })).status,
    ).toBe(403);
    expect((await cl.get('/api/v1/projects')).status).toBe(403);
    const p = await mg.post('/api/v1/projects').send({ name: 'X Tower', kind: 'apartment' });
    expect(p.status).toBe(201);
    expect((await ex.get('/api/v1/projects')).status).toBe(200);
    const price = await mg
      .put(`/api/v1/projects/${p.body.data.id}/pricing`)
      .send({ version: 0, pricing: { ratePerSqft: 100 } });
    expect(price.status).toBe(403);
  });

  it('slug from the name; Bangla-only name needs a slug; duplicate → 409', async () => {
    const a = await A.post('/api/v1/projects').send({ name: 'Green Valley Phase 2', kind: 'plot' });
    expect(a.body.data.slug).toBe('green-valley-phase-2');
    expect(a.body.data.landArea).toBeNull();
    const bn = await A.post('/api/v1/projects').send({ name: 'সবুজ ভ্যালি', kind: 'plot' });
    expect(bn.status).toBe(422);
    const dup = await A.post('/api/v1/projects').send({
      name: 'Green Valley Phase 2',
      kind: 'plot',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
  });

  it('land area stored in katha + decimal; location lat/lng round-trip', async () => {
    const res = await A.post('/api/v1/projects').send({
      name: 'River Plots',
      kind: 'plot',
      landArea: { value: 330, unit: 'decimal' },
      location: { area: 'Purbachal', city: 'Dhaka', lat: 23.84, lng: 90.5 },
    });
    expect(res.body.data.landArea).toMatchObject({
      value: 330,
      unit: 'decimal',
      decimal: 330,
      katha: 199.65,
      sqft: 143_748,
    });
    expect(res.body.data.location).toMatchObject({ lat: 23.84, lng: 90.5, area: 'Purbachal' });
    const half = await A.post('/api/v1/projects').send({
      name: 'Y',
      kind: 'plot',
      location: { lat: 1 },
    });
    expect(half.status).toBe(422);
  });

  it('optimistic concurrency: stale version → 409 STALE_VERSION', async () => {
    const { project } = await apartmentProject();
    const ok1 = await A.patch(`/api/v1/projects/${project.id}`).send({
      version: project.version,
      stage: 'ongoing',
    });
    expect(ok1.status).toBe(200);
    const stale = await A.patch(`/api/v1/projects/${project.id}`).send({
      version: project.version,
      stage: 'ready',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_VERSION');
  });

  it('block kind must match the project kind', async () => {
    const { project } = await apartmentProject();
    const res = await A.post(`/api/v1/projects/${project.id}/blocks`).send({
      kind: 'sector',
      code: 'S1',
      name: 'Sector 1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BLOCK_KIND');
  });
});

describe('units & pricing', () => {
  it('apartment unit: code generated, sq m derived, list price from the rate card', async () => {
    const { project, block } = await apartmentProject();
    await setApartmentPricing(project.id);
    const u = await unit(project.id, block.id, { parkingSlots: 1 });
    expect(u.code).toBe('A-5B');
    expect(u.saleableSqm).toBe(116.13);
    // 1250 × 8500 + floor rise (3 steps × 100 × 1250) + 1 parking
    expect(u.listPrice).toBe((10_625_000 + 375_000 + 400_000) * TK);
    const detail = await A.get(`/api/v1/units/${u.id}`);
    expect(detail.body.data.price.lines.map((l) => l.code)).toEqual([
      'base',
      'floor_rise',
      'parking',
    ]);
  });

  it('plot unit keeps the deed unit and shows both; apartment-only fields rejected', async () => {
    const p = await A.post('/api/v1/projects').send({ name: 'Plot City', kind: 'plot' });
    const pid = p.body.data.id;
    const b = await A.post(`/api/v1/projects/${pid}/blocks`).send({
      kind: 'block',
      code: 'B',
      name: 'Block B',
    });
    await A.put(`/api/v1/projects/${pid}/pricing`).send({
      version: p.body.data.version,
      pricing: { rateUnit: 'katha', rate: 2_500_000 * TK, cornerPremiumBps: 1000 },
    });
    const u = await A.post(`/api/v1/projects/${pid}/units`).send({
      blockId: b.body.data.id,
      plotNo: '12',
      roadWidthFt: 30,
      isCorner: true,
      landArea: { value: 5, unit: 'decimal' },
    });
    expect(u.status).toBe(201);
    expect(u.body.data.code).toBe('B-12');
    expect(u.body.data.landArea).toMatchObject({
      value: 5,
      unit: 'decimal',
      katha: 3.025,
      decimal: 5,
      sqft: 2178,
    });
    // 3.025 katha × ৳25,00,000 = ৳75,62,500 + 10 % corner
    expect(u.body.data.listPrice).toBe(831_875_000);
    const bad = await A.post(`/api/v1/projects/${pid}/units`).send({
      blockId: b.body.data.id,
      plotNo: '13',
      floor: 2,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0]).toMatchObject({ path: 'floor', code: 'FIELD_NOT_ALLOWED' });
  });

  it('floor outside the building → 400; unit price fields need pricing:write', async () => {
    const { project, block } = await apartmentProject();
    const res = await A.post(`/api/v1/projects/${project.id}/units`).send({
      blockId: block.id,
      floor: 11,
      position: 'A',
    });
    expect(res.body.error.code).toBe('FLOOR_OUT_OF_RANGE');
    const mg = await loginAgent(request, app, manager);
    const r2 = await mg
      .post(`/api/v1/projects/${project.id}/units`)
      .send({ blockId: block.id, floor: 1, position: 'A', rateOverride: 1 });
    expect(r2.status).toBe(403);
  });

  it('bulk create is all-or-nothing; repricing updates unsold units only', async () => {
    const { project, block } = await apartmentProject();
    const units = [1, 2, 3].map((floor) => ({
      blockId: block.id,
      floor,
      position: 'A',
      saleableSqft: 1000,
    }));
    const dup = await A.post(`/api/v1/projects/${project.id}/units/bulk`).send({
      units: [...units, { blockId: block.id, floor: 1, position: 'A' }],
    });
    expect(dup.status).toBe(422);
    expect(await Unit.countDocuments({ orgId: org._id })).toBe(0);

    const ok = await A.post(`/api/v1/projects/${project.id}/units/bulk`).send({ units });
    expect(ok.status).toBe(201);
    expect(ok.body.meta.created).toBe(3);
    expect(ok.body.data.every((u) => u.listPrice === null)).toBe(true); // no rate card yet

    // one is sold → keeps its (null) list price
    await unitService.transitionUnit({
      orgId: org._id,
      unitId: ok.body.data[0].id,
      from: ['available'],
      to: 'booked',
      ctx: { orgId: org._id, actor: { id: String(admin._id), kind: 'user' } },
    });
    const priced = await setApartmentPricing(project.id);
    expect(priced.body.meta.repricedUnits).toBe(2);
  });
});

describe('price matrix (POST /projects/:id/units/prices)', () => {
  it('dry run previews, commit writes all-or-nothing; null clears; needs pricing:write', async () => {
    const { project, block } = await apartmentProject();
    await setApartmentPricing(project.id);
    const a = await unit(project.id, block.id, { floor: 2, position: 'A', saleableSqft: 1000 });
    const b = await unit(project.id, block.id, { floor: 2, position: 'B', saleableSqft: 1000 });
    const url = `/api/v1/projects/${project.id}/units/prices`;

    const mg = await loginAgent(request, app, manager);
    expect(
      (await mg.post(url).send({ items: [{ id: a.id, version: a.version, rateOverride: 1 }] }))
        .status,
    ).toBe(403);

    const items = [
      { id: a.id, version: a.version, rateOverride: 9_000 * TK },
      { id: b.id, version: b.version, priceAdjustment: { amount: -50_000 * TK, note: 'Launch' } },
    ];
    const dry = await A.post(url).send({ dryRun: true, items });
    expect(dry.status).toBe(200);
    expect(dry.body.meta.dryRun).toBe(true);
    expect(dry.body.data[0]).toMatchObject({
      previousListPrice: 8_500_000 * TK,
      listPrice: 9_000_000 * TK,
    });
    expect(dry.body.data[1].listPrice).toBe(8_450_000 * TK);
    expect((await Unit.findOne({ orgId: org._id, _id: a.id }).lean()).listPrice).toBe(8_500_000 * TK); // nothing written

    const res = await A.post(url).send({ items });
    expect(res.status).toBe(200);
    expect(res.body.meta.changed).toBe(2);
    expect(res.body.data[0]).toMatchObject({ rateOverride: 9_000 * TK, version: a.version + 1 });
    expect(res.body.data[1].priceAdjustment).toEqual({ amount: -50_000 * TK, note: 'Launch' });

    // the old versions are now stale → whole batch refused, nothing changes
    const stale = await A.post(url).send({
      items: [{ id: a.id, version: a.version, rateOverride: null }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_VERSION');

    const cleared = await A.post(url).send({
      items: [
        { id: a.id, version: a.version + 1, rateOverride: null },
        { id: b.id, version: b.version + 1, priceAdjustment: null },
      ],
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.map((u) => u.listPrice)).toEqual([8_500_000 * TK, 8_500_000 * TK]);
    const raw = await Unit.findOne({ orgId: org._id, _id: a.id }).lean();
    expect(raw.rateOverride).toBeUndefined();
  });

  it('sold units and units of another project are refused', async () => {
    const { project, block } = await apartmentProject();
    const other = await A.post('/api/v1/projects').send({ name: 'Other Tower', kind: 'apartment' });
    const ob = await A.post(`/api/v1/projects/${other.body.data.id}/blocks`).send({
      kind: 'building',
      code: 'Z',
      name: 'Z',
      lowestFloor: 0,
      highestFloor: 9,
    });
    const foreign = await unit(other.body.data.id, ob.body.data.id);
    const u = await unit(project.id, block.id);
    const url = `/api/v1/projects/${project.id}/units/prices`;

    const nf = await A.post(url).send({
      items: [{ id: foreign.id, version: foreign.version, rateOverride: 1 }],
    });
    expect(nf.status).toBe(404);

    await unitService.transitionUnit({
      orgId: org._id,
      unitId: u.id,
      from: ['available'],
      to: 'booked',
      ctx: { orgId: org._id, actor: { id: String(admin._id), kind: 'user' } },
    });
    const sold = await A.post(url).send({
      items: [{ id: u.id, version: u.version + 1, rateOverride: 1 }],
    });
    expect(sold.status).toBe(409);
    expect(sold.body.error.code).toBe('UNIT_LOCKED');
  });
});

describe('status machine', () => {
  it('concurrent holds: exactly one wins', async () => {
    const { project, block } = await apartmentProject();
    const u = await unit(project.id, block.id);
    const execs = await Promise.all(
      [1, 2, 3, 4, 5].map(() => createUser(org, { role: 'sales_executive' })),
    );
    const agents = await Promise.all(execs.map((e) => loginAgent(request, app, e)));
    const results = await Promise.all(
      [...agents, ...agents].map((ag) =>
        ag.post(`/api/v1/units/${u.id}/hold`).send({ note: 'site visit' }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(results.find((r) => r.status === 409).body.error).toMatchObject({
      code: 'UNIT_STATE_CONFLICT',
      details: { status: 'held' },
    });
  });

  it('only the holder or a manager releases; manager can extend', async () => {
    const { project, block } = await apartmentProject();
    const u = await unit(project.id, block.id);
    const ex = await loginAgent(request, app, exec);
    const other = await loginAgent(
      request,
      app,
      await createUser(org, { role: 'sales_executive' }),
    );
    const held = await ex.post(`/api/v1/units/${u.id}/hold`).send({ hours: 2 });
    expect(held.body.data).toMatchObject({ status: 'held', hold: { by: String(exec._id) } });

    const no = await other.post(`/api/v1/units/${u.id}/release`);
    expect(no.status).toBe(403);
    expect(no.body.error.code).toBe('NOT_HOLDER');
    expect((await ex.post(`/api/v1/units/${u.id}/hold/extend`).send({ hours: 5 })).status).toBe(
      403,
    );
    const mg = await loginAgent(request, app, manager);
    expect((await mg.post(`/api/v1/units/${u.id}/hold/extend`).send({ hours: 5 })).status).toBe(
      200,
    );
    const rel = await mg.post(`/api/v1/units/${u.id}/release`);
    expect(rel.body.data).toMatchObject({ status: 'available', hold: null });
  });

  it('expired hold reads as available, can be taken over, and the job flips it', async () => {
    const { project, block } = await apartmentProject();
    const u = await unit(project.id, block.id);
    const ex = await loginAgent(request, app, exec);
    await ex.post(`/api/v1/units/${u.id}/hold`).send({});
    await Unit.updateOne(
      { orgId: org._id, _id: u.id },
      { $set: { 'hold.until': new Date(Date.now() - 1000) } },
    );

    const read = await A.get(`/api/v1/units/${u.id}`);
    expect(read.body.data).toMatchObject({ status: 'available', hold: null });
    const list = await A.get(`/api/v1/projects/${project.id}/units?status=available`);
    expect(list.body.meta.total).toBe(1);

    expect(await unitService.expireHolds(org._id)).toBe(1);
    const raw = await Unit.findOne({ orgId: org._id, _id: u.id }).lean();
    expect(raw.status).toBe('available');
    expect(raw.hold).toBeNull();
  });

  it('per-user hold cap', async () => {
    const { project, block } = await apartmentProject();
    const units = Array.from({ length: 11 }, (_, i) => ({
      blockId: block.id,
      floor: 1 + (i % 10),
      position: i < 10 ? 'A' : 'B',
    }));
    const created = await A.post(`/api/v1/projects/${project.id}/units/bulk`).send({ units });
    const ex = await loginAgent(request, app, exec);
    for (const u of created.body.data.slice(0, 10)) {
      expect((await ex.post(`/api/v1/units/${u.id}/hold`).send({})).status).toBe(200);
    }
    const over = await ex.post(`/api/v1/units/${created.body.data[10].id}/hold`).send({});
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('HOLD_LIMIT');
  });

  it('block needs units:block + reason; sold units lock price fields and cannot be deleted', async () => {
    const { project, block } = await apartmentProject();
    const u = await unit(project.id, block.id);
    const ex = await loginAgent(request, app, exec);
    expect(
      (await ex.post(`/api/v1/units/${u.id}/block`).send({ reason: 'landowner_share' })).status,
    ).toBe(403);
    expect((await A.post(`/api/v1/units/${u.id}/block`).send({ reason: 'other' })).status).toBe(
      422,
    );
    const blocked = await A.post(`/api/v1/units/${u.id}/block`).send({ reason: 'landowner_share' });
    expect(blocked.body.data).toMatchObject({ status: 'blocked', blockReason: 'landowner_share' });
    expect((await ex.post(`/api/v1/units/${u.id}/hold`).send({})).status).toBe(409);
    await A.post(`/api/v1/units/${u.id}/unblock`);

    await unitService.transitionUnit({
      orgId: org._id,
      unitId: u.id,
      from: ['available', 'held'],
      to: 'booked',
      ctx: { orgId: org._id, actor: { id: String(admin._id), kind: 'user' } },
    });
    const fresh = await A.get(`/api/v1/units/${u.id}`);
    const locked = await A.patch(`/api/v1/units/${u.id}`).send({
      version: fresh.body.data.version,
      saleableSqft: 1300,
    });
    expect(locked.body.error.code).toBe('UNIT_LOCKED');
    const label = await A.patch(`/api/v1/units/${u.id}`).send({
      version: fresh.body.data.version,
      typeLabel: 'Type B',
    });
    expect(label.status).toBe(200);
    expect((await A.delete(`/api/v1/units/${u.id}`)).body.error.code).toBe('UNIT_IN_USE');
    expect((await A.delete(`/api/v1/projects/${project.id}`)).body.error.code).toBe(
      'PROJECT_IN_USE',
    );
  });

  it('a stale PATCH after a hold is refused (status changes bump the version)', async () => {
    const { project, block } = await apartmentProject();
    const u = await unit(project.id, block.id);
    await (await loginAgent(request, app, exec)).post(`/api/v1/units/${u.id}/hold`).send({});
    const res = await A.patch(`/api/v1/units/${u.id}`).send({ version: u.version, typeLabel: 'X' });
    expect(res.body.error.code).toBe('STALE_VERSION');
  });
});

describe('floor plans', () => {
  it('typical floor plan resolves positions per floor', async () => {
    const { project, block } = await apartmentProject();
    const a3 = await unit(project.id, block.id, { floor: 3, position: 'A' });
    await unit(project.id, block.id, { floor: 4, position: 'A' });
    const img = await publicImage();
    const square = [
      [0.1, 0.1],
      [0.4, 0.1],
      [0.4, 0.4],
      [0.1, 0.4],
    ];
    const fp = await A.post(`/api/v1/projects/${project.id}/floorplans`).send({
      kind: 'floor',
      blockId: block.id,
      floors: [4, 3],
      title: 'Typical floor',
      mediaId: String(img._id),
      hotspots: [
        { key: 'a', position: 'a', points: square },
        {
          key: 'lift',
          label: 'Lift',
          points: [
            [0.5, 0.5],
            [0.6, 0.5],
            [0.6, 0.6],
          ],
        },
      ],
    });
    expect(fp.status).toBe(201);
    expect(fp.body.data).toMatchObject({ floors: [3, 4], floor: 3, imageWidth: 1600 });
    expect(fp.body.data.hotspots[0].target.unit.id).toBe(a3.id);
    expect(fp.body.data.hotspots[1].target).toBeNull();

    const f4 = await A.get(`/api/v1/floorplans/${fp.body.data.id}?floor=4`);
    expect(f4.body.data.hotspots[0].target.unit.code).toBe('A-4A');
    expect((await A.get(`/api/v1/floorplans/${fp.body.data.id}?floor=7`)).body.error.code).toBe(
      'FLOOR_NOT_IN_PLAN',
    );
  });

  it('rejects out-of-range coordinates and foreign units', async () => {
    const { project, block } = await apartmentProject();
    const other = await apartmentProject({ name: 'Other Tower' });
    const foreign = await unit(other.project.id, other.block.id);
    const img = await publicImage();
    const base = {
      kind: 'floor',
      blockId: block.id,
      floors: [5],
      title: 'F5',
      mediaId: String(img._id),
    };
    const bad = await A.post(`/api/v1/projects/${project.id}/floorplans`).send({
      ...base,
      hotspots: [
        {
          key: 'x',
          points: [
            [0, 0],
            [1.2, 0],
            [1, 1],
          ],
        },
      ],
    });
    expect(bad.status).toBe(422);
    const wrong = await A.post(`/api/v1/projects/${project.id}/floorplans`).send({
      ...base,
      hotspots: [
        {
          key: 'x',
          unitId: foreign.id,
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
      ],
    });
    expect(wrong.body.error.code).toBe('INVALID_HOTSPOT_TARGET');
  });
});

describe('public catalogue', () => {
  it('unpublished → 404; blocked units hidden; prices only with publicPricing', async () => {
    const { project, block } = await apartmentProject();
    await setApartmentPricing(project.id);
    const free = await unit(project.id, block.id, { floor: 2, position: 'A' });
    const hidden = await unit(project.id, block.id, { floor: 2, position: 'B' });
    await A.post(`/api/v1/units/${hidden.id}/block`).send({ reason: 'landowner_share' });
    const slug = project.slug;

    expect((await request(app).get(`/api/v1/public/projects/${slug}`)).status).toBe(404);
    let cur = (await A.get(`/api/v1/projects/${project.id}`)).body.data;
    await A.patch(`/api/v1/projects/${project.id}`).send({ version: cur.version, published: true });

    const list = await request(app).get('/api/v1/public/projects');
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toContain('public');
    expect(list.body.data[0].inventory).toMatchObject({ total: 1, available: 1, priceFrom: null });

    const units = await request(app).get(`/api/v1/public/projects/${slug}/units`);
    expect(units.body.data.map((u) => u.id)).toEqual([free.id]);
    expect(units.body.data[0]).not.toHaveProperty('hold');
    expect(units.body.data[0].price).toBeNull();
    expect((await request(app).get(`/api/v1/public/units/${hidden.id}`)).status).toBe(404);

    cur = (await A.get(`/api/v1/projects/${project.id}`)).body.data;
    await A.patch(`/api/v1/projects/${project.id}`).send({
      version: cur.version,
      publicPricing: true,
    });
    const priced = await request(app).get(`/api/v1/public/units/${free.id}`);
    expect(priced.body.data.price).toBe(free.listPrice);
    expect(priced.body.data.project.slug).toBe(slug);
  });

  it('public floor plan: blocked unit → unavailable without id', async () => {
    const { project, block } = await apartmentProject({ published: true });
    const u = await unit(project.id, block.id, { floor: 5, position: 'A' });
    await A.post(`/api/v1/units/${u.id}/block`).send({ reason: 'management_reserve' });
    const img = await publicImage();
    const fp = await A.post(`/api/v1/projects/${project.id}/floorplans`).send({
      kind: 'floor',
      blockId: block.id,
      floors: [5],
      title: 'F5',
      mediaId: String(img._id),
      hotspots: [
        {
          key: 'a',
          unitId: u.id,
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
      ],
    });
    const pub = await request(app).get(`/api/v1/public/floorplans/${fp.body.data.id}`);
    expect(pub.body.data.hotspots[0]).toMatchObject({
      unitId: null,
      target: { unit: { status: 'unavailable' } },
    });
  });
});
