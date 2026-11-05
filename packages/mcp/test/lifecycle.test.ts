import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { exitWithClient, processAlive } from "../src/lifecycle.js";

describe("exitWithClient (#23)", () => {
  afterEach(() => vi.useRealTimers());

  const harness = (ppid = 4242) => {
    const stdin = new EventEmitter();
    const signals = new Map<string, () => void>();
    const state = { ppid, alive: true };
    const exit = vi.fn();
    const stop = exitWithClient({
      stdin,
      onSignal: (sig, h) => signals.set(sig, h),
      ppid: () => state.ppid,
      alive: () => state.alive,
      exit,
      intervalMs: 1000,
    });
    return { stdin, signals, state, exit, stop };
  };

  it.each(["end", "close"])("exits once when stdin emits %s", (event) => {
    const h = harness();
    h.stdin.emit(event);
    h.stdin.emit("close");
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it.each(["SIGTERM", "SIGHUP"])("exits on %s", (sig) => {
    const h = harness();
    h.signals.get(sig)!();
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it("exits when re-parented, and when the parent stops answering", () => {
    vi.useFakeTimers();
    const a = harness();
    vi.advanceTimersByTime(3000);
    expect(a.exit).not.toHaveBeenCalled();
    a.state.ppid = 1;
    vi.advanceTimersByTime(1000);
    expect(a.exit).toHaveBeenCalledTimes(1);

    const b = harness();
    b.state.alive = false;
    vi.advanceTimersByTime(1000);
    expect(b.exit).toHaveBeenCalledTimes(1);
  });

  it("never watches a parent that was init from the start", () => {
    vi.useFakeTimers();
    const h = harness(1);
    h.state.alive = false;
    vi.advanceTimersByTime(5000);
    expect(h.exit).not.toHaveBeenCalled();
    h.stop();
  });

  it("processAlive answers for this process and a pid that cannot exist", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
  });
});
