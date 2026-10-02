// Import the built entry and resolve its packaged assets, never src/.
import assert from 'node:assert/strict';
import { highlightCode, canvasAssets } from '../dist/highlight.js';
import { toHTML, wrapDocument } from '../dist/markdown.js';
const code = highlightCode('bash', 'curl --fail https://fmrl.site\n');
assert.match(code, /<span class="tk-k">curl<\/span>/);
assert.match(code, /<span class="tk-a">--fail<\/span>/);
const page = wrapDocument(toHTML('```bash\necho hi\n```'), 'Smoke');
assert.ok(page.includes(canvasAssets.css));
assert.ok(page.includes(canvasAssets.copyJS));
assert.match(page, /<span class="tk-k">echo<\/span>/);
console.log('Built distribution: local code rendering and packaged canvas assets passed');
