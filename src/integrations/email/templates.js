/**
 * Transactional email templates (BN/EN). Plain, table-free HTML that renders in Gmail/Outlook.
 * Every interpolated value is escaped. Add a template = add one entry to TEMPLATES.
 */
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bnNum = (n) => String(n).replace(/\d/g, (d) => BN_DIGITS[d]);

function layout({ orgName, locale, body, button }) {
  const font =
    locale === 'bn'
      ? "'Noto Sans Bengali','Hind Siliguri',Arial,sans-serif"
      : 'Helvetica,Arial,sans-serif';
  const btn = button
    ? `<p style="margin:28px 0"><a href="${esc(button.url)}" style="background:#1c1917;color:#fafaf9;text-decoration:none;padding:12px 22px;border-radius:3px;display:inline-block;font-weight:600">${esc(button.label)}</a></p>
<p style="font-size:12px;color:#78716c;word-break:break-all">${esc(button.url)}</p>`
    : '';
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f5f2ec;padding:24px;font-family:${font};color:#1c1917;line-height:1.6">
<div style="max-width:520px;margin:0 auto;background:#fffdf9;border:1px solid #e7e2d9;border-radius:4px;padding:28px">
<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#b4532a;font-weight:700;margin-bottom:20px">${esc(orgName)}</div>
${body}${btn}
</div>
<p style="max-width:520px;margin:12px auto 0;font-size:11px;color:#a8a29e;text-align:center">${esc(orgName)}</p>
</body></html>`;
}

const p = (t) => `<p style="margin:0 0 12px">${t}</p>`;

const TEMPLATES = {
  password_reset: {
    en: (d) => ({
      subject: `Reset your ${d.orgName} password`,
      body:
        p(`Hi ${esc(d.name)},`) +
        p(
          'We received a request to reset your password. This link works once and expires in ' +
            `${esc(d.expiresMin)} minutes.`,
        ) +
        p("If you didn't ask for this, you can ignore this email — your password won't change."),
      button: { label: 'Reset password', url: d.url },
      text: `Hi ${d.name},\n\nReset your password (expires in ${d.expiresMin} minutes):\n${d.url}\n\nIf you didn't ask for this, ignore this email.`,
    }),
    bn: (d) => ({
      subject: `${d.orgName} — পাসওয়ার্ড রিসেট`,
      body:
        p(`প্রিয় ${esc(d.name)},`) +
        p(
          `আপনার পাসওয়ার্ড রিসেটের অনুরোধ পেয়েছি। লিংকটি একবারই ব্যবহার করা যাবে এবং ${bnNum(esc(d.expiresMin))} মিনিট পর মেয়াদ শেষ হবে।`,
        ) +
        p('অনুরোধটি আপনি না করে থাকলে এই ইমেইল উপেক্ষা করুন — আপনার পাসওয়ার্ড বদলাবে না।'),
      button: { label: 'পাসওয়ার্ড রিসেট করুন', url: d.url },
      text: `প্রিয় ${d.name},\n\nপাসওয়ার্ড রিসেট লিংক (${bnNum(d.expiresMin)} মিনিট মেয়াদ):\n${d.url}`,
    }),
  },

  account_setup: {
    en: (d) => ({
      subject: `Your ${d.orgName} account is ready`,
      body:
        p(`Hi ${esc(d.name)},`) +
        p(
          `An account has been created for you at <strong>${esc(d.orgName)}</strong>. ` +
            'Set your password to get started. The link expires in ' +
            `${esc(d.expiresHours)} hours.`,
        ),
      button: { label: 'Set password', url: d.url },
      text: `Hi ${d.name},\n\nAn account has been created for you at ${d.orgName}. Set your password (expires in ${d.expiresHours} hours):\n${d.url}`,
    }),
    bn: (d) => ({
      subject: `${d.orgName} — আপনার অ্যাকাউন্ট তৈরি হয়েছে`,
      body:
        p(`প্রিয় ${esc(d.name)},`) +
        p(
          `<strong>${esc(d.orgName)}</strong>-এ আপনার জন্য একটি অ্যাকাউন্ট তৈরি করা হয়েছে। ` +
            `শুরু করতে পাসওয়ার্ড সেট করুন। লিংকটির মেয়াদ ${bnNum(esc(d.expiresHours))} ঘণ্টা।`,
        ),
      button: { label: 'পাসওয়ার্ড সেট করুন', url: d.url },
      text: `প্রিয় ${d.name},\n\n${d.orgName}-এ আপনার অ্যাকাউন্ট তৈরি হয়েছে। পাসওয়ার্ড সেট করুন:\n${d.url}`,
    }),
  },

  password_changed: {
    en: (d) => ({
      subject: `Your ${d.orgName} password was changed`,
      body:
        p(`Hi ${esc(d.name)},`) +
        p(`Your password was changed on ${esc(d.when)}. All other devices have been signed out.`) +
        p("If this wasn't you, contact your administrator immediately."),
      text: `Hi ${d.name},\n\nYour password was changed on ${d.when}. If this wasn't you, contact your administrator immediately.`,
    }),
    bn: (d) => ({
      subject: `${d.orgName} — আপনার পাসওয়ার্ড পরিবর্তন হয়েছে`,
      body:
        p(`প্রিয় ${esc(d.name)},`) +
        p(
          `${esc(d.when)} তারিখে আপনার পাসওয়ার্ড পরিবর্তন করা হয়েছে। অন্য সব ডিভাইস থেকে সাইন আউট করা হয়েছে।`,
        ) +
        p('এটি আপনি না করে থাকলে এখনই অ্যাডমিনের সাথে যোগাযোগ করুন।'),
      text: `প্রিয় ${d.name},\n\n${d.when} তারিখে আপনার পাসওয়ার্ড পরিবর্তন করা হয়েছে। এটি আপনি না করে থাকলে অ্যাডমিনের সাথে যোগাযোগ করুন।`,
    }),
  },
};

export const EMAIL_TEMPLATES = Object.freeze(Object.keys(TEMPLATES));

/** @returns {{ subject: string, html: string, text: string }} */
export function renderEmail(template, locale, data) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`Unknown email template: ${template}`);
  const lang = locale === 'en' ? 'en' : 'bn';
  const out = t[lang](data);
  return {
    subject: out.subject,
    html: layout({ orgName: data.orgName, locale: lang, body: out.body, button: out.button }),
    text: out.text,
  };
}
