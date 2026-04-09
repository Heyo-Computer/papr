use tauri::State;
use crate::state::AppState;
use crate::logging;

#[tauri::command]
pub async fn transcribe_audio(
    audio_data: String,
    media_type: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let config = super::config::AgentConfig::default_from_disk(&state.config_dir);

    if config.speech_api_key.is_empty() {
        return Err("No speech API key configured. Add your Mistral API key under Speech in Settings.".to_string());
    }

    logging::info(&format!("transcribe_audio: {} bytes base64, type={}", audio_data.len(), media_type));

    let result = crate::services::speech::transcribe(&config.speech_api_key, &audio_data, &media_type).await?;

    logging::info(&format!("transcribe_audio: got '{}' ({} chars)", &result[..result.len().min(80)], result.len()));
    Ok(result)
}

/// Text-to-speech via Mistral Voxtral. Returns base64-encoded WAV audio.
#[tauri::command]
pub async fn speak_text(
    text: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let config = super::config::AgentConfig::default_from_disk(&state.config_dir);

    if config.speech_api_key.is_empty() {
        return Err("No speech API key configured. Add your Mistral API key under Speech in Settings.".to_string());
    }

    logging::info(&format!("speak_text: {} chars", text.len()));
    crate::services::speech::text_to_speech(&config.speech_api_key, &text).await
}

/// Transcribe a WAV file from disk (used by the native mic recorder plugin).
#[tauri::command]
pub async fn transcribe_file(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let config = super::config::AgentConfig::default_from_disk(&state.config_dir);

    if config.speech_api_key.is_empty() {
        return Err("No speech API key configured. Add your Mistral API key under Speech in Settings.".to_string());
    }

    logging::info(&format!("transcribe_file: path={}", file_path));

    let result = crate::services::speech::transcribe_file(&config.speech_api_key, &file_path).await?;

    logging::info(&format!("transcribe_file: got '{}' ({} chars)", &result[..result.len().min(80)], result.len()));

    // Clean up the temp recording file
    let _ = std::fs::remove_file(&file_path);

    Ok(result)
}
