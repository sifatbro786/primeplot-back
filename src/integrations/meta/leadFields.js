/**
 * Meta lead → our fields (pure, no I/O).
 * `field_data` is [{ name, values: [..] }]. Standard questions use fixed names (full_name,
 * first_name, last_name, phone_number, email, city, …); custom questions use whatever key the
 * form author gave them — those become "Question: answer" lines in the lead's message.
 */
const NAME_KEYS = ['full_name', 'name'];
const PHONE_KEYS = ['phone_number', 'phone', 'mobile', 'mobile_number', 'whatsapp_number'];
const EMAIL_KEYS = ['email', 'work_email'];
const SKIP_IN_MESSAGE = new Set([
  ...NAME_KEYS,
  'first_name',
  'last_name',
  ...PHONE_KEYS,
  ...EMAIL_KEYS,
]);

const first = (v) => (Array.isArray(v) ? v.find((x) => x != null && String(x).trim() !== '') : v);
const text = (v, max) => {
  const s = first(v);
  return s == null ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, max) || null;
};
/** "what_is_your_budget?" → "What is your budget?" */
export function labelOf(key) {
  const s = String(key ?? '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** Meta times look like "2026-10-13T10:00:00+0000"; unix seconds in webhooks. */
export function parseMetaTime(v) {
  if (v == null || v === '') return null;
  const d =
    typeof v === 'number'
      ? new Date(v * 1000)
      : new Date(String(v).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function mapMetaLead(raw) {
  const fields = new Map();
  for (const f of Array.isArray(raw?.field_data) ? raw.field_data : []) {
    if (f?.name) fields.set(String(f.name).toLowerCase(), f.values);
  }
  const get = (keys) => {
    for (const k of keys) {
      const v = text(fields.get(k), 200);
      if (v) return v;
    }
    return null;
  };

  const fullName =
    get(NAME_KEYS) || [get(['first_name']), get(['last_name'])].filter(Boolean).join(' ') || null;
  // Phone: the standard question first, then any field that looks like a phone question.
  let phone = get(PHONE_KEYS);
  if (!phone) {
    for (const [k, v] of fields) {
      if (/phone|mobile|whatsapp|ফোন|মোবাইল/i.test(k) && text(v, 40)) {
        phone = text(v, 40);
        break;
      }
    }
  }
  const email = get(EMAIL_KEYS);
  const emailOk =
    email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
      ? email.toLowerCase()
      : null;

  const answers = [];
  for (const [k, v] of fields) {
    if (SKIP_IN_MESSAGE.has(k)) continue;
    const val = Array.isArray(v)
      ? v.filter((x) => x != null && String(x).trim() !== '').join(', ')
      : v;
    if (val == null || String(val).trim() === '') continue;
    answers.push(`${labelOf(k)}: ${String(val).replace(/\s+/g, ' ').trim()}`);
  }

  const platform = String(raw?.platform ?? '').toLowerCase();
  return {
    name: fullName ? fullName.slice(0, 120) : null,
    phone,
    email: emailOk,
    message: answers.length ? answers.join('\n').slice(0, 2000) : null,
    source: platform === 'ig' || platform === 'instagram' ? 'instagram' : 'facebook',
    isOrganic: raw?.is_organic === true || raw?.is_organic === 'true' || raw?.is_organic === 1,
    formId: raw?.form_id != null ? String(raw.form_id) : null,
    adId: raw?.ad_id != null ? String(raw.ad_id) : null,
    adName: text(raw?.ad_name, 200),
    adsetName: text(raw?.adset_name, 200),
    campaign: text(raw?.campaign_name, 200),
    createdTime: parseMetaTime(raw?.created_time),
  };
}
