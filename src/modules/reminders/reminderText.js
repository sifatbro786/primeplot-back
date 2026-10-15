import { analyzeSms } from '#integrations/sms/segments.js';

/**
 * Installment-reminder SMS texts (no DB) — shared by the sender, the settings validation and
 * the live preview. Each company may write its own text per kind and language from the
 * dashboard (`reminders.texts`); a null text means the built-in one below.
 *
 * Placeholders: {name} (first name), {amount} (taka, no symbol), {date}, {unit} (unit code +
 * project), {company}, {link} (the booking in the customer portal). Unknown `{…}` are refused.
 */
export const REMINDER_KINDS = Object.freeze(['upcoming', 'today', 'overdue']);
export const REMINDER_PLACEHOLDERS = Object.freeze([
  'name',
  'amount',
  'date',
  'unit',
  'company',
  'link',
]);
export const REMINDER_MAX_SEGMENTS = 6;
export const REMINDER_TEXT_MAX = 480;

export const DEFAULT_REMINDER_TEXTS = Object.freeze({
  upcoming: Object.freeze({
    bn: '{company}: প্রিয় {name}, {unit}-এর ৳{amount} কিস্তি {date} তারিখে পরিশোধযোগ্য। বিস্তারিত: {link}',
    en: '{company}: Dear {name}, Tk {amount} for {unit} is due on {date}. Details: {link}',
  }),
  today: Object.freeze({
    bn: '{company}: প্রিয় {name}, {unit}-এর ৳{amount} কিস্তির শেষ তারিখ আজ ({date})। বিস্তারিত: {link}',
    en: '{company}: Dear {name}, Tk {amount} for {unit} is due today ({date}). Details: {link}',
  }),
  overdue: Object.freeze({
    bn: '{company}: প্রিয় {name}, {unit}-এর ৳{amount} কিস্তি {date} থেকে বকেয়া। দ্রুত পরিশোধ করুন; দিয়ে থাকলে উপেক্ষা করুন। {link}',
    en: '{company}: Dear {name}, Tk {amount} for {unit} has been overdue since {date}. Please pay soon; ignore if paid. {link}',
  }),
});

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
export const bnNum = (s) => String(s).replace(/\d/g, (d) => BN_DIGITS[d]);

const clean = (v, max) =>
  [
    ...String(v ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, max)
    .join('')
    .trim();

/** Placeholders used in a template that are not supported (e.g. `{phone}`), deduplicated. */
export function unknownPlaceholders(template) {
  const found = String(template ?? '').match(/\{[^{}\s]{1,30}\}/g) ?? [];
  return [...new Set(found.map((m) => m.slice(1, -1)))].filter(
    (k) => !REMINDER_PLACEHOLDERS.includes(k),
  );
}

/** The template in effect: the company's own text, else the built-in one. */
export function reminderTemplate(texts, kind, locale) {
  const lang = locale === 'en' ? 'en' : 'bn';
  return texts?.[kind]?.[lang]?.trim() || DEFAULT_REMINDER_TEXTS[kind][lang];
}

/**
 * Fill a template. `amount` comes formatted with Latin digits ("1,25,000"); Bangla texts get
 * Bangla digits. `date` is already in the customer's language.
 */
export function renderReminderSms(template, v, locale) {
  const amount = locale === 'en' ? String(v.amount ?? '') : bnNum(v.amount ?? '');
  const values = {
    name: clean(v.name, 40),
    amount,
    date: clean(v.date, 30),
    unit: clean(v.unit, 120),
    company: clean(v.company, 80),
    link: String(v.link ?? ''),
  };
  return String(template)
    .replace(/\{(name|amount|date|unit|company|link)\}/g, (_, k) => values[k])
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Generous sample values for length checks (long name, unit, amount; the real link length). */
export function sampleReminderValues(locale, { company, link }) {
  return locale === 'en'
    ? {
        name: 'Mohammad',
        amount: '12,50,000',
        date: '25 Sep 2026',
        unit: 'B-1204, Lake View Residence Phase 2',
        company,
        link,
      }
    : {
        name: 'মোহাম্মদ',
        amount: '12,50,000',
        date: '২৫/০৯/২০২৬',
        unit: 'B-1204, লেক ভিউ রেসিডেন্স ফেজ ২',
        company,
        link,
      };
}

/**
 * Length check with the sample values.
 * @returns {{ ok, rendered, segments, encoding, unknown: string[] }}
 */
export function checkReminderSms(template, { locale, company, link }) {
  const rendered = renderReminderSms(
    template,
    sampleReminderValues(locale, { company, link }),
    locale,
  );
  const a = analyzeSms(rendered);
  const unknown = unknownPlaceholders(template);
  return {
    ok: a.segments <= REMINDER_MAX_SEGMENTS && unknown.length === 0,
    rendered,
    segments: a.segments,
    encoding: a.encoding,
    unknown,
  };
}

/** Stored texts with every slot present (null = built-in). */
export function reminderTextsOf(stored) {
  return Object.fromEntries(
    REMINDER_KINDS.map((k) => [
      k,
      { bn: stored?.[k]?.bn?.trim() || null, en: stored?.[k]?.en?.trim() || null },
    ]),
  );
}
