import { PAGES, SECTION_TYPES } from './site.schema.js';

/**
 * Default content for every section (BN + EN). Used the first time a page is opened, for
 * "reset to default", and by the public API until a page is published.
 *
 * Generic copy only: statements the company must stand behind (numbers, people, customer
 * quotes, awards, the leader's message) start EMPTY — those sections stay hidden until real
 * content is entered. The generic claims below are a starting point and should be reviewed
 * by the company before publishing.
 */
const t = (en, bn) => ({ en, bn });

const RAW = {
  home: {
    hero: {
      eyebrow: t('Apartments & land', 'অ্যাপার্টমেন্ট ও জমি'),
      title: t('A home, *seen clearly* before you buy.', 'কেনার আগেই *স্পষ্ট দেখুন* আপনার ঘর।'),
      body: t(
        'Every project shows what is actually for sale today, with itemised prices and plans you can open — no guesswork, no surprises at booking.',
        'প্রতিটি প্রজেক্টে আজ আসলে কী বিক্রির জন্য আছে, তা খাতওয়ারি দাম আর প্ল্যানসহ দেখানো হয় — অনুমানের দরকার নেই, বুকিংয়ের সময় কোনো চমকও নেই।',
      ),
      primary: { label: t('Explore projects', 'প্রজেক্ট দেখুন'), href: '/projects' },
      secondary: { label: t('Talk to us', 'কথা বলুন'), href: '/contact' },
    },
    stats: {
      note: t(
        'Live figures from our inventory — they change the moment a home is reserved or booked.',
        'আমাদের ইনভেন্টরি থেকে লাইভ সংখ্যা — কোনো ইউনিট রিজার্ভ বা বুক হলেই সঙ্গে সঙ্গে বদলে যায়।',
      ),
    },
    featured: {
      eyebrow: t('Featured', 'ফিচারড'),
      title: t('Projects worth a visit', 'ঘুরে দেখার মতো প্রজেক্ট'),
    },
    whyUs: {
      eyebrow: t('Why {company}', 'কেন {company}'),
      title: t('Built to be *trusted* for decades', 'যুগের পর যুগ *আস্থা* রাখার মতো করে গড়া'),
      body: t(
        'A home is the largest purchase most families make. These are the commitments behind every building we deliver.',
        'বেশিরভাগ পরিবারের জীবনের সবচেয়ে বড় কেনাকাটা একটি বাড়ি। আমাদের প্রতিটি ভবনের পেছনে এই প্রতিশ্রুতিগুলো থাকে।',
      ),
      items: [
        {
          icon: 'file-check',
          title: t('Approved before we sell', 'অনুমোদনের পরেই বিক্রি'),
          body: t(
            'Projects are sold with the plan approval of the authority (RAJUK, CDA or the local authority) in hand — ask to see it at our office.',
            'অনুমোদনকারী কর্তৃপক্ষের (রাজউক, সিডিএ বা স্থানীয় কর্তৃপক্ষ) নকশা অনুমোদন হাতে নিয়েই প্রজেক্ট বিক্রি করা হয় — অফিসে এসে দেখে নিতে পারেন।',
          ),
        },
        {
          icon: 'hard-hat',
          title: t('Engineered structure', 'প্রকৌশলভিত্তিক কাঠামো'),
          body: t(
            'Soil test, structural design to the Bangladesh National Building Code (BNBC) including earthquake loads, and an engineer on site at every casting.',
            'মাটি পরীক্ষা, ভূমিকম্পের চাপসহ বাংলাদেশ জাতীয় ইমারত নির্মাণ বিধিমালা (BNBC) অনুযায়ী কাঠামো নকশা, আর প্রতিটি ঢালাইয়ে সাইটে প্রকৌশলী।',
          ),
        },
        {
          icon: 'clock',
          title: t('Progress you can follow', 'চোখে দেখা অগ্রগতি'),
          body: t(
            'Construction updates with photos are posted for every ongoing project, so you see progress instead of hearing promises.',
            'চলমান প্রতিটি প্রজেক্টের নির্মাণ অগ্রগতি ছবিসহ এখানে দেওয়া হয় — প্রতিশ্রুতি শোনার বদলে নিজেই অগ্রগতি দেখুন।',
          ),
        },
        {
          icon: 'receipt',
          title: t('Prices in writing', 'লিখিত দাম'),
          body: t(
            'Base rate, floor rise, facing, parking and every charge are itemised before you book — and frozen in your booking.',
            'বেস রেট, তলাভিত্তিক বৃদ্ধি, মুখ, পার্কিং আর প্রতিটি চার্জ বুকিংয়ের আগেই খাতওয়ারি জানানো হয় — বুকিংয়ে সেই দামই স্থির থাকে।',
          ),
        },
        {
          icon: 'landmark',
          title: t('Clean land title', 'নিষ্কণ্টক জমি'),
          body: t(
            'Land is taken up only after a legal check of the deed chain, mutation (namjari) and land-tax records.',
            'দলিলের ধারাবাহিকতা, নামজারি আর খাজনার কাগজ আইনি যাচাইয়ের পরেই জমি নেওয়া হয়।',
          ),
        },
        {
          icon: 'handshake',
          title: t('Support after handover', 'হস্তান্তরের পরেও পাশে'),
          body: t(
            'Help with registration, utility connections and forming the flat owners’ association after you move in.',
            'রেজিস্ট্রেশন, ইউটিলিটি সংযোগ আর ফ্ল্যাট মালিক সমিতি গঠনে হস্তান্তরের পরেও সহায়তা।',
          ),
        },
      ],
    },
    trackRecord: {
      eyebrow: t('Track record', 'অভিজ্ঞতা'),
      title: t('What we have delivered so far', 'এ পর্যন্ত যা হস্তান্তর করেছি'),
      items: [],
    },
    construction: {
      eyebrow: t('On site', 'সাইট থেকে'),
      title: t('Construction progress', 'নির্মাণ অগ্রগতি'),
      body: t(
        'Photos and progress from our sites, posted by the project team.',
        'আমাদের সাইটগুলোর ছবি ও অগ্রগতি — প্রজেক্ট টিমের পাঠানো।',
      ),
    },
    areas: {
      eyebrow: t('Locations', 'লোকেশন'),
      title: t('Where we build', 'আমরা যেখানে গড়ি'),
      body: t(
        'Choose an area to see every project there and how many homes are still free.',
        'এলাকা বেছে নিন — সেখানকার সব প্রজেক্ট আর কয়টি ইউনিট এখনো খালি, দেখতে পাবেন।',
      ),
    },
    howItWorks: {
      eyebrow: t('How buying works', 'কেনার ধাপ'),
      title: t('Four steps, nothing hidden', 'চারটি ধাপ, কিছুই লুকানো নয়'),
      items: [
        {
          title: t('Choose from live availability', 'লাইভ তালিকা থেকে বেছে নিন'),
          body: t(
            'See which homes are free right now — by building, floor and size — and the price of each.',
            'এই মুহূর্তে কোন ইউনিট খালি — ভবন, তলা ও আকার অনুযায়ী — আর প্রতিটির দাম দেখুন।',
          ),
        },
        {
          title: t('Visit the site', 'সাইট ভিজিট করুন'),
          body: t(
            'We arrange a visit and hold the unit you like while you decide.',
            'আমরা ভিজিটের ব্যবস্থা করি; সিদ্ধান্ত নেওয়া পর্যন্ত পছন্দের ইউনিট আপনার জন্য রিজার্ভ রাখি।',
          ),
        },
        {
          title: t('Book at a written price', 'লিখিত দামে বুক করুন'),
          body: t(
            'Your booking shows every line of the price — base rate, floor, facing, parking and charges.',
            'বুকিংয়ে দামের প্রতিটি খাত থাকে — বেস রেট, তলা, মুখ, পার্কিং ও অন্যান্য চার্জ।',
          ),
        },
        {
          title: t('Pay in installments', 'কিস্তিতে পরিশোধ করুন'),
          body: t(
            'Follow your schedule and receipts online; every receipt and allotment letter carries a QR code you can verify.',
            'অনলাইনে কিস্তির শিডিউল ও রসিদ দেখুন; প্রতিটি রসিদ ও বরাদ্দপত্রে যাচাইযোগ্য QR কোড থাকে।',
          ),
        },
      ],
    },
    testimonials: {
      eyebrow: t('Homeowners', 'বাসিন্দারা'),
      title: t('In their own words', 'তাঁদের নিজের কথায়'),
      items: [],
    },
    landownerCta: {
      eyebrow: t('For landowners', 'জমির মালিকদের জন্য'),
      title: t('Have land? *Let’s build on it together.*', 'জমি আছে? *চলুন একসাথে গড়ি।*'),
      body: t(
        'Joint-venture development: we bring design, approvals, construction and sales; you keep an agreed share of the finished flats.',
        'যৌথ উদ্যোগে উন্নয়ন: নকশা, অনুমোদন, নির্মাণ ও বিক্রির দায়িত্ব আমাদের; তৈরি ফ্ল্যাটের সম্মত অংশ আপনার।',
      ),
      label: t('Talk to us about your land', 'আপনার জমির কথা জানান'),
      href: '/landowners',
    },
    partners: {
      eyebrow: t('Approvals & partners', 'অনুমোদন ও অংশীদার'),
      title: t('Approved by, members of, financed through', 'অনুমোদন, সদস্যপদ ও গৃহঋণ সহযোগী'),
      items: [],
    },
    video: {
      eyebrow: t('Video tour', 'ভিডিও ট্যুর'),
      title: t('Walk through a project', 'ঘুরে দেখুন একটি প্রজেক্ট'),
      youtubeUrl: '',
    },
    faq: {
      eyebrow: t('FAQ', 'সাধারণ প্রশ্ন'),
      title: t('Questions buyers ask us', 'ক্রেতারা যা জানতে চান'),
      items: [
        {
          q: t('What do I receive when I book?', 'বুকিং দিলে কী কী কাগজ পাব?'),
          a: t(
            'A money receipt and a booking form showing the unit, its itemised price and your payment schedule. The allotment letter follows once the down payment is complete.',
            'টাকার রসিদ আর একটি বুকিং ফর্ম — যাতে ইউনিট, খাতওয়ারি দাম ও কিস্তির শিডিউল লেখা থাকে। ডাউন পেমেন্ট সম্পূর্ণ হলে বরাদ্দপত্র দেওয়া হয়।',
          ),
        },
        {
          q: t('Can I pay in installments?', 'কিস্তিতে পরিশোধ করা যাবে?'),
          a: t(
            'Yes. Most projects take a down payment followed by installments until handover. The schedule is written into your booking.',
            'হ্যাঁ। বেশিরভাগ প্রজেক্টে ডাউন পেমেন্টের পর হস্তান্তর পর্যন্ত কিস্তিতে পরিশোধ করা যায়। শিডিউল আপনার বুকিংয়েই লেখা থাকে।',
          ),
        },
        {
          q: t('Can I get a home loan?', 'গৃহঋণ পাওয়া যাবে?'),
          a: t(
            'Banks and financial institutions finance flats in approved projects. We provide the project documents your bank asks for.',
            'অনুমোদিত প্রজেক্টের ফ্ল্যাটে ব্যাংক ও আর্থিক প্রতিষ্ঠান ঋণ দেয়। আপনার ব্যাংক যে কাগজ চায়, প্রজেক্টের সেই কাগজপত্র আমরা দিই।',
          ),
        },
        {
          q: t('Can the price change after booking?', 'বুকিংয়ের পর দাম কি বদলাতে পারে?'),
          a: t(
            'No — the price and charges written in your booking are the price you pay.',
            'না — আপনার বুকিংয়ে যে দাম ও চার্জ লেখা থাকে, সেটাই আপনার দাম।',
          ),
        },
        {
          q: t('When is the flat registered in my name?', 'ফ্ল্যাট কবে আমার নামে রেজিস্ট্রি হবে?'),
          a: t(
            'Registration is done at the sub-registry office after full payment. Registration fees and stamp duty are paid by the buyer at government rates.',
            'সম্পূর্ণ পরিশোধের পর সাব-রেজিস্ট্রি অফিসে রেজিস্ট্রেশন হয়। রেজিস্ট্রেশন ফি ও স্ট্যাম্প শুল্ক সরকারি হারে ক্রেতা পরিশোধ করেন।',
          ),
        },
        {
          q: t('Can I visit a site before deciding?', 'সিদ্ধান্তের আগে সাইট দেখা যাবে?'),
          a: t(
            'Of course. Book a visit with the enquiry form or by phone and our team will take you round.',
            'অবশ্যই। এনকোয়ারি ফর্ম বা ফোনে ভিজিট বুক করুন — আমাদের টিম সাথে থেকে ঘুরিয়ে দেখাবে।',
          ),
        },
      ],
    },
    enquiry: {
      eyebrow: t('Enquiry', 'যোগাযোগ'),
      title: t('Tell us what you are looking for', 'আপনি কী খুঁজছেন, জানান'),
      body: t(
        'Size, area, budget, timing — our sales team will reply with the homes that fit, and nothing that doesn’t.',
        'আকার, এলাকা, বাজেট, সময় — আমাদের সেলস টিম শুধু আপনার উপযোগী ইউনিটগুলো নিয়েই উত্তর দেবে।',
      ),
    },
  },

  about: {
    intro: {
      eyebrow: t('About us', 'আমাদের কথা'),
      title: t('{company} — *homes built on trust*', '{company} — *আস্থার ওপর গড়া ঘর*'),
      body: t(
        '{company} builds apartments and develops residential land for families who want to know exactly what they are buying.\n\nThat is why our website shows live availability, itemised prices and real floor plans — the same information our sales team works from.',
        '{company} অ্যাপার্টমেন্ট নির্মাণ করে এবং আবাসিক জমি উন্নয়ন করে — সেই পরিবারগুলোর জন্য, যাঁরা ঠিক কী কিনছেন তা জানতে চান।\n\nতাই আমাদের ওয়েবসাইটে লাইভ খালি ইউনিট, খাতওয়ারি দাম আর আসল ফ্লোর প্ল্যান দেখানো হয় — আমাদের সেলস টিম যে তথ্য দেখে কাজ করে, ঠিক সেটাই।',
      ),
    },
    stats: {},
    story: {
      eyebrow: t('Our story', 'আমাদের পথচলা'),
      title: t('How we got here', 'যেভাবে এ পর্যন্ত'),
      milestones: [],
    },
    missionVision: {
      eyebrow: t('Purpose', 'লক্ষ্য'),
      title: t('Mission, vision and values', 'মিশন, ভিশন ও মূল্যবোধ'),
      mission: t(
        'To build homes families can trust — safe, well made, and sold with complete transparency.',
        'এমন ঘর গড়া, যার ওপর পরিবার ভরসা রাখতে পারে — নিরাপদ, যত্নে তৈরি, আর পুরো স্বচ্ছতায় বিক্রি।',
      ),
      vision: t(
        'To be the developer people recommend — for the quality of our buildings and the honesty of our dealings.',
        'এমন ডেভেলপার হওয়া, যাকে মানুষ অন্যকে সুপারিশ করে — ভবনের মান আর লেনদেনের সততার জন্য।',
      ),
      values: [
        {
          title: t('Integrity', 'সততা'),
          body: t(
            'We say what we will do, and put it in writing.',
            'যা বলি তা করি, আর তা লিখিতভাবে দিই।',
          ),
        },
        {
          title: t('Quality', 'মান'),
          body: t(
            'Design, materials and workmanship checked at every stage.',
            'নকশা, উপকরণ আর কারিগরি — প্রতিটি ধাপে যাচাই।',
          ),
        },
        {
          title: t('Transparency', 'স্বচ্ছতা'),
          body: t(
            'Live availability, itemised prices and verifiable documents.',
            'লাইভ খালি ইউনিট, খাতওয়ারি দাম আর যাচাইযোগ্য কাগজপত্র।',
          ),
        },
        {
          title: t('Responsibility', 'দায়বদ্ধতা'),
          body: t(
            'To buyers, landowners, neighbours and the people who build with us.',
            'ক্রেতা, জমির মালিক, প্রতিবেশী আর যাঁরা আমাদের সাথে গড়েন — সবার প্রতি।',
          ),
        },
      ],
    },
    principles: {
      eyebrow: t('What we stand for', 'আমাদের নীতি'),
      title: t('Four promises to every buyer', 'প্রত্যেক ক্রেতার কাছে চারটি প্রতিশ্রুতি'),
      items: [
        {
          icon: 'eye',
          title: t('Availability you can see', 'চোখে দেখা খালি ইউনিট'),
          body: t(
            'What you see as available is available. Reserved and sold homes are marked the moment it happens.',
            'যা খালি দেখছেন, তা সত্যিই খালি। রিজার্ভ বা বিক্রি হলেই সঙ্গে সঙ্গে চিহ্নিত হয়।',
          ),
        },
        {
          icon: 'receipt',
          title: t('Prices in writing', 'লিখিত দাম'),
          body: t(
            'Every price is itemised — base rate, floor rise, facing, parking and charges. No surprises at booking.',
            'প্রতিটি দাম খাতওয়ারি — বেস রেট, তলাভিত্তিক বৃদ্ধি, মুখ, পার্কিং ও চার্জ। বুকিংয়ের সময় কোনো চমক নেই।',
          ),
        },
        {
          icon: 'qr-code',
          title: t('Documents you can verify', 'যাচাইযোগ্য কাগজপত্র'),
          body: t(
            'Money receipts and allotment letters carry a QR code that anyone can check online.',
            'টাকার রসিদ ও বরাদ্দপত্রে QR কোড থাকে — যে কেউ অনলাইনে যাচাই করতে পারেন।',
          ),
        },
        {
          icon: 'building',
          title: t('Your own customer portal', 'নিজস্ব কাস্টমার পোর্টাল'),
          body: t(
            'Installments, dues, receipts and documents — all in one place, in Bangla or English.',
            'কিস্তি, বকেয়া, রসিদ ও কাগজপত্র — সব এক জায়গায়, বাংলা বা ইংরেজিতে।',
          ),
        },
      ],
    },
    leaderMessage: {
      eyebrow: t('From the chairman', 'চেয়ারম্যানের বার্তা'),
    },
    team: {
      eyebrow: t('Leadership', 'নেতৃত্ব'),
      title: t('The people behind {company}', '{company}-এর নেপথ্যে যাঁরা'),
      items: [],
    },
    quality: {
      eyebrow: t('How we build', 'যেভাবে গড়ি'),
      title: t('Construction standards', 'নির্মাণের মান'),
      body: t(
        'What goes into every building — checked by our engineers at each stage.',
        'প্রতিটি ভবনে যা থাকে — প্রতিটি ধাপে আমাদের প্রকৌশলীদের যাচাই করা।',
      ),
      items: [
        {
          icon: 'ruler',
          title: t('Soil test first', 'আগে মাটি পরীক্ষা'),
          body: t(
            'Every design starts from a soil investigation of the plot, which decides the foundation and piling.',
            'প্রতিটি নকশা শুরু হয় প্লটের মাটি পরীক্ষা দিয়ে — তার ভিত্তিতেই ফাউন্ডেশন ও পাইলিং ঠিক হয়।',
          ),
        },
        {
          icon: 'hard-hat',
          title: t('Structural design to BNBC', 'BNBC অনুযায়ী কাঠামো'),
          body: t(
            'Designed by registered structural engineers to the Bangladesh National Building Code, including earthquake and wind loads.',
            'নিবন্ধিত কাঠামো প্রকৌশলীর নকশা, বাংলাদেশ জাতীয় ইমারত নির্মাণ বিধিমালা অনুযায়ী — ভূমিকম্প ও বাতাসের চাপসহ।',
          ),
        },
        {
          icon: 'building',
          title: t('Graded materials', 'মানসম্পন্ন উপকরণ'),
          body: t(
            'Graded reinforcing steel and cement from established manufacturers; concrete cylinders tested from each casting.',
            'প্রতিষ্ঠিত উৎপাদকের গ্রেডেড রড ও সিমেন্ট; প্রতিটি ঢালাইয়ের কংক্রিট সিলিন্ডার পরীক্ষা।',
          ),
        },
        {
          icon: 'eye',
          title: t('Supervised workmanship', 'তদারকিতে কাজ'),
          body: t(
            'An engineer signs off reinforcement before every casting and checks finishing floor by floor.',
            'প্রতিটি ঢালাইয়ের আগে প্রকৌশলী রডের কাজ যাচাই করেন, আর তলা ধরে ধরে ফিনিশিং দেখেন।',
          ),
        },
        {
          icon: 'shield-check',
          title: t('Fire and electrical safety', 'অগ্নি ও বৈদ্যুতিক নিরাপত্তা'),
          body: t(
            'Fire exits and protection as required by code, proper earthing and protected wiring.',
            'বিধি অনুযায়ী অগ্নি-নির্গমন পথ ও সুরক্ষা, যথাযথ আর্থিং আর সুরক্ষিত ওয়্যারিং।',
          ),
        },
        {
          icon: 'droplets',
          title: t('Water and services', 'পানি ও সেবা'),
          body: t(
            'Underground and overhead reservoirs, planned drainage and space for generator and substation.',
            'ভূগর্ভস্থ ও ছাদের পানির ট্যাংক, পরিকল্পিত ড্রেনেজ আর জেনারেটর ও সাবস্টেশনের জায়গা।',
          ),
        },
      ],
    },
    completed: {
      eyebrow: t('Delivered', 'হস্তান্তরিত'),
      title: t('Completed projects', 'সম্পন্ন প্রজেক্ট'),
    },
    credentials: {
      eyebrow: t('Registration', 'নিবন্ধন'),
      title: t('Licences and membership', 'লাইসেন্স ও সদস্যপদ'),
      items: [],
    },
    awards: {
      eyebrow: t('Recognition', 'স্বীকৃতি'),
      title: t('Awards', 'পুরস্কার'),
      items: [],
    },
    csr: {
      eyebrow: t('Community', 'সমাজের জন্য'),
      title: t('Beyond building', 'নির্মাণের বাইরেও'),
      items: [],
    },
    cta: {
      title: t('Come and see for yourself', 'নিজে এসে দেখে যান'),
      body: t(
        'Visit a site with our team, or start by browsing all our projects.',
        'আমাদের টিমের সাথে সাইট ভিজিট করুন, অথবা সব প্রজেক্ট দেখে শুরু করুন।',
      ),
      label: t('All projects', 'সব প্রজেক্ট'),
      href: '/projects',
    },
  },
};

/** Parsed defaults: page → section key → full data (every field present). */
export const DEFAULTS = Object.freeze(
  Object.fromEntries(
    Object.entries(PAGES).map(([page, sections]) => [
      page,
      Object.freeze(
        Object.fromEntries(
          sections.map(([key, type]) => [key, SECTION_TYPES[type].parse(RAW[page]?.[key] ?? {})]),
        ),
      ),
    ]),
  ),
);

/** A page's default section list (all enabled, in the standard order). */
export const defaultSections = (page) =>
  PAGES[page].map(([key]) => ({ key, enabled: true, data: structuredClone(DEFAULTS[page][key]) }));
