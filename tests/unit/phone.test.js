import { describe, expect, it } from 'vitest';
import { formatBdPhone, normalizeBdPhone } from '#shared/utils/phone.js';

describe('normalizeBdPhone', () => {
  it.each([
    ['01712345678', '+8801712345678'],
    ['8801712345678', '+8801712345678'],
    ['+880 1712-345678', '+8801712345678'],
    ['00880 1712 345 678', '+8801712345678'],
    ['(017) 1234.5678', '+8801712345678'],
    ['০১৭১২৩৪৫৬৭৮', '+8801712345678'],
    ['01312345678', '+8801312345678'],
  ])('%s → %s', (input, out) => expect(normalizeBdPhone(input)).toBe(out));

  it.each(['01212345678', '0171234567', '017123456789', '+15551234567', 'abc', '', null])(
    'rejects %s',
    (input) => expect(normalizeBdPhone(input)).toBeNull(),
  );

  it('formats for display', () => {
    expect(formatBdPhone('+8801712345678')).toBe('+880 1712-345678');
  });
});
