import { signal } from "@preact/signals";
import { useEffect, useRef, useCallback } from "preact/hooks";
import { transcribeFile } from "../api/commands";
import { startRecording as micStart, stopRecording as micStop } from "tauri-plugin-mic-recorder-api";
import { register } from "@tauri-apps/plugin-global-shortcut";

export type VoiceState = "idle" | "recording" | "transcribing";
export const voiceState = signal<VoiceState>("idle");
export const voiceError = signal<string>("");

const MAX_RECORDING_MS = 60_000;

// Shared toggle ref so the global shortcut callback can access the latest toggle function
const toggleRef = { current: () => {} };

// Register the global shortcut once (module-level, idempotent)
let shortcutRegistered = false;
async function ensureShortcutRegistered() {
  if (shortcutRegistered) return;
  shortcutRegistered = true;
  try {
    await register("Ctrl+H", (event) => {
      if (event.state === "Pressed") {
        toggleRef.current();
      }
    });
  } catch (e) {
    console.warn("Global shortcut registration failed, using DOM fallback:", e);
    shortcutRegistered = false;
  }
}

export function useVoiceInput(onTranscription: (text: string) => void) {
  const timeoutId = useRef<number | null>(null);
  const onTranscriptionRef = useRef(onTranscription);
  onTranscriptionRef.current = onTranscription;

  const stopRecording = useCallback(async () => {
    if (timeoutId.current) {
      clearTimeout(timeoutId.current);
      timeoutId.current = null;
    }
    if (voiceState.value !== "recording") return;

    voiceState.value = "transcribing";
    voiceError.value = "";

    try {
      const filePath = await micStop();
      const text = await transcribeFile(filePath);
      onTranscriptionRef.current(text.trim());
    } catch (e) {
      voiceError.value = `${e}`;
    } finally {
      voiceState.value = "idle";
    }
  }, []);

  const startRecording = useCallback(async () => {
    voiceError.value = "";

    try {
      await micStart();
      voiceState.value = "recording";
      timeoutId.current = window.setTimeout(stopRecording, MAX_RECORDING_MS);
    } catch (e) {
      voiceError.value = `Microphone access failed: ${e}`;
      voiceState.value = "idle";
    }
  }, [stopRecording]);

  const toggle = useCallback(() => {
    if (voiceState.value === "recording") {
      stopRecording();
    } else if (voiceState.value === "idle") {
      startRecording();
    }
  }, [startRecording, stopRecording]);

  // Keep the shared ref up to date
  toggleRef.current = toggle;

  // Register Tauri global shortcut + DOM fallback
  useEffect(() => {
    ensureShortcutRegistered();

    // DOM fallback for when global shortcut isn't available
    function handleKey(e: KeyboardEvent) {
      if (shortcutRegistered) return;
      if (e.ctrlKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [toggle]);

  return { toggle };
}
