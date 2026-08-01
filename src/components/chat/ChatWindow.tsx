import { chatMessages, isAgentLoading, agentStatus, statusPopoverOpen } from "../../state/store";
import { sendChatMessage } from "../../api/chat";
import { abortMessage } from "../../api/commands";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";

export function ChatWindow({ heightPx }: { heightPx?: number | null }) {
  async function handleSend(text: string) {
    await sendChatMessage(text);
  }

  const status = agentStatus.value;
  const loading = isAgentLoading.value;

  // When the user has dragged the divider, drive the panel off an explicit
  // height and lift the default max-height cap so the drag can size it freely.
  const style = heightPx != null
    ? { height: `${heightPx}px`, maxHeight: "none" }
    : undefined;

  return (
    <div class="chat-panel" style={style}>
      <div class="chat-panel-header">
        <span class="chat-panel-title">Chat</span>
        {status === "disconnected" && (
          <button
            class="btn btn-sm btn-primary"
            onClick={() => (statusPopoverOpen.value = true)}
          >
            Set up
          </button>
        )}
        {status === "starting" && (
          <span class="chat-status-text">Starting...</span>
        )}
        {status === "error" && (
          <button
            class="btn btn-sm btn-ghost"
            onClick={() => (statusPopoverOpen.value = true)}
          >
            Error &mdash; view status
          </button>
        )}
        {loading && (
          <button
            class="btn btn-sm btn-ghost"
            onClick={() => { void abortMessage(); }}
            title="Stop the agent's current turn"
          >
            Stop
          </button>
        )}
      </div>
      <MessageList messages={chatMessages.value} loading={loading} />
      <ChatInput
        onSend={handleSend}
        disabled={loading}
      />
    </div>
  );
}
