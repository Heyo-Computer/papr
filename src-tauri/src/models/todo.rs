use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    pub completed: bool,
    #[serde(default)]
    pub has_spec: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayEntry {
    #[serde(default)]
    pub date: String,
    pub todos: Vec<TodoItem>,
}

impl DayEntry {
    pub fn new(date: String) -> Self {
        Self {
            date,
            todos: Vec::new(),
        }
    }
}
