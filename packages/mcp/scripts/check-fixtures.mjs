// The upstream fixture is the contract, not a comment promising to copy it.
// A new fixture deliberately blocks this check until markymd merges first.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
assert.ok(process.env.MARKYMD_FIXTURES_TOKEN, 'MARKYMD_FIXTURES_TOKEN is required: grant read-only Contents access to private toogreatwtf/markymd');
for (const name of ['heading-ids.json', 'canvas-parity.json']) {
  const url = `https://api.github.com/repos/toogreatwtf/markymd/contents/internal/render/testdata/${name}?ref=main`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.MARKYMD_FIXTURES_TOKEN}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  assert.ok(response.ok, `${name}: markymd main returned ${response.status}; merge the prerequisite markymd PR before this plugin PR`);
  const upstream = Buffer.from(await response.arrayBuffer());
  const local = readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url));
  assert.ok(local.equals(upstream), `${name} differs from markymd main; sync the fixture and rerun all three renderers`);
  console.log(`${name}: identical to markymd main`);
}
