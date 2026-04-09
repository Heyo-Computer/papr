use std::path::{Path, PathBuf};
use crate::models::todo::{DayEntry, TodoItem};

pub fn day_dir(storage_root: &Path, date: &str) -> PathBuf {
    // date format: YYYY-MM-DD
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return storage_root.join(date);
    }
    storage_root.join(parts[0]).join(parts[1]).join(parts[2])
}

pub fn ensure_day_dir(storage_root: &Path, date: &str) -> std::io::Result<PathBuf> {
    let dir = day_dir(storage_root, date);
    std::fs::create_dir_all(&dir)?;
    std::fs::create_dir_all(dir.join("specs"))?;
    Ok(dir)
}

pub fn load_day(storage_root: &Path, date: &str) -> DayEntry {
    let dir = day_dir(storage_root, date);
    let path = dir.join("day.json");

    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(entry) => return entry,
                Err(_) => {}
            },
            Err(_) => {}
        }
    }

    DayEntry::new(date.to_string())
}

pub fn save_day(storage_root: &Path, entry: &DayEntry) -> Result<(), String> {
    let dir = ensure_day_dir(storage_root, &entry.date).map_err(|e| e.to_string())?;
    let path = dir.join("day.json");
    let content = serde_json::to_string_pretty(entry).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

pub fn load_spec(storage_root: &Path, date: &str, todo_id: &str) -> String {
    let dir = day_dir(storage_root, date);
    let path = dir.join("specs").join(format!("{}.md", todo_id));

    std::fs::read_to_string(&path).unwrap_or_default()
}

pub fn save_spec(storage_root: &Path, date: &str, todo_id: &str, content: &str) -> Result<(), String> {
    let dir = ensure_day_dir(storage_root, date).map_err(|e| e.to_string())?;
    let path = dir.join("specs").join(format!("{}.md", todo_id));
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

pub fn load_days_range(storage_root: &Path, offset_start: i64, offset_end: i64) -> Vec<DayEntry> {
    let today = chrono::Local::now().date_naive();
    let mut date = today + chrono::Duration::days(offset_start);
    let end = today + chrono::Duration::days(offset_end);
    let mut entries = Vec::new();
    while date <= end {
        let date_str = date.format("%Y-%m-%d").to_string();
        entries.push(load_day(storage_root, &date_str));
        date += chrono::Duration::days(1);
    }
    entries
}

pub fn add_todo(storage_root: &Path, date: &str, title: &str) -> Result<DayEntry, String> {
    let mut entry = load_day(storage_root, date);
    let now = chrono::Local::now().to_rfc3339();
    let todo = TodoItem {
        id: uuid::Uuid::new_v4().to_string(),
        title: title.to_string(),
        completed: false,
        has_spec: false,
        created_at: now.clone(),
        updated_at: now,
    };
    entry.todos.push(todo);
    save_day(storage_root, &entry)?;
    Ok(entry)
}

pub fn update_todo(storage_root: &Path, date: &str, updated: TodoItem) -> Result<DayEntry, String> {
    let mut entry = load_day(storage_root, date);
    if let Some(todo) = entry.todos.iter_mut().find(|t| t.id == updated.id) {
        todo.title = updated.title;
        todo.completed = updated.completed;
        todo.has_spec = updated.has_spec;
        todo.updated_at = chrono::Local::now().to_rfc3339();
    }
    save_day(storage_root, &entry)?;
    Ok(entry)
}

pub fn delete_todo(storage_root: &Path, date: &str, todo_id: &str) -> Result<DayEntry, String> {
    let mut entry = load_day(storage_root, date);
    entry.todos.retain(|t| t.id != todo_id);

    // Also remove the spec file if it exists
    let spec_path = day_dir(storage_root, date).join("specs").join(format!("{}.md", todo_id));
    let _ = std::fs::remove_file(spec_path);

    save_day(storage_root, &entry)?;
    Ok(entry)
}
