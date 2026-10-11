import { describe, expect, it } from 'vitest';
import { renderEmail } from '#integrations/email/templates.js';

describe('email templates', () => {
  const data = {
    name: '<script>x</script>',
    orgName: 'Acme & Co',
    url: 'https://x.test/r?token=abc"def',
    expiresMin: 30,
    expiresHours: 72,
    when: 'now',
  };

  it('escapes every interpolated value in HTML', () => {
    const { html, subject } = renderEmail('password_reset', 'en', data);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Acme &amp; Co');
    expect(html).toContain('abc&quot;def');
    expect(subject).toContain('Acme & Co');
  });

  it('renders Bangla with Bangla digits', () => {
    const { html, subject } = renderEmail('password_reset', 'bn', data);
    expect(subject).toContain('পাসওয়ার্ড');
    expect(html).toContain('৩০');
  });

  it('falls back to bn for unknown locale and throws on unknown template', () => {
    expect(renderEmail('account_setup', 'fr', data).html).toContain('lang="bn"');
    expect(() => renderEmail('nope', 'en', data)).toThrow();
  });
});
