/**
 * exitWithClient ends this server when the client that started it is gone,
 * so a crashed or killed client never leaves an fmrl-mcp running that
 * nobody will find. Three signals, any one enough:
 *
 * - stdin ends or closes: the client closed our end of the pipe;
 * - SIGTERM or SIGHUP: the client, or its terminal, asked us to stop;
 * - the parent is gone: our parent process id changed (we were re-parented,
 *   usually to init) or the original parent no longer answers signal 0,
 *   checked every intervalMs.
 *
 * Every file this server writes goes to a temp file renamed into place, so
 * stopping at any moment leaves no half-written ring, key or page store.
 * The timer is unref'd: it never keeps the process alive on its own.
 */
export interface ExitWithClientDeps {
  stdin: Pick<NodeJS.ReadableStream, "on">;
  onSignal: (signal: "SIGTERM" | "SIGHUP", handler: () => void) => void;
  /** ppid reads the current parent process id. */
  ppid: () => number;
  /** alive answers whether a process id still exists (signal 0). */
  alive: (pid: number) => boolean;
  exit: (code: number) => void;
  intervalMs?: number;
  log?: (line: string) => void;
}

export function exitWithClient(deps: ExitWithClientDeps): () => void {
  const parent = deps.ppid();
  let done = false;
  const stop = (why: string) => {
    if (done) return;
    done = true;
    clearInterval(timer);
    deps.log?.(`fmrl-mcp: ${why}; exiting.`);
    deps.exit(0);
  };
  deps.stdin.on("end", () => stop("the client closed stdin"));
  deps.stdin.on("close", () => stop("the client closed stdin"));
  deps.onSignal("SIGTERM", () => stop("received SIGTERM"));
  deps.onSignal("SIGHUP", () => stop("received SIGHUP"));
  const timer = setInterval(() => {
    // A parent id of 0 or 1 at startup means we were never a child worth watching (a container's init, say).
    if (parent <= 1) return;
    if (deps.ppid() !== parent || !deps.alive(parent)) stop("the client that started this server is gone");
  }, deps.intervalMs ?? 10_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** processAlive is signal 0: it exists if the signal could be sent, or if only permission was refused. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
