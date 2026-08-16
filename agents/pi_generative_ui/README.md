# Pi Generative UI Agent

A Node.js chat agent (built on the [Pi SDK](https://github.com/earendil-works/pi)) that can generate live, interactive SVG/HTML widgets alongside its replies — charts, dashboards, forms, mockups — streamed to the browser and rendered in a sandboxed iframe.

> **⚠️ Reference project, not production-ready.**
> This repo is meant to demonstrate a pattern (generative UI over SSE, sandboxed widget rendering, a host↔widget postMessage bridge) with reasonable security defaults already applied — sandboxed null-origin iframes, a CDN allowlist via CSP, loopback-only binding, scoped CORS, request size limits, gesture-gated bridge calls, etc. It has **not** been hardened for production: there's no auth, sessions are single-user and in-memory, and several tradeoffs favor a simple local demo over multi-tenant/public deployment. Review the security posture and make changes appropriate to your environment before deploying this anywhere beyond your own machine.

## Architecture

Two servers, one browser tab:

```
┌──────────┐   POST /api/chat      ┌───────────────┐   tool calls    ┌─────┐
│ Browser  │ ────────────────────► │ server.js      │ ──────────────► │ LLM │
│ (app.js) │ ◄──── SSE stream ──── │ :3000          │ ◄── deltas ──── │     │
└────┬─────┘   /api/events         └───────────────┘                  └─────┘
     │                                     │
     │  fetch saved widget file            └─ subscribes to the Pi AgentSession,
     ▼                                        translates its events into SSE
┌──────────────┐                             frames for the browser.
│ widget-host.js│
│ :3001         │  serves /exports/*.html for cross-origin widget fetch
└──────────────┘
```

- **`server.js`** — serves the frontend, bridges chat to the Pi agent, streams agent events to the browser over SSE.
- **`widget-host.js`** — a second, separate-origin server that serves finished widget files from `exports/`, fetched cross-origin by the host page once a widget finishes streaming.
- **`ui/widgets.js`** — renders widgets in a sandboxed `srcdoc` iframe (null origin — no `allow-same-origin`), streams partial HTML in via `postMessage`, and re-executes `<script>` tags once at commit.

## Features

- **Real-time streaming**: assistant text, thinking, tool calls, and widget code all stream token-by-token over SSE.
- **Live widget preview**: the widget renders *while it's being generated*, not just after the tool call finishes.
- **Sandboxed rendering**: widgets run in a null-origin `srcdoc` iframe — no access to host cookies, DOM, or APIs. All host communication goes through an explicit, gesture-gated `postMessage` bridge (`sendPrompt`, `openLink`, `window.storage`).
- **Widget export**: generated widgets save to `exports/` and can be downloaded as standalone HTML/SVG files.
- **CDN allowlist via CSP**: widget `<script>`/`<style>` sources are restricted to 4 allowlisted CDNs.

## Project structure

```
pi_generative_ui/
├── server.js              # Main HTTP server: static files, /api/chat, /api/events (SSE)
├── widget-host.js         # Separate-origin server serving exports/ for cross-origin fetch
├── server-test.ts         # Standalone smoke test for the custom-provider wiring
├── .pi/
│   └── extensions/
│       └── visual-widgets.ts  # Pi extension: visual_instructions + show_visual tools
├── ui/
│   ├── index.html         # Entry HTML
│   ├── app.js              # Chat controller: SSE wiring, message UI, form handling
│   ├── widgets.js          # Widget renderer: sandboxed iframe, streaming, bridge
│   └── style.css           # Styles
├── exports/                # Generated widget files (gitignored)
├── .env                    # Local config (gitignored) — see .env.example
└── package.json
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your API key:

```bash
# Required — OpenAI-compatible API key
OPENAI_API_KEY=sk-...

# Optional — API base URL (defaults to https://api.openai.com/v1)
# For OpenRouter: https://openrouter.ai/api/v1
# API_BASE=https://openrouter.ai/api/v1

# Optional — model id (defaults to xiaomi/mimo-v2.5)
MODEL_ID=xiaomi/mimo-v2.5

# Optional — main server port (defaults to 3000)
PORT=3000

# Optional — widget-host port (defaults to 3001)
# WIDGET_PORT=3001

# Optional — widget origin reported to the browser (defaults to http://localhost:<WIDGET_PORT>)
# WIDGET_ORIGIN=http://localhost:3001
```

### 3. Start the server

```bash
npm start        # production
npm run dev       # auto-reload on file change
```

Open **http://localhost:3000**. Both servers bind to `127.0.0.1` only.

## Usage

1. Open the chat interface.
2. Ask the agent to visualize something, e.g.:
   - "Create a bar chart of monthly revenue"
   - "Build a contact form with validation"
   - "Design a dashboard with key metrics"
3. Watch the widget render live as it streams in.
4. Download the finished widget as a standalone HTML/SVG file if you want to keep it.

## Widget capabilities

The agent has two tools (`.pi/extensions/visual-widgets.ts`):

- **`visual_instructions`** — returns theme variables, viewport sizing, animation rules, and module-specific authoring guidance (diagram, chart, data_viz, mockup, interactive, art, elicitation) before generating anything.
- **`show_visual`** — renders the widget, saving it to `exports/`.

Widgets can be charts, forms, tables, dashboards, mockups, small interactive tools, or generative art. Interactive widgets can call:

- `sendPrompt(text)` — send a new message to the agent (only from a real click/keypress).
- `openLink(url)` — open an `http(s)` URL in a new tab (only from a real click/keypress).
- `window.storage.{get,set,delete}(key)` — simple async key-value persistence, scoped to the page session.

## Security notes

This demo already applies several mitigations worth knowing about if you extend it:

- Widget iframes are `sandbox="allow-scripts allow-forms"` with **no** `allow-same-origin` → null origin, fully isolated from the host page.
- CSP restricts widget script/style sources to 4 allowlisted CDNs, and denies `form-action`, `base-uri`, and `object-src`.
- `sendPrompt`/`openLink` only fire from a real, trusted user gesture (`event.isTrusted`) — a widget can't silently trigger them from a `<script>` on load.
- Both servers bind to `127.0.0.1` only and validate the `Host` header. `server.js` sends no CORS headers (same-origin only); `widget-host.js` echoes `Access-Control-Allow-Origin` only for the app's own origin — no `*`.
- `/api/chat` caps request bodies at 1 MB and rejects overlapping requests (the agent session is shared and single-turn).

Things intentionally left out of scope for a reference project: authentication, per-user sessions, rate limiting beyond the single in-flight guard, and persistence beyond the current process's memory.

## Technical details

- **Backend**: Node.js, native `http` module, zero framework dependencies.
- **Agent SDK**: [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi)
- **Frontend**: vanilla JavaScript ES modules, no build step.
- **Streaming**: Server-Sent Events (`/api/events`) for agent → browser; `postMessage` for host ↔ widget-iframe.
- **Testing**: `npx tsx server-test.ts` smoke-tests the custom-provider wiring end to end (provider registration → model resolution → agent session → streamed reply) without starting the HTTP server.

## License

MIT
