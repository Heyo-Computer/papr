import { listen } from "@tauri-apps/api/event";
import {
  agentStatus,
  setupProgress,
  streamingMessage,
  chatMessages,
  isAgentLoading,
  days,
  artifacts,
  allArtifacts,
  allBooks,
  allLists,
  pendingCreates,
  offlineDismissed,
} from "../state/store";
import { getDaysRange, listArtifacts, listAllArtifacts, flushPendingCreates, listPendingCreates, listBooks, listLists } from "./commands";
import { listPlugins } from "./plugins";
import type { AgentStatus } from "../types";

// On reconnect, replay any creates queued while offline, then refresh the
// pending mirror and the book/list summaries so synced items replace their
// pending rows. Best-effort: anything that fails to sync stays queued.
async function flushPending() {
  try {
    await flushPendingCreates();
  } catch {
    /* leave the queue intact; it'll retry on the next reconnect */
  }
  listPendingCreates().then((p) => { pendingCreates.value = p; }).catch(() => {});
  listBooks().then((b) => { allBooks.value = b; }).catch(() => {});
  listLists().then((l) => { allLists.value = l; }).catch(() => {});
}

// One streaming frame from the agent (relayed by Rust over the `chat-stream`
// Tauri event). The agent's `type` field is renamed to `kind` in the Rust layer.
interface StreamPayload {
  requestId: string;
  kind: "delta" | "thinking" | "tool_start" | "tool_end" | "error" | "done";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  message?: string;
}

let streamCounter = 0;
function streamId() {
  return `assistant-${Date.now()}-${++streamCounter}`;
}

// Flush the in-flight streaming bubble into the message list and refresh the
// side panels (todos/artifacts the agent may have changed). Idempotent: a second
// `done` (the Rust safety-net frame) finds a null streamingMessage and no-ops.
function finishStream() {
  const sm = streamingMessage.value;
  if (!sm) return;
  if (sm.content.trim()) {
    chatMessages.value = [
      ...chatMessages.value,
      { id: streamId(), role: "assistant", content: sm.content, timestamp: new Date().toISOString() },
    ];
  }
  streamingMessage.value = null;
  isAgentLoading.value = false;
  getDaysRange().then((e) => { days.value = e; }).catch(() => {});
  listArtifacts().then((i) => { artifacts.value = i; }).catch(() => {});
  listAllArtifacts().then((a) => { allArtifacts.value = a; }).catch(() => {});
}

export async function setupEventListeners() {
  await listen<string>("agent-status", (event) => {
    agentStatus.value = event.payload as AgentStatus;
    // When the agent comes up, pull installed Pi skills into the slash menu,
    // drop back out of offline mode, and sync anything queued while it was down.
    if (event.payload === "running") {
      offlineDismissed.value = false;
      listPlugins().catch(() => {});
      flushPending();
    }
  });
  await listen<string>("setup-progress", (event) => {
    setupProgress.value = event.payload;
  });
  await listen<StreamPayload>("chat-stream", (event) => {
    const p = event.payload;
    const sm = streamingMessage.value;
    // Ignore events for a turn that's already been flushed or never started.
    if (!sm || sm.requestId !== p.requestId) return;

    switch (p.kind) {
      case "delta":
        streamingMessage.value = { ...sm, content: sm.content + (p.text ?? "") };
        break;
      case "thinking":
        streamingMessage.value = { ...sm, thinking: sm.thinking + (p.text ?? "") };
        break;
      case "tool_start":
        streamingMessage.value = {
          ...sm,
          tools: [...sm.tools, { name: p.toolName ?? "tool", done: false }],
        };
        break;
      case "tool_end":
        streamingMessage.value = {
          ...sm,
          tools: sm.tools.map((t) =>
            t.name === p.toolName && !t.done ? { ...t, done: true, isError: p.isError } : t,
          ),
        };
        break;
      case "error":
        streamingMessage.value = {
          ...sm,
          content: sm.content + (sm.content ? "\n\n" : "") + `⚠️ ${p.message ?? "stream error"}`,
        };
        break;
      case "done":
        finishStream();
        break;
    }
  });
}
