use tauri::State;
use crate::models::todo::{DayEntry, TodoItem};
use crate::services::storage as svc;
use crate::services::agent as agent_svc;
use crate::state::AppState;
use crate::logging;

/// Get the agent URL if connected, or None for local fallback.
fn agent_url(state: &AppState) -> Option<String> {
    state.agent_url.lock().unwrap().clone()
}

/// Call an agent RPC and parse the result, returning Err if the agent is down.
async fn agent_rpc<T: serde::de::DeserializeOwned>(
    url: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<T, String> {
    let resp = agent_svc::send_rpc(url, method, params).await?;
    if let Some(err) = resp.error {
        return Err(err.message);
    }
    let result = resp.result.ok_or("Empty response from agent")?;
    serde_json::from_value(result).map_err(|e| format!("Failed to parse: {}", e))
}

#[tauri::command]
pub async fn load_day(date: String, state: State<'_, AppState>) -> Result<DayEntry, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "storage/load_day", serde_json::json!({ "date": date })).await;
    }
    Ok(svc::load_day(&state.storage_root, &date))
}

#[tauri::command]
pub async fn get_days_range(state: State<'_, AppState>) -> Result<Vec<DayEntry>, String> {
    if let Some(url) = agent_url(&state) {
        logging::info("get_days_range: routing through agent");
        let result: Result<Vec<DayEntry>, String> = agent_rpc(&url, "storage/load_days_range", serde_json::json!({"offset_start": -6, "offset_end": 1})).await;
        if let Ok(ref entries) = result {
            let summary: Vec<String> = entries.iter().map(|e| format!("{}({})", e.date, e.todos.len())).collect();
            logging::info(&format!("get_days_range: agent returned [{}]", summary.join(", ")));
        }
        return result;
    }
    logging::info("get_days_range: using local storage");
    let entries = svc::load_days_range(&state.storage_root, -6, 1);
    let summary: Vec<String> = entries.iter().map(|e| format!("{}({})", e.date, e.todos.len())).collect();
    logging::info(&format!("get_days_range: loaded [{}]", summary.join(", ")));
    Ok(entries)
}

#[tauri::command]
pub async fn get_month_range(state: State<'_, AppState>) -> Result<Vec<DayEntry>, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "storage/load_days_range", serde_json::json!({"offset_start": 2, "offset_end": 28})).await;
    }
    Ok(svc::load_days_range(&state.storage_root, 2, 28))
}

#[tauri::command]
pub async fn save_todo(date: String, title: String, state: State<'_, AppState>) -> Result<DayEntry, String> {
    logging::info(&format!("save_todo: date={}, title={}", date, title));
    if let Some(url) = agent_url(&state) {
        logging::info(&format!("save_todo: routing through agent at {}", url));
        let result: Result<DayEntry, String> = agent_rpc(&url, "storage/add_todo", serde_json::json!({ "date": date, "title": title })).await;
        match &result {
            Ok(entry) => logging::info(&format!("save_todo: agent returned {} todos for {}", entry.todos.len(), entry.date)),
            Err(e) => logging::error(&format!("save_todo: agent error: {}", e)),
        }
        return result;
    }
    logging::info("save_todo: using local storage");
    let result = svc::add_todo(&state.storage_root, &date, &title);
    match &result {
        Ok(entry) => logging::info(&format!("save_todo: saved {} todos for {} at {:?}", entry.todos.len(), entry.date, state.storage_root)),
        Err(e) => logging::error(&format!("save_todo: local error: {}", e)),
    }
    result
}

#[tauri::command]
pub async fn update_todo(date: String, todo: TodoItem, state: State<'_, AppState>) -> Result<DayEntry, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "storage/update_todo", serde_json::json!({ "date": date, "todo": todo })).await;
    }
    svc::update_todo(&state.storage_root, &date, todo)
}

#[tauri::command]
pub async fn delete_todo(date: String, todo_id: String, state: State<'_, AppState>) -> Result<DayEntry, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "storage/delete_todo", serde_json::json!({ "date": date, "todo_id": todo_id })).await;
    }
    svc::delete_todo(&state.storage_root, &date, &todo_id)
}

#[tauri::command]
pub async fn load_spec(date: String, todo_id: String, state: State<'_, AppState>) -> Result<String, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "storage/load_spec", serde_json::json!({ "date": date, "todo_id": todo_id })).await;
    }
    Ok(svc::load_spec(&state.storage_root, &date, &todo_id))
}

#[tauri::command]
pub async fn save_spec(date: String, todo_id: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(url) = agent_url(&state) {
        let _: serde_json::Value = agent_rpc(&url, "storage/save_spec", serde_json::json!({
            "date": date,
            "todo_id": todo_id,
            "content": content,
        })).await?;
        return Ok(());
    }
    svc::save_spec(&state.storage_root, &date, &todo_id, &content)
}
