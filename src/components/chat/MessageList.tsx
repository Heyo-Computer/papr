import { useEffect, useRef } from "preact/hooks";
import { MessageBubble } from "./MessageBubble";
import { streamingMessage } from "../../state/store";
import type { AgentMessage } from "../../types";

interface MessageListProps {
  messages: AgentMessage[];
  loading: boolean;
}

export function MessageList({ messages, loading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const stream = streamingMessage.value;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, loading, stream?.content, stream?.tools.length]);

  // Show the "Thinking..." placeholder only before the first token/tool arrives.
  const showThinking = loading && (!stream || (!stream.content && stream.tools.length === 0));

  return (
    <div class="chat-messages">
      {messages.length === 0 && !loading && (
        <div class="chat-empty-hint">Ask the agent anything...</div>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {stream && (stream.content || stream.tools.length > 0) && (
        <div class="chat-bubble assistant">
          {stream.tools.length > 0 && (
            <div class="chat-tool-activity">
              {stream.tools.map((t, i) => (
                <span
                  key={`${t.name}-${i}`}
                  class={`chat-tool-chip${t.done ? " done" : " running"}${t.isError ? " error" : ""}`}
                >
                  {t.done ? (t.isError ? "✕" : "✓") : "⚙"} {t.name}
                </span>
              ))}
            </div>
          )}
          {stream.content && <span class="chat-stream-text">{stream.content}</span>}
        </div>
      )}
      {showThinking && (
        <div class="chat-bubble assistant">
          <span style={{ opacity: 0.5 }}>Thinking...</span>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
