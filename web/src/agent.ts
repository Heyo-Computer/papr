// Client for the sandbox agent's HTTP API (`agent/src/index.ts`): JSON-RPC on
// /rpc, SSE chat on /chat/stream, liveness on /health. This is the same job the
// Rust `services::agent` module does for the desktop app.

import { AGENT_URL } from "./config.js";
import { broadcast } from "./events.js";

let requestId = 1;

/** Error carrying a message the UI can show as-is. */
export class AgentError extends Error {}

/**
 * Call an agent JSON-RPC method and return its `result`, turning a JSON-RPC
 * `error` into a rejection.
 */
export async function agentRpc<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 120_000,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${AGENT_URL}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: requestId++ }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AgentError(`Can't reach the agent at ${AGENT_URL} (${(e as Error).message})`);
  }

  if (!res.ok) throw new AgentError(`Agent returned HTTP ${res.status} for ${method}`);

  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new AgentError(body.error.message);
  return body.result as T;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${AGENT_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Chat streaming ──

// The turn currently being relayed. `abortChat` cancels our read of it; the
// agent side is stopped separately via the agent/abort RPC.
let currentTurn: AbortController | null = null;

export function abortChatRelay(): void {
  currentTurn?.abort();
  currentTurn = null;
}

/**
 * Start relaying one chat turn. Returns as soon as the request is accepted —
 * frames arrive asynchronously as `chat-stream` events, exactly as the desktop
 * app emits them (the agent's `type` field is renamed to `kind`, and the
 * caller's requestId is stamped on every frame).
 */
export function streamChat(message: string, reqId: string): void {
  const controller = new AbortController();
  currentTurn = controller;

  const emit = (payload: Record<string, unknown>) => {
    broadcast("chat-stream", { ...payload, requestId: reqId });
  };

  void (async () => {
    try {
      const res = await fetch(`${AGENT_URL}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        emit({ kind: "error", message: `stream request failed (HTTP ${res.status})` });
        return;
      }

      // Newline-delimited `data: {json}` frames, split on the blank line.
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            let val: Record<string, unknown>;
            try {
              val = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            if ("type" in val) {
              val.kind = val.type;
              delete val.type;
            }
            emit(val);
          }
        }
      }
    } catch (e) {
      // An abort is the user pressing stop, not a failure worth reporting.
      if ((e as Error).name !== "AbortError") {
        emit({ kind: "error", message: `stream read error: ${(e as Error).message}` });
      }
    } finally {
      if (currentTurn === controller) currentTurn = null;
      // Safety net in case the stream dropped before the agent's own `done`.
      emit({ kind: "done" });
    }
  })();
}
