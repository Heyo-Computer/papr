export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  has_spec: boolean;
  created_at: string;
  updated_at: string;
}

export interface DayEntry {
  date: string;
  todos: TodoItem[];
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface Artifact {
  name: string;
  path: string;
  size: number;
  created_at: string;
}

export interface Theme {
  name: string;
  colors: Record<string, string>;
  fonts: {
    body: string;
    mono: string;
  };
}

export type ViewTab = "week" | "month" | "artifacts";

export type AgentStatus = "disconnected" | "starting" | "running" | "error";

export type AgentMode = "local" | "deployed" | "remote";

export interface DeploymentInfo {
  mode: AgentMode;
  sandbox_id: string | null;
  public_url: string | null;
}

export interface AgentConfig {
  api_key: string;
  model: string;
  vm_name: string;
  vm_backend: string;
  data_dir: string;
  heyo_api_key: string;
  heyo_cloud_url: string;
  deploy_region: string;
  deploy_size_class: string;
  deploy_image: string;
  speech_api_key: string;
}

export interface CalendarConfig {
  client_id: string;
  client_secret: string;
  enabled: boolean;
  calendar_id: string;
}

export interface CalendarStatus {
  configured: boolean;
  connected: boolean;
  token_valid: boolean;
  enabled: boolean;
}

export interface CalendarEvent {
  summary: string;
  start_time: string;
  end_time: string;
}

export interface StatusInfo {
  agent_status: string;
  sandbox_status: string;
  sandbox_name: string;
  data_dir: string;
  data_dir_exists: boolean;
  heyvm_available: boolean;
  agent_error: string | null;
  sandbox_error: string | null;
  log_file: string;
  agent_mode: AgentMode;
  deploy_url: string | null;
}
