import { analyzeSms } from '#integrations/sms/segments.js';

/** Auto-reply text helpers (no DB) — shared by the sender and the settings validation. */
const MAX_NAME = 40;
export const AUTO_REPLY_MAX_SEGMENTS = 6;

export const SAMPLE_NAMES = Object.freeze({
  bn: 'মোহাম্মদ রহিম উদ্দিন',
  en: 'Mohammad Rahim Uddin',
});

/** Fill {name} and {company}. Unknown placeholders stay as typed. */
export function renderAutoReply(template, { name, company }) {
  const clean = (v, max) =>
    [
      ...String(v ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
    ]
      .slice(0, max)
      .join('')
      .trim();
  return String(template)
    .replaceAll('{name}', clean(name, MAX_NAME))
    .replaceAll('{company}', clean(company, 80))
    .trim();
}

export function companyName(org, locale) {
  return (locale === 'bn' ? org?.nameBn : null) || org?.name || '';
}

/** Website pages are /bn/… or /en/…; anything else falls back to the company's default language. */
export function localeFromPage(page, fallback = 'bn') {
  const m = /^\/(bn|en)(?:[/?#]|$)/.exec(page ?? '');
  return m ? m[1] : fallback;
}

/**
 * Length check for a template, filled with a long sample name and the company name.
 * @returns {{ ok: boolean, rendered: string, segments: number, encoding: string }}
 */
export function checkAutoReply(template, { org, locale }) {
  const rendered = renderAutoReply(template, {
    name: SAMPLE_NAMES[locale],
    company: companyName(org, locale),
  });
  const a = analyzeSms(rendered);
  return {
    ok: a.segments <= AUTO_REPLY_MAX_SEGMENTS,
    rendered,
    segments: a.segments,
    encoding: a.encoding,
  };
}
