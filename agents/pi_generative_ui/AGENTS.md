# Generative UI Agent

## Architecture

Pi runs the agent loop. The web frontend connects to it via HTTP + SSE.

```
┌─────────────┐     POST /api/chat      ┌──────────────────────┐
│  Web UI      │ ──────────────────────► │  server.js (Node)    │
│  ui/index    │ ◄── SSE /api/events ── │  Pi SDK agent loop   │
│  ui/app.js   │                         │  + visual-widgets ext │
│  ui/style    │                         │                      │
└─────────────┘                         └──────────────────────┘
```

## Files

```
├── server.js              # Node.js HTTP server using Pi SDK
├── ui/
│   ├── index.html         # Web UI HTML
│   ├── app.js             # Frontend JavaScript (SSE, widgets)
│   └── style.css          # Dark theme
├── .pi/
│   └── extensions/
│       └── visual-widgets.ts  # Pi extension: visual tools
├── exports/               # Generated widget files (SVG/HTML)
├── .env                   # API key and config
└── package.json
```

## Running

```bash
npm install
npm start
# → http://localhost:3000
```

Set your API key in `.env` file. The server uses Pi's SDK to create agent sessions with the visual widget tools loaded from `.pi/extensions/`.

## How It Works

1. User types a message in the web UI
2. Frontend POSTs to `/api/chat`
3. Server creates/uses a Pi `AgentSession` with the visual-widgets extension
4. Pi runs the agent loop (LLM calls, tool execution)
5. Events stream back to the frontend via SSE (`/api/events`)
6. When `show_visual` runs, the widget file is saved to `exports/` and displayed in an iframe
