import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
vi.mock('node:module', () => ({ createRequire: () => () => undefined }));
const g = globalThis as any;
let instances: FakeGo[];
let render: (go: FakeGo, language: string, source: string) => unknown;
let start: (go: FakeGo) => void;
class FakeGo {
  importObject = {};
  exited = false;
  settled: Array<((error?: unknown) => void) | undefined> = [];
  constructor() { instances.push(this); }
  run() {
    start(this);
    g.fmrlHighlight = (language: string, source: string) => render(this, language, source);
    // Observe both lifetime handlers without causing a real unhandled rejection.
    return { then: (...handlers: typeof this.settled) => { this.settled = handlers; } };
  }
}
beforeEach(() => {
  vi.resetModules(); instances = [];
  render = (_go, _language, source) => source;
  start = () => {};
  vi.stubGlobal('Go', FakeGo);
  vi.stubGlobal('fs', undefined);
  vi.stubGlobal('path', undefined);
  vi.stubGlobal('fmrlHighlight', undefined);
  vi.stubGlobal('WebAssembly', { Module: class {}, Instance: class {} });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Go renderer isolation and recovery', () => {
  it.each([false, true])('routes sync and async diagnostics to stderr with existing fs=%s', async (existing) => {
    const original = { marker: {}, writeSync: vi.fn(), write: vi.fn(), readFileSync: nodeFs.readFileSync };
    if (existing) g.fs = original;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { highlightCode } = await import('../src/highlight.js');
    highlightCode('bash', 'echo hi');
    expect(g.fs?.readFileSync).toBe(nodeFs.readFileSync);
    if (existing) expect(g.fs.marker).toBe(original.marker);
    expect(g.path.resolve).toBe(nodePath.resolve);
    expect(g.fs.writeSync(1, Buffer.from('sync'))).toBe(4);
    const callback = vi.fn();
    g.fs.write(2, Buffer.from('!async!'), 1, 5, null, callback);
    expect(callback).toHaveBeenCalledWith(null, 5, expect.any(Uint8Array));
    expect(stderr.mock.calls.map(([buffer]) => String(buffer))).toEqual(['sync', 'async']);
    expect(stdout).not.toHaveBeenCalled();
    expect(original.writeSync).not.toHaveBeenCalled();
    expect(original.write).not.toHaveBeenCalled();
  });
  it('handles startup rejection and permits a fresh instance', async () => {
    const { highlightCode } = await import('../src/highlight.js');
    highlightCode('bash', 'first');
    expect(instances[0].settled[1]).toBeTypeOf('function');
    instances[0].settled[1]!(new Error('startup failed'));
    expect(highlightCode('bash', 'second')).toBe('second');
    expect(instances).toHaveLength(2);
  });
  it('clears on exit without letting the old lifetime clear a newer instance', async () => {
    const { highlightCode } = await import('../src/highlight.js');
    highlightCode('bash', 'first');
    const old = instances[0]; old.exited = true;
    expect(highlightCode('bash', 'second')).toBe('second');
    expect(instances).toHaveLength(2);
    expect(old.settled[0]).toBeTypeOf('function');
    old.settled[0]!(); highlightCode('bash', 'third');
    expect(instances).toHaveLength(2);
  });
  it('rejects non-string output and recovers on the next call', async () => {
    const { highlightCode } = await import('../src/highlight.js');
    render = () => undefined;
    expect(() => highlightCode('bash', 'bad')).toThrow(/renderer/i);
    render = (_go, _lang, source) => source;
    expect(highlightCode('bash', 'good')).toBe('good');
    expect(instances).toHaveLength(2);
  });
  it('rejects startup that exited synchronously instead of caching a dead wrapper', async () => {
    start = (go) => { go.exited = true; };
    const { highlightCode } = await import('../src/highlight.js');
    expect(() => highlightCode('bash', 'bad')).toThrow(/renderer/i);
    start = () => {};
    expect(highlightCode('bash', 'good')).toBe('good');
  });
});
