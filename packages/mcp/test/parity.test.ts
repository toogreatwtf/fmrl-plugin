import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { toHTML, wrapDocument } from '../src/markdown.js';
import { parseFragment, serialize } from 'parse5';

// Same canonical form as Go and DOMParser: sort attributes, drop whitespace
// between blocks, retain every code/script byte after HTML CRLF normalization.
function canonical(source: string): string {
  const root: any = parseFragment(source);
  const walk = (n: any) => {
    if (n.attrs) n.attrs.sort((a: any,b: any) => a.name.localeCompare(b.name));
    if (n.childNodes) {
      n.childNodes = n.childNodes.filter((c: any) => !(c.nodeName === '#text' && /^\s*$/.test(c.value) && /^(#document-fragment|div|body|table|thead|tbody|tr)$/.test(n.nodeName)));
      n.childNodes.forEach(walk);
    }
  };
  walk(root);
  return serialize(root).replace(/&quot;/g, '"').trim();
}
const cases = JSON.parse(readFileSync(new URL('./fixtures/canvas-parity.json', import.meta.url), 'utf8'));
describe('the three-renderer canvas contract', () => {
  for (const c of cases) it(c.name, () => {
    expect(c.assertions).toEqual(['structure','token-spans','profile-script','copy-hooks']);
    const body = toHTML(c.md);
    expect(canonical(body)).toBe(c.html);
    expect((body.match(/<pre><code/g) || []).length).toBe(c.copyHooks);
  });
  it('wraps code with the shared selection-copy script and token stylesheet', () => {
    const page = wrapDocument(toHTML('```bash\necho hi\n```'), 'Code');
    expect(page).toContain('setBaseAndExtent');
    expect(page).toContain('setSelectionRange(0, text.length)');
    expect(page).toContain('.tk-k{color:#0a7550}');
  });
});
