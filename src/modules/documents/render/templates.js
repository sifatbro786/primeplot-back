import { amountInWords, formatTaka, toBnDigits } from '#shared/utils/money.js';
import { fontFaceCss } from './fonts.js';

/**
 * A4 document templates (B4.3) — one HTML page per document, used both as the print page and
 * as the Puppeteer PDF source (D1). Everything printed comes from the frozen `snapshot`; every
 * interpolated value is escaped. Bangla (bn) and English (en) share one layout.
 */

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// ── Labels ──────────────────────────────────────────────────────────────────────

const L = {
  en: {
    receipt: 'Money receipt',
    booking_form: 'Booking confirmation',
    allotment_letter: 'Allotment letter',
    statement: 'Statement of account',
    cancellation_letter: 'Cancellation letter',
    transfer_letter: 'Transfer letter',
    cheque_ack: 'Cheque acknowledgement',
    no: 'No.',
    date: 'Date',
    receivedFrom: 'Received with thanks from',
    customerNo: 'Customer no.',
    amount: 'Amount',
    inWords: 'In words',
    mode: 'Paid by',
    modes: {
      cash: 'Cash',
      bank_transfer: 'Bank transfer',
      pay_order: 'Pay order',
      cheque: 'Cheque',
      online: 'Online payment',
      slip: 'Bank deposit',
    },
    towards: 'Towards',
    project: 'Project',
    unit: 'Unit',
    plot: 'Plot',
    booking: 'Booking no.',
    bookingDate: 'Booking date',
    reference: 'Reference',
    instrument: 'Instrument no.',
    bank: 'Bank',
    account: 'Credited to',
    contract: 'Contract price',
    paidToDate: 'Paid to date',
    outstanding: 'Outstanding',
    charges: 'Other charges',
    receivedBy: 'Received by',
    authorised: 'Authorised signature',
    customerSig: 'Customer signature',
    applicant: 'Applicant',
    coApplicant: 'Co-applicant',
    father: 'Father',
    mother: 'Mother',
    phone: 'Phone',
    email: 'E-mail',
    nid: 'NID',
    passport: 'Passport',
    address: 'Present address',
    permanent: 'Permanent address',
    foreign: 'Address abroad',
    unitDetails: 'Property',
    floor: 'Floor',
    type: 'Type',
    size: 'Size',
    facing: 'Facing',
    road: 'Road',
    parking: 'Parking',
    price: 'Price',
    discount: 'Discount',
    listTotal: 'List price',
    schedule: 'Payment schedule',
    due: 'Due date',
    whenCalled: 'When called',
    paid: 'Paid',
    remaining: 'Remaining',
    status: 'Status',
    nominees: 'Nominees',
    relation: 'Relation',
    share: 'Share',
    plan: 'Payment plan',
    custom: 'Custom schedule',
    asOf: 'As of',
    entries: 'Payments',
    overdue: 'Overdue',
    refunded: 'Refunded',
    total: 'Total',
    verify: 'Scan to verify this document',
    issued: 'Issued',
    hash: 'Fingerprint',
    void: 'VOID',
    statuses: {
      paid: 'Paid',
      partial: 'Part paid',
      due: 'Due',
      overdue: 'Overdue',
      upcoming: 'Upcoming',
      not_called: 'Not called',
    },
    ledgerTypes: { receipt: 'Receipt', reversal: 'Reversed', refund: 'Refund' },
    chequeNo: 'Cheque no.',
    chequeDate: 'Cheque date',
    branch: 'Branch',
    chequeNote:
      'This acknowledges that the cheque is in our hands. It is not a money receipt: the receipt is issued when the cheque is honoured by the bank.',
    sqft: 'sq ft',
    sqm: 'sq m',
    katha: 'katha',
    decimal: 'decimal',
    corner: 'Corner',
    yes: 'Yes',
    dear: 'Dear',
    subject: 'Subject',
    allotIntro: (d) =>
      `We are pleased to allot the property described below in ${d.project} to you against booking no. ${d.booking}, subject to the terms of the booking and timely payment of the remaining instalments.`,
    allotClose:
      'Registration of the property will be done after the full price and all charges have been paid.',
    cancelIntro: (d) =>
      `Booking no. ${d.booking} for ${d.unit} in ${d.project} has been cancelled on ${d.date}.`,
    reason: 'Reason',
    deduction: 'Deduction',
    refundable: 'Refundable amount',
    cancelClose:
      'The refundable amount will be paid as per company policy. Please bring this letter and the original money receipts when collecting it.',
    transferIntro: (d) =>
      `Booking no. ${d.booking} for ${d.unit} in ${d.project} has been transferred on ${d.date}.`,
    from: 'From',
    to: 'To',
    fee: 'Transfer fee',
    waived: 'waived',
    transferClose:
      'All rights and obligations under the booking, including the remaining payments, now belong to the new holder.',
    waivedBookingMoney: 'Booking money waived',
    lineLabels: {
      base: 'Base price',
      floor_rise: 'Floor rise',
      facing: 'Facing premium',
      corner: 'Corner premium',
      parking: 'Car parking',
      road_width: 'Road width premium',
      adjustment: 'Adjustment',
    },
    page: 'Page',
  },
  bn: {
    receipt: 'মানি রসিদ',
    booking_form: 'বুকিং নিশ্চিতকরণ',
    allotment_letter: 'বরাদ্দপত্র',
    statement: 'হিসাব বিবরণী',
    cancellation_letter: 'বাতিলপত্র',
    transfer_letter: 'হস্তান্তরপত্র',
    cheque_ack: 'চেক প্রাপ্তি স্বীকার',
    no: 'নং',
    date: 'তারিখ',
    receivedFrom: 'ধন্যবাদের সাথে গ্রহণ করা হলো',
    customerNo: 'গ্রাহক নং',
    amount: 'টাকার পরিমাণ',
    inWords: 'কথায়',
    mode: 'পরিশোধের মাধ্যম',
    modes: {
      cash: 'নগদ',
      bank_transfer: 'ব্যাংক ট্রান্সফার',
      pay_order: 'পে-অর্ডার',
      cheque: 'চেক',
      online: 'অনলাইন পেমেন্ট',
      slip: 'ব্যাংক জমা',
    },
    towards: 'যে খাতে',
    project: 'প্রকল্প',
    unit: 'ইউনিট',
    plot: 'প্লট',
    booking: 'বুকিং নং',
    bookingDate: 'বুকিংয়ের তারিখ',
    reference: 'রেফারেন্স',
    instrument: 'ইনস্ট্রুমেন্ট নং',
    bank: 'ব্যাংক',
    account: 'জমা হয়েছে',
    contract: 'চুক্তিমূল্য',
    paidToDate: 'এ পর্যন্ত পরিশোধ',
    outstanding: 'বকেয়া',
    charges: 'অন্যান্য চার্জ',
    receivedBy: 'গ্রহণকারী',
    authorised: 'অনুমোদিত স্বাক্ষর',
    customerSig: 'গ্রাহকের স্বাক্ষর',
    applicant: 'আবেদনকারী',
    coApplicant: 'সহ-আবেদনকারী',
    father: 'পিতা',
    mother: 'মাতা',
    phone: 'ফোন',
    email: 'ই-মেইল',
    nid: 'জাতীয় পরিচয়পত্র',
    passport: 'পাসপোর্ট',
    address: 'বর্তমান ঠিকানা',
    permanent: 'স্থায়ী ঠিকানা',
    foreign: 'প্রবাসের ঠিকানা',
    unitDetails: 'সম্পত্তির বিবরণ',
    floor: 'তলা',
    type: 'ধরন',
    size: 'আয়তন',
    facing: 'দিক',
    road: 'রাস্তা',
    parking: 'পার্কিং',
    price: 'মূল্য',
    discount: 'ছাড়',
    listTotal: 'তালিকামূল্য',
    schedule: 'পরিশোধ সূচি',
    due: 'পরিশোধের তারিখ',
    whenCalled: 'ঘোষণা সাপেক্ষে',
    paid: 'পরিশোধিত',
    remaining: 'বাকি',
    status: 'অবস্থা',
    nominees: 'নমিনি',
    relation: 'সম্পর্ক',
    share: 'অংশ',
    plan: 'পরিশোধ পরিকল্পনা',
    custom: 'বিশেষ সূচি',
    asOf: 'তারিখ পর্যন্ত',
    entries: 'পরিশোধসমূহ',
    overdue: 'মেয়াদোত্তীর্ণ',
    refunded: 'ফেরত',
    total: 'মোট',
    verify: 'যাচাই করতে স্ক্যান করুন',
    issued: 'ইস্যু',
    hash: 'ফিঙ্গারপ্রিন্ট',
    void: 'বাতিল',
    statuses: {
      paid: 'পরিশোধিত',
      partial: 'আংশিক',
      due: 'আজ দেয়',
      overdue: 'মেয়াদোত্তীর্ণ',
      upcoming: 'আসন্ন',
      not_called: 'ঘোষণা হয়নি',
    },
    ledgerTypes: { receipt: 'রসিদ', reversal: 'বাতিল রসিদ', refund: 'ফেরত' },
    chequeNo: 'চেক নং',
    chequeDate: 'চেকের তারিখ',
    branch: 'শাখা',
    chequeNote:
      'এই চেকটি আমাদের হাতে পৌঁছেছে — এটি তার স্বীকৃতি, মানি রসিদ নয়। ব্যাংকে চেক নগদায়ন হলে মানি রসিদ দেওয়া হবে।',
    sqft: 'বর্গফুট',
    sqm: 'বর্গমিটার',
    katha: 'কাঠা',
    decimal: 'শতাংশ',
    corner: 'কর্নার',
    yes: 'হ্যাঁ',
    dear: 'প্রিয়',
    subject: 'বিষয়',
    allotIntro: (d) =>
      `বুকিং নং ${d.booking}-এর বিপরীতে ${d.project} প্রকল্পের নিচে বর্ণিত সম্পত্তি আপনার নামে বরাদ্দ দেওয়া হলো। বুকিংয়ের শর্তাবলি ও অবশিষ্ট কিস্তি যথাসময়ে পরিশোধ সাপেক্ষে এই বরাদ্দ বহাল থাকবে।`,
    allotClose: 'সম্পূর্ণ মূল্য ও সকল চার্জ পরিশোধের পর সম্পত্তির রেজিস্ট্রেশন সম্পন্ন করা হবে।',
    cancelIntro: (d) =>
      `${d.project} প্রকল্পের ${d.unit}-এর বুকিং (নং ${d.booking}) ${d.date} তারিখে বাতিল করা হয়েছে।`,
    reason: 'কারণ',
    deduction: 'কর্তন',
    refundable: 'ফেরতযোগ্য অর্থ',
    cancelClose:
      'ফেরতযোগ্য অর্থ কোম্পানির নীতিমালা অনুযায়ী পরিশোধ করা হবে। অর্থ গ্রহণের সময় এই পত্র ও মূল মানি রসিদগুলো সঙ্গে আনবেন।',
    transferIntro: (d) =>
      `${d.project} প্রকল্পের ${d.unit}-এর বুকিং (নং ${d.booking}) ${d.date} তারিখে হস্তান্তর করা হয়েছে।`,
    from: 'পূর্বের মালিক',
    to: 'নতুন মালিক',
    fee: 'হস্তান্তর ফি',
    waived: 'মওকুফ',
    transferClose: 'বুকিংয়ের সকল অধিকার ও দায়, অবশিষ্ট কিস্তিসহ, এখন থেকে নতুন মালিকের।',
    waivedBookingMoney: 'বুকিং মানি মওকুফ',
    lineLabels: {
      base: 'মূল দাম',
      floor_rise: 'তলা অনুযায়ী বৃদ্ধি',
      facing: 'দিক অনুযায়ী প্রিমিয়াম',
      corner: 'কর্নার প্রিমিয়াম',
      parking: 'গাড়ি পার্কিং',
      road_width: 'রাস্তার প্রশস্ততা প্রিমিয়াম',
      adjustment: 'সমন্বয়',
    },
    page: 'পৃষ্ঠা',
  },
};

const FACING = {
  en: {
    north: 'North',
    south: 'South',
    east: 'East',
    west: 'West',
    north_east: 'North-east',
    north_west: 'North-west',
    south_east: 'South-east',
    south_west: 'South-west',
  },
  bn: {
    north: 'উত্তর',
    south: 'দক্ষিণ',
    east: 'পূর্ব',
    west: 'পশ্চিম',
    north_east: 'উত্তর-পূর্ব',
    north_west: 'উত্তর-পশ্চিম',
    south_east: 'দক্ষিণ-পূর্ব',
    south_west: 'দক্ষিণ-পশ্চিম',
  },
};

// ── Formatting helpers ──────────────────────────────────────────────────────────

function fmt(locale) {
  const bn = locale === 'bn';
  const dateFmt = new Intl.DateTimeFormat(bn ? 'bn-BD' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return {
    bn,
    t: L[bn ? 'bn' : 'en'],
    num: (n) => (bn ? toBnDigits(n) : String(n)),
    money: (p) => `৳ ${formatTaka(p, { bn })}`,
    words: (p) => amountInWords(Math.abs(p), bn ? 'bn' : 'en'),
    date: (d) => (d ? esc(dateFmt.format(new Date(`${d}T00:00:00Z`))) : '—'),
    pick: (en, bnText) => (bn && bnText ? bnText : en),
  };
}

const row = (k, v) => (v || v === 0 ? `<tr><th>${k}</th><td>${v}</td></tr>` : '');

function orgName(o, f) {
  return esc(f.pick(o.name, o.nameBn));
}

function unitTitle(s, f) {
  const u = s.unit;
  return u.kind === 'plot'
    ? `${f.t.plot} ${esc(u.plotNo ?? u.code)}`
    : `${f.t.unit} ${esc(u.code)}`;
}

function projectName(s, f) {
  return esc(f.pick(s.project.name, s.project.nameBn));
}

function unitBlock(s, f) {
  const u = s.unit;
  const area =
    u.kind === 'plot' && u.landArea
      ? `${f.num(u.landArea.katha)} ${f.t.katha} · ${f.num(u.landArea.decimal)} ${f.t.decimal}`
      : u.saleableSqft
        ? `${f.num(u.saleableSqft)} ${f.t.sqft} · ${f.num(u.saleableSqm)} ${f.t.sqm}`
        : null;
  return `<table class="kv">
    ${row(f.t.project, projectName(s, f))}
    ${row(u.kind === 'plot' ? f.t.plot : f.t.unit, `<b>${esc(u.code)}</b>${u.blockName ? ` · ${esc(u.blockName)}` : ''}`)}
    ${u.kind === 'plot' ? row(f.t.road, u.road ? `${esc(u.road)}${u.roadWidthFt ? ` (${f.num(u.roadWidthFt)} ft)` : ''}` : null) : row(f.t.floor, (u.floor ?? u.floor === 0) ? f.num(u.floor) : null)}
    ${row(f.t.type, u.typeLabel ? esc(u.typeLabel) : null)}
    ${row(f.t.size, area)}
    ${row(f.t.facing, u.facing ? FACING[f.bn ? 'bn' : 'en'][u.facing] : null)}
    ${row(f.t.corner, u.isCorner ? f.t.yes : null)}
    ${row(f.t.parking, u.parkingSlots ? f.num(u.parkingSlots) : null)}
  </table>`;
}

function personBlock(p, f, title) {
  if (!p) return '';
  return `<div class="person"><div class="eyebrow">${title}</div>
  <div class="pname">${esc(f.pick(p.name, p.nameBn))}${p.customerNo ? ` <span class="muted mono">${esc(p.customerNo)}</span>` : ''}</div>
  <table class="kv">
    ${row(f.t.father, p.fatherName ? esc(p.fatherName) : null)}
    ${row(f.t.mother, p.motherName ? esc(p.motherName) : null)}
    ${row(f.t.phone, `<span class="mono">${esc(p.phone)}</span>`)}
    ${row(f.t.email, p.email ? esc(p.email) : null)}
    ${row(f.t.nid, p.nid ? `<span class="mono">${esc(p.nid)}</span>` : null)}
    ${row(f.t.passport, p.passportNo ? `<span class="mono">${esc(p.passportNo)}</span>` : null)}
    ${row(f.t.address, p.presentAddress ? esc(p.presentAddress) : null)}
    ${row(f.t.permanent, p.permanentAddress ? esc(p.permanentAddress) : null)}
    ${row(f.t.foreign, p.foreignAddress ? esc(p.foreignAddress) : null)}
  </table></div>`;
}

function lineLabel(l, f) {
  if (l.code.startsWith('charge:')) return esc(f.pick(l.label, l.labelBn));
  return f.t.lineLabels[l.code] ?? esc(l.code);
}

function scheduleTable(items, f, { withPaid = false } = {}) {
  const rows = items
    .map(
      (i) => `<tr>
      <td class="num">${f.num(i.seq)}</td>
      <td>${esc(f.pick(i.label, i.labelBn))}</td>
      <td>${i.dueDate ? f.date(i.dueDate) : `<span class="muted">${f.t.whenCalled}</span>`}</td>
      <td class="num">${f.money(i.amount)}</td>
      ${withPaid ? `<td class="num">${f.money(i.paid ?? 0)}</td><td class="num">${f.money(i.remaining ?? i.amount - (i.paid ?? 0))}</td><td>${f.t.statuses[i.status] ?? ''}</td>` : ''}
    </tr>`,
    )
    .join('');
  const total = items.reduce((s, i) => s + i.amount, 0);
  const paid = items.reduce((s, i) => s + (i.paid ?? 0), 0);
  return `<table class="grid">
    <thead><tr><th class="num">#</th><th></th><th>${f.t.due}</th><th class="num">${f.t.amount}</th>
    ${withPaid ? `<th class="num">${f.t.paid}</th><th class="num">${f.t.remaining}</th><th>${f.t.status}</th>` : ''}</tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td></td><td>${f.t.total}</td><td></td><td class="num">${f.money(total)}</td>
    ${withPaid ? `<td class="num">${f.money(paid)}</td><td class="num">${f.money(total - paid)}</td><td></td>` : ''}</tr></tfoot>
  </table>`;
}

function totalsStrip(tot, f) {
  if (!tot) return '';
  return `<div class="strip">
    <div><span>${f.t.contract}</span><b>${f.money(tot.contract)}</b></div>
    ${tot.charges ? `<div><span>${f.t.charges}</span><b>${f.money(tot.charges)}</b></div>` : ''}
    <div><span>${f.t.paidToDate}</span><b>${f.money(tot.paidToDate)}</b></div>
    <div class="accent"><span>${f.t.outstanding}</span><b>${f.money(tot.outstanding)}</b></div>
  </div>`;
}

const signatures = (f, left = f.t.customerSig) =>
  `<div class="sigs"><div>${left}</div><div>${f.t.authorised}</div></div>`;

// ── Bodies per type ─────────────────────────────────────────────────────────────

const BODY = {
  receipt(s, f) {
    const r = s.receipt;
    const instrument = [
      r.instrumentNo && `${f.t.instrument}: <span class="mono">${esc(r.instrumentNo)}</span>`,
      r.instrumentBank && `${f.t.bank}: ${esc(r.instrumentBank)}`,
      r.instrumentDate && `${f.t.date}: ${f.date(r.instrumentDate)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    return `
    <section class="lead">
      <div class="eyebrow">${f.t.receivedFrom}</div>
      <div class="pname big">${esc(f.pick(s.holder.name, s.holder.nameBn))}</div>
      <div class="muted">${f.t.customerNo} <span class="mono">${esc(s.holder.customerNo)}</span> · ${f.t.booking} <span class="mono">${esc(s.booking.bookingNo)}</span> · ${unitTitle(s, f)}, ${projectName(s, f)}</div>
    </section>
    <section class="amount">
      <div class="figure">${f.money(r.amount)}</div>
      <div class="words"><span class="muted">${f.t.inWords}:</span> ${esc(f.words(r.amount))}</div>
    </section>
    <table class="kv wide">
      ${row(f.t.mode, f.t.modes[r.mode] ?? esc(r.mode))}
      ${row(f.t.instrument, instrument || null)}
      ${row(f.t.reference, r.reference ? `<span class="mono">${esc(r.reference)}</span>` : null)}
      ${row(f.t.account, r.bankAccount ? `${esc(r.bankAccount.bankName)} — <span class="mono">${esc(r.bankAccount.accountNo)}</span>` : null)}
      ${row(f.t.towards, r.allocations.map((a) => `${esc(f.pick(a.label, a.labelBn))} <span class="muted">(${f.money(a.amount)})</span>`).join('<br>'))}
      ${row(f.t.receivedBy, r.receivedByName ? esc(r.receivedByName) : null)}
    </table>
    ${totalsStrip(s.totals, f)}
    ${signatures(f)}`;
  },

  cheque_ack(s, f) {
    const c = s.cheque;
    return `
    <section class="lead">
      <div class="eyebrow">${f.t.receivedFrom}</div>
      <div class="pname big">${esc(f.pick(s.holder.name, s.holder.nameBn))}</div>
      <div class="muted">${f.t.booking} <span class="mono">${esc(s.booking.bookingNo)}</span> · ${unitTitle(s, f)}, ${projectName(s, f)}</div>
    </section>
    <section class="amount">
      <div class="figure">${f.money(c.amount)}</div>
      <div class="words"><span class="muted">${f.t.inWords}:</span> ${esc(f.words(c.amount))}</div>
    </section>
    <table class="kv wide">
      ${row(f.t.chequeNo, `<span class="mono">${esc(c.chequeNo)}</span>`)}
      ${row(f.t.bank, esc(c.bank))}
      ${row(f.t.branch, c.branch ? esc(c.branch) : null)}
      ${row(f.t.chequeDate, f.date(c.chequeDate))}
    </table>
    <p class="note">${f.t.chequeNote}</p>
    ${signatures(f)}`;
  },

  booking_form(s, f) {
    const p = s.price;
    const lines = p.lines
      .map((l) => `<tr><td>${lineLabel(l, f)}</td><td class="num">${f.money(l.amount)}</td></tr>`)
      .join('');
    return `
    <div class="cols">
      ${personBlock(s.holder, f, f.t.applicant)}
      <div><div class="eyebrow">${f.t.unitDetails}</div>${unitBlock(s, f)}
      <table class="kv">${row(f.t.bookingDate, f.date(s.booking.bookingDate))}${row(f.t.plan, esc(s.planName ?? f.t.custom))}</table></div>
    </div>
    ${(s.coApplicants ?? []).map((c) => personBlock(c, f, f.t.coApplicant)).join('')}
    <div class="eyebrow">${f.t.price}</div>
    <table class="grid compact"><tbody>${lines}
      ${p.discount ? `<tr><td>${f.t.discount}</td><td class="num">− ${f.money(p.discount)}</td></tr>` : ''}
    </tbody><tfoot><tr><td>${f.t.contract}</td><td class="num">${f.money(p.contractTotal)}</td></tr></tfoot></table>
    <div class="words small"><span class="muted">${f.t.inWords}:</span> ${esc(f.words(p.contractTotal))}</div>
    <div class="eyebrow">${f.t.schedule}</div>
    ${scheduleTable(s.schedule, f)}
    ${s.bookingMoneyWaived ? `<p class="note">${f.t.waivedBookingMoney}: ${esc(s.bookingMoneyWaived)}</p>` : ''}
    ${
      s.nominees?.length
        ? `<div class="eyebrow">${f.t.nominees}</div><table class="grid compact"><thead><tr><th></th><th>${f.t.relation}</th><th>${f.t.nid}</th><th class="num">${f.t.share}</th></tr></thead><tbody>${s.nominees
            .map(
              (n) =>
                `<tr><td>${esc(n.name)}</td><td>${esc(n.relation)}</td><td class="mono">${esc(n.nid ?? '')}</td><td class="num">${f.num(n.sharePct)}%</td></tr>`,
            )
            .join('')}</tbody></table>`
        : ''
    }
    ${signatures(f)}`;
  },

  allotment_letter(s, f) {
    const d = {
      project: projectName(s, f),
      booking: esc(s.booking.bookingNo),
    };
    return `
    <p>${f.t.dear} ${esc(f.pick(s.holder.name, s.holder.nameBn))},</p>
    <p class="subject"><b>${f.t.subject}:</b> ${f.t.allotment_letter} — ${unitTitle(s, f)}, ${projectName(s, f)}</p>
    <p>${f.t.allotIntro(d)}</p>
    ${unitBlock(s, f)}
    ${totalsStrip(s.totals, f)}
    <p>${f.t.allotClose}</p>
    ${signatures(f)}`;
  },

  statement(s, f) {
    const entries = s.entries
      .map(
        (e) =>
          `<tr><td>${f.date(e.date)}</td><td>${f.t.ledgerTypes[e.type] ?? esc(e.type)}</td><td class="mono">${esc(e.ref ?? '')}</td><td class="num">${f.money(e.amount)}</td></tr>`,
      )
      .join('');
    return `
    <div class="cols">
      <div><div class="eyebrow">${f.t.applicant}</div><div class="pname">${esc(f.pick(s.holder.name, s.holder.nameBn))}</div>
      <div class="muted">${f.t.customerNo} <span class="mono">${esc(s.holder.customerNo)}</span> · <span class="mono">${esc(s.holder.phone)}</span></div></div>
      <div><table class="kv">${row(f.t.project, projectName(s, f))}${row(f.t.unit, `<b>${esc(s.unit.code)}</b>`)}${row(f.t.booking, `<span class="mono">${esc(s.booking.bookingNo)}</span>`)}${row(f.t.asOf, f.date(s.asOf))}</table></div>
    </div>
    <div class="strip">
      <div><span>${f.t.total}</span><b>${f.money(s.totals.total)}</b></div>
      <div><span>${f.t.paid}</span><b>${f.money(s.totals.paid)}</b></div>
      <div class="accent"><span>${f.t.outstanding}</span><b>${f.money(s.totals.outstanding)}</b></div>
      <div><span>${f.t.overdue}</span><b>${f.money(s.totals.overdue)}</b></div>
    </div>
    <div class="eyebrow">${f.t.schedule}</div>
    ${scheduleTable(s.schedule, f, { withPaid: true })}
    <div class="eyebrow">${f.t.entries}</div>
    <table class="grid compact"><thead><tr><th>${f.t.date}</th><th></th><th>${f.t.no}</th><th class="num">${f.t.amount}</th></tr></thead><tbody>${entries || '<tr><td colspan="4" class="muted">—</td></tr>'}</tbody></table>
    ${s.refunded ? `<p class="note">${f.t.refunded}: ${f.money(s.refunded)}</p>` : ''}`;
  },

  cancellation_letter(s, f) {
    const c = s.cancellation;
    const d = {
      project: projectName(s, f),
      booking: esc(s.booking.bookingNo),
      unit: unitTitle(s, f),
      date: f.date(c.date),
    };
    return `
    <p>${f.t.dear} ${esc(f.pick(s.holder.name, s.holder.nameBn))},</p>
    <p class="subject"><b>${f.t.subject}:</b> ${f.t.cancellation_letter} — ${unitTitle(s, f)}</p>
    <p>${f.t.cancelIntro(d)}</p>
    <table class="kv wide">
      ${row(f.t.reason, esc(c.reason))}
      ${row(f.t.paidToDate, f.money(c.paid))}
      ${row(f.t.deduction, `${f.money(c.deduction)}${c.deductionBps != null ? ` <span class="muted">(${f.num(c.deductionBps / 100)}%)</span>` : ''}`)}
      ${row(f.t.refundable, `<b>${f.money(c.refundable)}</b>`)}
      ${row(f.t.inWords, esc(f.words(c.refundable)))}
    </table>
    <p>${f.t.cancelClose}</p>
    ${signatures(f)}`;
  },

  transfer_letter(s, f) {
    const t = s.transfer;
    const d = {
      project: projectName(s, f),
      booking: esc(s.booking.bookingNo),
      unit: unitTitle(s, f),
      date: f.date(t.date),
    };
    return `
    <p class="subject"><b>${f.t.subject}:</b> ${f.t.transfer_letter} — ${unitTitle(s, f)}</p>
    <p>${f.t.transferIntro(d)}</p>
    <div class="cols">
      ${personBlock(t.from, f, f.t.from)}
      ${personBlock(t.to, f, f.t.to)}
    </div>
    <table class="kv wide">
      ${row(f.t.fee, t.feeWaivedReason ? `${f.t.waived} — ${esc(t.feeWaivedReason)}` : f.money(t.fee))}
    </table>
    ${totalsStrip(s.totals, f)}
    <p>${f.t.transferClose}</p>
    <div class="sigs three"><div>${f.t.from}</div><div>${f.t.to}</div><div>${f.t.authorised}</div></div>`;
  },
};

/** The date shown under the document number. */
export function mainDate(type, s) {
  switch (type) {
    case 'receipt':
      return s.receipt.date;
    case 'cheque_ack':
      return s.cheque.receivedDate;
    case 'allotment_letter':
      return s.allotment.date;
    case 'statement':
      return s.asOf;
    case 'cancellation_letter':
      return s.cancellation.date;
    case 'transfer_letter':
      return s.transfer.date;
    default:
      return s.booking.bookingDate;
  }
}

// ── Page ────────────────────────────────────────────────────────────────────────

const CSS = `
:root{--ink:#1C1D1A;--muted:#666861;--line:#E5E3DF;--olive:#2D3228;--sage:#6B705C;--paper:#F2EDE3;--tint:#E3E6D8}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;color:var(--ink);font:400 10.5pt/1.55 'Plus Jakarta Sans','Hind Siliguri',sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body.bn{font-family:'Hind Siliguri','Plus Jakarta Sans',sans-serif;font-size:11pt}
@page{size:A4;margin:14mm 14mm 16mm}
.sheet{position:relative;width:210mm;min-height:297mm;margin:12mm auto;padding:14mm 14mm 16mm;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 30px rgba(45,50,40,.10)}
@media print{html{background:#fff}.sheet{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}}
.mast{display:flex;justify-content:space-between;gap:10mm;align-items:flex-start;padding-bottom:5mm;border-bottom:1.5pt solid var(--olive)}
.brand{display:flex;gap:4mm;align-items:center;min-width:0}
.brand img{max-height:16mm;max-width:30mm;object-fit:contain}
.org{font:600 17pt/1.2 'Playfair Display','Hind Siliguri',serif;color:var(--olive);letter-spacing:.005em}
body.bn .org{font-family:'Hind Siliguri',serif;font-weight:600}
.org-meta{font-size:8pt;color:var(--muted);line-height:1.45}
.docid{text-align:right;flex:none}
.docid .title{font:600 8pt/1 'Plus Jakarta Sans','Hind Siliguri',sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--sage)}
body.bn .docid .title{letter-spacing:0;font-size:10pt}
.docid .number{font:600 13pt/1.3 'Plus Jakarta Sans',monospace;font-variant-numeric:tabular-nums;margin-top:2mm}
.docid .date{font-size:9pt;color:var(--muted)}
main{padding-top:6mm}
.eyebrow{font-size:7.5pt;letter-spacing:.14em;text-transform:uppercase;color:var(--sage);font-weight:600;margin:5mm 0 1.5mm}
body.bn .eyebrow{letter-spacing:0;font-size:9pt}
.lead .eyebrow{margin-top:0}
.pname{font-weight:600;font-size:12pt}
.pname.big{font:600 18pt/1.25 'Playfair Display','Hind Siliguri',serif;color:var(--olive)}
body.bn .pname.big{font-family:'Hind Siliguri',serif}
.muted{color:var(--muted)}
.mono{font-variant-numeric:tabular-nums;letter-spacing:.01em}
.amount{margin:6mm 0 4mm;padding:5mm 6mm;background:var(--tint);border-left:3pt solid var(--olive)}
.figure{font:600 22pt/1.1 'Plus Jakarta Sans',sans-serif;font-variant-numeric:tabular-nums;color:var(--olive)}
.words{margin-top:1.5mm;font-size:10pt}
.words.small{font-size:9pt;margin:1.5mm 0 0}
table{border-collapse:collapse;width:100%}
.kv th{width:36mm;text-align:left;font-weight:400;color:var(--muted);padding:1.1mm 3mm 1.1mm 0;vertical-align:top;font-size:9pt}
.kv td{padding:1.1mm 0;vertical-align:top}
.kv.wide th{width:42mm}
.grid{font-size:9pt;margin-top:1mm}
.grid th{font-weight:600;color:var(--muted);text-align:left;border-bottom:.75pt solid var(--ink);padding:1.4mm 2mm}
.grid td{border-bottom:.5pt solid var(--line);padding:1.3mm 2mm;vertical-align:top}
.grid tfoot td{border-top:.75pt solid var(--ink);border-bottom:none;font-weight:600}
.grid .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.grid tr{page-break-inside:avoid}
.compact td,.compact th{padding:1mm 2mm}
.strip{display:flex;gap:0;margin:5mm 0;border:.75pt solid var(--line)}
.strip>div{flex:1;padding:2.5mm 3.5mm;border-right:.75pt solid var(--line)}
.strip>div:last-child{border-right:none}
.strip span{display:block;font-size:7.5pt;color:var(--muted);letter-spacing:.06em;text-transform:uppercase}
body.bn .strip span{letter-spacing:0;font-size:8.5pt}
.strip b{font-variant-numeric:tabular-nums;font-size:10.5pt}
.strip .accent{background:var(--olive);color:#fff}.strip .accent span{color:#D9DCCD}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:8mm}
.person{margin-bottom:2mm}
.subject{margin:4mm 0}
.note{font-size:9pt;color:var(--muted);border-top:.5pt dashed var(--line);padding-top:2mm;margin-top:4mm}
.sigs{display:flex;justify-content:space-between;gap:20mm;margin-top:20mm;page-break-inside:avoid}
.sigs>div{flex:1;border-top:.75pt solid var(--ink);padding-top:1.5mm;font-size:8.5pt;color:var(--muted);text-align:center}
.verify{display:flex;gap:4mm;align-items:center;margin-top:10mm;padding-top:4mm;border-top:.5pt solid var(--line);page-break-inside:avoid}
.verify .qr{width:22mm;height:22mm;flex:none}.verify .qr svg{width:100%;height:100%}
.verify .vtext{font-size:7.5pt;color:var(--muted);line-height:1.5;word-break:break-all}
.verify .vtext b{color:var(--ink);font-size:8.5pt;font-weight:600}
.void{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;overflow:hidden}
.void span{transform:rotate(-28deg);font:600 90pt/1 'Plus Jakarta Sans','Hind Siliguri',sans-serif;color:rgba(160,40,30,.16);border:6pt solid rgba(160,40,30,.16);padding:4mm 12mm;letter-spacing:.08em}
@media print{.void{position:fixed}}
`;

/**
 * Full HTML page for a document.
 * @param {object} a
 * @param {object} a.doc      { type, number, snapshot, status, contentHash, createdAt }
 * @param {'bn'|'en'} a.locale
 * @param {string|null} a.logo     data: URI
 * @param {string} a.verifyUrl
 * @param {string} a.qrSvg    inline <svg> (generated by us — trusted markup)
 */
export function renderDocumentHtml({ doc, locale, logo, verifyUrl, qrSvg }) {
  const f = fmt(locale);
  const s = doc.snapshot;
  const o = s.org;
  const meta1 = [f.pick(o.address, o.addressBn), o.phone, o.email, o.website]
    .filter(Boolean)
    .map(esc)
    .join(' · ');
  const meta2 = [
    o.tradeLicenseNo && `${f.bn ? 'ট্রেড লাইসেন্স' : 'Trade licence'} ${esc(o.tradeLicenseNo)}`,
    o.rehabMemberNo && `REHAB ${esc(o.rehabMemberNo)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const body = BODY[doc.type](s, f);
  const issued = new Date(doc.createdAt ?? Date.now()).toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="${f.bn ? 'bn' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(f.t[doc.type])} ${esc(doc.number)}</title>
<style>${fontFaceCss()}\n${CSS}</style></head>
<body class="${f.bn ? 'bn' : 'en'}"><div class="sheet">
${doc.status === 'void' ? `<div class="void"><span>${f.t.void}</span></div>` : ''}
<header class="mast">
  <div class="brand">${logo ? `<img src="${esc(logo)}" alt="">` : ''}<div>
    <div class="org">${orgName(o, f)}</div>
    ${o.legalName && o.legalName !== o.name ? `<div class="org-meta">${esc(o.legalName)}</div>` : ''}
    ${meta1 ? `<div class="org-meta">${meta1}</div>` : ''}
    ${meta2 ? `<div class="org-meta">${meta2}</div>` : ''}
  </div></div>
  <div class="docid"><div class="title">${f.t[doc.type]}</div>
    <div class="number">${esc(doc.number)}</div>
    <div class="date">${f.date(mainDate(doc.type, s))}</div></div>
</header>
<main>${body}</main>
<footer class="verify">
  <div class="qr">${qrSvg}</div>
  <div class="vtext"><b>${f.t.verify}</b><br>${esc(verifyUrl)}<br>${f.t.issued} ${f.date(issued)} · ${f.t.hash} <span class="mono">${esc(doc.contentHash.slice(0, 16))}</span></div>
</footer>
</div></body></html>`;
}

export const DOCUMENT_TITLES = Object.freeze({ en: L.en, bn: L.bn });
