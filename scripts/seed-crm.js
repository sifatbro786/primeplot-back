// Demo CRM data for development: staff, buyer + landowner leads in every stage, timelines,
// tasks (overdue / today / upcoming + one that reminds in ~3 minutes), notifications and an SMS
// log — so every F4 screen can be tested without typing data by hand.
//
//   npm run seed:crm             # create (skipped when demo leads already exist)
//   npm run seed:crm -- --reset  # delete the demo leads/tasks/notifications/SMS first, then create
//   npm run seed:crm -- --password "…"   # password for the demo staff (else one is generated)
//
// Demo leads are recognised by their phone numbers (+8801999xxxxxx, and +447700900xxx — a UK
// range reserved for fiction), so --reset never touches real leads. Demo staff accounts are kept
// on --reset (users are never hard-deleted). Times are relative to "now", so re-run with --reset
// to get fresh "overdue / today / SLA" states. Needs `npm run seed`. Never run it on production.
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '#config/env.js';
import { connectDB, disconnectDB } from '#config/db.js';
import { hashPassword } from '#shared/crypto/password.js';
import { rankBetween } from '#shared/utils/rank.js';
import { landArea } from '#shared/utils/area.js';
import { analyzeSms } from '#integrations/sms/segments.js';
import { getCurrentOrg } from '#modules/organizations/organization.service.js';
import { User } from '#modules/users/user.model.js';
import { Project } from '#modules/projects/project.model.js';
import { Lead, openKeyOf } from '#modules/leads/lead.model.js';
import { LeadActivity } from '#modules/leads/leadActivity.model.js';
import { LeadTask } from '#modules/leads/leadTask.model.js';
import { getSettings, getStages } from '#modules/leads/pipeline.service.js';
import { slaDueAt } from '#modules/leads/sla.js';
import { renderAutoReply, companyName } from '#modules/leads/autoReplyText.js';
import { Notification } from '#modules/notifications/notification.model.js';
import { SmsMessage } from '#modules/sms/smsMessage.model.js';
import { assertPasswordAllowed, zPassword } from '#modules/auth/passwordPolicy.js';

const { values: args } = parseArgs({
  options: {
    reset: { type: 'boolean', default: false },
    password: { type: 'string' },
  },
});

if (env.isProd) {
  console.error('\n✖ seed:crm refuses to run with NODE_ENV=production\n');
  process.exit(1);
}

const { ObjectId } = mongoose.Types;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TK = 100;
const LAKH = 100_000 * TK;
const NOW = new Date();
const ago = (ms) => new Date(NOW.getTime() - ms);
const ahead = (ms) => new Date(NOW.getTime() + ms);
const DEMO_PHONE = /^\+(8801999|447700900)/;
const bdPhone = (n) => `+8801999${String(n).padStart(6, '0')}`;

// Deterministic randomness, so two runs produce the same data.
let seed = 20261014;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

/** End of today in Dhaka (UTC+6) minus `margin`, but never earlier than now + 10 min. */
function laterToday(preferMs) {
  const local = NOW.getTime() + 6 * HOUR;
  const endUtc = Math.floor(local / DAY) * DAY + DAY - 6 * HOUR;
  const t = Math.min(NOW.getTime() + preferMs, endUtc - 10 * MIN);
  return new Date(Math.max(t, NOW.getTime() + 10 * MIN));
}
/** Tomorrow (Dhaka) at hh:mm local. */
function tomorrowAt(h, m = 0) {
  const local = NOW.getTime() + 6 * HOUR;
  const startUtc = Math.floor(local / DAY) * DAY + DAY - 6 * HOUR;
  return new Date(startUtc + h * HOUR + m * MIN);
}

/** Validate through the Mongoose schema, then insert raw so back-dated timestamps survive. */
async function rawInsert(Model, objs) {
  const docs = [];
  for (const o of objs) {
    const d = new Model(o);
    await d.validate();
    docs.push(d.toObject({ depopulate: true }));
  }
  if (docs.length) await Model.collection.insertMany(docs);
  return docs;
}

// ── demo content ────────────────────────────────────────────────────────────────

const STAFF = [
  { key: 'nadia', name: 'Nadia Islam', email: 'nadia@demo.primeplot.test', role: 'sales_manager' },
  { key: 'sumi', name: 'Sumi Akter', email: 'sumi@demo.primeplot.test', role: 'sales_executive' },
  {
    key: 'rakib',
    name: 'Rakib Hasan',
    email: 'rakib@demo.primeplot.test',
    role: 'sales_executive',
  },
];

const FIRST = [
  'Rashed',
  'Tahmina',
  'Arif',
  'Shirin',
  'Kamrul',
  'Rumana',
  'Sohel',
  'Nasrin',
  'Jahid',
  'Lima',
  'Fahim',
  'Sharmin',
  'Zahid',
  'Mousumi',
  'Hasib',
  'Tania',
  'Rubel',
  'Shapla',
  'Anis',
  'Mitu',
];
const LAST = [
  'Hossain',
  'Rahman',
  'Ahmed',
  'Islam',
  'Chowdhury',
  'Akter',
  'Uddin',
  'Sarkar',
  'Mia',
  'Begum',
  'Talukder',
  'Khan',
];
const BN_NAMES = ['মোহাম্মদ সেলিম', 'রাশিদা খাতুন', 'আব্দুল মান্নান', 'নাজমা বেগম', 'শফিকুর রহমান'];
const MESSAGES = [
  '3 bed, south facing if possible. Need loan support.',
  'দক্ষিণমুখী ফ্ল্যাট আছে? কিস্তিতে দেওয়া যাবে?',
  'Looking for a ready flat near my office. Please call after 6 pm.',
  'হ্যান্ডওভার কবে? পার্কিং আলাদা দাম কি?',
  'Price list please. Interested in 1450 sqft.',
  null,
];

/**
 * Named scenarios — the ones the test guide refers to. `stage`: number = nth open stage,
 * 'won' / 'lost'. Owners: admin | nadia | sumi | rakib | null (unassigned).
 */
function buyerScenarios(p) {
  return [
    {
      ref: 'slaRunning',
      name: 'Tanvir Ahmed',
      phone: bdPhone(1),
      source: 'website',
      stage: 0,
      owner: null,
      createdAgo: 8 * MIN,
      page: '/bn/projects/lake-view-residency',
      project: p.apartment,
      bedrooms: 3,
      budget: [90, 120],
      message: 'Lake View-এ ৩ বেডরুম, দক্ষিণমুখী — দাম জানাবেন।',
      autoReply: 'sent',
    },
    {
      ref: 'slaBreached',
      name: 'Farzana Akter',
      phone: bdPhone(2),
      source: 'facebook',
      stage: 0,
      owner: 'sumi',
      createdAgo: 1 * DAY,
      breach: true,
      formName: 'Lake View — October leads',
      project: p.apartment,
      bedrooms: 3,
      budget: [80, 100],
      autoReply: 'sent',
      meta: true,
    },
    {
      ref: 'slaEscalated',
      name: 'Mahmudul Hasan',
      phone: bdPhone(3),
      source: 'website',
      stage: 0,
      owner: 'admin',
      createdAgo: 2 * DAY,
      breach: true,
      escalated: true,
      page: '/en/projects',
      project: p.plot,
      message: 'Interested in a 3 katha plot near the main road.',
      autoReply: 'sent',
    },
    {
      ref: 'overdueTask',
      name: 'Nusrat Jahan',
      phone: bdPhone(4),
      source: 'instagram',
      stage: 1,
      owner: 'admin',
      createdAgo: 3 * DAY,
      respondedAfter: 12 * MIN,
      project: p.apartment,
      bedrooms: 3,
      budget: [100, 130],
      calls: [['call_back', 'Asked to call back in the evening — wants south facing.']],
      tasks: [{ title: 'Call back — south-facing options', type: 'call', due: ago(3 * HOUR) }],
    },
    {
      ref: 'todayTask',
      name: 'Shafiqul Islam',
      phone: bdPhone(5),
      source: 'phone',
      stage: 1,
      owner: 'admin',
      createdAgo: 2 * DAY,
      respondedAfter: 0,
      project: p.apartment,
      bedrooms: 2,
      budget: [60, 75],
      calls: [['connected', 'Wants the price list and payment schedule by email.']],
      tasks: [
        {
          title: 'Send price list + payment schedule',
          type: 'follow_up',
          due: laterToday(2 * HOUR),
        },
        {
          title: 'Reminder test — bell rings in ~3 minutes',
          type: 'call',
          due: ahead(18 * MIN),
          remind: 15,
        },
      ],
    },
    {
      ref: 'visit',
      name: 'Sadia Rahman',
      phone: bdPhone(6),
      source: 'referral',
      referrer: 'Kamal Uddin (A-3B owner)',
      stage: 2,
      owner: 'sumi',
      createdAgo: 6 * DAY,
      respondedAfter: 20 * MIN,
      project: p.apartment,
      bedrooms: 4,
      budget: [140, 170],
      calls: [['connected', 'Site visit fixed for tomorrow 11 am with family.']],
      tasks: [{ title: 'Site visit — Lake View, Building A', type: 'visit', due: tomorrowAt(11) }],
    },
    {
      ref: 'visited',
      name: 'Imran Khan',
      phone: bdPhone(7),
      source: 'walk_in',
      stage: 3,
      owner: 'admin',
      createdAgo: 9 * DAY,
      respondedAfter: 0,
      project: p.apartment,
      bedrooms: 3,
      budget: [95, 110],
      notes: ['Visited with wife. Liked A-8A, worried about the handover date.'],
      tasks: [
        { title: 'Share construction progress photos', type: 'follow_up', due: ahead(2 * DAY) },
      ],
    },
    {
      ref: 'vip',
      name: 'Mithila Das',
      phone: bdPhone(8),
      source: 'website',
      stage: 4,
      owner: 'admin',
      tags: ['vip'],
      createdAgo: 14 * DAY,
      respondedAfter: 25 * MIN,
      page: '/en/projects/lake-view-residency',
      project: p.apartment,
      bedrooms: 4,
      budget: [180, 220],
      autoReply: 'sent',
      calls: [['connected', 'Negotiating 2% discount + one extra parking.']],
      tasks: [
        { title: 'Meeting with MD — final price', type: 'meeting', due: ahead(2 * DAY + 3 * HOUR) },
      ],
    },
    {
      ref: 'repeat',
      name: 'Abdul Karim',
      phone: bdPhone(9),
      source: 'facebook',
      stage: 1,
      owner: 'rakib',
      createdAgo: 12 * DAY,
      respondedAfter: 40 * MIN,
      formName: 'Uttara Green Court — ready flats',
      project: p.ready ?? p.apartment,
      enquiries: 3,
      meta: true,
      autoReply: 'sent',
      calls: [
        ['no_answer', null],
        ['busy', null],
      ],
    },
    {
      ref: 'won',
      name: 'Rafiq Chowdhury',
      phone: bdPhone(10),
      source: 'referral',
      referrer: 'Office walk-in',
      stage: 'won',
      owner: 'admin',
      createdAgo: 20 * DAY,
      closedAgo: 3 * DAY,
      respondedAfter: 0,
      project: p.apartment,
      bedrooms: 3,
      budget: [100, 115],
      calls: [['connected', 'Booking money paid.']],
    },
    {
      ref: 'lost',
      name: 'Jannatul Ferdous',
      phone: bdPhone(11),
      source: 'website',
      stage: 'lost',
      owner: 'sumi',
      lostReason: 'price',
      lostNote: 'Budget is 20 lakh below our rate.',
      createdAgo: 18 * DAY,
      closedAgo: 5 * DAY,
      respondedAfter: 30 * MIN,
      project: p.apartment,
      budget: [60, 70],
      autoReply: 'sent',
    },
    {
      ref: 'mergeA',
      name: 'Habibur Rahman',
      phone: bdPhone(12),
      source: 'website',
      stage: 0,
      owner: 'admin',
      createdAgo: 4 * DAY,
      respondedAfter: 15 * MIN,
      page: '/bn/projects/lake-view-residency',
      project: p.apartment,
      email: 'habib.rahman@example.com',
      autoReply: 'sent',
      calls: [['no_answer', null]],
    },
    {
      ref: 'mergeB',
      name: 'Habibur Rahman',
      phone: bdPhone(13),
      source: 'phone',
      stage: 1,
      owner: 'admin',
      createdAgo: 2 * DAY,
      respondedAfter: 0,
      bedrooms: 3,
      calls: [['connected', 'Called from his office number — same person as the website enquiry.']],
    },
    {
      ref: 'unassigned',
      name: 'Ayesha Siddika',
      phone: bdPhone(14),
      source: 'website',
      stage: 0,
      owner: null,
      createdAgo: 3 * HOUR,
      page: '/bn/projects',
      project: p.plot,
      message: 'প্লটের কিস্তি সুবিধা আছে?',
      autoReply: 'sent',
    },
    {
      ref: 'nrb',
      name: 'Shahriar Kabir (UK)',
      phone: '+447700900123',
      source: 'website',
      stage: 1,
      owner: 'rakib',
      createdAgo: 5 * DAY,
      respondedAfter: 3 * HOUR,
      page: '/en/projects/lake-view-residency',
      project: p.apartment,
      email: 'shahriar.k@example.co.uk',
      message: 'Living in London, buying for my parents. WhatsApp preferred.',
      autoReply: 'skipped',
    },
  ];
}

function buyerFillers(p, startPhone) {
  const out = [];
  const plan = [
    ...Array(48).fill(0), // the "New" column gets > 50 cards → tests "show more" (with the scenarios)
    ...Array(6).fill(1),
    ...Array(4).fill(2),
    ...Array(3).fill(3),
    ...Array(2).fill(4),
    'won',
    'won',
    'lost',
    'lost',
    'lost',
  ];
  const owners = ['admin', 'admin', 'sumi', 'rakib', 'sumi', null];
  const sources = [
    'website',
    'website',
    'facebook',
    'facebook',
    'instagram',
    'phone',
    'walk_in',
    'manual',
  ];
  plan.forEach((stage, i) => {
    const bn = i % 9 === 4;
    const name = bn ? BN_NAMES[i % BN_NAMES.length] : `${FIRST[i % FIRST.length]} ${pick(LAST)}`;
    const source = pick(sources);
    const project = pick(
      [p.apartment, p.apartment, p.plot, p.ready, null].filter((x) => x !== undefined),
    );
    const min = between(50, 120);
    out.push({
      name,
      phone: bdPhone(startPhone + i),
      source,
      stage,
      owner: pick(owners),
      createdAgo: between(1, 26) * DAY + between(0, 600) * MIN,
      respondedAfter: between(5, 45) * MIN,
      page:
        source === 'website'
          ? pick(['/bn/projects', '/bn/projects/lake-view-residency', '/en/projects'])
          : null,
      formName: source === 'facebook' ? 'Lake View — October leads' : null,
      meta: source === 'facebook',
      project,
      bedrooms: project ? pick([2, 3, 3, 4]) : null,
      budget: project ? [min, min + between(10, 40)] : null,
      message: source === 'website' ? pick(MESSAGES) : null,
      autoReply: ['website', 'facebook'].includes(source)
        ? i % 13 === 7
          ? 'failed'
          : 'sent'
        : null,
      calls: [[pick(['no_answer', 'connected', 'busy', 'switched_off']), null]],
      lostReason:
        stage === 'lost' ? pick(['budget', 'location', 'bought_elsewhere', 'unreachable']) : null,
      closedAgo: stage === 'won' || stage === 'lost' ? between(1, 20) * DAY : null,
      doneTask: i % 5 === 0,
    });
  });
  return out;
}

function landownerScenarios(startPhone) {
  const L = (value, unit) => landArea(value, unit);
  return [
    {
      ref: 'landNew',
      name: 'Abdur Rauf',
      phone: bdPhone(startPhone),
      source: 'website',
      stage: 0,
      owner: null,
      createdAgo: 30 * MIN,
      page: '/bn/landowners',
      autoReply: 'sent',
      message: 'বাড়ির পাশে আমাদের ৫ কাঠা জমি, ডেভেলপারকে দিতে চাই।',
      land: {
        location: 'Mirpur 12, Block C, Road 5',
        area: L(5, 'katha'),
        roadWidthFt: 20,
        ownership: 'inherited',
        mutation: 'done',
        expectedShare: '55:45',
      },
    },
    {
      name: 'Golam Mostafa',
      phone: bdPhone(startPhone + 1),
      source: 'facebook',
      stage: 1,
      owner: 'nadia',
      createdAgo: 4 * DAY,
      respondedAfter: 35 * MIN,
      formName: 'Landowner JV — Dhaka',
      meta: true,
      autoReply: 'sent',
      calls: [['connected', 'Three brothers own it jointly; all agree to JV.']],
      land: {
        location: 'Uttara Sector 10, Road 14',
        area: L(8, 'katha'),
        roadWidthFt: 30,
        ownership: 'joint',
        mutation: 'pending',
        expectedShare: '50:50',
      },
      tasks: [
        { title: 'Collect deed copies (CS/RS/BS)', type: 'follow_up', due: laterToday(4 * HOUR) },
      ],
    },
    {
      name: 'Selina Parvin',
      phone: bdPhone(startPhone + 2),
      source: 'referral',
      referrer: 'Architect Tareq',
      stage: 2,
      owner: 'admin',
      createdAgo: 10 * DAY,
      respondedAfter: 0,
      land: {
        location: 'Bashundhara Block N, Road 7',
        area: L(10, 'katha'),
        roadWidthFt: 40,
        ownership: 'sole',
        mutation: 'done',
        expectedShare: '60:40',
      },
      notes: ['Land inspected — corner plot, no encroachment.'],
      tasks: [{ title: 'Soil test quotation', type: 'other', due: ahead(3 * DAY) }],
    },
    {
      name: 'Md. Nurul Amin',
      phone: bdPhone(startPhone + 3),
      source: 'phone',
      stage: 3,
      owner: 'nadia',
      createdAgo: 16 * DAY,
      respondedAfter: 0,
      land: {
        location: 'Mohammadpur, Japan Garden City side',
        area: L(6.5, 'katha'),
        roadWidthFt: 25,
        ownership: 'company',
        mutation: 'done',
        expectedShare: '55% owner',
      },
      notes: ['Lawyer is checking the mutation khatian and tax receipts.'],
    },
    {
      name: 'Rokeya Sultana',
      phone: bdPhone(startPhone + 4),
      source: 'website',
      stage: 4,
      owner: 'admin',
      createdAgo: 25 * DAY,
      respondedAfter: 50 * MIN,
      page: '/en/landowners',
      autoReply: 'sent',
      land: {
        location: 'Purbachal Sector 1',
        area: L(33, 'decimal'),
        roadWidthFt: 60,
        ownership: 'sole',
        mutation: 'done',
        expectedShare: '50:50 + signing money',
      },
      tasks: [{ title: 'Draft JV agreement for review', type: 'meeting', due: ago(1 * DAY) }],
    },
    {
      name: 'Kazi Anwar Hossain',
      phone: bdPhone(startPhone + 5),
      source: 'referral',
      referrer: 'Existing landowner',
      stage: 'won',
      owner: 'nadia',
      createdAgo: 40 * DAY,
      closedAgo: 6 * DAY,
      respondedAfter: 0,
      land: {
        location: 'Aftabnagar, Block F',
        area: L(7, 'katha'),
        roadWidthFt: 30,
        ownership: 'inherited',
        mutation: 'done',
        expectedShare: '55:45',
      },
    },
    {
      name: 'Monowar Hossain',
      phone: bdPhone(startPhone + 6),
      source: 'facebook',
      stage: 'lost',
      owner: 'admin',
      lostReason: 'location',
      createdAgo: 22 * DAY,
      closedAgo: 9 * DAY,
      respondedAfter: 20 * MIN,
      meta: true,
      formName: 'Landowner JV — Dhaka',
      autoReply: 'sent',
      land: {
        location: 'Savar, 2 km off the highway',
        area: L(20, 'decimal'),
        roadWidthFt: 12,
        ownership: 'joint',
        mutation: 'not_started',
        expectedShare: null,
      },
    },
  ];
}

// ── run ─────────────────────────────────────────────────────────────────────────

await connectDB({ retries: 2 });
try {
  const org = await getCurrentOrg();
  const orgId = org._id;

  if (args.reset) {
    const ids = await Lead.find({ orgId, phone: DEMO_PHONE })
      .setOptions({ withDeleted: true })
      .distinct('_id');
    const sids = ids.map(String);
    const r = await Promise.all([
      Lead.deleteMany({ orgId, _id: { $in: ids } }).setOptions({ withDeleted: true }),
      LeadActivity.deleteMany({ orgId, leadId: { $in: ids } }),
      LeadTask.deleteMany({ orgId, leadId: { $in: ids } }).setOptions({ withDeleted: true }),
      Notification.deleteMany({
        orgId,
        $or: [{ 'data.leadId': { $in: sids } }, { 'data.demo': true }],
      }),
      SmsMessage.deleteMany({ orgId, $or: [{ leadId: { $in: ids } }, { to: DEMO_PHONE }] }),
    ]);
    console.log(
      `✔ Reset: ${r[0].deletedCount} lead(s), ${r[1].deletedCount} activities, ${r[2].deletedCount} task(s), ` +
        `${r[3].deletedCount} notification(s), ${r[4].deletedCount} SMS`,
    );
  } else if (await Lead.exists({ orgId, phone: DEMO_PHONE }).setOptions({ withDeleted: true })) {
    console.log(
      '• Demo leads already exist — nothing created. Use `npm run seed:crm -- --reset` to recreate.',
    );
    process.exitCode = 0;
    throw Object.assign(new Error('skip'), { skip: true });
  }

  // Staff
  const admin = await User.findOne({ orgId, role: 'admin', status: 'active' })
    .sort({ createdAt: 1 })
    .lean();
  if (!admin) throw new Error('No active admin — run `npm run seed` first.');
  const users = { admin };
  let password = args.password;
  let generated = false;
  for (const s of STAFF) {
    let u = await User.findOne({ orgId, email: s.email }).lean();
    if (!u) {
      if (!password) {
        password = randomBytes(9).toString('base64url');
        generated = true;
      }
      zPassword.parse(password);
      assertPasswordAllowed(password, { email: s.email, name: s.name });
      u = (
        await User.create({
          orgId,
          name: s.name,
          email: s.email,
          role: s.role,
          status: 'active',
          locale: 'bn',
          passwordHash: await hashPassword(password),
          passwordChangedAt: NOW,
        })
      ).toObject();
      console.log(`✔ Staff created: ${s.email} (${s.role})`);
    }
    users[s.key] = u;
  }
  const uid = (key) => (key ? users[key]._id : null);

  // Projects (optional — leads work without them)
  const projects = await Project.find({ orgId }).select('kind stage slug').lean();
  const p = {
    apartment:
      projects.find((x) => x.kind === 'apartment' && x.stage !== 'ready')?._id ??
      projects.find((x) => x.kind === 'apartment')?._id ??
      null,
    ready: projects.find((x) => x.kind === 'apartment' && x.stage === 'ready')?._id,
    plot: projects.find((x) => x.kind === 'plot')?._id ?? null,
  };

  const settings = await getSettings(orgId);
  const stagesByType = {
    buyer: await getStages(orgId, 'buyer'),
    landowner: await getStages(orgId, 'landowner'),
  };
  const stageFor = (type, ref) => {
    const list = stagesByType[type];
    if (ref === 'won') return list.find((s) => s.kind === 'won');
    if (ref === 'lost') return list.find((s) => s.kind === 'lost');
    const open = list.filter((s) => s.kind === 'open');
    return open[Math.min(ref, open.length - 1)];
  };
  const openPath = (type, stage) => {
    const open = stagesByType[type].filter((s) => s.kind === 'open');
    if (stage.kind === 'open')
      return open.slice(0, open.findIndex((s) => String(s._id) === String(stage._id)) + 1);
    return [...open.slice(0, stage.kind === 'won' ? open.length : between(1, 3)), stage];
  };

  const specs = [
    ...buyerScenarios(p).map((s) => ({ ...s, type: 'buyer' })),
    ...buyerFillers(p, 100).map((s) => ({ ...s, type: 'buyer' })),
    ...landownerScenarios(500).map((s) => ({ ...s, type: 'landowner' })),
  ];

  const leads = [];
  const activities = [];
  const tasks = [];
  const sms = [];
  const refs = {};
  const act = (lead, type, at, extra = {}) =>
    activities.push({ orgId, leadId: lead._id, type, at, createdAt: at, updatedAt: at, ...extra });

  for (const s of specs) {
    const _id = new ObjectId();
    const stage = stageFor(s.type, s.stage);
    let createdAt = ago(s.createdAgo);
    let due = slaDueAt(createdAt, settings.sla);
    if (s.breach && due) {
      // Push the arrival back until the first-response time has clearly passed.
      for (let i = 0; i < 6 && due > ago(10 * MIN); i += 1) {
        createdAt = new Date(createdAt.getTime() - DAY);
        due = slaDueAt(createdAt, settings.sla);
      }
    }
    const responded =
      s.respondedAfter != null ? new Date(createdAt.getTime() + s.respondedAfter) : null;
    const closedAt = s.closedAgo ? ago(s.closedAgo) : null;
    const owner = uid(s.owner);
    const staffCreated = ['manual', 'walk_in', 'phone', 'referral'].includes(s.source);
    const createdBy = staffCreated ? (owner ?? admin._id) : null;
    const lead = {
      _id,
      orgId,
      __v: 0,
      type: s.type,
      name: s.name,
      phone: s.phone,
      email: s.email ?? null,
      source: s.source,
      sourceDetail: {
        page: s.page ?? null,
        formName: s.formName ?? null,
        referrer: s.referrer ?? null,
      },
      message: s.message ?? null,
      interest:
        s.type === 'buyer'
          ? {
              projectId: s.project ?? null,
              bedrooms: s.bedrooms ?? null,
              budgetMin: s.budget ? s.budget[0] * LAKH : null,
              budgetMax: s.budget ? s.budget[1] * LAKH : null,
            }
          : undefined,
      land: s.land ?? undefined,
      stageId: stage._id,
      status: stage.kind,
      rank: 'a0',
      lostReason: stage.kind === 'lost' ? (s.lostReason ?? 'other') : null,
      lostNote: s.lostNote ?? null,
      closedAt: stage.kind === 'open' ? null : closedAt,
      assigneeId: owner,
      assignedAt: owner ? new Date(createdAt.getTime() + MIN) : null,
      slaDueAt: due,
      firstResponseAt: responded,
      slaEscalatedAt: s.escalated && due ? new Date(due.getTime() + 2 * MIN) : null,
      enquiryCount: s.enquiries ?? 1,
      tags: s.tags ?? [],
      createdBy,
      openKey: stage.kind === 'open' ? openKeyOf(s.type, s.phone) : null,
      createdAt,
      updatedAt: createdAt,
    };

    // Timeline
    let t = createdAt.getTime();
    const step = (ms) => {
      t = Math.min(t + ms, (closedAt ?? NOW).getTime() - MIN);
      return new Date(t);
    };
    act(lead, 'created', createdAt, {
      actorId: createdBy,
      meta: { source: s.source, page: s.page ?? null },
    });
    if (s.meta) {
      act(lead, 'meta_lead', createdAt, {
        meta: {
          leadgenId: String(9_000_000_000 + between(1, 99_999_999)),
          formId: '7781234500',
          formName: s.formName,
          adName: 'October carousel',
          campaign: 'Dhaka homes — Q4',
          organic: false,
          duplicate: false,
        },
      });
    }
    if (owner)
      act(lead, 'assigned', new Date(createdAt.getTime() + MIN), {
        actorId: staffCreated ? createdBy : null,
        meta: { to: String(owner), auto: !staffCreated },
      });
    if (s.autoReply) {
      const locale = s.page?.startsWith('/en') || s.phone.startsWith('+44') ? 'en' : 'bn';
      const text = renderAutoReply(
        locale === 'bn' ? settings.autoReply.textBn : settings.autoReply.textEn,
        { name: s.name, company: companyName(org, locale) },
      );
      const a = analyzeSms(text);
      const smsId = new ObjectId();
      const at = new Date(createdAt.getTime() + 40_000);
      const failed = s.autoReply === 'failed';
      sms.push({
        _id: smsId,
        orgId,
        to: s.phone,
        body: text,
        locale,
        purpose: 'lead_auto_reply',
        leadId: _id,
        encoding: a.encoding,
        segments: a.segments,
        costPoisha:
          env.SMS_COST_PER_SEGMENT_POISHA != null && s.autoReply === 'sent'
            ? a.segments * env.SMS_COST_PER_SEGMENT_POISHA
            : null,
        driver: env.SMS_DRIVER,
        status: s.autoReply,
        attempts: s.autoReply === 'skipped' ? 0 : failed ? 4 : 1,
        error: failed
          ? { code: 'INSUFFICIENT_BALANCE', message: 'Gateway balance is too low' }
          : s.autoReply === 'skipped'
            ? {
                code: 'UNSUPPORTED_DESTINATION',
                message: 'Bangladeshi gateways cannot reach foreign numbers',
              }
            : undefined,
        sentAt: s.autoReply === 'sent' ? at : null,
        failedAt: failed ? at : null,
        createdAt: new Date(createdAt.getTime() + 5_000),
        updatedAt: at,
      });
      act(lead, 'auto_reply', at, {
        body: text,
        meta: {
          smsId: String(smsId),
          status: s.autoReply,
          segments: a.segments,
          errorCode: failed
            ? 'INSUFFICIENT_BALANCE'
            : s.autoReply === 'skipped'
              ? 'UNSUPPORTED_DESTINATION'
              : null,
        },
      });
    }
    for (let e = 2; e <= (s.enquiries ?? 1); e += 1) {
      const at = step(between(1, 3) * DAY);
      act(lead, 'enquiry', at, {
        body: e === 2 ? 'Is the 2nd floor still available?' : null,
        meta: { source: s.source, page: null, projectId: s.project ? String(s.project) : null },
      });
      lead.lastEnquiryAt = at;
    }
    if (s.escalated && due) {
      act(lead, 'sla_escalated', lead.slaEscalatedAt, { meta: { dueAt: due, notified: 2 } });
    }
    if (responded) {
      t = responded.getTime();
      const calls = s.calls ?? [['connected', null]];
      calls.forEach(([outcome, body], i) => {
        const at = i === 0 ? responded : step(between(2, 20) * HOUR);
        act(lead, 'call', at, {
          actorId: owner ?? admin._id,
          outcome,
          body,
          durationSec: outcome === 'connected' || outcome === 'call_back' ? between(60, 420) : null,
        });
      });
      // Stage changes along the pipeline
      const path = openPath(s.type, stage);
      for (let i = 1; i < path.length; i += 1) {
        const at = path[i].kind === 'open' ? step(between(3, 30) * HOUR) : closedAt;
        act(lead, 'stage_change', at, {
          actorId: owner ?? admin._id,
          body: path[i].kind === 'lost' ? (s.lostNote ?? null) : null,
          meta: {
            from: String(path[i - 1]._id),
            to: String(path[i]._id),
            status: path[i].kind,
            lostReason: path[i].kind === 'lost' ? lead.lostReason : null,
          },
        });
      }
      for (const note of s.notes ?? [])
        act(lead, 'note', step(between(1, 6) * HOUR), { actorId: owner ?? admin._id, body: note });
      if (s.doneTask) {
        const tid = new ObjectId();
        const due2 = step(DAY);
        tasks.push({
          _id: tid,
          orgId,
          __v: 0,
          leadId: _id,
          assigneeId: owner ?? admin._id,
          title: 'Send brochure on WhatsApp',
          type: 'follow_up',
          dueAt: due2,
          remindAt: new Date(due2.getTime() - 15 * MIN),
          remindedAt: due2,
          status: 'done',
          doneAt: due2,
          doneBy: owner ?? admin._id,
          createdBy: owner ?? admin._id,
          createdAt: new Date(due2.getTime() - 3 * HOUR),
          updatedAt: due2,
        });
        act(lead, 'task_done', due2, {
          actorId: owner ?? admin._id,
          body: 'Send brochure on WhatsApp',
          meta: { taskId: String(tid) },
        });
      }
    }
    // Open tasks (only on open leads)
    if (stage.kind === 'open') {
      for (const task of s.tasks ?? []) {
        const tid = new ObjectId();
        const at = new Date(
          Math.min(
            NOW.getTime() - 5 * MIN,
            Math.max(createdAt.getTime() + 10 * MIN, task.due.getTime() - 2 * DAY),
          ),
        );
        const remind = task.remind ?? 15;
        const remindAt = new Date(task.due.getTime() - remind * MIN);
        const assignee = owner ?? admin._id;
        tasks.push({
          _id: tid,
          orgId,
          __v: 0,
          leadId: _id,
          assigneeId: assignee,
          title: task.title,
          type: task.type,
          dueAt: task.due,
          remindAt,
          remindedAt: remindAt < NOW ? remindAt : null,
          status: 'open',
          createdBy: assignee,
          createdAt: at,
          updatedAt: at,
        });
        act(lead, 'task_created', at, {
          actorId: assignee,
          body: task.title,
          meta: { taskId: String(tid), dueAt: task.due },
        });
      }
    }
    const own = activities.filter((a) => a.leadId === _id);
    const contact = own.filter((a) => ['call', 'note', 'stage_change'].includes(a.type));
    lead.lastActivityAt = contact.length
      ? new Date(Math.max(...contact.map((a) => a.at.getTime())))
      : null;
    const open = tasks.filter((x) => x.leadId === _id && x.status === 'open');
    lead.nextFollowUpAt = open.length
      ? new Date(Math.min(...open.map((x) => x.dueAt.getTime())))
      : null;
    lead.updatedAt = new Date(Math.max(createdAt.getTime(), lead.lastActivityAt?.getTime() ?? 0));
    if (s.ref) refs[s.ref] = lead;
    leads.push(lead);
  }

  // Kanban ranks: newest on top, demo cards after any real cards in that column.
  const byStage = new Map();
  for (const l of leads) {
    const k = String(l.stageId);
    if (!byStage.has(k)) byStage.set(k, []);
    byStage.get(k).push(l);
  }
  for (const [stageId, list] of byStage) {
    const last = await Lead.findOne({ orgId, stageId }).sort({ rank: -1 }).select('rank').lean();
    let prev = last?.rank ?? null;
    list.sort((a, b) => b.createdAt - a.createdAt);
    for (const l of list) {
      l.rank = rankBetween(prev, null);
      prev = l.rank;
    }
  }

  // Test SMS from the Integrations page, one sent, one failed
  for (const [i, status] of ['sent', 'failed'].entries()) {
    const body = 'PrimePlot test SMS — if you got this, SMS works.';
    const a = analyzeSms(body);
    const at = ago((i + 1) * 26 * HOUR);
    sms.push({
      orgId,
      to: bdPhone(900 + i),
      body,
      locale: null,
      purpose: 'test',
      encoding: a.encoding,
      segments: a.segments,
      driver: env.SMS_DRIVER,
      status,
      attempts: status === 'failed' ? 4 : 1,
      error:
        status === 'failed'
          ? { code: 'SENDER_ID_INVALID', message: 'Sender ID is not approved for this account' }
          : undefined,
      sentAt: status === 'sent' ? at : null,
      failedAt: status === 'failed' ? at : null,
      createdBy: admin._id,
      createdAt: at,
      updatedAt: at,
    });
  }

  // Notifications for the admin (+ a few for the demo staff)
  const N = (userId, type, data, when, read = false) => {
    const createdAt = when ?? ago(HOUR);
    return {
      orgId,
      userId,
      type,
      data: { ...data, demo: true },
      readAt: read ? new Date(createdAt.getTime() + 10 * MIN) : null,
      createdAt,
      updatedAt: createdAt,
    };
  };
  const L = (l) => ({ leadId: String(l._id), name: l.name, type: l.type, source: l.source });
  const notifications = [
    N(admin._id, 'lead.unassigned', L(refs.slaRunning), refs.slaRunning.createdAt),
    N(admin._id, 'lead.unassigned', L(refs.unassigned), refs.unassigned.createdAt),
    N(
      admin._id,
      'task.due',
      {
        taskId: String(tasks.find((x) => String(x.leadId) === String(refs.overdueTask._id))._id),
        leadId: String(refs.overdueTask._id),
        title: 'Call back — south-facing options',
        dueAt: ago(3 * HOUR),
        leadName: refs.overdueTask.name,
        leadPhone: refs.overdueTask.phone,
      },
      ago(3 * HOUR + 15 * MIN),
    ),
    N(
      admin._id,
      'lead.sla_breached',
      {
        ...L(refs.slaEscalated),
        assigneeId: String(admin._id),
        assigneeName: admin.name,
        slaDueAt: refs.slaEscalated.slaDueAt,
      },
      refs.slaEscalated.slaEscalatedAt,
    ),
    N(admin._id, 'lead.enquiry', { ...L(refs.repeat) }, ago(2 * DAY)),
    N(admin._id, 'lead.assigned', { ...L(refs.vip), by: users.nadia.name }, ago(13 * DAY), true),
    N(
      admin._id,
      'integration.error',
      { integration: 'sms', code: 'INSUFFICIENT_BALANCE', message: 'Gateway balance is too low' },
      ago(5 * HOUR),
    ),
    N(
      admin._id,
      'integration.error',
      {
        integration: 'meta',
        code: 'META_TOKEN_INVALID',
        message: 'Error validating access token: session has expired',
      },
      ago(3 * DAY),
      true,
    ),
    N(users.sumi._id, 'lead.assigned', { ...L(refs.slaBreached) }, refs.slaBreached.createdAt),
    N(
      users.nadia._id,
      'lead.sla_breached',
      {
        ...L(refs.slaEscalated),
        assigneeId: String(admin._id),
        assigneeName: admin.name,
        slaDueAt: refs.slaEscalated.slaDueAt,
      },
      refs.slaEscalated.slaEscalatedAt,
    ),
  ];

  await rawInsert(Lead, leads);
  await rawInsert(LeadActivity, activities);
  await rawInsert(LeadTask, tasks);
  await rawInsert(SmsMessage, sms);
  await rawInsert(Notification, notifications);

  const count = (type) => leads.filter((l) => l.type === type).length;
  console.log(
    `✔ ${count('buyer')} buyer + ${count('landowner')} landowner leads, ${activities.length} timeline entries, ` +
      `${tasks.length} task(s), ${notifications.length} notification(s), ${sms.length} SMS`,
  );
  if (!p.apartment)
    console.log(
      '• No projects found — leads have no project interest. Run `npm run seed:demo` first for the full picture.',
    );
  if (!settings.sla?.enabled)
    console.log('• SLA is off in CRM settings — no SLA chips. Turn it on and run with --reset.');
  if (generated) {
    console.log(`\n  Demo staff password (shown once): ${password}`);
    console.log('  Same password for nadia@ / sumi@ / rakib@demo.primeplot.test');
  }

  const line = (label, l) => console.log(`  ${label.padEnd(38)} ${l.name.padEnd(22)} ${l.phone}`);
  console.log('\nTest guide (sign in as the admin unless noted):');
  line('SLA running, unassigned', refs.slaRunning);
  line('SLA missed → escalates on API start', refs.slaBreached);
  line('SLA missed, already escalated', refs.slaEscalated);
  line('Overdue follow-up (My tasks)', refs.overdueTask);
  line('Due today + bell in ~3 min', refs.todayTask);
  line('Site visit tomorrow (Sumi)', refs.visit);
  line('VIP in negotiation', refs.vip);
  line('Repeat enquiry ×3 (Facebook)', refs.repeat);
  line('Lost (price) → reopen test', refs.lost);
  line('Merge test — first', refs.mergeA);
  line('Merge test — second', refs.mergeB);
  line('NRB number (SMS skipped)', refs.nrb);
  console.log(
    `\n  Duplicate test: "New lead" with phone ${refs.todayTask.phone.replace('+880', '0')} → "open that lead".`,
  );
  console.log(
    `  Website repeat enquiry: submit the site form with ${refs.mergeA.phone.replace('+880', '0')} → enquiry count +1.`,
  );
  console.log('  Executive view: sign in as sumi@demo.primeplot.test — sees only her leads.');
} catch (err) {
  if (!err.skip) throw err;
} finally {
  await disconnectDB();
}
