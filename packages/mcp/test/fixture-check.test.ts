import { describe, expect, it, vi } from 'vitest';
import { checkFixtures } from '../scripts/check-fixtures.mjs';
const revision = '1234567890abcdef1234567890abcdef12345678';
const local = Buffer.from('[{"case":"<code>&quot;</code>"}]');
const options = () => ({ token: 'test-only-token', revision, readFixture: () => local, log: vi.fn(), fetchImpl: vi.fn(async () => new Response(local)) });
describe('immutable upstream fixture comparison', () => {
  it('compares both raw fixture files against the recorded commit, never moving main', async () => {
    const opts = options();
    await checkFixtures(opts);
    expect(opts.fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url] of opts.fetchImpl.mock.calls as unknown as [string][]) expect(url).toContain(`?ref=${revision}`);
  });
  it('fails on unexpected byte drift', async () => {
    const opts = options(); opts.fetchImpl.mockResolvedValue(new Response('drift'));
    await expect(checkFixtures(opts)).rejects.toThrow(/differs/);
  });
  it('does not call missing credentials or an inaccessible upstream a parity pass', async () => {
    await expect(checkFixtures({ ...options(), token: '' })).rejects.toThrow(/required/);
    const opts = options(); opts.fetchImpl.mockResolvedValue(new Response('unavailable', { status: 404 }));
    await expect(checkFixtures(opts)).rejects.toThrow(/404/);
  });
  it('rejects a moving ref', async () => {
    await expect(checkFixtures({ ...options(), revision: 'main' })).rejects.toThrow(/commit/);
  });
});
