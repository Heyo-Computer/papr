import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { loadSpec, saveSpec, speakText } from "../../api/commands";
import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import type { TodoItem } from "../../types";

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")       // code blocks
    .replace(/`[^`]+`/g, "")              // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → text
    .replace(/#{1,6}\s+/g, "")            // headings
    .replace(/[*_~]{1,3}/g, "")           // bold/italic/strike
    .replace(/^[-*+]\s+/gm, "")           // list markers
    .replace(/^\d+\.\s+/gm, "")           // ordered lists
    .replace(/^>\s+/gm, "")               // blockquotes
    .replace(/\|/g, " ")                  // table pipes
    .replace(/---+/g, "")                 // horizontal rules
    .replace(/\n{2,}/g, ". ")             // paragraph breaks → pause
    .replace(/\n/g, " ")
    .trim();
}

function useReadAloud() {
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setSpeaking(false);
  }, []);

  const toggle = useCallback(async (text: string) => {
    if (speaking) {
      stop();
      return;
    }
    const plain = stripMarkdown(text);
    if (!plain) return;

    setSpeaking(true);
    try {
      const base64Audio = await speakText(plain);
      const audio = new Audio(`data:audio/wav;base64,${base64Audio}`);
      audioRef.current = audio;
      audio.onended = () => { audioRef.current = null; setSpeaking(false); };
      audio.onerror = () => { audioRef.current = null; setSpeaking(false); };
      await audio.play();
    } catch (e) {
      console.error("TTS failed:", e);
      setSpeaking(false);
    }
  }, [speaking, stop]);

  return { speaking, toggle, stop };
}

interface TodoSpecProps {
  todo: TodoItem;
  date: string;
  onUpdate: (todo: TodoItem) => void;
}

export function TodoSpec({ todo, date, onUpdate }: TodoSpecProps) {
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const { speaking, toggle: toggleSpeak, stop: stopSpeak } = useReadAloud();

  useEffect(() => {
    loadSpec(date, todo.id).then((spec) => {
      setContent(spec);
      setDraft(spec);
    }).catch(() => {});
  }, [date, todo.id]);

  async function handleSave() {
    await saveSpec(date, todo.id, draft);
    setContent(draft);
    setEditing(false);

    if (!todo.has_spec && draft.length > 0) {
      onUpdate({ ...todo, has_spec: true });
    } else if (todo.has_spec && draft.length === 0) {
      onUpdate({ ...todo, has_spec: false });
    }
  }

  function handleCancel() {
    setDraft(content);
    setEditing(false);
  }

  // Stop speech when unmounting or switching to edit
  useEffect(() => () => stopSpeak(), []);

  return (
    <>
      <div class="todo-spec">
        {editing ? (
          <>
            <textarea
              class="todo-spec-editor"
              value={draft}
              onInput={(e) => setDraft(e.currentTarget.value)}
              placeholder="Write a markdown spec..."
              rows={8}
            />
            <div class="todo-spec-actions">
              <button class="btn btn-sm btn-secondary" onClick={handleCancel}>
                Cancel
              </button>
              <button class="btn btn-sm btn-primary" onClick={handleSave}>
                Save
              </button>
            </div>
          </>
        ) : (
          <>
            {content ? (
              <div class="todo-spec-content-row">
                <div
                  class="todo-spec-content"
                  onClick={() => setEditing(true)}
                  style={{ cursor: "pointer", flex: 1 }}
                >
                  <MarkdownRenderer content={content} />
                </div>
                <button
                  class={`btn btn-sm btn-ghost spec-action-btn${speaking ? " speaking" : ""}`}
                  onClick={() => toggleSpeak(content)}
                  title={speaking ? "Stop reading" : "Read aloud"}
                >
                  {speaking ? "\u25A0" : "\u25B6"}
                </button>
                <button
                  class="btn btn-sm btn-ghost spec-action-btn"
                  onClick={() => setModalOpen(true)}
                  title="Expand spec"
                >
                  &#x2922;
                </button>
              </div>
            ) : (
              <button
                class="btn btn-sm btn-ghost"
                onClick={() => setEditing(true)}
              >
                + Add spec
              </button>
            )}
          </>
        )}
      </div>

      {modalOpen && (
        <SpecModal
          title={todo.title}
          content={content}
          onClose={() => setModalOpen(false)}
          onEdit={() => {
            setModalOpen(false);
            setEditing(true);
          }}
        />
      )}
    </>
  );
}

function SpecModal({
  title,
  content,
  onClose,
  onEdit,
}: {
  title: string;
  content: string;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { speaking, toggle: toggleSpeak, stop: stopSpeak } = useReadAloud();

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Stop speech on unmount
  useEffect(() => () => stopSpeak(), []);

  return (
    <div class="spec-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="spec-modal">
        <div class="spec-modal-header">
          <span class="spec-modal-title">{title}</span>
          <div class="spec-modal-header-actions">
            <button
              class={`btn btn-sm btn-ghost${speaking ? " speaking" : ""}`}
              onClick={() => toggleSpeak(content)}
              title={speaking ? "Stop reading" : "Read aloud"}
            >
              {speaking ? "\u25A0 Stop" : "\u25B6 Read"}
            </button>
            <button class="btn btn-sm btn-ghost" onClick={onEdit}>
              Edit
            </button>
            <button class="btn btn-sm btn-ghost" onClick={onClose} title="Close">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        </div>
        <div class="spec-modal-body">
          <MarkdownRenderer content={content} />
        </div>
      </div>
    </div>
  );
}
