// Compare immutable provenance; moving main would break unrelated plugin PRs.
// The CLI stays strict: absent credentials are never a successful parity check.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

export async function checkFixtures({ token, revision, fetchImpl = fetch,
  readFixture = name => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url)), log = console.log }) {
  assert.ok(token, 'MARKYMD_FIXTURES_TOKEN is required: grant read-only Contents access to private toogreatwtf/markymd');
  assert.match(revision, /^[a-f0-9]{40}$/, 'upstream revision must be a full immutable commit SHA');
  for (const name of ['heading-ids.json', 'canvas-parity.json']) {
    const url = `https://api.github.com/repos/toogreatwtf/markymd/contents/internal/render/testdata/${name}?ref=${revision}`;
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    assert.ok(response.ok, `${name}: markymd ${revision} returned ${response.status}; the upstream comparison did not pass`);
    const upstream = Buffer.from(await response.arrayBuffer());
    assert.ok(readFixture(name).equals(upstream), `${name} differs from markymd ${revision}; sync the fixture and rerun all three renderers`);
    log(`${name}: identical to markymd ${revision}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { revision } = JSON.parse(readFileSync(new URL('../src/vendor/upstream.json', import.meta.url), 'utf8'));
  await checkFixtures({ token: process.env.MARKYMD_FIXTURES_TOKEN, revision });
}
