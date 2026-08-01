//! Plugin / package management commands. Thin forwarders to the agent's
//! `plugins/*` JSON-RPC methods, which drive Pi's package manager (install,
//! remove, list extensions/skills/prompts from any npm:/git:/local source).
use crate::services::agent as svc;
use crate::state::AppState;
use tauri::State;

fn require_url(state: &State<'_, AppState>) -> Result<String, String> {
    state
        .agent_url
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Agent is not running. Use the status popover to set up the agent.".to_string())
}

fn unwrap_rpc(resp: crate::models::agent::AcpResponse) -> Result<serde_json::Value, String> {
    if let Some(err) = resp.error {
        return Err(err.message);
    }
    Ok(resp.result.unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn list_plugins(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let url = require_url(&state)?;
    let resp = svc::send_rpc(&url, "plugins/list", serde_json::json!({})).await?;
    unwrap_rpc(resp)
}

/// Install a Pi package from a source (`npm:pkg`, `git:host/repo`, or a local
/// path). npm/git fetches can be slow, so this uses an extended timeout.
#[tauri::command]
pub async fn install_plugin(
    source: String,
    local: bool,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let url = require_url(&state)?;
    let resp = svc::send_rpc_with_timeout(
        &url,
        "plugins/install",
        serde_json::json!({ "source": source, "local": local }),
        600,
    )
    .await?;
    unwrap_rpc(resp)
}

#[tauri::command]
pub async fn remove_plugin(
    source: String,
    local: bool,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let url = require_url(&state)?;
    let resp = svc::send_rpc_with_timeout(
        &url,
        "plugins/remove",
        serde_json::json!({ "source": source, "local": local }),
        300,
    )
    .await?;
    unwrap_rpc(resp)
}
