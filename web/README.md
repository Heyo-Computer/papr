# paperagent web

The browser shell — an alternative to the Tauri desktop app that runs the same
UI against the same sandbox agent.

The desktop app is a webview plus a Rust backend. The Rust side does two jobs:
it forwards data commands to the agent's JSON-RPC API, and it manages the host
machine (heyvm sandboxes, deploys, OAuth). This server replaces the first job
and drops the second, so the frontend runs unmodified in any browser.

```
  browser                          web server                    agent
  ┌──────────────┐   POST /api/invoke/:cmd   ┌──────────┐   POST /rpc   ┌───────┐
  │ Preact app   │ ────────────────────────► │ command  │ ────────────► │ Pi    │
  │              │ ◄──── {result}│{error} ── │ table    │ ◄──────────── │ agent │
  │              │                           │          │               │       │
  │  transport   │   GET  /api/events (SSE)  │ event    │  /chat/stream │       │
  │  shim        │ ◄──────────────────────── │ bus      │ ◄──────────── │       │
  └──────────────┘                           └──────────┘               └───────┘
```

`src/api/transport.ts` in the frontend picks the transport at runtime: Tauri IPC
when `window.__TAURI_INTERNALS__` exists, HTTP otherwise. Nothing else in the UI
knows which shell it's in.

## Running it

```bash
# From the repo root: build the frontend into web/public and compile the server
bun run build:web

# Serve it (agent already running somewhere)
AGENT_URL=http://127.0.0.1:8080 bun run start:web
```

Then open <http://localhost:3000>.

For frontend development with hot reload, run the server and Vite side by side —
Vite proxies `/api` to the server:

```bash
bun run start:web    # terminal 1
bun run dev:web      # terminal 2, http://localhost:1420
```

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `AGENT_URL` | `http://127.0.0.1:8080` | The agent's HTTP API |
| `TODO_DATA_DIR` | `~/.todo` | Data root; `config/` lives under it |
| `TODO_CONFIG_DIR` | `$TODO_DATA_DIR/config` | Override just the config directory |
| `TODO_LOG_FILE` | `$TODO_DATA_DIR/logs/agent.log` | Log shown by "View Logs" in the status popover |
| `WEB_PUBLIC_DIR` | `../public` | Built frontend |
| `AGENT_SPAWN` | unset | Supervise a local agent process (see below) |
| `AGENT_DIR` | `/opt/paperagent/agent` | Where the built agent lives, when supervising |

## Supervising the agent

The agent takes its provider, API key and model from its **environment at
process start** — the desktop app supplies them when it launches the agent over
heyvm. With no desktop app in the picture there'd be nowhere to put an API key,
so setting `AGENT_SPAWN=1` makes the web server start the agent itself, with env
built from `agent.json`, and restart it when those values change. Saving a key in
Settings therefore takes effect immediately.

Leave `AGENT_SPAWN` unset and the server is a pure client of whatever is already
listening at `AGENT_URL`.

## What the browser can't do

Data, chat, plugins, artifacts, books, lists, speech and Google Calendar all
work. These are desktop-only and their UI is hidden when the frontend detects web
mode:

- **Sandbox lifecycle** — create/start/stop a VM, attach to an existing one.
  heyvm runs on the host; the web shell talks to an agent that is already up.
- **Deploy / Remote / P2P / Network connect** — all reconfigure the *host's*
  agent connection. The server chooses the agent here.
- **Import/export against `~/.todo`** — that's the desktop machine's filesystem.
- **"Open with default application"** on an artifact — the browser downloads it
  from `/api/artifact/download` instead.

Calling one of these anyway returns a plain "only available in the desktop app"
error rather than failing silently.

Voice input works in both shells: the desktop app records through the native mic
plugin, the browser through `MediaRecorder`, and both post the audio to the same
Voxtral transcription path (`src/api/mic.ts`).

## Google Calendar

The integration lives in the agent (`agent/src/tools/google-calendar.ts`), so
credentials and tokens sit in the VM's `/data/config` and travel with the data
rather than being pinned to one machine. Both shells drive the same `calendar/*`
RPC methods.

Only the browser handoff differs, because Google has to redirect the user
somewhere:

| Shell | Redirect URI |
|---|---|
| Web | `<origin>/api/calendar/callback` — served by this server |
| Desktop | `http://localhost:19284/callback` — a loopback listener in the app |

Register whichever you use as an authorized redirect URI on the OAuth client;
Settings shows the right one for the shell you're in. `/api/calendar/connect`
builds the consent URL and redirects; the callback route hands the code to the
agent, which does the exchange and stores the tokens. The redirect URI is derived
from the incoming request and honors `X-Forwarded-Proto` / `X-Forwarded-Host`, so
it works behind a proxy or a `heyvm bind` hostname — just register that URL too.

A connection set up by an older desktop build (tokens on the host) is adopted
into the VM automatically on first launch, and never overwrites one already
there.

## Running as a Firecracker VM

`Dockerfile.firecracker` bakes the agent, this server and the built frontend into
a bootable rootfs, so the VM serves the whole app on port 3000 with no desktop
client involved.

```bash
# Context is the repo root, not this directory
heyvm mvm build --local-only -f web/Dockerfile.firecracker -c . \
    -n paperagent-web --size-mb 2048

heyvm create --name paperagent --backend-type firecracker \
    --image paperagent-web --memory 2g

heyvm get paperagent        # read guest_ip, then open http://<guest_ip>:3000
```

Give the VM at least `--memory 2g` — the Pi SDK the agent runs on is OOM-killed
below that. The web server still comes up, so the symptom is a UI that loads but
never leaves the boot gate; `/data/logs/web.log` names the cause.

On first launch open Settings and paste an API key. The server writes it to
`/data/config/agent.json` and restarts the agent with it, so nothing needs to be
baked into the image. `/data` is the only persistent volume — user data, Pi's
package/session directory and logs live there, while `node_modules` stays on the
rootfs under `/opt/paperagent` (the data volume is far too small for it).
