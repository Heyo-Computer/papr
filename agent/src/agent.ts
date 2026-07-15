import { randomUUID } from "node:crypto";
import { saveTodoSpec, updateTodo, getTodosForDate, getBacklogText, addBacklogItem, moveBacklogToDay } from "./tools/todo.js";
import { saveArtifact, listArtifacts } from "./tools/artifact.js";
import { getCalendarEvents, getCalendarEventById } from "./tools/calendar.js";
import { linkTodoToListItem, unlinkTodoFromListItem, linkTodoToBookPage, unlinkTodoFromBookPage, createPageFromTodo, createListItemFromTodo } from "./tools/links.js";
import { searchIndex, type DocKind, type IndexDoc } from "./tools/search.js";
import {
  listLists,
  getList,
  createList,
  addListItem,
  updateListItem,
  deleteListItem,
  type ListField,
} from "./tools/lists.js";
import {
  listBooks,
  getBook,
  createBook,
  addPage,
  savePageContent,
  loadPage,
  updatePageMeta,
} from "./tools/books.js";
import type { AgentMessage } from "./types.js";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { toPiTools, type ToolSchema } from "./pi/toolAdapter.js";
import { PiRuntime } from "./pi/session.js";
import { PluginManager, type PluginInfo } from "./pi/plugins.js";
import { buildSystemPrompt, loadPromptConfig, searchSummarySystem, STRUCTURE_NOTE_SYSTEM } from "./pi/prompt.js";

/** Render index results into a compact, model-readable block for the /search summary.
 * Each line leads with the result's `token` so the model can echo it verbatim as a chip. */
function renderResultsForModel(results: IndexDoc[], query: string): string {
  if (results.length === 0) {
    return `Search query: "${query}"\n\nResults: (none found)`;
  }
  const lines = results.map((r, i) => {
    const bits = [`${i + 1}. [${r.kind}] ${r.token}`];
    if (r.date) bits.push(`   date: ${r.date}`);
    if (r.snippet) bits.push(`   ${r.snippet}`);
    return bits.join("\n");
  });
  return `Search query: "${query}"\n\nResults (${results.length}):\n${lines.join("\n")}`;
}

// NOTE: low-level file/shell tools (read_file, write_file, list_directory,
// exec_command) are intentionally omitted — Pi's built-in read/write/bash tools
// cover them (see BUILTIN_TOOLS in pi/session.ts).
const tools: ToolSchema[] = [
  {
    name: "save_spec",
    description:
      "Save a markdown spec for a todo item. This writes the spec file and sets has_spec=true on the todo. " +
      "The date is in YYYY-MM-DD format and the todo_id is the UUID of the todo item.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date of the todo (YYYY-MM-DD)" },
        todo_id: { type: "string", description: "UUID of the todo item" },
        content: { type: "string", description: "Markdown content for the spec" },
      },
      required: ["date", "todo_id", "content"],
    },
  },
  {
    name: "update_todo",
    description: "Update a todo item's title or completed status.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date of the todo (YYYY-MM-DD)" },
        todo_id: { type: "string", description: "UUID of the todo item" },
        title: { type: "string", description: "New title (optional, omit to keep current)" },
        completed: { type: "boolean", description: "New completed status (optional, omit to keep current)" },
      },
      required: ["date", "todo_id"],
    },
  },
  {
    name: "get_todos",
    description: "Get all todo items for a given date. Use this to look up todo IDs and see what the user is working on.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to query (YYYY-MM-DD). Defaults to today." },
      },
      required: [],
    },
  },
  {
    name: "get_backlog",
    description:
      "List all items in the general (undated) backlog. Returns titles, completion state, and ids. " +
      "Use this when the user asks about backlog items or undated tasks.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "add_backlog_item",
    description: "Add a new item to the general (undated) backlog.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Item title" },
      },
      required: ["title"],
    },
  },
  {
    name: "move_backlog_to_day",
    description:
      "Move a backlog item onto a specific day's todo list. Preserves the item's id and any attached spec. " +
      "Use this when the user wants to schedule a backlog item for a particular date.",
    parameters: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "UUID of the backlog item" },
        date: { type: "string", description: "Target date (YYYY-MM-DD)" },
      },
      required: ["item_id", "date"],
    },
  },
  {
    name: "save_artifact",
    description:
      "Save a reusable file (script, snippet, reference, markdown note) to the artifacts library. " +
      "Updates the index so the file appears in the Artifacts tab. " +
      "Use this for standalone reusable files, NOT for todo-attached docs (use save_spec for those).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Filename (e.g., 'hello.py', 'notes.md'). Just the name, no path." },
        content: { type: "string", description: "File content" },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "list_artifacts",
    description: "List all saved artifacts with their names, sizes, and creation dates.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "calendar_events",
    description:
      "List upcoming Google Calendar events from the local cache. Returns events with id, summary, time, " +
      "location, meeting URL, and attendees. Use this to look up events the user is asking about. " +
      "Defaults to today + next 7 days.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Start date YYYY-MM-DD (defaults to today)" },
        days_ahead: { type: "number", description: "Number of days after start date to include (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "calendar_event",
    description:
      "Fetch full details for a specific calendar event by id. Returns the full event JSON " +
      "(summary, attendees, description, location, meeting URL). Use this when you need complete details " +
      "to craft a spec — e.g., the full description, full attendee list, or meeting agenda.",
    parameters: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Event id from calendar_events output" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "link_todo_to_list_item",
    description:
      "Link a todo to an existing list item so they reference each other. Writes the link onto both " +
      "the todo and the list item. Use `date` = the todo's date (YYYY-MM-DD), or empty string for a backlog item.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        list_id: { type: "string", description: "UUID of the list" },
        item_id: { type: "string", description: "UUID of the item within the list" },
      },
      required: ["date", "todo_id", "list_id", "item_id"],
    },
  },
  {
    name: "unlink_todo_from_list_item",
    description: "Remove the link between a todo and a list item (both sides).",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        list_id: { type: "string", description: "UUID of the list" },
        item_id: { type: "string", description: "UUID of the item within the list" },
      },
      required: ["date", "todo_id", "list_id", "item_id"],
    },
  },
  {
    name: "link_todo_to_book_page",
    description:
      "Link a todo to an existing book page so they reference each other. Writes the link onto both " +
      "the todo and the page. Use `date` = the todo's date (YYYY-MM-DD), or empty string for a backlog item.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        book_id: { type: "string", description: "UUID of the book" },
        page_id: { type: "string", description: "UUID of the page within the book" },
      },
      required: ["date", "todo_id", "book_id", "page_id"],
    },
  },
  {
    name: "unlink_todo_from_book_page",
    description: "Remove the link between a todo and a book page (both sides).",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        book_id: { type: "string", description: "UUID of the book" },
        page_id: { type: "string", description: "UUID of the page within the book" },
      },
      required: ["date", "todo_id", "book_id", "page_id"],
    },
  },
  {
    name: "create_page_from_todo",
    description:
      "Create a NEW page in a book from a todo (e.g. log standup notes as a new page in the standup book). " +
      "The page is titled after the todo and seeded with the todo's spec content; the todo and the new page " +
      "are then linked on both sides. Look up the todo with get_todos and the book with list_books/get_book first.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        book_id: { type: "string", description: "UUID of the book to add the page to" },
      },
      required: ["date", "todo_id", "book_id"],
    },
  },
  {
    name: "create_list_item_from_todo",
    description:
      "Create a NEW item (row) in a list from a todo. The list's first text field is defaulted to the todo " +
      "title; the todo and the new item are then linked on both sides. Look up the todo with get_todos and the " +
      "list with list_lists/get_list first.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        list_id: { type: "string", description: "UUID of the list to add the item to" },
      },
      required: ["date", "todo_id", "list_id"],
    },
  },
  {
    name: "list_lists",
    description: "List all of the user's lists (structured tables) with their ids, names, and last-updated times.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_list",
    description:
      "Get a single list by id, including its field definitions and all items (each with its id and values). " +
      "Use this to look up list/item ids before adding, updating, deleting, or linking items.",
    parameters: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "UUID of the list" },
      },
      required: ["list_id"],
    },
  },
  {
    name: "create_list",
    description:
      "Create a new list (a structured table). Define its columns via `fields`. Each field has a `key` " +
      "(machine name used in item values), a `label` (display name), and a `kind` " +
      "(one of: text, number, date, bool, select). For `select`, include an `options` string array.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name of the list" },
        fields: {
          type: "array",
          description: "Column definitions for the list",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Machine name for the field (used as the key in item values)" },
              label: { type: "string", description: "Human-readable column label" },
              kind: {
                type: "string",
                description: "Field type",
                enum: ["text", "number", "date", "bool", "select"],
              },
              options: {
                type: "array",
                description: "Allowed values when kind is 'select'",
                items: { type: "string" },
              },
            },
            required: ["key", "label", "kind"],
          },
        },
      },
      required: ["name"],
    },
  },
  {
    name: "add_list_item",
    description:
      "Add a row to a list. `values` is an object keyed by the list's field keys " +
      "(e.g. { name: \"Acme\", email: \"hi@acme.com\" }). Returns the updated list.",
    parameters: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "UUID of the list" },
        values: { type: "object", description: "Field values for the new item, keyed by field key" },
      },
      required: ["list_id", "values"],
    },
  },
  {
    name: "update_list_item",
    description:
      "Update an existing list item's values. `values` replaces the item's values object. " +
      "Look up the item_id with get_list first.",
    parameters: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "UUID of the list" },
        item_id: { type: "string", description: "UUID of the item within the list" },
        values: { type: "object", description: "New field values for the item, keyed by field key" },
      },
      required: ["list_id", "item_id", "values"],
    },
  },
  {
    name: "delete_list_item",
    description: "Delete an item (row) from a list by id. Returns the updated list.",
    parameters: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "UUID of the list" },
        item_id: { type: "string", description: "UUID of the item within the list" },
      },
      required: ["list_id", "item_id"],
    },
  },
  {
    name: "list_books",
    description: "List all of the user's books (collections of markdown pages) with their ids, names, and last-updated times.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_book",
    description:
      "Get a book by id. Returns the book's metadata and table of contents (its pages with their ids, " +
      "titles, and order). Use this to look up page ids before reading or updating a page.",
    parameters: {
      type: "object",
      properties: {
        book_id: { type: "string", description: "UUID of the book" },
      },
      required: ["book_id"],
    },
  },
  {
    name: "create_book",
    description: "Create a new (empty) book. Use add_book_page to add pages afterward.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name of the book" },
      },
      required: ["name"],
    },
  },
  {
    name: "add_book_page",
    description:
      "Add a page to a book. Optionally provide initial markdown `content`. Returns the updated book " +
      "(including the new page's id in its table of contents).",
    parameters: {
      type: "object",
      properties: {
        book_id: { type: "string", description: "UUID of the book" },
        title: { type: "string", description: "Title of the new page" },
        content: { type: "string", description: "Initial markdown content for the page (optional)" },
      },
      required: ["book_id", "title"],
    },
  },
  {
    name: "get_book_page",
    description: "Get a single page's title and markdown content from a book.",
    parameters: {
      type: "object",
      properties: {
        book_id: { type: "string", description: "UUID of the book" },
        page_id: { type: "string", description: "UUID of the page within the book" },
      },
      required: ["book_id", "page_id"],
    },
  },
  {
    name: "update_book_page",
    description:
      "Update a book page's title and/or markdown content. Omit `title` to keep the current title; " +
      "omit `content` to keep the current content.",
    parameters: {
      type: "object",
      properties: {
        book_id: { type: "string", description: "UUID of the book" },
        page_id: { type: "string", description: "UUID of the page within the book" },
        title: { type: "string", description: "New page title (optional)" },
        content: { type: "string", description: "New markdown content (optional)" },
      },
      required: ["book_id", "page_id"],
    },
  },
  {
    name: "search_content",
    description:
      "Search across everything the user has: todos, specs, backlog, lists+items, books+pages, " +
      "artifacts, and calendar events (including PAST meetings). Use this whenever the user references " +
      "something vaguely or asks where/find/which/when (e.g. \"where did I note the launch date\", " +
      "\"find my Acme list\", \"when did I last meet Hugo\"). This is the only way to find a calendar " +
      "event by keyword or in the past — calendar_events only lists a forward date window. Returns " +
      "ranked matches; each result has kind, title, snippet, ids, and a `token` (an @[..] mention " +
      "string). When you surface a result to the user, echo its `token` verbatim so it renders as a " +
      "clickable chip (calendar tokens render as plain text — there is no calendar chip).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms." },
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: ["todo", "backlog", "spec", "list", "list_item", "book", "page", "artifact", "calendar"],
          },
          description: "Optional filter — only return results of these kinds.",
        },
        limit: { type: "number", description: "Max results (default 10)." },
      },
      required: ["query"],
    },
  },
];

export class Agent {
  // The Pi runtime builds its model lazily on first chat so the storage server
  // can boot (and serve all non-chat RPCs) even when no API key is configured.
  private runtime = new PiRuntime();
  // The domain tools, adapted to Pi custom tools backed by executeTool.
  private customTools = toPiTools(tools, (name, input) => this.executeTool(name, input));
  // One persistent Pi session per day, lazily created and keyed by YYYY-MM-DD.
  private sessions = new Map<string, AgentSession>();
  // Pi package/plugin manager (extensions, skills, prompt templates).
  private plugins = new PluginManager(this.runtime);

  constructor() {}

  // ── Plugins ──────────────────────────────────────────────────────────────
  // After install/remove, dispose all live sessions so the next message rebuilds
  // them with a fresh resource loader that discovers the new packages/skills.

  private reloadPlugins(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }

  listPlugins(): Promise<PluginInfo> {
    return this.plugins.list();
  }

  async installPlugin(source: string, local: boolean): Promise<PluginInfo> {
    await this.plugins.install(source, local);
    this.reloadPlugins();
    return this.plugins.list();
  }

  async removePlugin(source: string, local: boolean): Promise<PluginInfo> {
    await this.plugins.remove(source, local);
    this.reloadPlugins();
    return this.plugins.list();
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Get (or lazily build) the chat session for a day. */
  async session(day = this.today()): Promise<AgentSession> {
    let s = this.sessions.get(day);
    if (!s) {
      s = await this.runtime.buildChatSession({
        systemPrompt: buildSystemPrompt(loadPromptConfig(), day),
        customTools: this.customTools,
        sessionId: `paperagent-${day}`,
      });
      this.sessions.set(day, s);
    }
    return s;
  }

  async chat(userMessage: string): Promise<AgentMessage> {
    // Deterministic /search skill: retrieval runs in code (always hits the index),
    // and the model only summarizes the actual results — so it can never hedge about
    // a "limitation" or silently skip the search.
    const searchMatch = /^\s*\/search\s+([\s\S]+)/i.exec(userMessage);
    if (searchMatch) {
      const query = searchMatch[1].trim();
      if (query) return this.searchAndSummarize(query);
    }

    // Non-streaming path: run the turn and synthesize the assistant message from
    // the collected text deltas (Pi's prompt() resolves void; output is events).
    let content = "";
    await this.stream(userMessage, (ev) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
        content += ev.assistantMessageEvent.delta;
      }
    });

    return {
      id: randomUUID(),
      role: "assistant",
      content: content.trim(),
      timestamp: new Date().toISOString(),
    };
  }

  /** Run a prompt on the current day's session, forwarding every Pi session event
   *  to `onEvent`. Used by both the non-streaming chat() above and the SSE
   *  streaming endpoint. The subscription is scoped to this turn. */
  async stream(userMessage: string, onEvent: (ev: AgentSessionEvent) => void): Promise<void> {
    const session = await this.session();
    const unsub = session.subscribe(onEvent);
    try {
      await session.prompt(userMessage);
    } finally {
      unsub();
    }
  }

  /** Abort the in-flight turn for the current day's session, if any. Leaves the
   *  session (and the process) alive — unlike agent/stop which exits. */
  async abort(): Promise<void> {
    const s = this.sessions.get(this.today());
    if (s) await s.abort();
  }

  /** Deterministic search skill (/search): query the index in code, then make a
   * single tool-less LLM call to summarize the *actual* results. The model is handed
   * authoritative results and forbidden from claiming a limitation, so retrieval is
   * deterministic and never silently skipped or editorialized away. */
  private async searchAndSummarize(query: string): Promise<AgentMessage> {
    const results = searchIndex(query, { limit: 10 });
    const content = await this.runtime.oneShot(
      searchSummarySystem(this.today()),
      renderResultsForModel(results, query),
    );

    return {
      id: randomUUID(),
      role: "assistant",
      content,
      timestamp: new Date().toISOString(),
    };
  }

  /** Turn a raw voice-note transcript into a clean, structured Markdown document
   * for a notebook page. Single-shot, tool-less, and STATELESS — it never reads
   * or writes `this.history`, so dictating a note doesn't pollute the ongoing
   * chat. Returns the page title (derived from the leading H1) plus the full
   * markdown body. */
  async structureNote(transcript: string): Promise<{ title: string; markdown: string }> {
    const clean = (transcript ?? "").trim();
    if (!clean) return { title: "Voice note", markdown: "" };

    // Stateless tool-less one-shot — never touches a persistent chat session.
    let markdown = (await this.runtime.oneShot(STRUCTURE_NOTE_SYSTEM, `Raw transcript:\n\n${clean}`)).trim();
    // Strip an accidental ```markdown … ``` fence if the model wrapped its output.
    markdown = markdown.replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    if (!markdown) markdown = clean; // never lose the note if structuring returns nothing

    // Derive the page title from the leading H1, else the first non-empty line.
    let title = "Voice note";
    const h1 = /^#\s+(.+)$/m.exec(markdown);
    if (h1) {
      title = h1[1].trim();
    } else {
      const firstLine = markdown.split("\n").find((l) => l.trim());
      if (firstLine) title = firstLine.replace(/^#+\s*/, "").trim().slice(0, 80);
    }
    return { title: title || "Voice note", markdown };
  }

  // Dispatch a domain tool by name. Throws on failure so Pi marks the tool
  // result as an error (the wrapper in pi/toolAdapter.ts relays the message).
  private async executeTool(name: string, input: Record<string, any>): Promise<string> {
    {
      switch (name) {
        case "save_spec":
          return saveTodoSpec(input.date, input.todo_id, input.content);
        case "update_todo":
          return updateTodo(input.date, input.todo_id, input.title, input.completed as unknown as boolean | undefined);
        case "get_todos":
          return getTodosForDate(input.date);
        case "get_backlog":
          return getBacklogText();
        case "add_backlog_item":
          return JSON.stringify(addBacklogItem(input.title));
        case "move_backlog_to_day":
          return JSON.stringify(moveBacklogToDay(input.item_id, input.date));
        case "save_artifact":
          return saveArtifact(input.name, input.content);
        case "list_artifacts":
          return listArtifacts();
        case "calendar_events":
          return getCalendarEvents(input.date, input.days_ahead as unknown as number | undefined);
        case "calendar_event":
          return getCalendarEventById(input.event_id);
        case "link_todo_to_list_item":
          return JSON.stringify(linkTodoToListItem(input.date ?? "", input.todo_id, input.list_id, input.item_id));
        case "unlink_todo_from_list_item":
          return JSON.stringify(unlinkTodoFromListItem(input.date ?? "", input.todo_id, input.list_id, input.item_id));
        case "link_todo_to_book_page":
          return JSON.stringify(linkTodoToBookPage(input.date ?? "", input.todo_id, input.book_id, input.page_id));
        case "unlink_todo_from_book_page":
          return JSON.stringify(unlinkTodoFromBookPage(input.date ?? "", input.todo_id, input.book_id, input.page_id));
        case "create_page_from_todo":
          return JSON.stringify(createPageFromTodo(input.date ?? "", input.todo_id, input.book_id));
        case "create_list_item_from_todo":
          return JSON.stringify(createListItemFromTodo(input.date ?? "", input.todo_id, input.list_id));
        case "list_lists":
          return JSON.stringify(listLists());
        case "get_list":
          return JSON.stringify(getList(input.list_id));
        case "create_list":
          return JSON.stringify(createList(input.name, (input.fields as unknown as ListField[]) ?? []));
        case "add_list_item":
          return JSON.stringify(addListItem(input.list_id, (input.values as unknown as Record<string, unknown>) ?? {}));
        case "update_list_item":
          return JSON.stringify(
            updateListItem(input.list_id, {
              id: input.item_id,
              values: (input.values as unknown as Record<string, unknown>) ?? {},
              linked_todos: [],
              created_at: "",
              updated_at: "",
            }),
          );
        case "delete_list_item":
          return JSON.stringify(deleteListItem(input.list_id, input.item_id));
        case "list_books":
          return JSON.stringify(listBooks());
        case "get_book":
          return JSON.stringify(getBook(input.book_id));
        case "create_book":
          return JSON.stringify(createBook(input.name));
        case "add_book_page": {
          let book = addPage(input.book_id, input.title);
          if (input.content != null && input.content !== "") {
            const page = book.pages[book.pages.length - 1];
            book = savePageContent(input.book_id, page.id, input.content);
          }
          return JSON.stringify(book);
        }
        case "get_book_page": {
          const book = getBook(input.book_id);
          const page = book.pages.find((p) => p.id === input.page_id);
          if (!page) throw new Error(`page ${input.page_id} not found`);
          return JSON.stringify({ ...page, content: loadPage(input.book_id, input.page_id) });
        }
        case "update_book_page": {
          let book = getBook(input.book_id);
          if (input.title != null) book = updatePageMeta(input.book_id, input.page_id, input.title);
          if (input.content != null) book = savePageContent(input.book_id, input.page_id, input.content);
          return JSON.stringify(book);
        }
        case "search_content": {
          const raw = (input as Record<string, unknown>).kinds;
          let kinds: DocKind[] | undefined;
          if (Array.isArray(raw)) kinds = raw as DocKind[];
          else if (typeof raw === "string" && raw.trim()) {
            try {
              const parsed = JSON.parse(raw);
              kinds = Array.isArray(parsed) ? (parsed as DocKind[]) : [raw as DocKind];
            } catch {
              kinds = raw.split(/[,\s]+/).filter(Boolean) as DocKind[];
            }
          }
          const limitRaw = (input as Record<string, unknown>).limit;
          const limit = limitRaw != null ? Number(limitRaw) : undefined;
          return JSON.stringify(searchIndex(input.query, { kinds, limit }));
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    }
  }

  /** Reset the conversation: dispose the current day's session so the next
   *  message starts a fresh one. */
  clearHistory() {
    const day = this.today();
    const s = this.sessions.get(day);
    if (s) {
      s.dispose();
      this.sessions.delete(day);
    }
  }
}
