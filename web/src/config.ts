// Server-side stand-in for the Tauri app's host-local state.
//
// The desktop app keeps a handful of things on the host rather than in the
// sandbox: the agent config, the theme, and the offline create queue. The web
// shell has no host, so the server owns those files instead — same names, same
// JSON shapes, so a config written by one shell is readable by the other.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the agent's HTTP API lives. Inside the VM this is the local agent. */
export const AGENT_URL = (process.env.AGENT_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

/** Mirrors the desktop app's ~/.todo (mounted at /data inside the sandbox). */
export const DATA_DIR = process.env.TODO_DATA_DIR ?? path.join(os.homedir(), ".todo");

export const CONFIG_DIR = process.env.TODO_CONFIG_DIR ?? path.join(DATA_DIR, "config");

/** Surfaced in the status popover's "View Logs"; the agent's log is what matters. */
export const LOG_FILE = process.env.TODO_LOG_FILE ?? path.join(DATA_DIR, "logs", "agent.log");

/** Directory of the built frontend (index.html + assets/). */
export const PUBLIC_DIR = process.env.WEB_PUBLIC_DIR ?? path.join(import.meta.dirname, "..", "public");

export const PORT = Number(process.env.PORT ?? 3000);

// ── JSON file helpers ──

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), "utf8")) as object) };
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, file), JSON.stringify(value, null, 2));
}

// ── agent.json ──

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
  spec_verbosity: string;
  user_context: string;
  theme_name: string;
  llm_provider: string;
  openrouter_api_key: string;
  openrouter_model: string;
}

const USER_CONTEXT_MAX = 1000;

function defaultAgentConfig(): AgentConfig {
  return {
    api_key: "",
    model: "claude-sonnet-4-6",
    vm_name: "todo-agent",
    vm_backend: "kvm",
    data_dir: DATA_DIR,
    heyo_api_key: "",
    heyo_cloud_url: "https://server.heyo.computer",
    deploy_region: "US",
    deploy_size_class: "small",
    deploy_image: "ubuntu:24.04",
    speech_api_key: "",
    spec_verbosity: "normal",
    user_context: "",
    theme_name: "dark",
    llm_provider: "anthropic",
    openrouter_api_key: "",
    openrouter_model: "anthropic/claude-sonnet-4-6",
  };
}

export function getAgentConfig(): AgentConfig {
  return readJson("agent.json", defaultAgentConfig());
}

export function setAgentConfig(config: AgentConfig): void {
  // Same normalization the Rust command applies, so the two shells can't write
  // configs the other would reject.
  const next = { ...config };
  if (!["terse", "normal", "detailed"].includes(next.spec_verbosity)) next.spec_verbosity = "normal";
  if (next.user_context && [...next.user_context].length > USER_CONTEXT_MAX) {
    next.user_context = [...next.user_context].slice(0, USER_CONTEXT_MAX).join("");
  }
  writeJson("agent.json", next);
}

// ── theme.json ──

export function getTheme(): string {
  return readJson<{ name: string }>("theme.json", { name: "dark" }).name;
}

export function setTheme(name: string): void {
  writeJson("theme.json", { name });
}

// Calendar config and tokens are NOT here: the agent owns them, in the VM's
// /data/config, so both shells share one connection. See the agent's
// tools/google-calendar.ts.

// ── pending_creates.json ──
//
// Book/list creates made while the agent was unreachable, replayed on
// reconnect. Same file and shape as the desktop queue.

export interface PendingCreate {
  local_id: string;
  kind: string;
  name: string;
  fields: unknown[];
  created_at: string;
}

export function readPendingQueue(): PendingCreate[] {
  try {
    const raw = fs.readFileSync(path.join(CONFIG_DIR, "pending_creates.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writePendingQueue(queue: PendingCreate[]): void {
  writeJson("pending_creates.json", queue);
}

/** Last `n` lines of the log file, or "" if there isn't one. */
export function recentLogs(n: number): string {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n");
    return lines.slice(Math.max(0, lines.length - n)).join("\n");
  } catch {
    return "";
  }
}
