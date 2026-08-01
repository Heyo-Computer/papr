// Mistral Voxtral (speech) and vision calls, ported from the desktop app's
// `services::speech` / `services::vision`. The browser can't hold the API key,
// so these stay server-side and read it from the saved agent config.

import { getAgentConfig } from "./config.js";

const TRANSCRIBE_MODEL = "voxtral-mini-latest";
const TTS_MODEL = "voxtral-mini-tts-2603";
const VISION_MODEL = "mistral-large-2512";

function requireKey(): string {
  const key = getAgentConfig().speech_api_key;
  if (!key) {
    throw new Error("No speech API key configured. Add your Mistral API key under Speech in Settings.");
  }
  return key;
}

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
};

async function mistral(path: string, init: RequestInit, key: string): Promise<Response> {
  const res = await fetch(`https://api.mistral.ai/v1${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`Mistral API error (${res.status}): ${await res.text()}`);
  }
  return res;
}

/** Transcribe base64 audio captured in the browser. */
export async function transcribe(audioBase64: string, mediaType: string): Promise<string> {
  const key = requireKey();
  const bytes = Buffer.from(audioBase64, "base64");
  if (bytes.length === 0) throw new Error("Recording is empty — no audio was captured.");

  const form = new FormData();
  form.append("model", TRANSCRIBE_MODEL);
  form.append("file", new Blob([bytes], { type: mediaType }), `recording.${EXTENSIONS[mediaType] ?? "webm"}`);

  const res = await mistral("/audio/transcriptions", { method: "POST", body: form }, key);
  return ((await res.json()) as { text: string }).text;
}

/** Text-to-speech. Returns base64 WAV, matching the desktop command. */
export async function textToSpeech(text: string): Promise<string> {
  const key = requireKey();
  const res = await mistral(
    "/audio/speech",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, input: text, voice: "en_paul_neutral", response_format: "wav" }),
    },
    key,
  );
  return ((await res.json()) as { audio_data: string }).audio_data;
}

/** Extract the information in an image that the agent needs to act on it. */
export async function describeImage(imageBase64: string, mediaType: string, userPrompt: string): Promise<string> {
  const key = requireKey();

  const extractionPrompt = userPrompt.trim()
    ? `The user has shared this image with their AI assistant and asks: "${userPrompt.replace(/"/g, "'")}"\n\n` +
      "Extract the relevant information from the image so the assistant can fulfill the request. " +
      "If the image contains a list, transcribe each item exactly. If it contains text, transcribe it. " +
      "If it contains a diagram or structure, describe the structure. " +
      "Return ONLY the extracted information — no preamble, no commentary on what the user should do."
    : "Describe this image in detail. Extract any text, lists, diagrams, or structured information " +
      "that would be useful for further processing. Be thorough but concise.";

  const res = await mistral(
    "/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: extractionPrompt },
              { type: "image_url", image_url: `data:${mediaType};base64,${imageBase64}` },
            ],
          },
        ],
      }),
    },
    key,
  );

  const data = (await res.json()) as { choices?: { message: { content: string } }[] };
  const text = data.choices?.[0]?.message.content;
  if (text === undefined) throw new Error("Mistral vision returned no choices");
  return text;
}
