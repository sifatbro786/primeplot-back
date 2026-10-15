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

// Brand palette (primeplot-front/styles/theme.css) — inline hex because e-mail clients ignore
// CSS variables. Olive charcoal primary, sage accent, warm linen/sand surfaces.
const C = Object.freeze({
  page: '#F2EDE3', // --pp-paper
  card: '#FFFFFF', // --pp-surface
  line: '#E5E3DF', // --pp-line
  primary: '#2D3228', // --pp-primary
  primaryInk: '#F9F8F6', // --pp-primary-ink
  accent: '#6B705C', // --pp-accent (sage)
  accentOnDark: '#A9AE96', // --pp-accent-on-dark
  ink: '#1C1D1A', // --pp-ink
  muted: '#666861', // --pp-ink-muted
  subtle: '#85877F', // --pp-ink-subtle
});

function layout({ orgName, locale, body, button }) {
  const font =
    locale === 'bn'
      ? "'Hind Siliguri','Noto Sans Bengali',Arial,sans-serif"
      : "'Plus Jakarta Sans',Helvetica,Arial,sans-serif";
  const display = locale === 'bn' ? font : "'Playfair Display',Georgia,'Times New Roman',serif";
  const btn = button
    ? `<p style="margin:28px 0 8px"><a href="${esc(button.url)}" style="background:${C.primary};color:${C.primaryInk};text-decoration:none;padding:13px 24px;border-radius:4px;display:inline-block;font-weight:600;letter-spacing:.02em">${esc(button.label)}</a></p>
<p style="font-size:12px;color:${C.subtle};word-break:break-all;margin:0">${esc(button.url)}</p>`
    : '';
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"></head>
<body style="margin:0;background:${C.page};padding:24px 12px;font-family:${font};color:${C.ink};line-height:1.65">
<div style="max-width:560px;margin:0 auto;background:${C.card};border:1px solid ${C.line};border-radius:6px;overflow:hidden">
<div style="background:${C.primary};padding:22px 28px;border-bottom:3px solid ${C.accent}">
<div style="font-family:${display};font-size:20px;line-height:1.2;color:${C.primaryInk}">${esc(orgName)}</div>
</div>
<div style="padding:28px 28px 30px;font-size:15px">
${body}${btn}
</div>
</div>
<p style="max-width:560px;margin:14px auto 0;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${C.subtle};text-align:center">${esc(orgName)}</p>
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
  // B4.3 — sent with the receipt PDF attached (documents.emailReceipt job).
  receipt: {
    en: (d) => ({
      subject: `Money receipt ${d.receiptNo} — ${d.orgName}`,
      body:
        p(`Dear ${esc(d.name)},`) +
        p(
          `Thank you — we have received <b>Tk ${esc(d.amount)}</b> on ${esc(d.date)} for booking ` +
            `${esc(d.bookingNo)} (${esc(d.unit)}, ${esc(d.project)}).`,
        ) +
        p(
          `Your money receipt <b>${esc(d.receiptNo)}</b> is attached as a PDF. Its QR code can be scanned to check it.`,
        ),
      button: { label: 'Verify the receipt', url: d.verifyUrl },
      text: `Dear ${d.name},\n\nWe have received Tk ${d.amount} on ${d.date} for booking ${d.bookingNo} (${d.unit}, ${d.project}). Receipt ${d.receiptNo} is attached.\n\nVerify: ${d.verifyUrl}`,
    }),
    bn: (d) => ({
      subject: `মানি রসিদ ${d.receiptNo} — ${d.orgName}`,
      body:
        p(`প্রিয় ${esc(d.name)},`) +
        p(
          `ধন্যবাদ — বুকিং ${esc(d.bookingNo)} (${esc(d.unit)}, ${esc(d.project)})-এর জন্য ${esc(d.date)} তারিখে ` +
            `<b>৳${bnNum(esc(d.amount))}</b> গ্রহণ করা হয়েছে।`,
        ) +
        p(
          `আপনার মানি রসিদ <b>${esc(d.receiptNo)}</b> PDF হিসেবে সংযুক্ত। রসিদের QR কোড স্ক্যান করে এটি যাচাই করা যাবে।`,
        ),
      button: { label: 'রসিদ যাচাই করুন', url: d.verifyUrl },
      text: `প্রিয় ${d.name},\n\nবুকিং ${d.bookingNo}-এর জন্য ৳${bnNum(d.amount)} গ্রহণ করা হয়েছে। রসিদ ${d.receiptNo} সংযুক্ত।\n\nযাচাই: ${d.verifyUrl}`,
    }),
  },

  // B5 — short portal notices (slip approved/rejected, profile request, online payment).
  // `lines` are plain strings (escaped); the caller writes them in the client's language.
  notice: {
    en: (d) => ({
      subject: `${d.subject} — ${d.orgName}`,
      body: p(`Dear ${esc(d.name)},`) + (d.lines ?? []).map((l) => p(esc(l))).join(''),
      button: d.url ? { label: d.buttonLabel ?? 'Open the portal', url: d.url } : undefined,
      text: `Dear ${d.name},\n\n${(d.lines ?? []).join('\n')}${d.url ? `\n\n${d.url}` : ''}`,
    }),
    bn: (d) => ({
      subject: `${d.subject} — ${d.orgName}`,
      body: p(`প্রিয় ${esc(d.name)},`) + (d.lines ?? []).map((l) => p(esc(l))).join(''),
      button: d.url ? { label: d.buttonLabel ?? 'পোর্টাল খুলুন', url: d.url } : undefined,
      text: `প্রিয় ${d.name},\n\n${(d.lines ?? []).join('\n')}${d.url ? `\n\n${d.url}` : ''}`,
    }),
  },

  // B5.3 — installment reminder. `items`: [{ label, dueDate, amount }] (amount pre-formatted).
  installment_reminder: {
    en: (d) => ({
      subject:
        d.kind === 'overdue'
          ? `Payment overdue — ${d.bookingNo} — ${d.orgName}`
          : `Payment reminder — ${d.bookingNo} — ${d.orgName}`,
      body:
        p(`Dear ${esc(d.name)},`) +
        p(
          d.kind === 'overdue'
            ? `Tk ${esc(d.amount)} for ${esc(d.unit)} (${esc(d.project)}) was due on ${esc(d.dueDate)} and is still unpaid.`
            : d.kind === 'today'
              ? `Tk ${esc(d.amount)} for ${esc(d.unit)} (${esc(d.project)}) is due today, ${esc(d.dueDate)}.`
              : `Tk ${esc(d.amount)} for ${esc(d.unit)} (${esc(d.project)}) falls due on ${esc(d.dueDate)}.`,
        ) +
        (d.items ?? [])
          .map((i) => p(`• ${esc(i.label)} — Tk ${esc(i.amount)} (${esc(i.dueDate)})`))
          .join('') +
        (d.totalOverdue
          ? p(`Total overdue on this booking: <b>Tk ${esc(d.totalOverdue)}</b>.`)
          : '') +
        p('If you have already paid, please ignore this message — thank you.'),
      button: d.url ? { label: 'View dues and pay', url: d.url } : undefined,
      text: `Dear ${d.name},\n\nTk ${d.amount} for ${d.unit} (${d.project}) — due ${d.dueDate}.${d.url ? `\n\n${d.url}` : ''}\n\nIf you have already paid, please ignore this message.`,
    }),
    bn: (d) => ({
      subject:
        d.kind === 'overdue'
          ? `কিস্তি বকেয়া — ${d.bookingNo} — ${d.orgName}`
          : `কিস্তির রিমাইন্ডার — ${d.bookingNo} — ${d.orgName}`,
      body:
        p(`প্রিয় ${esc(d.name)},`) +
        p(
          d.kind === 'overdue'
            ? `${esc(d.unit)} (${esc(d.project)})-এর ৳${bnNum(esc(d.amount))} পরিশোধের তারিখ ছিল ${esc(d.dueDate)}, যা এখনও বকেয়া।`
            : d.kind === 'today'
              ? `${esc(d.unit)} (${esc(d.project)})-এর ৳${bnNum(esc(d.amount))} পরিশোধের শেষ তারিখ আজ, ${esc(d.dueDate)}।`
              : `${esc(d.unit)} (${esc(d.project)})-এর ৳${bnNum(esc(d.amount))} পরিশোধের তারিখ ${esc(d.dueDate)}।`,
        ) +
        (d.items ?? [])
          .map((i) => p(`• ${esc(i.label)} — ৳${bnNum(esc(i.amount))} (${esc(i.dueDate)})`))
          .join('') +
        (d.totalOverdue
          ? p(`এই বুকিংয়ে মোট বকেয়া: <b>৳${bnNum(esc(d.totalOverdue))}</b>।`)
          : '') +
        p('ইতিমধ্যে পরিশোধ করে থাকলে এই বার্তাটি উপেক্ষা করুন — ধন্যবাদ।'),
      button: d.url ? { label: 'বকেয়া দেখুন ও পরিশোধ করুন', url: d.url } : undefined,
      text: `প্রিয় ${d.name},\n\n${d.unit} (${d.project})-এর ৳${bnNum(d.amount)} — তারিখ ${d.dueDate}।${d.url ? `\n\n${d.url}` : ''}\n\nইতিমধ্যে পরিশোধ করে থাকলে উপেক্ষা করুন।`,
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
