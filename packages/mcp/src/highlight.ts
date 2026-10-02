import nodeFs, { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

// Built from markymd's public renderer. Only code text enters this local lexer.
// wasmSHA256 covers the compressed canvas.wasm.gz bytes (not the module).
export const canvasAssets: {css: string; copyJS: string; wasmSHA256: string; runtimeSHA256?: string} =
  JSON.parse(readFileSync(new URL('./vendor/canvas-assets.json', import.meta.url), 'utf8'));

type GoRuntime = { importObject: WebAssembly.Imports; exited: boolean; run(instance: WebAssembly.Instance): Promise<void> };
type Renderer = { go: GoRuntime; highlight?: (language: string, source: string) => unknown };
const globals = globalThis as typeof globalThis & {
  fs?: typeof nodeFs;
  path?: typeof nodePath;
  Go: new () => GoRuntime;
  fmrlHighlight?: (language: string, source: string) => unknown;
};
let renderer: Renderer | undefined;

function installRuntimeIO(): void {
  // Wrap even an existing fs: the Go runtime otherwise reuses it unchanged.
  // Preserve all other members, and supply real path rather than Go's stub.
  const writeSync = (_fd: number, buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset): number => {
    const bytes = buffer.subarray(offset, offset + length);
    process.stderr.write(bytes);
    return bytes.byteLength;
  };
  const write = (_fd: number, buffer: Uint8Array, offset: number, length: number, _position: number | null,
    callback: (error: Error | null, written?: number, buffer?: Uint8Array) => void): void => {
    let written: number;
    try { written = writeSync(_fd, buffer, offset, length); }
    catch (error) { callback(error as Error); return; }
    callback(null, written, buffer);
  };
  globals.fs = new Proxy(globals.fs || nodeFs, {
    get(target, key, receiver) {
      if (key === 'writeSync') return writeSync;
      if (key === 'write') return write;
      return Reflect.get(target, key, receiver);
    },
  });
  globals.path ||= nodePath;
}

export function highlightCode(language: string, source: string): string {
  if (renderer?.go.exited) renderer = undefined;
  if (!renderer) {
    installRuntimeIO();
    const compressed = readFileSync(new URL('./vendor/canvas.wasm.gz', import.meta.url));
    if (createHash('sha256').update(compressed).digest('hex') !== canvasAssets.wasmSHA256) {
      throw new Error('The private code renderer asset checksum does not match');
    }
    createRequire(import.meta.url)('./vendor/wasm_exec.cjs');
    const current: Renderer = { go: new globals.Go() };
    renderer = current;
    const clear = () => { if (renderer === current) renderer = undefined; };
    // Do not accidentally accept a wrapper left by an earlier Go instance.
    globals.fmrlHighlight = undefined;
    try {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(gunzipSync(compressed)), current.go.importObject);
      current.go.run(instance).then(clear, () => {
        clear();
        process.stderr.write('Private code renderer stopped; plain code remains available.\n');
      });
      current.highlight = globals.fmrlHighlight;
      if (typeof current.highlight !== 'function' || current.go.exited) {
        throw new Error('The private code renderer did not start');
      }
    } catch (error) { clear(); throw error; }
  }
  const current = renderer;
  try {
    const html = current.highlight!(language, source);
    if (typeof html !== 'string' || current.go.exited) throw new Error('The private code renderer returned no HTML');
    return html;
  } catch (error) {
    if (renderer === current) renderer = undefined;
    throw error;
  }
}
