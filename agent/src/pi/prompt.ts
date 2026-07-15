/**
 * System prompts and prompt configuration for the Pi-backed agent. Ported from
 * the previous hand-rolled engine; the only substantive change is that the
 * low-level file tools (`read_file`/`write_file`/`list_directory`/`exec_command`)
 * are now Pi's built-in `read`/`write`/`bash` tools, so the guidance refers to
 * those names.
 */
import * as fs from "node:fs";

const CONFIG_PATH = "/data/config/agent.json";

export interface PromptConfig {
  spec_verbosity: "terse" | "normal" | "detailed";
  user_context: string;
}

export function loadPromptConfig(): PromptConfig {
  // Prefer env (passed by the host at agent start) — under KVM the host can't
  // update the seeded /data/config/agent.json. Fall back to the config file.
  const fromFile = (() => {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
      return {};
    }
  })();

  const rawVerbosity = process.env.SPEC_VERBOSITY ?? fromFile.spec_verbosity;
  const verbosity = ["terse", "normal", "detailed"].includes(rawVerbosity)
    ? (rawVerbosity as PromptConfig["spec_verbosity"])
    : "normal";
  const userContext =
    process.env.USER_CONTEXT ??
    (typeof fromFile.user_context === "string" ? fromFile.user_context : "");

  return { spec_verbosity: verbosity, user_context: userContext };
}

function verbosityInstruction(verbosity: PromptConfig["spec_verbosity"]): string {
  switch (verbosity) {
    case "terse":
      return "When writing specs, be brief and to the point. Use minimal headers and bullet points. Skip preamble and obvious context. Aim for the smallest spec that captures the essential information.";
    case "detailed":
      return "When writing specs, be thorough. Include relevant context, rationale, edge cases, and step-by-step detail where applicable. Err on the side of more information.";
    case "normal":
    default:
      return "When writing specs, use a balanced level of detail — clear and complete without being exhaustive.";
  }
}

/** Build the main chat system prompt for a given day. */
export function buildSystemPrompt(promptConfig: PromptConfig, today: string): string {
  let systemPrompt =
    `You are a helpful agent for a todo/task management app. Today is ${today}.\n` +
    "The user's data directory is mounted at /data. The storage structure is:\n" +
    "  /data/storage/YYYY/MM/DD/day.json   — day's todos\n" +
    "  /data/storage/YYYY/MM/DD/specs/{todo-id}.md — spec for a todo\n" +
    "  /data/storage/backlog.json — the general (undated) backlog list\n" +
    "  /data/storage/backlog/specs/{item-id}.md — spec for a backlog item\n" +
    "  /data/storage/lists/{list-id}.json — a list (its fields + items)\n" +
    "  /data/storage/books/{book-id}/book.json — a book's metadata + page table of contents\n" +
    "  /data/storage/books/{book-id}/pages/{page-id}.md — a book page's markdown content\n" +
    "  /data/artifacts/ — reusable files\n\n" +
    "The backlog is the user's general todo list with no due date. Use get_backlog to read it. " +
    "When the user wants to schedule a backlog item for a specific day, use move_backlog_to_day.\n" +
    "When the user mentions a todo with @[title](id:UUID|date:YYYY-MM-DD), use the UUID and date directly.\n" +
    "When the user mentions an artifact with @[name](artifact:relative/path), it lives at " +
    "/data/artifacts/relative/path. If it's a file, use the read tool to read its contents; if it's a " +
    "folder, use the bash tool (e.g. `ls`) to see what's inside (then read specific files) when relevant.\n" +
    "When the user mentions a list with @[name](list:<listId>) or @[name](list:<listId>/<itemId>), " +
    "use the list/item tools with those ids. When the user mentions a book with @[name](book:<bookId>) " +
    "or @[name](book:<bookId>/<pageId>), use the book/page tools with those ids.\n" +
    "When asked to create a spec for a todo, use the save_spec tool — don't write files manually.\n" +
    "When asked to save anything to artifacts (a script, snippet, note, reference, or any file " +
    "the user wants to keep around), you MUST use the save_artifact tool — NOT the write tool. " +
    "The write tool is for low-level file operations only; save_artifact updates the artifact index " +
    "so the file appears in the user's Artifacts tab. " +
    "save_spec is for todo-attached docs; save_artifact is for standalone reusable files.\n" +
    "When you need to look up todos, use the get_todos tool.\n" +
    "Lists are structured tables and books are collections of markdown pages. You MUST use the " +
    "list_*/book_* tools (list_lists, get_list, create_list, add_list_item, update_list_item, " +
    "delete_list_item, list_books, get_book, create_book, add_book_page, get_book_page, " +
    "update_book_page) to work with them — NOT the write tool. Those tools keep the indexes in sync so the " +
    "changes appear in the Lists and Books tabs. Look up list/item and book/page ids with get_list / " +
    "get_book before updating, deleting, or linking.\n" +
    "Todos can be linked to list items and book pages. Use link_todo_to_list_item / link_todo_to_book_page " +
    "(and the unlink_* variants) to connect them — the link is written onto both sides. Pass the todo's date " +
    "(YYYY-MM-DD), or an empty string for a backlog item.\n" +
    "To create a brand-new page or item FROM a todo (e.g. \"log my standup notes as a page in my standup book\"), " +
    "look up the todo with get_todos then call create_page_from_todo / create_list_item_from_todo — these create " +
    "the page/item seeded from the todo and link both sides in one step.\n" +
    "When the user references a meeting or calendar event, use calendar_events to list events in a " +
    "date window and calendar_event to fetch full details (attendees, description, meeting link). " +
    "calendar_events only lists a window of cached events — to find a PAST meeting or look one up by " +
    "keyword/attendee (e.g. \"when did I last meet Hugo\"), use search_content, which indexes all " +
    "cached calendar events including past ones. " +
    "To create a spec for an event, look up the matching todo with get_todos, then call save_spec.\n" +
    "When the user references something vaguely or asks where/find/which/when something is across their " +
    "todos, lists, books, artifacts, or calendar events, use the search_content tool. You MUST echo each result's " +
    "`token` (the @[..] string) verbatim when presenting it, so it renders as a clickable chip. " +
    "Never tell the user you are unable to search a category of their data (e.g. past calendar events) — " +
    "search_content indexes all of it; call it and answer from the results. If it returns nothing, say " +
    "nothing was found rather than claiming you lack access.\n" +
    "Be concise and action-oriented. Prefer using tools over asking the user for information you can look up.\n\n" +
    verbosityInstruction(promptConfig.spec_verbosity);

  if (promptConfig.user_context.trim()) {
    systemPrompt +=
      "\n\nThe user has provided this context about themselves — use it to tailor specs and responses:\n" +
      promptConfig.user_context.trim();
  }

  return systemPrompt;
}

/** System prompt for the deterministic /search summary (tool-less one-shot). */
export function searchSummarySystem(today: string): string {
  return (
    `You are a helpful assistant for a todo/task management app. Today is ${today}. ` +
    "You are presenting the results of a deterministic search across the user's data — " +
    "todos, specs, backlog, lists, books, artifacts, and calendar events (including PAST " +
    "meetings). The results below were retrieved directly from the index, not by you, and " +
    "are authoritative and complete. Summarize them for the user in 1-3 sentences and echo " +
    "each result's `token` verbatim so it renders as a clickable chip. NEVER claim you can't " +
    "search something (e.g. past calendar events) — if it isn't in the results, it simply " +
    "wasn't found. If there are no results, say so plainly."
  );
}

/** System prompt for voice-note structuring (stateless, tool-less one-shot). */
export const STRUCTURE_NOTE_SYSTEM =
  "You convert a raw voice-note transcript into a clean, well-structured " +
  "Markdown document for a notebook page. The transcript is dictated speech: it " +
  "may ramble, repeat itself, include filler words (um, uh, like, you know), " +
  "false starts, and self-corrections.\n" +
  "Your job:\n" +
  "- Strip filler, repetition, and verbal noise while keeping ALL real content and intent.\n" +
  "- Impose structure: a single top-level '# ' title on the first line that captures the " +
  "subject, then '## ' section headers, bulleted or numbered lists, and short paragraphs " +
  "as the content warrants.\n" +
  "- Turn things the speaker enumerates ('first… second… also…', shopping/todo style runs) " +
  "into proper Markdown lists.\n" +
  "- Preserve the speaker's wording and meaning — do NOT invent facts, answer questions the " +
  "transcript poses, or add commentary. This is transcription cleanup, NOT a chat reply.\n" +
  "- Fix obvious transcription, grammar, and punctuation slips.\n" +
  "Respond with ONLY the Markdown document — no preamble, no explanation, no code fences.";
