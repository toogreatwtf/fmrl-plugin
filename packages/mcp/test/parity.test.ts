import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { toHTML, wrapDocument } from '../src/markdown.js';
import { parseFragment, serialize } from 'parse5';

// DOM canonicalization compares structure only. A separate rawCodeBodies
// assertion below preserves entity encoding and code whitespace byte-for-byte.
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
    expect([...body.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((match) => match[1])).toEqual(c.rawCodeBodies);
    expect((body.match(/<pre><code/g) || []).length).toBe(c.copyHooks);
  });
  it('wraps code with the shared selection-copy script and token stylesheet', () => {
    const page = wrapDocument(toHTML('```bash\necho hi\n```'), 'Code');
    expect(page).toContain('setBaseAndExtent');
    expect(page).toContain('setSelectionRange(0, text.length)');
    expect(page).toContain('.tk-k{color:#0a7550}');
  });
});
it('preserves public fallback entity bytes before DOM canonicalization', () => {
  expect(toHTML('```no-such-lexer\n"quoted" \'apostrophe\' <&\n```')).toContain('&quot;quoted&quot; \'apostrophe\' &lt;&amp;\n</code>');
});
it('does not manufacture a newline in an empty fence', () => {
  expect(toHTML('```\n```')).toBe('<pre><code></code></pre>\n');
});
it.each([1, 2, 3])('preserves %s trailing blank fence lines byte-for-byte', (lines) => {
  const text = '\n'.repeat(lines);
  expect(toHTML('```\n' + text + '```')).toBe('<pre><code>' + text + '</code></pre>\n');
  expect(toHTML('```\none\n' + text + '```')).toBe('<pre><code>one\n' + text + '</code></pre>\n');
});
