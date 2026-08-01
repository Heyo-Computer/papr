// paperagent web server — the browser alternative to the Tauri desktop shell.
//
// It serves the same Preact frontend and gives it the two things Tauri would
// have: a command channel (POST /api/invoke/:command) and an event channel
// (GET /api/events, Server-Sent Events). Everything data-related is forwarded
// to the sandbox agent, which stays the single source of truth.
//
// Environment:
//   PORT             port to listen on            (default 3000)
//   AGENT_URL        the agent's HTTP API         (default http://127.0.0.1:8080)
//   TODO_DATA_DIR    data root, holds config/     (default ~/.todo)
//   TODO_CONFIG_DIR  override just the config dir (default $TODO_DATA_DIR/config)
//   TODO_LOG_FILE    log shown in the status UI   (default $TODO_DATA_DIR/logs/agent.log)
//   WEB_PUBLIC_DIR   built frontend               (default ../public)

import path from "node:path";
import express from "express";
import { handlers } from "./commands.js";
import { agentRpc, AgentError } from "./agent.js";
import { AGENT_URL, DATA_DIR, PORT, PUBLIC_DIR } from "./config.js";
import { addClient, sendTo } from "./events.js";
import { currentStatus, startHealthPoller } from "./status.js";
import * as supervisor from "./supervisor.js";

const app = express();

// Chat turns and artifact saves can carry sizeable payloads (base64 images from
// the chat composer, in particular), so the default 100kb limit is too tight.
app.use(express.json({ limit: "50mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", agent: currentStatus(), agentUrl: AGENT_URL });
});

// ── Command channel: the web shell's `invoke` ──
//
// Always answers {result} or {error} with HTTP 200/400 so the frontend's
// transport can tell a command failure from a transport failure.
app.post("/api/invoke/:command", async (req, res) => {
  const command = req.params.command;
  const handler = handlers[command];

  if (!handler) {
    res.status(400).json({ error: `Unknown command: ${command}` });
    return;
  }

  try {
    const result = await handler((req.body ?? {}) as Record<string, unknown>);
    res.json({ result: result ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof AgentError)) console.error(`invoke ${command} failed:`, message);
    res.status(400).json({ error: message });
  }
});

// ── Event channel: the web shell's `listen` ──
app.get("/api/events", (_req, res) => {
  const client = addClient(res);
  // Prime the connection so a fresh page doesn't wait for the next poll to
  // learn whether the agent is up.
  sendTo(client, "agent-status", currentStatus());
});

// ── Google Calendar OAuth ──
//
// The agent holds the credentials and does the token exchange; our job is the
// part that only a thing the browser can reach can do — send the user to
// Google's consent screen and catch them on the way back. The redirect URI is
// derived from the request, so it works behind a proxy or a bound hostname as
// long as that same URL is registered in the Google Cloud project.

/** The callback URL as the *browser* sees it, honoring reverse-proxy headers. */
function callbackUri(req: express.Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0] ?? req.get("host");
  return `${proto}://${host}/api/calendar/callback`;
}

/** Minimal self-closing page for the OAuth popup. */
function popupResult(title: string, detail: string, ok: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:14px system-ui;margin:3rem auto;max-width:32rem;text-align:center">
<h2 style="color:${ok ? "#137333" : "#b3261e"}">${title}</h2>
<p>${detail}</p>
<p style="opacity:.6">You can close this window.</p>
<script>
  // Tell the opener to re-check status, then get out of the way.
  try { window.opener && window.opener.postMessage({ type: "calendar-oauth", ok: ${ok} }, "*"); } catch (e) {}
  ${ok ? "setTimeout(function () { window.close(); }, 1200);" : ""}
</script>`;
}

app.get("/api/calendar/connect", async (req, res) => {
  try {
    const { url } = await agentRpc<{ url: string }>("calendar/auth_url", {
      redirect_uri: callbackUri(req),
    });
    res.redirect(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).send(popupResult("Couldn't start sign-in", message, false));
  }
});

app.get("/api/calendar/callback", async (req, res) => {
  // Google reports user-denied consent as ?error=access_denied.
  const error = req.query.error;
  if (error) {
    res.status(400).send(popupResult("Sign-in cancelled", String(error), false));
    return;
  }

  const code = req.query.code;
  if (!code) {
    res.status(400).send(popupResult("Sign-in failed", "Google didn't return an authorization code.", false));
    return;
  }

  try {
    // The redirect URI must match the one that started the flow, so derive it
    // the same way rather than storing it.
    await agentRpc("calendar/exchange_code", { code: String(code), redirect_uri: callbackUri(req) });
    res.send(popupResult("Calendar connected", "Your Google Calendar is now linked.", true));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).send(popupResult("Sign-in failed", message, false));
  }
});

// ── Artifact download ──
//
// Stands in for the desktop app's "open with default application": the artifact
// lives inside the sandbox, so pull it over the agent's read RPC and hand the
// bytes to the browser under its own filename.
app.get("/api/artifact/download", async (req, res) => {
  const rel = String(req.query.path ?? "");
  if (!rel) {
    res.status(400).json({ error: "Missing 'path' parameter" });
    return;
  }

  try {
    const content = await agentRpc<string>("artifacts/read", { path: rel });
    const name = path.basename(rel) || "artifact";
    // `inline` lets the browser preview what it can (text, images, PDFs) and
    // fall back to downloading the rest.
    res.setHeader("Content-Disposition", `inline; filename="${name.replace(/"/g, "")}"`);
    res.type(path.extname(name) || "text/plain").send(content);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Static frontend ──
app.use(express.static(PUBLIC_DIR));

// Single-page app: anything that isn't an API route or a real file is a client
// route, so hand back index.html.
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"), (err) => {
    if (err) res.status(404).send("Frontend not built. Run `bun run build:web` first.");
  });
});

// When co-located with the agent (the VM image), launch it before polling so
// the first health check has something to find.
supervisor.start();
startHealthPoller();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void supervisor.stop().finally(() => process.exit(0));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`paperagent web listening on http://0.0.0.0:${PORT}`);
  console.log(`  agent:  ${AGENT_URL}${supervisor.SUPERVISING ? " (supervised)" : ""}`);
  console.log(`  data:   ${DATA_DIR}`);
  console.log(`  static: ${PUBLIC_DIR}`);
});
