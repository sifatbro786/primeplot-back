import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDriver } from '#integrations/storage/local.driver.js';

describe('local storage driver', () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-store-'));
  const d = createLocalDriver({ root });

  it('writes atomically into the visibility folder', async () => {
    await d.put({ key: '2026/10/abc-card.webp', body: Buffer.from('hi'), visibility: 'private' });
    expect(readFileSync(join(root, 'private/2026/10/abc-card.webp'), 'utf8')).toBe('hi');
    expect(await d.stat({ key: '2026/10/abc-card.webp', visibility: 'public' })).toBeNull();
  });

  it.each(['../etc/passwd', '2026/../../x', '/abs', 'a//b', 'a\\b', 'ok/<x>'])(
    'rejects key %s',
    async (key) => {
      await expect(d.put({ key, body: Buffer.from('x'), visibility: 'public' })).rejects.toThrow();
    },
  );

  it('rejects unknown visibility', async () => {
    await expect(
      d.put({ key: 'a.webp', body: Buffer.from('x'), visibility: 'secret' }),
    ).rejects.toThrow();
  });
});
