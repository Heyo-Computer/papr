// The command table: every `invoke()` the frontend can make, implemented for
// the web shell.
//
// Commands fall into three groups.
//
//   proxied  — the desktop app's Rust handler is a thin forwarder to an agent
//              JSON-RPC method, so we forward the same way. Argument names go
//              from the webview's camelCase to the agent's snake_case, exactly
//              as the Rust layer does.
//   local    — host-side state the desktop app keeps in ~/.todo/config; here the
//              server owns those files (see config.ts).
//   desktop  — genuinely needs the host machine (heyvm, OS opener, OAuth
//              loopback). These fail with an explanation rather than silently
//              doing nothing.

import fs from "node:fs";
import { agentRpc, streamChat } from "./agent.js";
import * as store from "./config.js";
import { AGENT_URL, DATA_DIR, LOG_FILE } from "./config.js";
import * as speech from "./speech.js";
import { currentStatus, refreshStatus } from "./status.js";
import * as supervisor from "./supervisor.js";

type Args = Record<string, any>;
type Handler = (args: Args) => unknown | Promise<unknown>;

/** Forward to an agent JSON-RPC method, mapping the webview's argument names. */
function rpc(method: string, params: (a: Args) => Record<string, unknown> = () => ({}), timeoutMs?: number): Handler {
  return (args) => agentRpc(method, params(args), timeoutMs);
}

/** A command that only the desktop shell can carry out. */
function desktopOnly(what: string): Handler {
  return () => {
    throw new Error(`${what} is only available in the desktop app.`);
  };
}

/**
 * Poll until the agent answers, up to ~15s. A just-launched agent needs a
 * moment to bind its port, and the Settings/boot-gate buttons that call this
 * should report success once it's actually up rather than immediately failing.
 */
async function waitForAgent(): Promise<string> {
  for (let attempt = 0; attempt < 15; attempt++) {
    if ((await refreshStatus()) === "running") return "running";
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return currentStatus();
}

export const handlers: Record<string, Handler> = {
  // ── Storage ──
  load_day: rpc("storage/load_day", (a) => ({ date: a.date })),
  get_days_range: rpc("storage/load_days_range", () => ({ offset_start: -6, offset_end: 1 })),
  get_month_range: rpc("storage/load_days_range", () => ({ offset_start: 2, offset_end: 28 })),
  get_days_range_offset: rpc("storage/load_days_range", (a) => ({
    offset_start: a.offsetStart,
    offset_end: a.offsetEnd,
  })),
  save_todo: rpc("storage/add_todo", (a) => ({ date: a.date, title: a.title })),
  update_todo: rpc("storage/update_todo", (a) => ({ date: a.date, todo: a.todo })),
  delete_todo: rpc("storage/delete_todo", (a) => ({ date: a.date, todo_id: a.todoId })),
  load_spec: rpc("storage/load_spec", (a) => ({ date: a.date, todo_id: a.todoId })),
  save_spec: rpc("storage/save_spec", (a) => ({ date: a.date, todo_id: a.todoId, content: a.content })),

  // ── Backlog ──
  load_backlog: rpc("storage/load_backlog"),
  add_backlog_item: rpc("storage/add_backlog_item", (a) => ({ title: a.title })),
  update_backlog_item: rpc("storage/update_backlog_item", (a) => ({ item: a.item })),
  delete_backlog_item: rpc("storage/delete_backlog_item", (a) => ({ item_id: a.itemId })),
  load_backlog_spec: rpc("storage/load_backlog_spec", (a) => ({ item_id: a.itemId })),
  save_backlog_spec: rpc("storage/save_backlog_spec", (a) => ({ item_id: a.itemId, content: a.content })),
  move_backlog_to_day: rpc("storage/move_backlog_to_day", (a) => ({ item_id: a.itemId, date: a.date })),

  // ── Lists ──
  list_lists: rpc("lists/list_lists"),
  load_list: rpc("lists/load_list", (a) => ({ list_id: a.listId })),
  create_list: rpc("lists/create_list", (a) => ({ name: a.name, fields: a.fields ?? [] })),
  update_list_meta: rpc("lists/update_list_meta", (a) => ({ list_id: a.listId, name: a.name, fields: a.fields ?? [] })),
  delete_list: rpc("lists/delete_list", (a) => ({ list_id: a.listId })),
  add_list_item: rpc("lists/add_list_item", (a) => ({ list_id: a.listId, values: a.values ?? {} })),
  update_list_item: rpc("lists/update_list_item", (a) => ({ list_id: a.listId, item: a.item })),
  delete_list_item: rpc("lists/delete_list_item", (a) => ({ list_id: a.listId, item_id: a.itemId })),

  // ── Books ──
  list_books: rpc("books/list_books"),
  load_book: rpc("books/load_book", (a) => ({ book_id: a.bookId })),
  create_book: rpc("books/create_book", (a) => ({ name: a.name })),
  delete_book: rpc("books/delete_book", (a) => ({ book_id: a.bookId })),
  add_page: rpc("books/add_page", (a) => ({ book_id: a.bookId, title: a.title })),
  load_page: rpc("books/load_page", (a) => ({ book_id: a.bookId, page_id: a.pageId })),
  save_page: rpc("books/save_page", (a) => ({ book_id: a.bookId, page_id: a.pageId, content: a.content })),
  update_page_meta: rpc("books/update_page_meta", (a) => ({ book_id: a.bookId, page_id: a.pageId, title: a.title })),
  reorder_pages: rpc("books/reorder_pages", (a) => ({ book_id: a.bookId, ordered_ids: a.orderedIds ?? [] })),
  delete_page: rpc("books/delete_page", (a) => ({ book_id: a.bookId, page_id: a.pageId })),

  // ── Links ──
  link_todo_to_list_item: rpc("links/link_todo_to_list_item", (a) => ({
    date: a.date, todo_id: a.todoId, list_id: a.listId, item_id: a.itemId,
  })),
  unlink_todo_from_list_item: rpc("links/unlink_todo_from_list_item", (a) => ({
    date: a.date, todo_id: a.todoId, list_id: a.listId, item_id: a.itemId,
  })),
  link_todo_to_book_page: rpc("links/link_todo_to_book_page", (a) => ({
    date: a.date, todo_id: a.todoId, book_id: a.bookId, page_id: a.pageId,
  })),
  unlink_todo_from_book_page: rpc("links/unlink_todo_from_book_page", (a) => ({
    date: a.date, todo_id: a.todoId, book_id: a.bookId, page_id: a.pageId,
  })),
  create_page_from_todo: rpc("links/create_page_from_todo", (a) => ({
    date: a.date, todo_id: a.todoId, book_id: a.bookId,
  })),
  create_list_item_from_todo: rpc("links/create_list_item_from_todo", (a) => ({
    date: a.date, todo_id: a.todoId, list_id: a.listId,
  })),

  // ── Artifacts ──
  list_artifacts: rpc("artifacts/list", (a) => ({ dir: a.dir ?? "" })),
  list_all_artifacts: rpc("artifacts/list_all"),
  read_artifact: rpc("artifacts/read", (a) => ({ path: a.path })),
  save_artifact: rpc("artifacts/save", (a) => ({ path: a.path, content: a.content ?? "" })),
  delete_artifact: rpc("artifacts/delete", (a) => ({ path: a.path })),
  create_artifact_folder: rpc("artifacts/create_folder", (a) => ({ path: a.path })),
  rename_artifact: rpc("artifacts/rename", (a) => ({ path: a.path, new_name: a.newName })),
  move_artifact: rpc("artifacts/move", (a) => ({ path: a.path, target_dir: a.targetDir ?? "" })),
  list_artifact_folders: rpc("artifacts/list_folders"),
  // The browser opens /api/artifact/download directly instead (see the frontend's
  // ArtifactItem), so this only fires if something else calls it.
  open_artifact_external: desktopOnly("Opening an artifact in another application"),

  // ── Plugins (Pi package library) ──
  // npm/git fetches are slow; match the desktop app's extended timeouts.
  list_plugins: rpc("plugins/list"),
  install_plugin: rpc("plugins/install", (a) => ({ source: a.source, local: !!a.local }), 600_000),
  remove_plugin: rpc("plugins/remove", (a) => ({ source: a.source, local: !!a.local }), 300_000),

  // ── Chat / agent ──
  send_message: rpc("agent/chat", (a) => ({ message: a.message }), 900_000),
  structure_note: rpc("agent/structure_note", (a) => ({ transcript: a.transcript }), 300_000),

  send_message_streaming: (a) => {
    streamChat(a.message as string, a.requestId as string);
    return null;
  },

  abort_message: async () => {
    // Stop the agent's turn; our relay ends when the stream closes.
    await agentRpc("agent/abort").catch(() => undefined);
    return null;
  },

  agent_status: () => currentStatus(),

  // The web shell provisions nothing. When it supervises a co-located agent
  // (AGENT_SPAWN) "setup" means (re)launch it; otherwise it's just a re-check
  // of the agent we were pointed at.
  setup_agent: async () => {
    if (supervisor.SUPERVISING && !supervisor.isRunning()) supervisor.start();
    const status = await waitForAgent();
    if (status !== "running") throw new Error(`No agent responding at ${AGENT_URL}.`);
    return `Connected to the agent at ${AGENT_URL}`;
  },
  start_agent: async () => {
    if (supervisor.SUPERVISING && !supervisor.isRunning()) supervisor.start();
    const status = await waitForAgent();
    if (status !== "running") throw new Error(`No agent responding at ${AGENT_URL}.`);
    return null;
  },
  stop_agent: async () => {
    if (!supervisor.SUPERVISING) throw new Error("Stopping the agent process is only available in the desktop app.");
    await supervisor.stop();
    return null;
  },
  update_agent: desktopOnly("Updating the agent"),
  get_chat_history: () => [],

  // ── Config / theme / status ──
  get_agent_config: () => store.getAgentConfig(),
  set_agent_config: async (a) => {
    store.setAgentConfig(a.config as store.AgentConfig);
    // The agent reads its provider/key/model from env at launch, so a new API
    // key only takes effect once it's restarted. No-op unless we own it.
    await supervisor.restartIfLaunchConfigChanged();
    return null;
  },
  get_theme: () => store.getTheme(),
  set_theme: (a) => {
    store.setTheme(a.themeName as string);
    return null;
  },
  get_recent_logs: (a) => store.recentLogs((a.lines as number) ?? 40),

  get_status_info: async () => {
    const status = await refreshStatus();
    return {
      agent_status: status === "running" ? "running" : "unreachable",
      sandbox_status: "n/a",
      sandbox_name: store.getAgentConfig().vm_name,
      data_dir: DATA_DIR,
      data_dir_exists: fs.existsSync(DATA_DIR),
      heyvm_available: false,
      agent_error: status === "running" ? null : `Agent not responding at ${AGENT_URL}`,
      sandbox_error: null,
      log_file: LOG_FILE,
      agent_mode: "web",
      deploy_url: null,
    };
  },

  get_deployment_info: () => ({
    mode: "web",
    sandbox_id: null,
    public_url: null,
    p2p_ticket: null,
    p2p_relay: null,
    network_service: null,
    network_port: null,
  }),

  // ── Pending create queue ──
  list_pending_creates: () => store.readPendingQueue(),
  enqueue_pending_create: (a) => {
    const queue = [...store.readPendingQueue(), a.entry as store.PendingCreate];
    store.writePendingQueue(queue);
    return queue;
  },
  remove_pending_create: (a) => {
    const queue = store.readPendingQueue().filter((e) => e.local_id !== a.localId);
    store.writePendingQueue(queue);
    return queue;
  },
  flush_pending_creates: async () => {
    // Replay each queued create, dropping an entry only once it lands.
    const remaining: store.PendingCreate[] = [];
    const errors: string[] = [];
    let synced = 0;

    for (const entry of store.readPendingQueue()) {
      const [method, params] =
        entry.kind === "list"
          ? ["lists/create_list", { name: entry.name, fields: entry.fields }]
          : ["books/create_book", { name: entry.name }];
      try {
        await agentRpc(method as string, params as Record<string, unknown>);
        synced++;
      } catch (e) {
        errors.push(`${entry.kind} "${entry.name}": ${(e as Error).message}`);
        remaining.push(entry);
      }
    }

    store.writePendingQueue(remaining);
    return { synced, remaining: remaining.length, errors };
  },

  // ── Speech / vision ──
  transcribe_audio: (a) => speech.transcribe(a.audioData as string, a.mediaType as string),
  speak_text: (a) => speech.textToSpeech(a.text as string),
  describe_image: (a) => speech.describeImage(a.imageData as string, a.mediaType as string, a.prompt as string),
  // Desktop-only: takes a path on the host filesystem written by the native
  // recorder plugin. The browser uses transcribe_audio instead.
  transcribe_file: desktopOnly("Transcribing a file from disk"),

  // ── Calendar ──
  //
  // The agent owns the whole integration (credentials, tokens, Google API), so
  // these are forwarders. Only the browser handoff is ours: the frontend opens
  // /api/calendar/connect, which redirects to Google and comes back to
  // /api/calendar/callback (see server.ts).
  get_calendar_config: rpc("calendar/get_config"),
  set_calendar_config: rpc("calendar/set_config", (a) => ({ config: a.config })),
  get_calendar_status: rpc("calendar/status"),
  disconnect_google_calendar: rpc("calendar/disconnect"),
  fetch_calendar_events: rpc("calendar/fetch_events", () => ({ start_offset: 0, end_offset: 30 })),
  sync_calendar_to_todos: async () => {
    const result = await agentRpc<{ message: string }>("calendar/sync_to_todos", {}, 300_000);
    return result.message;
  },

  // An invoke() call can't redirect the browser, so hand back the URL to open
  // and let the frontend put it in a popup. Relative to the app's own origin,
  // which is what the redirect URI has to match.
  connect_google_calendar: () => "/api/calendar/connect",

  // ── Migration ──
  // "local" means this device's ~/.todo, which a browser can't see; report the
  // sandbox side (which the Data panel shows) and zeros for local.
  migration_stats: async () => ({
    local: { days: 0, todos: 0, backlog: 0, lists: 0, books: 0, artifacts: 0 },
    sandbox: await agentRpc("migration/stats").then((s: any) => s?.sandbox ?? s),
  }),
  migrate_local_to_sandbox: desktopOnly("Importing local data into the sandbox"),
  export_sandbox_to_local: desktopOnly("Exporting the sandbox to a local directory"),

  // ── Host-machine features (heyvm, deploy, P2P, network) ──
  create_vm: desktopOnly("Creating a VM"),
  start_vm: desktopOnly("Starting a VM"),
  stop_vm: desktopOnly("Stopping a VM"),
  snapshot_vm: desktopOnly("Snapshotting a VM"),
  vm_status: () => "n/a",
  list_sandboxes: () => [],
  list_vms: () => [],
  use_existing_vm: desktopOnly("Attaching to an existing VM"),
  deploy_agent: desktopOnly("Deploying to Heyo Cloud"),
  connect_remote: desktopOnly("Connecting to a remote agent"),
  disconnect_remote: desktopOnly("Disconnecting"),
  teardown_deploy: desktopOnly("Tearing down a deployment"),
  connect_p2p: desktopOnly("Connecting over P2P"),
  disconnect_p2p: desktopOnly("Disconnecting"),
  list_network_services: () => [],
  connect_network: desktopOnly("Connecting to a networked VM"),
};
