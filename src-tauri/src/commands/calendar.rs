//! Google Calendar commands.
//!
//! The integration itself lives in the agent (`agent/src/tools/google-calendar.ts`)
//! so the desktop app and the web shell share one implementation and one set of
//! credentials — tokens live in the VM's /data/config and travel with the data.
//! These commands are forwarders.
//!
//! The one part that stays here is the browser handoff. A desktop app has no
//! public URL for Google to redirect to, so it opens the consent screen in the
//! system browser and catches the callback on a loopback listener; the web shell
//! uses its own origin instead. Google requires the redirect URI to match
//! between the two legs of the flow, so it's passed to both agent calls.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::logging;
use crate::services::calendar as cal;
use crate::services::routing::{agent_rpc, agent_url, require_agent};
use crate::state::AppState;

/// Must be registered as an authorized redirect URI on the OAuth client.
const LOOPBACK_REDIRECT_URI: &str = "http://localhost:19284/callback";

#[tauri::command]
pub async fn get_calendar_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let url = require_agent(&state).await?;
    adopt_host_credentials(&state, &url).await;
    agent_rpc(&url, "calendar/get_config", serde_json::json!({})).await
}

#[tauri::command]
pub async fn set_calendar_config(
    config: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let url = require_agent(&state).await?;
    let _: serde_json::Value =
        agent_rpc(&url, "calendar/set_config", serde_json::json!({ "config": config })).await?;
    Ok(())
}

#[tauri::command]
pub async fn get_calendar_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let url = require_agent(&state).await?;
    adopt_host_credentials(&state, &url).await;
    agent_rpc(&url, "calendar/status", serde_json::json!({})).await
}

/// Open the consent screen in the system browser, catch the callback on the
/// loopback listener, and hand the code to the agent to exchange.
#[tauri::command]
pub async fn connect_google_calendar(
    _app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let url = require_agent(&state).await?;

    let auth: serde_json::Value = agent_rpc(
        &url,
        "calendar/auth_url",
        serde_json::json!({ "redirect_uri": LOOPBACK_REDIRECT_URI }),
    )
    .await?;
    let auth_url = auth
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("Agent returned no auth URL")?
        .to_string();

    logging::info("calendar: opening auth URL");
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _ = open::that(&auth_url);
    })
    .await;

    let code = cal::wait_for_auth_code().await?;

    let _: serde_json::Value = agent_rpc(
        &url,
        "calendar/exchange_code",
        serde_json::json!({ "code": code, "redirect_uri": LOOPBACK_REDIRECT_URI }),
    )
    .await?;

    logging::info("calendar: OAuth complete, tokens saved in the sandbox");
    Ok("Google Calendar connected.".to_string())
}

#[tauri::command]
pub async fn disconnect_google_calendar(state: State<'_, AppState>) -> Result<(), String> {
    let url = require_agent(&state).await?;
    let _: serde_json::Value = agent_rpc(&url, "calendar/disconnect", serde_json::json!({})).await?;
    logging::info("calendar: disconnected");
    Ok(())
}

/// Upcoming events for the next 30 days, without syncing them to todos.
#[tauri::command]
pub async fn fetch_calendar_events(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let url = require_agent(&state).await?;
    agent_rpc(
        &url,
        "calendar/fetch_events",
        serde_json::json!({ "start_offset": 0, "end_offset": 30 }),
    )
    .await
}

/// Sync the calendar window into the event cache and the todo list.
#[tauri::command]
pub async fn sync_calendar_to_todos(state: State<'_, AppState>) -> Result<String, String> {
    let url = require_agent(&state).await?;
    let result: serde_json::Value =
        agent_rpc(&url, "calendar/sync_to_todos", serde_json::json!({})).await?;
    let msg = result
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("Calendar synced.")
        .to_string();
    logging::info(&format!("calendar: {}", msg));
    Ok(msg)
}

/// Startup hook — sync quietly if the agent is up and sync is enabled. The agent
/// no-ops when it isn't configured, so there's nothing to check here first.
pub async fn auto_sync_calendar(app: AppHandle) {
    let state = app.state::<AppState>();

    let Some(url) = agent_url(&state) else {
        logging::info("calendar auto-sync: agent not connected, skipping");
        return;
    };

    adopt_host_credentials(&state, &url).await;

    match agent_rpc::<serde_json::Value>(&url, "calendar/sync_to_todos", serde_json::json!({})).await
    {
        Ok(result) => {
            let added = result.get("added").and_then(|v| v.as_u64()).unwrap_or(0);
            if added > 0 {
                logging::info(&format!("calendar auto-sync: added {} events as todos", added));
                let _ = app.emit("calendar-synced", added);
            } else {
                logging::info("calendar auto-sync: no new events");
            }
        }
        Err(e) => logging::warn(&format!("calendar auto-sync: {}", e)),
    }
}

// ── Migration off the host ──

/// Older builds kept the OAuth client and tokens in this device's config dir.
/// Hand them to the agent once per launch so an existing connection survives the
/// move into the VM. `calendar/import_local` only fills in what isn't already
/// set there, so this can never clobber a working in-VM connection.
async fn adopt_host_credentials(state: &AppState, url: &str) {
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }

    let config = cal::CalendarConfig::load(&state.config_dir);
    let tokens = cal::CalendarTokens::load(&state.config_dir);
    if config.client_id.is_empty() && tokens.refresh_token.is_empty() {
        return;
    }

    match agent_rpc::<serde_json::Value>(
        url,
        "calendar/import_local",
        serde_json::json!({ "config": config, "tokens": tokens }),
    )
    .await
    {
        Ok(result) => logging::info(&format!("calendar: adopted host credentials: {}", result)),
        Err(e) => logging::warn(&format!("calendar: couldn't adopt host credentials: {}", e)),
    }
}
