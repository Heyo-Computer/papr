//! Desktop-side remnants of the Google Calendar integration.
//!
//! The integration itself moved into the agent
//! (`agent/src/tools/google-calendar.ts`) so both shells share one
//! implementation and the credentials live in the VM with the rest of the data.
//! What's left here is what only a desktop app can do or needs to know:
//!
//! - `wait_for_auth_code` — the loopback listener that catches Google's
//!   redirect. A desktop app has no public URL, so it can't use the web shell's
//!   `<origin>/api/calendar/callback` route.
//! - `CalendarConfig` / `CalendarTokens` — the *legacy* host-side files, read
//!   once at startup and handed to the agent (see
//!   `commands::calendar::adopt_host_credentials`) so an existing connection
//!   isn't lost. Nothing writes them any more.
//! - `CalendarEvent` — still the shape used by `services::storage`'s retained
//!   reference implementation of the event cache.

use crate::logging;
use serde::{Deserialize, Serialize};
use std::path::Path;

const REDIRECT_PORT: u16 = 19284;

// ── Legacy host-side config (read-only; the agent owns these now) ──

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CalendarConfig {
    pub client_id: String,
    pub client_secret: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub calendar_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CalendarTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}

impl CalendarConfig {
    pub fn load(config_dir: &Path) -> Self {
        load_json(config_dir, "calendar.json")
    }
}

impl CalendarTokens {
    pub fn load(config_dir: &Path) -> Self {
        load_json(config_dir, "calendar_tokens.json")
    }
}

fn load_json<T: Default + serde::de::DeserializeOwned>(config_dir: &Path, name: &str) -> T {
    std::fs::read_to_string(config_dir.join(name))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// ── OAuth loopback listener ──

/// Bind the loopback redirect port, wait for Google's callback, and return the
/// authorization code. The caller passes it to the agent to exchange.
pub async fn wait_for_auth_code() -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind(format!("127.0.0.1:{}", REDIRECT_PORT))
        .await
        .map_err(|e| format!("Failed to bind redirect listener: {}", e))?;

    logging::info(&format!(
        "calendar: listening for OAuth callback on port {}",
        REDIRECT_PORT
    ));

    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|e| format!("Failed to accept connection: {}", e))?;

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read request: {}", e))?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Parse from the request line: GET /callback?code=xxx&scope=... HTTP/1.1
    let query = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|path| path.split('?').nth(1).map(str::to_string))
        .unwrap_or_default();

    let param = |name: &str| -> Option<String> {
        query.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == name).then(|| v.to_string())
        })
    };

    // A user who declines consent comes back with ?error=access_denied and no code.
    let (title, detail) = match (param("code"), param("error")) {
        (Some(_), _) => ("Calendar connected!", "You can close this tab."),
        (None, Some(_)) => ("Sign-in cancelled", "You can close this tab and try again."),
        (None, None) => ("Sign-in failed", "Google didn't return an authorization code."),
    };
    let html = format!("<html><body><h2>{}</h2><p>{}</p></body></html>", title, detail);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html,
    );
    let _ = stream.write_all(response.as_bytes()).await;

    let code = param("code").ok_or("No auth code in callback")?;
    logging::info("calendar: received auth code");
    Ok(code)
}

// ── Event shape (used by the retained storage reference implementation) ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEvent {
    #[serde(default)]
    pub id: String,
    pub summary: String,
    pub start_time: String,
    pub end_time: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub meeting_url: String,
    #[serde(default)]
    pub attendees: Vec<String>,
}
