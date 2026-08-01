// Transport shim for the two shells the same UI runs in.
//
//   Desktop  — Tauri IPC: `invoke` goes to the Rust backend, `listen` to the
//              Tauri event bus.
//   Web      — the `web/` Express server: `invoke` POSTs to /api/invoke/:cmd,
//              `listen` multiplexes one shared EventSource on /api/events.
//
// Both shells expose the *same* command names and event payloads, so nothing
// downstream of this file has to know which one it's running in. The Tauri
// modules are pulled in with dynamic `import()` so a web build never loads
// them.

/** True inside the Tauri webview; false in a plain browser. */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True when running as the web app (served by `web/`), false on desktop. */
export const isWebMode = !isTauri;

// Base for the web server's HTTP API. Relative by default — the server hosts
// the bundle — with an override for pointing a dev build at another host.
export const apiBase: string =
  (import.meta.env?.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "/api";

/**
 * Error whose `toString()` is the bare message, matching Tauri's `invoke`
 * rejection (it rejects with the Rust `Err(String)` itself). Call sites
 * interpolate errors as `${err}` and would otherwise gain an "Error: " prefix.
 */
export class InvokeError extends Error {
  toString(): string {
    return this.message;
  }
}

// ── Tauri side (lazily loaded) ──

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type TauriListen = <T>(
  event: string,
  handler: (e: { event: string; id: number; payload: T }) => void,
) => Promise<() => void>;

let tauriInvoke: Promise<TauriInvoke> | null = null;
let tauriListen: Promise<TauriListen> | null = null;

function loadTauriInvoke(): Promise<TauriInvoke> {
  tauriInvoke ??= import("@tauri-apps/api/core").then((m) => m.invoke as TauriInvoke);
  return tauriInvoke;
}

function loadTauriListen(): Promise<TauriListen> {
  tauriListen ??= import("@tauri-apps/api/event").then((m) => m.listen as unknown as TauriListen);
  return tauriListen;
}

// ── Web side ──

async function webInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}/invoke/${cmd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
  } catch (e) {
    throw new InvokeError(`Can't reach the server (${(e as Error).message})`);
  }

  // The server always answers {result} or {error}; a non-JSON body means
  // something upstream (proxy, load balancer) intercepted the call.
  let body: { result?: unknown; error?: string };
  try {
    body = await res.json();
  } catch {
    throw new InvokeError(`${cmd} failed (HTTP ${res.status})`);
  }
  if (!res.ok || body.error) throw new InvokeError(body.error ?? `${cmd} failed (HTTP ${res.status})`);
  return body.result as T;
}

// One EventSource shared by every listener, opened on first use. Named events
// arrive as `{event, payload}` JSON, mirroring the Tauri event shape.
type Handler = (e: { event: string; id: number; payload: unknown }) => void;
const webHandlers = new Map<string, Set<Handler>>();
let eventSource: EventSource | null = null;
let eventId = 0;

function ensureEventSource() {
  if (eventSource) return;
  eventSource = new EventSource(`${apiBase}/events`);
  eventSource.onmessage = (msg) => {
    let frame: { event?: string; payload?: unknown };
    try {
      frame = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (!frame.event) return;
    for (const handler of webHandlers.get(frame.event) ?? []) {
      handler({ event: frame.event, id: ++eventId, payload: frame.payload });
    }
  };
  // EventSource reconnects on its own; nothing to do but stay out of its way.
  eventSource.onerror = () => {};
}

function webListen(event: string, handler: Handler): () => void {
  ensureEventSource();
  let set = webHandlers.get(event);
  if (!set) {
    set = new Set();
    webHandlers.set(event, set);
  }
  set.add(handler);
  return () => set.delete(handler);
}

// ── Public API (same signatures as @tauri-apps/api) ──

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isWebMode) return webInvoke<T>(cmd, args);
  return (await loadTauriInvoke())<T>(cmd, args);
}

export async function listen<T>(
  event: string,
  handler: (e: { event: string; id: number; payload: T }) => void,
): Promise<() => void> {
  if (isWebMode) return webListen(event, handler as Handler);
  return (await loadTauriListen())<T>(event, handler);
}
