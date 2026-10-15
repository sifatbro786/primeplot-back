// Demo WEBSITE content for development (B2b): fills every Home and About section that is still
// empty — track record, testimonials, partners, video tour, story, leadership, awards, CSR … —
// with bilingual dummy copy and free stock photos (Unsplash / Pexels), then publishes both pages.
//
//   npm run seed:site               # fill only what is empty (your own edits are kept)
//   npm run seed:site -- --overwrite  # replace these sections with the demo content
//
// Photos are downloaded once and stored as normal public media (re-runs reuse them by hash);
// a photo that cannot be downloaded is simply left out. Every name, figure, quote and award
// here is FICTIONAL placeholder content — replace it in Dashboard → Website before going live.
// Needs `npm run seed` first. Never run it on production.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { env } from '#config/env.js';
import { connectDB, disconnectDB } from '#config/db.js';
import '#jobs/index.js'; // registers job types (publishing queues a website revalidation)
import { permissionsFor } from '#shared/auth/permissions.js';
import { getCurrentOrg } from '#modules/organizations/organization.service.js';
import { User } from '#modules/users/user.model.js';
import { Media } from '#modules/media/media.model.js';
import { createMedia } from '#modules/media/media.service.js';
import { SitePage } from '#modules/site/sitePage.model.js';
import { DEFAULTS } from '#modules/site/site.defaults.js';
import { completeSections, parseSeo } from '#modules/site/site.schema.js';
import { getPage, publishPage, saveDraft } from '#modules/site/site.service.js';

const { values: args } = parseArgs({
  options: { overwrite: { type: 'boolean', default: false } },
});

if (env.isProd) {
  console.error('\n✖ seed:site refuses to run with NODE_ENV=production\n');
  process.exit(1);
}

const t = (en, bn) => ({ en, bn });
const U = (id, w = 1600) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=80`;
const PX = (id, w = 900) =>
  `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${w}`;

/** Stock photos used below (key → URL). Portraits are Pexels, places are Unsplash. */
const PHOTOS = {
  tower: U('photo-1545324418-cc1a3fa10c00'),
  facade: U('photo-1486406146926-c627a92ad1ab'),
  interior: U('photo-1600607687939-ce8a6c25118c'),
  land: U('photo-1500382017468-9049fed747ef'),
  city: U('photo-1477959858617-67f85cf4f1df'),
  park: U('photo-1571896349842-33c89424de2d'),
  p1: PX(2379004),
  p2: PX(774909),
  p3: PX(1222271),
  p4: PX(415829),
  p5: PX(220453),
  p6: PX(1239291),
  p7: PX(614810),
  p8: PX(733872),
};

// `{photo:key}` placeholders are swapped for media ids once the photos are stored.
const photo = (key) => `{photo:${key}}`;

const DEMO = {
  home: {
    featured: {
      body: t(
        'Ongoing and ready projects with live availability — open any one to see the floors, the free units and their itemised prices.',
        'চলমান ও প্রস্তুত প্রজেক্ট, লাইভ খালি ইউনিটসহ — যেকোনোটি খুলে তলা, খালি ইউনিট আর খাতওয়ারি দাম দেখুন।',
      ),
    },
    trackRecord: {
      body: t(
        'Numbers from fourteen years of building across Dhaka and Chattogram.',
        'ঢাকা ও চট্টগ্রামে চৌদ্দ বছরের নির্মাণ অভিজ্ঞতার কিছু হিসাব।',
      ),
      items: [
        { value: '14', label: t('Years of building', 'বছরের অভিজ্ঞতা') },
        { value: '38', label: t('Projects handed over', 'প্রজেক্ট হস্তান্তর') },
        { value: '2,400+', label: t('Families at home', 'পরিবার বসবাস করছেন') },
        { value: '1.9M', label: t('Sq ft constructed', 'বর্গফুট নির্মাণ') },
      ],
    },
    testimonials: {
      items: [
        {
          name: t('Dr. Shahana Parveen', 'ডা. শাহানা পারভীন'),
          role: t('Homeowner, Bashundhara R/A', 'বাসিন্দা, বসুন্ধরা আ/এ'),
          quote: t(
            'We compared six developers. This was the only one that showed us the full price sheet on the first visit — and the handover came two months early.',
            'ছয়টি ডেভেলপার যাচাই করেছিলাম। প্রথম ভিজিটেই পুরো দামের তালিকা দেখিয়েছিল শুধু এরাই — আর হস্তান্তর হয়েছে নির্ধারিত সময়ের দুই মাস আগে।',
          ),
          photoMediaId: photo('p2'),
        },
        {
          name: t('Kamrul Hasan', 'কামরুল হাসান'),
          role: t('Non-resident buyer, London', 'প্রবাসী ক্রেতা, লন্ডন'),
          quote: t(
            'Buying from abroad felt safe because every installment receipt arrived with a QR code my brother could check at the office.',
            'বিদেশ থেকে কিনেও নিশ্চিন্ত ছিলাম — প্রতিটি কিস্তির রসিদে QR কোড ছিল, ভাই অফিসে গিয়ে যাচাই করে নিতে পারত।',
          ),
          photoMediaId: photo('p3'),
        },
        {
          name: t('Farhana & Rafiq Chowdhury', 'ফারহানা ও রফিক চৌধুরী'),
          role: t('Homeowners, Uttara', 'বাসিন্দা, উত্তরা'),
          quote: t(
            'The site engineer walked us through the casting of our own floor. Small thing, but it told us how they build.',
            'আমাদের নিজের তলার ঢালাইয়ের সময় সাইট ইঞ্জিনিয়ার সাথে করে ঘুরিয়ে দেখিয়েছিলেন। ছোট ব্যাপার, কিন্তু এতেই বুঝেছি তারা কীভাবে গড়ে।',
          ),
          photoMediaId: photo('p8'),
        },
        {
          name: t('Md. Abdul Mannan', 'মো. আব্দুল মান্নান'),
          role: t('Landowner partner, Mirpur DOHS', 'জমির মালিক অংশীদার, মিরপুর ডিওএইচএস'),
          quote: t(
            'They kept every promise in the joint-venture agreement, including the date. My family now lives in four of the flats.',
            'যৌথ চুক্তির প্রতিটি কথা, তারিখসহ, তারা রেখেছে। আমার পরিবার এখন চারটি ফ্ল্যাটে থাকে।',
          ),
          photoMediaId: photo('p5'),
        },
        {
          name: t('Tasnim Ahmed', 'তাসনিম আহমেদ'),
          role: t('First-time buyer, Mohammadpur', 'প্রথমবার ক্রেতা, মোহাম্মদপুর'),
          quote: t(
            'The online portal shows my schedule, receipts and dues in one place. I have not had to call the office once.',
            'অনলাইন পোর্টালে শিডিউল, রসিদ আর বকেয়া এক জায়গায় দেখি। একবারও অফিসে ফোন করতে হয়নি।',
          ),
          photoMediaId: photo('p6'),
        },
      ],
    },
    partners: {
      items: [
        { name: 'RAJUK', group: 'approval', url: '' },
        {
          name: 'Chattogram Development Authority',
          group: 'approval',
          url: '',
        },
        { name: 'REHAB', group: 'membership', url: '' },
        { name: 'FBCCI', group: 'membership', url: '' },
        { name: 'Delta Brac Housing', group: 'bank', url: '' },
        { name: 'IDLC Finance', group: 'bank', url: '' },
        { name: 'BRAC Bank', group: 'bank', url: '' },
        { name: 'City Bank', group: 'bank', url: '' },
        { name: 'Studio Mati Architects', group: 'partner', url: '' },
        { name: 'Shoreline Structural Consultants', group: 'partner', url: '' },
      ],
    },
    video: {
      body: t(
        'A four-minute walk through a finished three-bedroom home — the light, the finishes and the views you can expect.',
        'তৈরি একটি তিন বেডরুমের ঘরে চার মিনিটের হাঁটা — আলো, ফিনিশিং আর জানালার দৃশ্য, যা আপনি পাবেন।',
      ),
      youtubeUrl: 'https://www.youtube.com/watch?v=r2InPYnhZr4',
      posterMediaId: photo('interior'),
    },
  },

  about: {
    intro: { imageMediaId: photo('facade') },
    stats: {
      note: t('Live figures from our current inventory.', 'বর্তমান ইনভেন্টরি থেকে লাইভ সংখ্যা।'),
    },
    story: {
      body: t(
        'We started in 2012 with a single six-storey building in Mohammadpur, financed by two families who trusted us with their land.\n\nFourteen years later we have handed over 38 projects across Dhaka and Chattogram — and we still sell every one of them the same way: approvals in hand, prices in writing, progress you can see.',
        '২০১২ সালে মোহাম্মদপুরে একটি ছয়তলা ভবন দিয়ে শুরু — দুটি পরিবার তাদের জমি নিয়ে আমাদের ওপর আস্থা রেখেছিল।\n\nচৌদ্দ বছর পর ঢাকা ও চট্টগ্রামে ৩৮টি প্রজেক্ট হস্তান্তর করেছি — আর প্রতিটি এখনো একইভাবে বিক্রি করি: অনুমোদন হাতে, লিখিত দাম, চোখে দেখা অগ্রগতি।',
      ),
      milestones: [
        {
          year: '2012',
          title: t('First building', 'প্রথম ভবন'),
          body: t(
            'A six-storey joint venture in Mohammadpur, handed over in 26 months.',
            'মোহাম্মদপুরে ছয়তলা যৌথ উদ্যোগ, ২৬ মাসে হস্তান্তর।',
          ),
        },
        {
          year: '2015',
          title: t('REHAB membership', 'রিহ্যাব সদস্যপদ'),
          body: t(
            'Joined the Real Estate & Housing Association of Bangladesh.',
            'রিয়েল এস্টেট অ্যান্ড হাউজিং অ্যাসোসিয়েশন অব বাংলাদেশের সদস্য হই।',
          ),
        },
        {
          year: '2018',
          title: t('Chattogram office', 'চট্টগ্রাম অফিস'),
          body: t(
            'First projects outside Dhaka, in Khulshi and Agrabad.',
            'ঢাকার বাইরে প্রথম প্রজেক্ট — খুলশী ও আগ্রাবাদে।',
          ),
        },
        {
          year: '2021',
          title: t('Land projects', 'জমির প্রজেক্ট'),
          body: t(
            'Our first planned plot project with roads, drainage and title transfer included.',
            'রাস্তা, ড্রেনেজ ও নামজারিসহ প্রথম পরিকল্পিত প্লট প্রজেক্ট।',
          ),
        },
        {
          year: '2025',
          title: t('Customer portal', 'কাস্টমার পোর্টাল'),
          body: t(
            'Every buyer can now follow schedules, receipts and construction online.',
            'প্রত্যেক ক্রেতা এখন অনলাইনে শিডিউল, রসিদ ও নির্মাণ অগ্রগতি দেখতে পান।',
          ),
        },
      ],
    },
    leaderMessage: {
      name: t('Engr. Rezaul Karim', 'প্রকৌ. রেজাউল করিম'),
      designation: t('Chairman', 'চেয়ারম্যান'),
      message: t(
        'When a family books a flat, they are trusting us with years of savings and a promise about their future. We take that seriously.\n\nThat is why we sell only approved projects, write every taka of the price into the booking, and show our construction progress openly. It is slower than selling on promises — and it is the only way we want to build.\n\nThank you for considering us. Our door, and our sites, are always open.',
        'একটি পরিবার যখন ফ্ল্যাট বুক করে, তখন তারা বছরের পর বছরের সঞ্চয় আর ভবিষ্যতের একটি প্রতিশ্রুতি আমাদের হাতে তুলে দেয়। আমরা বিষয়টি গুরুত্বের সঙ্গে নিই।\n\nতাই আমরা শুধু অনুমোদিত প্রজেক্ট বিক্রি করি, দামের প্রতিটি টাকা বুকিংয়ে লিখে দিই, আর নির্মাণ অগ্রগতি খোলাখুলি দেখাই। প্রতিশ্রুতিতে বিক্রির চেয়ে এটি ধীর — কিন্তু আমরা এভাবেই গড়তে চাই।\n\nআমাদের বিবেচনায় রাখার জন্য ধন্যবাদ। আমাদের দরজা, আর আমাদের সাইট, সবসময় খোলা।',
      ),
      photoMediaId: photo('p1'),
    },
    team: {
      items: [
        {
          name: t('Engr. Rezaul Karim', 'প্রকৌ. রেজাউল করিম'),
          designation: t('Chairman', 'চেয়ারম্যান'),
          bio: t(
            'Civil engineer (BUET), 25 years in structural design and construction.',
            'সিভিল ইঞ্জিনিয়ার (বুয়েট), কাঠামো নকশা ও নির্মাণে ২৫ বছর।',
          ),
          photoMediaId: photo('p1'),
        },
        {
          name: t('Nasrin Akhter', 'নাসরিন আক্তার'),
          designation: t('Managing Director', 'ব্যবস্থাপনা পরিচালক'),
          bio: t(
            'Leads sales and customer care; previously in housing finance for 12 years.',
            'বিক্রয় ও গ্রাহকসেবার নেতৃত্বে; আগে ১২ বছর গৃহঋণ খাতে।',
          ),
          photoMediaId: photo('p4'),
        },
        {
          name: t('Arch. Tanvir Rahman', 'স্থপতি তানভীর রহমান'),
          designation: t('Head of Design', 'ডিজাইন প্রধান'),
          bio: t(
            'Architect focused on daylight, cross-ventilation and usable floor plans.',
            'আলো, বায়ুচলাচল ও ব্যবহারযোগ্য ফ্লোর প্ল্যান নিয়ে কাজ করা স্থপতি।',
          ),
          photoMediaId: photo('p7'),
        },
        {
          name: t('Engr. Sabrina Haque', 'প্রকৌ. সাবরিনা হক'),
          designation: t('Head of Construction', 'নির্মাণ প্রধান'),
          bio: t(
            'Runs site quality, safety and the casting schedule on every project.',
            'প্রতিটি প্রজেক্টে সাইটের মান, নিরাপত্তা ও ঢালাই সূচি দেখেন।',
          ),
          photoMediaId: photo('p6'),
        },
      ],
    },
    completed: {
      body: t(
        'Buildings we have handed over — families have been living in them for years.',
        'যে ভবনগুলো আমরা হস্তান্তর করেছি — বছরের পর বছর সেখানে পরিবারগুলো বসবাস করছে।',
      ),
    },
    credentials: {
      items: [
        { name: 'REHAB Member', group: 'membership', url: '' },
        { name: 'FBCCI Member', group: 'membership', url: '' },
        { name: 'RAJUK Enlisted Developer', group: 'approval', url: '' },
        { name: 'Dhaka Chamber of Commerce', group: 'membership', url: '' },
      ],
    },
    awards: {
      items: [
        {
          year: '2024',
          title: t('Best Mid-size Residential Project', 'সেরা মাঝারি আবাসিক প্রজেক্ট'),
          by: t(
            'Bangladesh Real Estate Awards (demo)',
            'বাংলাদেশ রিয়েল এস্টেট অ্যাওয়ার্ডস (ডেমো)',
          ),
        },
        {
          year: '2022',
          title: t('Green Building Commendation', 'সবুজ ভবন স্বীকৃতি'),
          by: t('Urban Design Forum (demo)', 'আরবান ডিজাইন ফোরাম (ডেমো)'),
        },
        {
          year: '2019',
          title: t('Customer Trust Award', 'গ্রাহক আস্থা পুরস্কার'),
          by: t('Housing Fair Dhaka (demo)', 'হাউজিং ফেয়ার ঢাকা (ডেমো)'),
        },
      ],
    },
    csr: {
      body: t(
        'A share of every project goes back to the neighbourhood it is built in.',
        'প্রতিটি প্রজেক্টের একটি অংশ ফিরে যায় সেই এলাকার মানুষের কাছে।',
      ),
      items: [
        {
          title: t('Trees for every building', 'প্রতি ভবনে গাছ'),
          body: t(
            'Fifty native trees planted around each handed-over project.',
            'প্রতিটি হস্তান্তরিত প্রজেক্টের চারপাশে পঞ্চাশটি দেশি গাছ।',
          ),
          imageMediaId: photo('land'),
        },
        {
          title: t('Safe sites, trained workers', 'নিরাপদ সাইট, প্রশিক্ষিত শ্রমিক'),
          body: t(
            'Free safety gear and monthly training for every worker on our sites.',
            'সাইটের প্রত্যেক শ্রমিকের জন্য বিনামূল্যে নিরাপত্তা সরঞ্জাম ও মাসিক প্রশিক্ষণ।',
          ),
          imageMediaId: photo('city'),
        },
        {
          title: t('Neighbourhood playgrounds', 'পাড়ার খেলার মাঠ'),
          body: t(
            'Small parks and play areas kept open for the community.',
            'এলাকাবাসীর জন্য খোলা ছোট পার্ক ও খেলার জায়গা।',
          ),
          imageMediaId: photo('park'),
        },
      ],
    },
  },
};

// ── helpers ─────────────────────────────────────────────────────────────────────

const isEmpty = (v) =>
  v == null ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && 'en' in v && 'bn' in v && !v.en && !v.bn);

/** Swap `{photo:key}` strings for stored media ids (null when the photo is unavailable). */
function resolvePhotos(value, ids) {
  if (Array.isArray(value)) return value.map((v) => resolvePhotos(v, ids));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePhotos(v, ids)]));
  if (typeof value === 'string' && value.startsWith('{photo:'))
    return ids.get(value.slice(7, -1)) ?? null;
  return value;
}

async function storePhoto(orgId, user, ctx, key, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const found = await Media.findOne({ orgId, sha256, visibility: 'public' }).select('_id').lean();
    if (found) return String(found._id);
    const m = await createMedia({
      orgId,
      user,
      file: { buffer, originalname: `stock-${key}.jpg` },
      visibility: 'public',
      purpose: 'general',
      alt: `Stock photo (${key})`,
      ctx,
    });
    return String(m._id);
  } catch (err) {
    console.warn(`  ! photo "${key}" skipped (${err.message})`);
    return null;
  }
}

// ── run ─────────────────────────────────────────────────────────────────────────

await connectDB({ retries: 2 });
try {
  const org = await getCurrentOrg();
  const orgId = org._id;
  const adminDoc = await User.findOne({
    orgId,
    role: 'admin',
    status: 'active',
  })
    .sort({ createdAt: 1 })
    .lean();
  if (!adminDoc) throw new Error('No active admin — run `npm run seed` first.');
  const admin = {
    id: String(adminDoc._id),
    orgId,
    role: adminDoc.role,
    name: adminDoc.name,
    email: adminDoc.email,
    permissions: permissionsFor(adminDoc.role),
  };
  const ctx = {
    orgId,
    actor: { id: admin.id, role: admin.role, name: admin.name, kind: 'user' },
    ip: null,
    userAgent: 'seed-site',
    requestId: null,
  };

  console.log('• Downloading stock photos (Unsplash / Pexels)…');
  const ids = new Map();
  for (const [key, url] of Object.entries(PHOTOS)) {
    ids.set(key, await storePhoto(orgId, admin, ctx, key, url));
  }
  console.log(`✔ Photos: ${[...ids.values()].filter(Boolean).length}/${ids.size} stored`);

  for (const [page, patches] of Object.entries(DEMO)) {
    const { version } = await getPage(orgId, page); // creates the page from defaults if new
    const doc = await SitePage.findOne({ orgId, key: page }).lean();
    const sections = structuredClone(completeSections(page, doc.draft?.sections, DEFAULTS[page]));
    let filled = 0;
    for (const s of sections) {
      const patch = patches[s.key];
      if (!patch) continue;
      const demo = resolvePhotos(patch, ids);
      let touched = false;
      for (const [field, value] of Object.entries(demo)) {
        if (value == null) continue;
        if (args.overwrite || isEmpty(s.data[field])) {
          s.data[field] = value;
          touched = true;
        }
      }
      if (touched || args.overwrite) s.enabled = true;
      if (touched) filled += 1;
    }
    const saved = await saveDraft({
      orgId,
      key: page,
      input: { version, sections, seo: parseSeo(doc.draft?.seo) },
      ctx,
    });
    try {
      await publishPage({
        orgId,
        key: page,
        version: saved.version,
        note: 'Demo content (seed:site)',
        ctx,
      });
      console.log(`✔ ${page}: ${filled} section(s) filled, published`);
    } catch (err) {
      if (err.code !== 'NO_CHANGES') throw err;
      console.log(`• ${page}: nothing new to publish`);
    }
  }
  console.log('\nOpen /bn and /bn/about (the API must be running so the site revalidates).');
  console.log('Everything here is fictional — edit it in Dashboard → Website before launch.');
} finally {
  await disconnectDB();
}
