import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

// Built from markymd's public renderer. No network, child process, key, or
// plaintext transmission: only code text enters an in-process Go WASM lexer.
export const canvasAssets: {css: string; copyJS: string; wasmSHA256: string} =
  JSON.parse(readFileSync(new URL('./vendor/canvas-assets.json', import.meta.url), 'utf8'));
let highlight: ((language: string, source: string) => string) | undefined;
export function highlightCode(language: string, source: string): string {
  if (!highlight) {
    createRequire(import.meta.url)('./vendor/wasm_exec.cjs');
    const go = new (globalThis as any).Go();
    const bytes = gunzipSync(readFileSync(new URL('./vendor/canvas.wasm.gz', import.meta.url)));
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), go.importObject);
    void go.run(instance);
    highlight = (globalThis as any).fmrlHighlight;
    if (!highlight) throw new Error('The private code renderer did not start');
  }
  return highlight(language, source);
}
