/**
 * Google Calendar integration — OAuth, event fetching, and sync-to-todos.
 *
 * This lives in the agent (and therefore in the VM) so both shells share one
 * implementation and one set of credentials: tokens land in /data/config
 * alongside the rest of the user's data and travel with `heyvm sync`.
 *
 * The one thing that genuinely differs between shells is where Google sends the
 * user back, so `redirect_uri` is a parameter rather than a constant:
 *
 *   web shell — <origin>/api/calendar/callback, served by the web server
 *   desktop   — http://localhost:19284/callback, a loopback listener in the app
 *
 * Google requires the redirect_uri used for the code exchange to match the one
 * that started the flow, so callers pass the same value to both `authUrl` and
 * `exchangeCode`.
 *
 * Ported from the Rust services/calendar.rs + commands/calendar.rs, which now
 * delegate here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR } from "./paths.js";
import { saveEvents } from "./calendar.js";
import { loadDayEntry, addTodo, saveTodoSpec } from "./todo.js";

const CONFIG_DIR = path.join(DATA_DIR, "config");
const CONFIG_PATH = path.join(CONFIG_DIR, "calendar.json");
const TOKENS_PATH = path.join(CONFIG_DIR, "calendar_tokens.json");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPES = "https://www.googleapis.com/auth/calendar.events.readonly";

/** Days of past events pulled into the searchable cache. The window slides
 *  forward each sync and `saveEvents` merges, so history accumulates past this. */
const PAST_LOOKBACK_DAYS = 90;
/** Days ahead to fetch and materialize as todos. */
const FUTURE_DAYS = 30;

export interface CalendarConfig {
  client_id: string;
  client_secret: string;
  enabled: boolean;
  calendar_id: string;
}

export interface CalendarTokens {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. */
  expires_at: number;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start_time: string;
  end_time: string;
  description: string;
  location: string;
  meeting_url: string;
  attendees: string[];
}

// ── Persistence ──

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf-8")) };
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

export function getConfig(): CalendarConfig {
  return readJson(CONFIG_PATH, { client_id: "", client_secret: "", enabled: false, calendar_id: "" });
}

export function setConfig(config: CalendarConfig): CalendarConfig {
  writeJson(CONFIG_PATH, config);
  return config;
}

function getTokens(): CalendarTokens {
  return readJson(TOKENS_PATH, { access_token: "", refresh_token: "", expires_at: 0 });
}

function setTokens(tokens: CalendarTokens): void {
  writeJson(TOKENS_PATH, tokens);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A minute of slack so a token doesn't expire mid-request. */
function tokenIsValid(t: CalendarTokens): boolean {
  return !!t.access_token && nowSeconds() < t.expires_at - 60;
}

export function status() {
  const config = getConfig();
  const tokens = getTokens();
  return {
    configured: !!config.client_id && !!config.client_secret,
    connected: !!tokens.refresh_token,
    token_valid: tokenIsValid(tokens),
    enabled: config.enabled,
  };
}

export function disconnect(): { ok: true } {
  setTokens({ access_token: "", refresh_token: "", expires_at: 0 });
  return { ok: true };
}

/**
 * Seed config/tokens that were set up by an older desktop build, which kept them
 * on the host. Only fills in what isn't already set here, so it's safe to call
 * on every launch and can never clobber a working in-VM connection.
 */
export function importLocal(config?: Partial<CalendarConfig>, tokens?: Partial<CalendarTokens>) {
  let importedConfig = false;
  let importedTokens = false;

  const current = getConfig();
  if (config?.client_id && !current.client_id) {
    setConfig({
      client_id: config.client_id,
      client_secret: config.client_secret ?? "",
      enabled: config.enabled ?? false,
      calendar_id: config.calendar_id ?? "",
    });
    importedConfig = true;
  }

  const currentTokens = getTokens();
  if (tokens?.refresh_token && !currentTokens.refresh_token) {
    setTokens({
      access_token: tokens.access_token ?? "",
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at ?? 0,
    });
    importedTokens = true;
  }

  return { imported_config: importedConfig, imported_tokens: importedTokens };
}

// ── OAuth ──

/** Consent-screen URL to send the user to. `redirectUri` must be registered in
 *  the Google Cloud project and reused for the exchange. */
export function authUrl(redirectUri: string): string {
  const config = getConfig();
  if (!config.client_id || !config.client_secret) {
    throw new Error("Set Google OAuth Client ID and Client Secret in settings first.");
  }
  const params = new URLSearchParams({
    client_id: config.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    // offline + consent so Google actually returns a refresh token, including
    // on a repeat authorization.
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function postForm(url: string, form: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) throw new Error(`Google token endpoint returned ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Trade the callback's `code` for tokens and persist them. */
export async function exchangeCode(code: string, redirectUri: string) {
  const config = getConfig();
  if (!config.client_id || !config.client_secret) {
    throw new Error("Set Google OAuth Client ID and Client Secret in settings first.");
  }

  const token = await postForm(TOKEN_URL, {
    code,
    client_id: config.client_id,
    client_secret: config.client_secret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  setTokens({
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? "",
    expires_at: nowSeconds() + (token.expires_in ?? 3600),
  });

  return status();
}

/** A live access token, refreshing if the stored one has expired. */
async function accessToken(): Promise<string> {
  const tokens = getTokens();
  if (tokenIsValid(tokens)) return tokens.access_token;

  if (!tokens.refresh_token) {
    throw new Error("Not connected to Google Calendar. Connect in Settings.");
  }

  const config = getConfig();
  const token = await postForm(TOKEN_URL, {
    refresh_token: tokens.refresh_token,
    client_id: config.client_id,
    client_secret: config.client_secret,
    grant_type: "refresh_token",
  });

  // A refresh response doesn't repeat the refresh token — keep the stored one.
  const next: CalendarTokens = {
    access_token: token.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: nowSeconds() + (token.expires_in ?? 3600),
  };
  setTokens(next);
  return next.access_token;
}

// ── Google Calendar API ──

interface GEntryPoint {
  uri?: string;
  entryPointType?: string;
}

interface GEvent {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  description?: string;
  location?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: GEntryPoint[] };
  attendees?: { email?: string; displayName?: string }[];
}

/** Meeting URL, preferring an explicit Meet link, then a video conference entry
 *  point, then any entry point, then a known meeting domain in the description. */
function extractMeetingUrl(g: GEvent): string {
  if (g.hangoutLink) return g.hangoutLink;

  const entries = g.conferenceData?.entryPoints ?? [];
  const video = entries.find((e) => e.entryPointType === "video" && e.uri);
  if (video?.uri) return video.uri;
  const any = entries.find((e) => e.uri);
  if (any?.uri) return any.uri;

  for (const word of (g.description ?? "").split(/\s+/)) {
    const trimmed = word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9/=&?_.-]+$/g, "");
    if (/^https?:\/\//.test(trimmed) && /(zoom\.us|meet\.google\.com)/.test(trimmed)) return trimmed;
  }
  return "";
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

/** Fetch events between today+startOffset and today+endOffset, inclusive. */
export async function fetchEventsRange(startOffsetDays: number, endOffsetDays: number): Promise<CalendarEvent[]> {
  const token = await accessToken();
  const config = getConfig();
  const calendarId = config.calendar_id || "primary";

  const params = new URLSearchParams({
    timeMin: `${offsetDate(startOffsetDays)}T00:00:00Z`,
    timeMax: `${offsetDate(endOffsetDays)}T23:59:59Z`,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "2500",
  });

  const res = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Calendar API error (${res.status}): ${await res.text()}`);

  const list = (await res.json()) as { items?: GEvent[] };
  return (list.items ?? [])
    // An event with no summary has nothing to show on a todo line.
    .filter((g): g is GEvent & { summary: string } => !!g.summary)
    .map((g) => ({
      id: g.id ?? "",
      summary: g.summary,
      start_time: g.start?.dateTime ?? g.start?.date ?? "",
      end_time: g.end?.dateTime ?? g.end?.date ?? "",
      description: g.description ?? "",
      location: g.location ?? "",
      meeting_url: extractMeetingUrl(g),
      attendees: (g.attendees ?? []).map((a) => a.displayName || a.email || "").filter(Boolean),
    }));
}

// ── Sync to todos ──

function eventDate(event: CalendarEvent): string {
  const datePart = event.start_time.split("T")[0] ?? "";
  return datePart.length === 10 ? datePart : "";
}

/** "14:30 - Standup" for a timed event, bare summary for an all-day one. */
function formatEventTitle(event: CalendarEvent): string {
  const time = event.start_time.split("T")[1];
  return time ? `${time.slice(0, 5)} - ${event.summary}` : event.summary;
}

function renderEventSpec(event: CalendarEvent): string {
  const lines = [`# ${event.summary}`, ""];
  if (event.start_time || event.end_time) lines.push(`**When**: ${event.start_time} - ${event.end_time}`);
  if (event.location) lines.push(`**Where**: ${event.location}`);
  if (event.meeting_url) lines.push(`**Meeting link**: ${event.meeting_url}`);
  if (event.attendees.length) {
    lines.push("", "**Attendees**:", ...event.attendees.map((a) => `- ${a}`));
  }
  if (event.description) lines.push("", "---", "", event.description);
  return lines.join("\n") + "\n";
}

/**
 * Fetch the sync window, cache all of it for the agent's search, and add the
 * upcoming portion to the todo list. Past meetings are cached but never
 * materialized as todos.
 */
export async function syncToTodos(): Promise<{ synced: number; added: number; message: string }> {
  const config = getConfig();
  if (!config.enabled || !config.client_id) {
    return { synced: 0, added: 0, message: "Calendar sync not enabled." };
  }

  const events = await fetchEventsRange(-PAST_LOOKBACK_DAYS, FUTURE_DAYS);
  saveEvents(events);

  const today = localDateStr(new Date());
  const upcoming = events.filter((e) => {
    const d = eventDate(e);
    return d && d >= today;
  });

  // Group by day so each date is loaded once.
  const byDate = new Map<string, CalendarEvent[]>();
  for (const event of upcoming) {
    const date = eventDate(event);
    if (!date) continue;
    const bucket = byDate.get(date);
    if (bucket) bucket.push(event);
    else byDate.set(date, [event]);
  }

  let added = 0;
  for (const [date, dayEvents] of byDate) {
    const existing = new Set(loadDayEntry(date).todos.map((t) => t.title));
    for (const event of dayEvents) {
      const title = formatEventTitle(event);
      if (existing.has(title)) continue;

      const entry = addTodo(date, title);
      existing.add(title);
      added++;

      // A meeting link is worth a spec — it's what the user actually needs at
      // the time of the event.
      const newTodo = entry.todos[entry.todos.length - 1];
      if (event.meeting_url && newTodo) {
        saveTodoSpec(date, newTodo.id, renderEventSpec(event));
      }
    }
  }

  return {
    synced: events.length,
    added,
    message: `Synced ${events.length} events, added ${added} new todos.`,
  };
}
