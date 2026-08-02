# Pi Generative UI Agent

A Node.js agent that combines Pi SDK with visual widget capabilities, allowing an AI to generate rich, interactive UI components alongside chat responses.

## Architecture

```
┌──────────┐   POST /api/chat      ┌──────────┐   tool calls    ┌─────┐
│ Browser  │ ────────────────────► │ server.js│ ──────────────► │ LLM │
│ (app.js) │ ◄──── SSE stream ──── │          │ ◄── deltas ──── │     │
└──────────┘   /api/events         └──────────┘                 └─────┘
                                     │
                                     └─ subscribes to the Pi AgentSession,
                                        translates its events into SSE
                                        messages for the browser.
```

## Features

- **Real-time streaming**: Server-Sent Events (SSE) for live chat updates
- **Widget generation**: AI can create interactive visual components (charts, forms, dashboards, etc.)
- **Sandboxed rendering**: Widgets render in secure srcdoc iframes
- **Widget export**: Save and download generated widgets as standalone HTML files
- **Dark/Light theme**: Built-in theme switching

## Project Structure

```
pi_generative_ui/
├── server.js          # Main server (HTTP + SSE + Pi agent integration)
├── widget-host.js     # Separate server for serving widget files
├── ui/
│   ├── index.html     # Main HTML entry point
│   ├── app.js         # Chat UI logic
│   ├── style.css      # Styles
│   └── widgets.js     # Widget rendering system
├── exports/           # Generated widget files
└── .env               # Environment configuration
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a `.env` file (see `.env.example`):

```bash
# Required: Your OpenAI-compatible API key
OPENAI_API_KEY=sk-...

# Optional: API base URL (defaults to https://api.openai.com/v1)
# For OpenRouter: https://openrouter.ai/api/v1
# API_BASE=https://openrouter.ai/api/v1

# Optional: Model override (defaults to xiaomi/mimo-v2.5)
MODEL_ID=xiaomi/mimo-v2.5

# Optional: Server port (default: 3000)
PORT=3000
```

### 3. Start the server

```bash
# Production
npm start

# Development (auto-reload)
npm run dev
```

Open http://localhost:3000 in your browser.

## Usage

1. Open the chat interface
2. Ask the AI to generate visual content, e.g.:
   - "Create a bar chart showing population data"
   - "Build a contact form with validation"
   - "Design a dashboard with key metrics"
3. Watch as the AI generates interactive widgets in real-time
4. Click the download button to save widgets as HTML files

## Widget Capabilities

The agent can generate various widget types:

- **Charts**: Bar, line, pie, and scatter charts
- **Forms**: Input fields, dropdowns, checkboxes with validation
- **Tables**: Data grids with sorting and filtering
- **Dashboards**: Multi-component layouts
- **Games**: Simple interactive games
- **Custom HTML**: Any web component

## Technical Details

- **Backend**: Node.js with native HTTP server (no framework dependencies)
- **Agent SDK**: [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi)
- **Frontend**: Vanilla JavaScript (no build step required)
- **Streaming**: Server-Sent Events (SSE) for real-time updates
- **Security**: Widgets render in sandboxed iframes

## License

MIT
