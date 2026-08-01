// Microphone capture, abstracted over the two shells.
//
//   Desktop — the native tauri-plugin-mic-recorder writes a WAV to disk and the
//             Rust side uploads that file to Voxtral.
//   Web     — MediaRecorder captures in-page; we base64 the blob and hand it to
//             the server's `transcribe_audio`, which uploads it the same way.
//
// Both paths present the same two calls, so the voice hooks don't branch.

import { startRecording as micStart, stopRecording as micStop } from "tauri-plugin-mic-recorder-api";
import { isWebMode } from "./transport";
import { transcribeAudio, transcribeFile } from "./commands";

// The in-flight browser recording. Null on desktop (the plugin holds the state)
// and whenever nothing is being recorded.
let webRecording: {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
} | null = null;

/** MediaRecorder reports e.g. "audio/webm;codecs=opus"; Voxtral wants the base type. */
function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0].trim() || "audio/webm";
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // btoa() on one giant string blows the argument limit for long recordings,
  // so build it in chunks.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Begin recording. Rejects if the mic is unavailable or permission is denied. */
export async function startRecording(): Promise<void> {
  if (!isWebMode) {
    await micStart();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("this browser has no microphone API (needs HTTPS or localhost)");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start();
  webRecording = { recorder, stream, chunks };
}

/** Stop the in-flight recording and return its transcript. */
export async function stopAndTranscribe(): Promise<string> {
  if (!isWebMode) {
    const filePath = await micStop();
    return transcribeFile(filePath);
  }

  const rec = webRecording;
  webRecording = null;
  if (!rec) throw new Error("no recording in progress");

  const blob = await new Promise<Blob>((resolve) => {
    rec.recorder.onstop = () => resolve(new Blob(rec.chunks, { type: rec.recorder.mimeType }));
    rec.recorder.stop();
  });
  // Release the mic so the browser drops its recording indicator.
  for (const track of rec.stream.getTracks()) track.stop();

  if (blob.size === 0) throw new Error("no audio was captured");
  return transcribeAudio(await blobToBase64(blob), baseMimeType(blob.type));
}

/** Drop an in-flight browser recording without transcribing it. */
export function cancelRecording(): void {
  if (!webRecording) return;
  const rec = webRecording;
  webRecording = null;
  rec.recorder.onstop = null;
  try {
    rec.recorder.stop();
  } catch {
    /* already stopped */
  }
  for (const track of rec.stream.getTracks()) track.stop();
}
