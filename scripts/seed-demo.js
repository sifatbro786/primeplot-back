// Demo catalogue for development: 4 published projects (2 apartment, 1 plot, 1 upcoming) with
// rate cards, buildings/sectors, units in mixed states, a typical floor plan and site plans.
// Everything goes through the real services, so prices, areas and codes are what the app
// itself would produce. Safe to re-run: an existing demo project (same slug) is skipped.
//
//   npm run seed:demo            # create what is missing
//   npm run seed:demo -- --reset # delete the demo projects first, then create them again
//
// Needs `npm run seed` (organization + first admin) to have run. Never run it on production.
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { env } from '#config/env.js';
import { connectDB, disconnectDB } from '#config/db.js';
import '#jobs/index.js'; // registers job types, so changes can queue website revalidation
import { permissionsFor } from '#shared/auth/permissions.js';
import { getCurrentOrg } from '#modules/organizations/organization.service.js';
import { User } from '#modules/users/user.model.js';
import { Project } from '#modules/projects/project.model.js';
import { Block } from '#modules/projects/block.model.js';
import { Unit } from '#modules/units/unit.model.js';
import { FloorPlan } from '#modules/floorplans/floorplan.model.js';
import { Booking } from '#modules/bookings/booking.model.js';
import { Media } from '#modules/media/media.model.js';
import * as projects from '#modules/projects/project.service.js';
import * as units from '#modules/units/unit.service.js';
import * as floorplans from '#modules/floorplans/floorplan.service.js';
import { createMedia } from '#modules/media/media.service.js';
import {
  zApartmentPricing,
  zPlotPricing,
  zProjectCreate,
} from '#modules/projects/project.validation.js';
import { zUnitBulk } from '#modules/units/unit.validation.js';
import { zFloorPlanCreate } from '#modules/floorplans/floorplan.service.js';
import * as construction from '#modules/construction/construction.service.js';
import { ConstructionUpdate } from '#modules/construction/constructionUpdate.model.js';
import { zUpdateCreate } from '#modules/construction/construction.validation.js';

const { values: args } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });
const TK = 100; // poisha per taka
const LAKH = 100_000 * TK;

if (env.isProd) {
  console.error('\n✖ seed:demo refuses to run with NODE_ENV=production\n');
  process.exit(1);
}

// ── demo content ────────────────────────────────────────────────────────────────

const DEMO = [
  {
    project: {
      name: 'Lake View Residency',
      nameBn: 'লেক ভিউ রেসিডেন্সি',
      slug: 'lake-view-residency',
      code: 'LVR',
      kind: 'apartment',
      stage: 'ongoing',
      published: true,
      featured: true,
      sortOrder: 1,
      publicPricing: true,
      tagline: 'Two lake-facing towers in Bashundhara, ten minutes from the airport road.',
      taglineBn: 'বসুন্ধরায় লেকমুখী দুটি ভবন, এয়ারপোর্ট রোড থেকে দশ মিনিট।',
      description:
        'Lake View Residency rises on a 20-katha plot facing the Bashundhara canal. Building A has ten floors over a basement car park; Building B, eight.\n\nEvery home is planned for cross-ventilation, with a deep south or east balcony and a separate service entry.',
      descriptionBn:
        '২০ কাঠার প্লটে বসুন্ধরা লেকের মুখোমুখি লেক ভিউ রেসিডেন্সি। ভবন এ — বেসমেন্ট পার্কিংসহ দশ তলা; ভবন বি — আট তলা।\n\nপ্রতিটি ইউনিটে ক্রস-ভেন্টিলেশন, দক্ষিণ বা পূর্বমুখী চওড়া বারান্দা আর আলাদা সার্ভিস প্রবেশপথ।',
      highlights: [
        { en: 'Lake-facing south homes', bn: 'লেকমুখী দক্ষিণের ইউনিট' },
        { en: 'RAJUK-approved design', bn: 'রাজউক অনুমোদিত নকশা' },
        {
          en: 'Two lifts per building, full generator backup',
          bn: 'প্রতি ভবনে দুটি লিফট, পূর্ণ জেনারেটর ব্যাকআপ',
        },
        { en: 'Rooftop garden and community hall', bn: 'ছাদবাগান ও কমিউনিটি হল' },
      ],
      amenities: [
        'lift',
        'generator',
        'substation',
        'car_parking',
        'rooftop_garden',
        'community_hall',
        'gym',
        'cctv',
        'security',
        'fire_safety',
        'intercom',
        'prayer_room',
      ],
      location: {
        address: 'Plot 214, Road 8, Block K, Bashundhara R/A',
        addressBn: 'প্লট ২১৪, রোড ৮, ব্লক কে, বসুন্ধরা আ/এ',
        area: 'Bashundhara',
        areaBn: 'বসুন্ধরা',
        city: 'Dhaka',
        district: 'Dhaka',
        lat: 23.8191,
        lng: 90.4526,
      },
      landArea: { value: 20, unit: 'katha' },
      approval: { authority: 'RAJUK', number: '25.39.0000.118.2025' },
      handoverAt: '2028-06-30',
    },
    pricing: {
      ratePerSqft: 9_500 * TK,
      floorRise: { fromFloor: 3, perFloorPerSqft: 100 * TK },
      facingPremiums: [{ facing: 'south', perSqft: 200 * TK }],
      cornerPerSqft: 150 * TK,
      parkingPerSlot: 4 * LAKH,
      charges: [
        {
          code: 'utility',
          label: 'Utility connections',
          labelBn: 'ইউটিলিটি সংযোগ',
          amount: 1.5 * LAKH,
        },
      ],
    },
    blocks: [
      {
        kind: 'building',
        code: 'A',
        name: 'Building A',
        nameBn: 'ভবন এ',
        lowestFloor: -1,
        highestFloor: 10,
        sortOrder: 0,
        floors: [1, 10],
      },
      {
        kind: 'building',
        code: 'B',
        name: 'Building B',
        nameBn: 'ভবন বি',
        lowestFloor: 0,
        highestFloor: 8,
        sortOrder: 1,
        floors: [1, 8],
      },
    ],
    types: {
      A: {
        typeLabel: 'Type A',
        bedrooms: 3,
        bathrooms: 3,
        balconies: 2,
        saleableSqft: 1450,
        carpetSqft: 1190,
        parkingSlots: 1,
        facing: 'south',
        isCorner: true,
      },
      B: {
        typeLabel: 'Type B',
        bedrooms: 3,
        bathrooms: 2,
        balconies: 2,
        saleableSqft: 1250,
        carpetSqft: 1020,
        parkingSlots: 1,
        facing: 'south',
      },
      C: {
        typeLabel: 'Type C',
        bedrooms: 2,
        bathrooms: 2,
        balconies: 1,
        saleableSqft: 1100,
        carpetSqft: 890,
        parkingSlots: 0,
        facing: 'east',
      },
      D: {
        typeLabel: 'Type D',
        bedrooms: 4,
        bathrooms: 4,
        balconies: 3,
        saleableSqft: 1600,
        carpetSqft: 1310,
        parkingSlots: 1,
        facing: 'east',
        isCorner: true,
      },
    },
    states: {
      held: ['A-10A', 'A-7B', 'B-5C'],
      booked: ['A-3A', 'A-3B', 'A-4C', 'A-6D', 'B-2A', 'B-2B', 'B-6D'],
      blocked: ['A-9D'],
    },
    plans: 'apartment',
  },
  {
    project: {
      name: 'Uttara Green Court',
      nameBn: 'উত্তরা গ্রিন কোর্ট',
      slug: 'uttara-green-court',
      code: 'UGC',
      kind: 'apartment',
      stage: 'ready',
      published: true,
      featured: false,
      sortOrder: 2,
      publicPricing: true,
      tagline: 'Ready to move in — fourteen homes beside the Sector 13 park.',
      taglineBn: 'এখনই ওঠার উপযোগী — সেক্টর ১৩-এর পার্কের পাশে চৌদ্দটি ইউনিট।',
      description:
        'A compact seven-storey building with two homes per floor, finished and handed over floor by floor since 2025.',
      descriptionBn:
        'প্রতি তলায় দুটি ইউনিটসহ সাত তলার ছিমছাম ভবন — ২০২৫ সাল থেকে তলা ধরে হস্তান্তর চলছে।',
      highlights: [
        { en: 'Move in now', bn: 'এখনই উঠতে পারবেন' },
        { en: 'Park-facing homes', bn: 'পার্কমুখী ইউনিট' },
      ],
      amenities: ['lift', 'generator', 'car_parking', 'cctv', 'security', 'gas_connection'],
      location: {
        address: 'House 31, Road 12, Sector 13, Uttara',
        addressBn: 'বাড়ি ৩১, রোড ১২, সেক্টর ১৩, উত্তরা',
        area: 'Uttara',
        areaBn: 'উত্তরা',
        city: 'Dhaka',
        district: 'Dhaka',
        lat: 23.8728,
        lng: 90.3878,
      },
      landArea: { value: 6, unit: 'katha' },
      approval: { authority: 'RAJUK', number: '25.39.0000.072.2022' },
      handoverAt: '2025-12-31',
    },
    pricing: {
      ratePerSqft: 8_200 * TK,
      parkingPerSlot: 3.5 * LAKH,
      facingPremiums: [{ facing: 'south', perSqft: 150 * TK }],
    },
    blocks: [
      {
        kind: 'building',
        code: 'G',
        name: 'Green Court',
        nameBn: 'গ্রিন কোর্ট',
        lowestFloor: 0,
        highestFloor: 7,
        sortOrder: 0,
        floors: [1, 7],
      },
    ],
    types: {
      A: {
        typeLabel: 'Park side',
        bedrooms: 3,
        bathrooms: 3,
        balconies: 2,
        saleableSqft: 1350,
        parkingSlots: 1,
        facing: 'south',
      },
      B: {
        typeLabel: 'Garden side',
        bedrooms: 3,
        bathrooms: 2,
        balconies: 2,
        saleableSqft: 1180,
        parkingSlots: 1,
        facing: 'north',
      },
    },
    states: { booked: ['G-1A', 'G-1B', 'G-2A', 'G-2B', 'G-3A', 'G-4B', 'G-5A'], held: ['G-6A'] },
  },
  {
    project: {
      name: 'Purbachal Shapla City',
      nameBn: 'পূর্বাচল শাপলা সিটি',
      slug: 'purbachal-shapla-city',
      code: 'PSC',
      kind: 'plot',
      stage: 'ongoing',
      published: true,
      featured: true,
      sortOrder: 3,
      publicPricing: true,
      tagline: 'Residential plots on 25–40 ft roads, beside the Purbachal 300 ft road.',
      taglineBn: 'পূর্বাচল ৩০০ ফুট সড়কের পাশে ২৫–৪০ ফুট রাস্তার আবাসিক প্লট।',
      description:
        'Two sectors of mutated, ready-to-build plots with internal roads, drainage and a central park. Deeds are registered in katha.',
      descriptionBn:
        'অভ্যন্তরীণ রাস্তা, ড্রেনেজ ও কেন্দ্রীয় পার্কসহ দুটি সেক্টরে নামজারিকৃত, বাড়ি তোলার উপযোগী প্লট। দলিল কাঠায় রেজিস্ট্রি হয়।',
      highlights: [
        { en: 'Mutation done, ready to build', bn: 'নামজারি সম্পন্ন, বাড়ি তোলার উপযোগী' },
        { en: 'Central park and mosque plot', bn: 'কেন্দ্রীয় পার্ক ও মসজিদের জায়গা' },
      ],
      amenities: ['security', 'cctv', 'gas_connection', 'kids_play_area', 'prayer_room'],
      location: {
        address: 'Sector 3, beside the 300 ft road, Rupganj',
        addressBn: 'সেক্টর ৩, ৩০০ ফুট সড়কের পাশে, রূপগঞ্জ',
        area: 'Purbachal',
        areaBn: 'পূর্বাচল',
        city: 'Narayanganj',
        district: 'Narayanganj',
        lat: 23.841,
        lng: 90.5155,
      },
      landArea: { value: 9.5, unit: 'decimal' },
      approval: null,
      handoverAt: null,
    },
    pricing: {
      rateUnit: 'katha',
      rate: 45 * LAKH,
      cornerPremiumBps: 1000,
      roadWidthPremiums: [
        { minWidthFt: 30, perUnit: 2 * LAKH },
        { minWidthFt: 40, perUnit: 5 * LAKH },
      ],
      charges: [
        {
          code: 'registration_support',
          label: 'Registration support',
          labelBn: 'রেজিস্ট্রেশন সহায়তা',
          amount: 50_000 * TK,
        },
      ],
    },
    blocks: [
      { kind: 'sector', code: 'S1', name: 'Sector 1', nameBn: 'সেক্টর ১', sortOrder: 0 },
      { kind: 'sector', code: 'S2', name: 'Sector 2', nameBn: 'সেক্টর ২', sortOrder: 1 },
    ],
    // per sector: [road, width ft, plots on it, katha each]
    roads: {
      S1: [
        ['1', 25, 8, 3],
        ['2', 30, 8, 3],
      ],
      S2: [['3', 40, 6, 5]],
    },
    states: { held: ['S1-4', 'S2-3'], booked: ['S1-1', 'S1-2', 'S1-9', 'S2-1', 'S2-6'] },
    plans: 'plot',
  },
  {
    project: {
      name: 'Dhanmondi Lakeside',
      nameBn: 'ধানমন্ডি লেকসাইড',
      slug: 'dhanmondi-lakeside',
      code: 'DLS',
      kind: 'apartment',
      stage: 'upcoming',
      published: true,
      featured: false,
      sortOrder: 4,
      publicPricing: false,
      tagline: 'Eight homes on a quiet lane off Road 27 — launching soon.',
      taglineBn: 'রোড ২৭-এর পাশে নিরিবিলি গলিতে আটটি ইউনিট — শিগগিরই আসছে।',
      location: { area: 'Dhanmondi', areaBn: 'ধানমন্ডি', city: 'Dhaka', district: 'Dhaka' },
      landArea: { value: 5, unit: 'katha' },
      handoverAt: '2029-12-31',
      amenities: ['lift', 'generator', 'car_parking'],
    },
  },
];

// ── drawings (rendered to PNG with sharp, uploaded through the media pipeline) ─────────

const W = 1600;
const H = 1000;
const svgFrame = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fbfaf7"/><g font-family="Arial, sans-serif">${body}</g></svg>`;

/** Typical floor: four flats around a core. Returns the drawing and normalized flat rectangles. */
function typicalFloorDrawing() {
  const m = 80;
  const core = { x: 700, y: 380, w: 200, h: 240 };
  const flats = {
    A: [m, m, 700 - m, 420],
    B: [900, m, W - m - 900, 420],
    C: [m, 500, 700 - m, H - m - 500],
    D: [900, 500, W - m - 900, H - m - 500],
  };
  let body = `<rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" fill="none" stroke="#1c1d1a" stroke-width="10"/>`;
  for (const [k, [x, y, w, h]] of Object.entries(flats)) {
    body += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#1c1d1a" stroke-width="6"/>`;
    // a few interior walls so it reads as a plan
    body += `<line x1="${x + w * 0.45}" y1="${y}" x2="${x + w * 0.45}" y2="${y + h * 0.6}" stroke="#3d4035" stroke-width="3"/>`;
    body += `<line x1="${x}" y1="${y + h * 0.6}" x2="${x + w * 0.7}" y2="${y + h * 0.6}" stroke="#3d4035" stroke-width="3"/>`;
    body += `<text x="${x + 24}" y="${y + 44}" font-size="28" fill="#85877f">${k}</text>`;
  }
  body += `<rect x="${core.x}" y="${core.y}" width="${core.w}" height="${core.h}" fill="#e9e6df" stroke="#1c1d1a" stroke-width="4"/>`;
  body += `<text x="${core.x + 100}" y="${core.y + 128}" font-size="26" text-anchor="middle" fill="#666861">LIFT · STAIR</text>`;
  const norm = ([x, y, w, h]) =>
    [
      [x / W, y / H],
      [(x + w) / W, y / H],
      [(x + w) / W, (y + h) / H],
      [x / W, (y + h) / H],
    ].map((p) => p.map((v) => Math.round(v * 1e5) / 1e5));
  return {
    svg: svgFrame(body),
    flats: Object.fromEntries(Object.entries(flats).map(([k, r]) => [k, norm(r)])),
    core: norm([core.x, core.y, core.w, core.h]),
  };
}

/** Site plan with one rectangle per building/plot. `cells` = [{ key, label, rect:[x,y,w,h] }]. */
function sitePlanDrawing(cells, roads = []) {
  let body = '';
  for (const r of roads)
    body += `<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" fill="#e9e6df"/><text x="${r[0] + 16}" y="${r[1] + r[3] / 2 + 9}" font-size="24" fill="#666861">${r[4]}</text>`;
  for (const c of cells) {
    const [x, y, w, h] = c.rect;
    body += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff" stroke="#1c1d1a" stroke-width="4"/>`;
    body += `<text x="${x + w / 2}" y="${y + h / 2 + 8}" font-size="22" text-anchor="middle" fill="#85877f">${c.label}</text>`;
  }
  const norm = ([x, y, w, h]) =>
    [
      [x / W, y / H],
      [(x + w) / W, y / H],
      [(x + w) / W, (y + h) / H],
      [x / W, (y + h) / H],
    ].map((p) => p.map((v) => Math.round(v * 1e5) / 1e5));
  return { svg: svgFrame(body), shapes: cells.map((c) => ({ ...c, points: norm(c.rect) })) };
}

async function uploadDrawing(ctx, user, svg, alt) {
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const m = await createMedia({
    orgId: ctx.orgId,
    user,
    file: { buffer, originalname: 'plan.png', mimetype: 'image/png', size: buffer.length },
    visibility: 'public',
    purpose: 'floor_plan',
    alt,
    ctx,
  });
  return String(m._id); // createMedia returns a plain document (_id, no id virtual)
}

/** Placeholder "site photo": a tower with `cast` of `total` floors done (dev data only). */
function progressDrawing(cast, total, label) {
  const w = 1200;
  const h = 800;
  const fh = 44;
  const x0 = 420;
  const base = 700;
  let floors = '';
  for (let i = 0; i < total; i++) {
    const y = base - (i + 1) * fh;
    const done = i < cast;
    floors += `<rect x="${x0}" y="${y}" width="360" height="${fh - 6}" fill="${done ? '#8a8f7a' : 'none'}" stroke="#4b5040" stroke-width="3" stroke-dasharray="${done ? '0' : '10 8'}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="#e9e4d8"/><rect y="${base}" width="${w}" height="${h - base}" fill="#b9ad92"/>
${floors}<text x="40" y="70" font-family="sans-serif" font-size="34" fill="#2f3326">${label}</text>
<text x="40" y="115" font-family="sans-serif" font-size="22" fill="#5d604f">Demo placeholder — replace with a real site photo</text></svg>`;
}

// ── run ────────────────────────────────────────────────────────────────────────

await connectDB({ retries: 2 });
try {
  const org = await getCurrentOrg();
  const admin = await User.findOne({ orgId: org._id, role: 'admin', status: 'active' }).lean();
  if (!admin) throw new Error('No active admin — run `npm run seed` first');
  const user = {
    id: String(admin._id),
    name: admin.name,
    role: 'admin',
    permissions: permissionsFor('admin'),
  };
  const ctx = {
    orgId: org._id,
    actor: { id: user.id, role: 'admin', name: admin.name, kind: 'user' },
    ip: null,
    userAgent: 'seed-demo',
    requestId: null,
  };
  const slugs = DEMO.map((d) => d.project.slug);

  if (args.reset) {
    const old = await Project.find({ orgId: org._id, slug: { $in: slugs } })
      .select('_id')
      .setOptions({ withDeleted: true })
      .lean();
    const ids = old.map((p) => p._id);
    // B4: receipts and the ledger are permanent — never wipe a project that has sales.
    const sold = await Booking.countDocuments({
      orgId: org._id,
      projectId: { $in: ids },
    }).setOptions({ withDeleted: true });
    if (sold) {
      throw new Error(
        `${sold} booking(s) exist on the demo projects — reset refused (receipts are permanent). ` +
          'Use a fresh database for a clean demo.',
      );
    }
    const plans = await FloorPlan.find({ orgId: org._id, projectId: { $in: ids } })
      .select('mediaId')
      .setOptions({ withDeleted: true })
      .lean();
    const updates = await ConstructionUpdate.find({ orgId: org._id, projectId: { $in: ids } })
      .select('photos')
      .setOptions({ withDeleted: true })
      .lean();
    await Promise.all([
      ConstructionUpdate.deleteMany({ orgId: org._id, projectId: { $in: ids } }).setOptions({
        withDeleted: true,
      }),
      Unit.deleteMany({ orgId: org._id, projectId: { $in: ids } }),
      Block.deleteMany({ orgId: org._id, projectId: { $in: ids } }),
      FloorPlan.deleteMany({ orgId: org._id, projectId: { $in: ids } }),
      Project.deleteMany({ orgId: org._id, _id: { $in: ids } }),
      // drawings: soft delete → the media purge job removes the files after 7 days
      Media.updateMany(
        {
          orgId: org._id,
          _id: {
            $in: [
              ...plans.map((p) => p.mediaId),
              ...updates.flatMap((u) => u.photos.map((ph) => ph.mediaId)),
            ],
          },
        },
        { $set: { deletedAt: new Date() } },
      ),
    ]);
    console.log(`• Reset: removed ${ids.length} demo project(s)`);
  }

  for (const d of DEMO) {
    const exists = await Project.exists({ orgId: org._id, slug: d.project.slug });
    if (exists) {
      console.log(`• ${d.project.slug} already exists — skipped (use --reset to recreate)`);
      continue;
    }
    let p = await projects.createProject({
      orgId: org._id,
      input: zProjectCreate.parse(d.project),
      ctx,
    });

    if (d.pricing) {
      const schema = p.kind === 'plot' ? zPlotPricing : zApartmentPricing;
      ({ project: p } = await projects.replacePricing({
        orgId: org._id,
        id: p.id,
        pricing: schema.parse(d.pricing),
        version: p.version,
        ctx,
      }));
    }

    const blocks = {};
    for (const b of d.blocks ?? []) {
      const { floors: _f, ...input } = b;
      blocks[b.code] = await projects.createBlock({ orgId: org._id, projectId: p.id, input, ctx });
    }

    // units
    const inputs = [];
    if (p.kind === 'apartment') {
      for (const b of d.blocks ?? []) {
        const [lo, hi] = b.floors;
        for (let floor = lo; floor <= hi; floor++) {
          for (const [position, t] of Object.entries(d.types)) {
            if (b.code === 'B' && position === 'D' && floor > 6) continue; // B is narrower up top
            inputs.push({ blockId: blocks[b.code].id, floor, position, ...t });
          }
        }
      }
    } else {
      for (const [code, roads] of Object.entries(d.roads ?? {})) {
        let n = 0;
        for (const [road, widthFt, count, katha] of roads) {
          for (let i = 0; i < count; i++) {
            n += 1;
            inputs.push({
              blockId: blocks[code].id,
              plotNo: String(n),
              road,
              roadWidthFt: widthFt,
              landArea: { value: katha, unit: 'katha' },
              dimensions:
                katha === 5
                  ? { frontFt: 50, backFt: 50, leftFt: 72, rightFt: 72 }
                  : { frontFt: 40, backFt: 40, leftFt: 54, rightFt: 54 },
              facing: road === '2' ? 'south' : 'north',
              isCorner: i === 0 || i === count - 1,
            });
          }
        }
      }
    }
    let created = [];
    if (inputs.length) {
      created = (
        await units.bulkCreateUnits({
          orgId: org._id,
          projectId: p.id,
          inputs: zUnitBulk.parse({ units: inputs }).units,
          user,
          ctx,
        })
      ).items;
    }
    const byCode = new Map(created.map((u) => [u.code, u]));
    const pick = (codes = []) => codes.map((c) => byCode.get(c)).filter(Boolean);

    for (const u of pick(d.states?.held)) {
      await units.holdUnit({
        orgId: org._id,
        unitId: u.id,
        user,
        hours: 72,
        note: 'Demo hold',
        ctx,
      });
    }
    for (const u of pick(d.states?.booked)) {
      await units.transitionUnit({
        orgId: org._id,
        unitId: u.id,
        from: ['available'],
        to: 'booked',
        ctx,
        meta: { demo: true },
      });
    }
    for (const u of pick(d.states?.blocked)) {
      await units.blockUnit({ orgId: org._id, unitId: u.id, reason: 'landowner_share', ctx });
    }

    // plans
    if (d.plans === 'apartment') {
      const a = blocks.A;
      const tf = typicalFloorDrawing();
      const mediaId = await uploadDrawing(ctx, user, tf.svg, `${p.name} typical floor`);
      const floors = Array.from({ length: 10 }, (_, i) => i + 1);
      await floorplans.createFloorPlan({
        orgId: org._id,
        projectId: p.id,
        ctx,
        input: zFloorPlanCreate.parse({
          kind: 'floor',
          blockId: a.id,
          floors,
          title: 'Typical floor — Building A',
          titleBn: 'টিপিক্যাল ফ্লোর — ভবন এ',
          mediaId,
          hotspots: [
            ...Object.entries(tf.flats).map(([pos, points]) => ({
              key: `flat-${pos}`,
              position: pos,
              points,
            })),
            { key: 'core', label: 'Lift & stair', points: tf.core },
          ],
          sortOrder: 0,
        }),
      });
      const site = sitePlanDrawing(
        [
          { key: 'bldg-a', label: 'A', rect: [160, 160, 560, 620], blockId: blocks.A.id },
          { key: 'bldg-b', label: 'B', rect: [880, 260, 520, 520], blockId: blocks.B.id },
        ],
        [[0, 860, W, 100, 'ROAD 8']],
      );
      const siteMedia = await uploadDrawing(ctx, user, site.svg, `${p.name} site plan`);
      await floorplans.createFloorPlan({
        orgId: org._id,
        projectId: p.id,
        ctx,
        input: zFloorPlanCreate.parse({
          kind: 'master',
          title: 'Site plan',
          titleBn: 'সাইট প্ল্যান',
          mediaId: siteMedia,
          hotspots: site.shapes.map((s) => ({ key: s.key, blockId: s.blockId, points: s.points })),
          sortOrder: 1,
        }),
      });
    }

    if (d.plans === 'plot') {
      // Sector 1: two rows of plots along road 1 (top) and road 2 (bottom); Sector 2 on the right.
      const cells = [];
      const s1 = created.filter((u) => u.blockId === blocks.S1.id);
      const s2 = created.filter((u) => u.blockId === blocks.S2.id);
      s1.forEach((u, i) => {
        const row = u.road === '1' ? 0 : 1;
        const col = row === 0 ? i : i - 8;
        cells.push({
          key: `plot-${u.id}`,
          label: u.plotNo,
          unitId: u.id,
          rect: [80 + col * 112, row === 0 ? 200 : 520, 104, 260],
        });
      });
      s2.forEach((u, i) =>
        cells.push({
          key: `plot-${u.id}`,
          label: u.plotNo,
          unitId: u.id,
          rect: [1060 + (i % 3) * 150, i < 3 ? 200 : 520, 140, 260],
        }),
      );
      const site = sitePlanDrawing(cells, [
        [60, 100, 920, 80, 'ROAD 1 · 25 FT'],
        [60, 800, 920, 80, 'ROAD 2 · 30 FT'],
        [1040, 100, 470, 80, 'ROAD 3 · 40 FT'],
      ]);
      const mediaId = await uploadDrawing(ctx, user, site.svg, `${p.name} layout plan`);
      await floorplans.createFloorPlan({
        orgId: org._id,
        projectId: p.id,
        ctx,
        input: zFloorPlanCreate.parse({
          kind: 'master',
          title: 'Layout plan',
          titleBn: 'লে-আউট প্ল্যান',
          mediaId,
          hotspots: site.shapes.map((s) => ({ key: s.key, unitId: s.unitId, points: s.points })),
          sortOrder: 0,
        }),
      });
    }

    // construction updates (B2b) for projects under construction
    let posted = 0;
    if (p.stage === 'ongoing' && p.kind === 'apartment') {
      const STEPS = [
        ['2026-05-20', 'Piling complete', 'পাইলিং সম্পন্ন', 15, 'piling', 0],
        [
          '2026-07-28',
          'Basement and ground floor cast',
          'বেসমেন্ট ও নিচতলার ঢালাই সম্পন্ন',
          30,
          'basement',
          1,
        ],
        [
          '2026-10-02',
          'Fourth-floor slab cast in Building A',
          'ভবন এ-তে চতুর্থ তলার ছাদ ঢালাই সম্পন্ন',
          45,
          'structure',
          4,
        ],
      ];
      for (const [date, en, bn, percent, milestone, cast] of STEPS) {
        const photo = await uploadDrawing(ctx, user, progressDrawing(cast, 10, en), en);
        await construction.createUpdate({
          orgId: org._id,
          projectId: p.id,
          input: zUpdateCreate.parse({
            date,
            title: { en, bn },
            body: {
              en: 'Work is on schedule. Our engineer checked the reinforcement before casting.',
              bn: 'কাজ সময়মতো চলছে। ঢালাইয়ের আগে আমাদের প্রকৌশলী রডের কাজ যাচাই করেছেন।',
            },
            percent,
            milestone,
            photos: [{ mediaId: photo, caption: { en, bn } }],
            published: true,
          }),
          ctx,
        });
        posted += 1;
      }
    }

    console.log(
      `✔ ${p.slug}: ${created.length} unit(s)${d.plans ? ' + plans' : ''}${posted ? ` + ${posted} construction updates` : ''}`,
    );
  }
  console.log(
    '\nDone. Open /bn/projects on the website (the API must be running for revalidation jobs).',
  );
} finally {
  await disconnectDB();
}
