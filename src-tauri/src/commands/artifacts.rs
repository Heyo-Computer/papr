use tauri::State;
use crate::models::artifact::Artifact;
use crate::services::routing::{agent_rpc, require_agent};
use crate::state::AppState;

#[tauri::command]
pub async fn list_artifacts(dir: Option<String>, state: State<'_, AppState>) -> Result<Vec<Artifact>, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/list", serde_json::json!({ "dir": dir.unwrap_or_default() })).await
}

#[tauri::command]
pub async fn list_all_artifacts(state: State<'_, AppState>) -> Result<Vec<Artifact>, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/list_all", serde_json::json!({})).await
}

#[tauri::command]
pub async fn read_artifact(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/read", serde_json::json!({ "path": path })).await
}

/// Materialize a VM-resident artifact to a host temp file and return its path,
/// so the UI's "Open with default app" can hand a real host path to the OS
/// opener. The artifact lives inside the sandbox at /data/artifacts and is not
/// reachable from the host, so we pull its content over the read RPC and cache a
/// local copy under <temp>/todo-artifacts/, preserving the basename (and thus the
/// extension) so the OS picks the right application. `path` is the artifact's
/// relative path.
#[tauri::command]
pub async fn open_artifact_external(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let url = require_agent(&state).await?;
    let content: String = agent_rpc(&url, "artifacts/read", serde_json::json!({ "path": path })).await?;

    // Safe basename from the relative path (guards against empty / trailing-slash).
    let base = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "artifact".to_string());

    let dir = std::env::temp_dir().join("todo-artifacts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create temp dir: {}", e))?;
    let file = dir.join(&base);
    std::fs::write(&file, content).map_err(|e| format!("write temp artifact: {}", e))?;
    Ok(file.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn save_artifact(path: String, content: String, state: State<'_, AppState>) -> Result<Artifact, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/save", serde_json::json!({ "path": path, "content": content })).await
}

#[tauri::command]
pub async fn delete_artifact(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let url = require_agent(&state).await?;
    let _: serde_json::Value = agent_rpc(&url, "artifacts/delete", serde_json::json!({ "path": path })).await?;
    Ok(())
}

#[tauri::command]
pub async fn create_artifact_folder(path: String, state: State<'_, AppState>) -> Result<Artifact, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/create_folder", serde_json::json!({ "path": path })).await
}

#[tauri::command]
pub async fn rename_artifact(path: String, new_name: String, state: State<'_, AppState>) -> Result<Artifact, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/rename", serde_json::json!({ "path": path, "new_name": new_name })).await
}

#[tauri::command]
pub async fn move_artifact(path: String, target_dir: String, state: State<'_, AppState>) -> Result<Artifact, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/move", serde_json::json!({ "path": path, "target_dir": target_dir })).await
}

#[tauri::command]
pub async fn list_artifact_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/list_folders", serde_json::json!({})).await
}
