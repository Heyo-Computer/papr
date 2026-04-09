import { useState, useRef, useEffect, useCallback } from "preact/hooks";
import { days } from "../../state/store";
import { useVoiceInput, voiceState, voiceError } from "../../hooks/useVoiceInput";
import type { TodoItem } from "../../types";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled: boolean;
}

interface MentionOption {
  todo: TodoItem;
  date: string;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [text, setText] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleTranscription = useCallback((transcribed: string) => {
    const message = text.trim() ? text.trim() + " " + transcribed : transcribed;
    if (message.trim() && !disabled) {
      onSend(message.trim());
      setText("");
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
    }
  }, [text, disabled, onSend]);

  const { toggle: toggleVoice } = useVoiceInput(handleTranscription);
  const vState = voiceState.value;
  const vError = voiceError.value;

  // Build flat list of all todos across loaded days
  function getMentionOptions(): MentionOption[] {
    const query = mentionQuery.toLowerCase();
    const options: MentionOption[] = [];
    for (const day of days.value) {
      for (const todo of day.todos) {
        if (!query || todo.title.toLowerCase().includes(query)) {
          options.push({ todo, date: day.date });
        }
      }
    }
    return options;
  }

  const options = showMentions ? getMentionOptions() : [];

  function insertMention(opt: MentionOption) {
    // Find the @ trigger position
    const cursorPos = inputRef.current?.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const atPos = beforeCursor.lastIndexOf("@");
    if (atPos === -1) return;

    const before = text.slice(0, atPos);
    const after = text.slice(cursorPos);
    const mention = `@[${opt.todo.title}](id:${opt.todo.id}|date:${opt.date})`;
    const newText = before + mention + " " + after;

    setText(newText);
    setShowMentions(false);
    setMentionQuery("");

    // Refocus and set cursor after the mention
    requestAnimationFrame(() => {
      if (inputRef.current) {
        const pos = before.length + mention.length + 1;
        inputRef.current.focus();
        inputRef.current.setSelectionRange(pos, pos);
      }
    });
  }

  function handleSubmit() {
    const trimmed = text.trim();
    if (trimmed && !disabled) {
      onSend(trimmed);
      setText("");
      setShowMentions(false);
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (showMentions && options.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, options.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(options[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleInput(e: Event) {
    const target = e.currentTarget as HTMLTextAreaElement;
    const value = target.value;
    setText(value);
    target.style.height = "auto";
    target.style.height = Math.min(target.scrollHeight, 120) + "px";

    // Check for @ trigger
    const cursorPos = target.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursorPos);
    const atMatch = beforeCursor.match(/@([^\s@]*)$/);

    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setShowMentions(true);
      setMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    if (showMentions && menuRef.current) {
      const item = menuRef.current.children[mentionIndex] as HTMLElement;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [mentionIndex, showMentions]);

  return (
    <>
      {vError && <div class="voice-error">{vError}</div>}
      <div class="chat-input-area">
        {showMentions && options.length > 0 && (
          <div class="mention-menu" ref={menuRef}>
            {options.map((opt, i) => (
              <div
                key={opt.todo.id}
                class={`mention-item${i === mentionIndex ? " selected" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(opt);
                }}
              >
                <span class="mention-title">{opt.todo.title}</span>
                <span class="mention-date">{opt.date}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          class="chat-input"
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Message the agent... (@ to mention a todo)"
          disabled={disabled}
          rows={1}
        />
        <button
          class={`btn btn-icon mic-btn${vState === "recording" ? " recording" : ""}${vState === "transcribing" ? " transcribing" : ""}`}
          onClick={toggleVoice}
          disabled={disabled || vState === "transcribing"}
          title={
            vState === "recording" ? "Stop recording (Ctrl+H)" :
            vState === "transcribing" ? "Transcribing..." :
            "Voice input (Ctrl+H)"
          }
        >
          {vState === "transcribing" ? (
            <span class="mic-spinner" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          )}
        </button>
        <button
          class="btn btn-primary"
          onClick={handleSubmit}
          disabled={disabled || !text.trim()}
        >
          Send
        </button>
      </div>
    </>
  );
}
