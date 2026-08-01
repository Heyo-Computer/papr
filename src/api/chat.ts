import { sendMessageStreaming } from "./commands";
import { chatMessages, isAgentLoading, streamingMessage } from "../state/store";
import type { TodoItem } from "../types";

let msgCounter = 0;
function localId() { return `local-${Date.now()}-${++msgCounter}`; }

export function buildSummaryPrompt(
  date: string,
  formatted: { weekday: string; display: string },
  todos: TodoItem[]
): string {
  const open = todos.filter((t) => !t.completed);
  const done = todos.filter((t) => t.completed);
  const line = (t: TodoItem) => `- @[${t.title}](id:${t.id}|date:${date})`;

  const parts = [
    `Please summarize my tasks for ${formatted.weekday} (${formatted.display}) and give me actionable suggestions.`,
  ];
  if (open.length > 0) parts.push(`\n\nOpen tasks:\n${open.map(line).join("\n")}`);
  if (done.length > 0) parts.push(`\n\nCompleted tasks:\n${done.map(line).join("\n")}`);
  parts.push("\n\nSuggestions I'm looking for: which items to move to another day, which items would benefit from a spec, and any quick wins I could batch together.");
  return parts.join("");
}

export async function sendChatMessage(text: string): Promise<void> {
  const requestId = localId();
  chatMessages.value = [...chatMessages.value, {
    id: localId(), role: "user" as const, content: text, timestamp: new Date().toISOString(),
  }];
  isAgentLoading.value = true;
  // Open a live assistant bubble; the `chat-stream` listener (api/events.ts)
  // fills it with deltas/tool activity and flushes it on `done`.
  streamingMessage.value = { id: localId(), requestId, content: "", thinking: "", tools: [] };
  try {
    await sendMessageStreaming(text, requestId);
  } catch (err) {
    // Failed to even start the stream — surface it and clear the loading state.
    streamingMessage.value = null;
    isAgentLoading.value = false;
    chatMessages.value = [...chatMessages.value, {
      id: localId(), role: "assistant" as const, content: `${err}`, timestamp: new Date().toISOString(),
    }];
  }
}
