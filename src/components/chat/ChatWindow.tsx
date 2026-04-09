import { chatMessages, isAgentLoading, agentStatus, statusPopoverOpen, days } from "../../state/store";
import { sendMessage, getDaysRange } from "../../api/commands";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";

let msgCounter = 0;
function localId(): string {
  return `local-${Date.now()}-${++msgCounter}`;
}

export function ChatWindow() {
  async function handleSend(text: string) {
    const userMsg = {
      id: localId(),
      role: "user" as const,
      content: text,
      timestamp: new Date().toISOString(),
    };
    chatMessages.value = [...chatMessages.value, userMsg];
    isAgentLoading.value = true;

    try {
      const response = await sendMessage(text);
      chatMessages.value = [...chatMessages.value, response];
      // Refresh days in case the agent modified todos
      getDaysRange().then((entries) => { days.value = entries; }).catch(() => {});
    } catch (err) {
      const errorMsg = {
        id: localId(),
        role: "assistant" as const,
        content: `${err}`,
        timestamp: new Date().toISOString(),
      };
      chatMessages.value = [...chatMessages.value, errorMsg];
    } finally {
      isAgentLoading.value = false;
    }
  }

  const status = agentStatus.value;

  return (
    <div class="chat-panel">
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
      </div>
      <MessageList messages={chatMessages.value} loading={isAgentLoading.value} />
      <ChatInput
        onSend={handleSend}
        disabled={isAgentLoading.value}
      />
    </div>
  );
}
