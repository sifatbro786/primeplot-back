import { isDeepStrictEqual } from 'node:util';

const SECRET_KEY = /pass(word)?|secret|token|hash|otp/i;

function plain(v) {
  if (v == null) return v;
  if (typeof v.toObject === 'function') return v.toObject({ depopulate: true });
  if (typeof v.toHexString === 'function') return v.toHexString();
  return v;
}

/**
 * Shallow field diff for the audit log: { field: { from, to } } for changed top-level fields
 * among `fields`. Secrets are recorded as changed but never with their values.
 */
export function diffFields(before, after, fields) {
  const out = {};
  for (const f of fields) {
    const a = plain(before?.[f]);
    const b = plain(after?.[f]);
    if (
      isDeepStrictEqual(
        JSON.parse(JSON.stringify(a ?? null)),
        JSON.parse(JSON.stringify(b ?? null)),
      )
    ) {
      continue;
    }
    out[f] = SECRET_KEY.test(f) ? { changed: true } : { from: a ?? null, to: b ?? null };
  }
  return Object.keys(out).length ? out : undefined;
}
