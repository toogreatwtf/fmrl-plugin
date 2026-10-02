import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { canvasAssets } from '../src/highlight.js';
it('records the SHA-256 of gzip bytes, not the expanded WebAssembly module', () => {
  const bytes = readFileSync(new URL('../src/vendor/canvas.wasm.gz', import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(canvasAssets.wasmSHA256);
});
it('verifies the runtime copied with the module', () => {
  const bytes = readFileSync(new URL('../src/vendor/wasm_exec.cjs', import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(canvasAssets.runtimeSHA256);
});
