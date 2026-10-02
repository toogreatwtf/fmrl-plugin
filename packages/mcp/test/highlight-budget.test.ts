import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/highlight.js', () => ({ canvasAssets: {}, highlightCode: vi.fn((_lang, source) => `<span>${source}</span>`) }));
import { highlightCode } from '../src/highlight.js';
import { toHTML } from '../src/markdown.js';
const highlight = vi.mocked(highlightCode);
beforeEach(() => { highlight.mockClear(); });
const fence = (source: string) => '```bash\n' + source + '\n```';
describe('bounded, fail-safe highlighting', () => {
  it('escapes oversized fences before calling the lexer, counting UTF-8 bytes', () => {
    const source = 'é'.repeat(16 * 1024) + '<&"';
    expect(toHTML(fence(source))).toContain('&lt;&amp;&quot;\n</code>');
    expect(highlight).not.toHaveBeenCalled();
  });
  it('caps each document at 128 KiB and resets the budget for the next document', () => {
    const source = 'x'.repeat(32 * 1024 - 1);
    toHTML(Array(5).fill(fence(source)).join('\n\n'));
    expect(highlight).toHaveBeenCalledTimes(4);
    toHTML(fence('small'));
    expect(highlight).toHaveBeenCalledTimes(5);
  });
  it('escapes the body on a runtime error', () => {
    highlight.mockImplementationOnce(() => { throw new Error('Go program has already exited'); });
    expect(toHTML(fence('<&"'))).toBe('<pre><code class="language-bash">&lt;&amp;&quot;\n</code></pre>\n');
  });
  it('never seals undefined output', () => {
    highlight.mockReturnValueOnce(undefined as unknown as string);
    expect(toHTML(fence('<&"'))).toContain('&lt;&amp;&quot;\n</code>');
  });
});
