use crate::logging;
use base64::Engine;

/// Transcribe audio using the Mistral Voxtral API.
/// Accepts base64-encoded audio data and a MIME type (e.g. "audio/webm").
pub async fn transcribe(api_key: &str, audio_base64: &str, media_type: &str) -> Result<String, String> {
    logging::info(&format!("speech::transcribe: media_type={}, audio_len={}", media_type, audio_base64.len()));

    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64)
        .map_err(|e| format!("Failed to decode audio: {}", e))?;

    logging::info(&format!("speech::transcribe: decoded {} bytes", audio_bytes.len()));

    let ext = match media_type {
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        "audio/mp4" => "mp4",
        "audio/wav" => "wav",
        "audio/mpeg" => "mp3",
        _ => "webm",
    };

    let file_part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(format!("recording.{}", ext))
        .mime_str(media_type)
        .map_err(|e| format!("Failed to create multipart: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .text("model", "voxtral-mini-latest")
        .part("file", file_part);

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.mistral.ai/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Voxtral API request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = format!("Voxtral API error ({}): {}", status, text);
        logging::error(&msg);
        return Err(msg);
    }

    #[derive(serde::Deserialize)]
    struct VoxtralResponse {
        text: String,
    }

    let data: VoxtralResponse = resp.json().await
        .map_err(|e| format!("Failed to parse Voxtral response: {}", e))?;

    logging::info(&format!("speech::transcribe: result='{}' ({} chars)", &data.text[..data.text.len().min(80)], data.text.len()));
    Ok(data.text)
}

/// Transcribe a WAV file from disk.
pub async fn transcribe_file(api_key: &str, file_path: &str) -> Result<String, String> {
    logging::info(&format!("speech::transcribe_file: path={}", file_path));

    let audio_bytes = std::fs::read(file_path)
        .map_err(|e| format!("Failed to read audio file: {}", e))?;

    logging::info(&format!("speech::transcribe_file: read {} bytes", audio_bytes.len()));

    if audio_bytes.is_empty() {
        return Err("Recording file is empty — no audio was captured.".to_string());
    }

    let file_part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name("recording.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("Failed to create multipart: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .text("model", "voxtral-mini-latest")
        .part("file", file_part);

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.mistral.ai/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Voxtral API request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = format!("Voxtral API error ({}): {}", status, text);
        logging::error(&msg);
        return Err(msg);
    }

    #[derive(serde::Deserialize)]
    struct VoxtralResponse {
        text: String,
    }

    let data: VoxtralResponse = resp.json().await
        .map_err(|e| format!("Failed to parse Voxtral response: {}", e))?;

    logging::info(&format!("speech::transcribe_file: result='{}' ({} chars)", &data.text[..data.text.len().min(80)], data.text.len()));
    Ok(data.text)
}

/// Text-to-speech using the Mistral Voxtral TTS API. Returns base64-encoded audio.
pub async fn text_to_speech(api_key: &str, text: &str) -> Result<String, String> {
    logging::info(&format!("speech::tts: {} chars", text.len()));

    let body = serde_json::json!({
        "model": "voxtral-mini-tts-2603",
        "input": text,
        "voice": "en_paul_neutral",
        "response_format": "wav",
    });

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.mistral.ai/v1/audio/speech")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Voxtral TTS request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = format!("Voxtral TTS error ({}): {}", status, text);
        logging::error(&msg);
        return Err(msg);
    }

    #[derive(serde::Deserialize)]
    struct TtsResponse {
        audio_data: String,
    }

    let data: TtsResponse = resp.json().await
        .map_err(|e| format!("Failed to parse Voxtral TTS response: {}", e))?;

    logging::info(&format!("speech::tts: got {} bytes base64 audio", data.audio_data.len()));
    Ok(data.audio_data)
}
