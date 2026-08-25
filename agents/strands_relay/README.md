# Strands Relay

A multi-transport agent service built on [Strands Agents](https://strandsagents.com) with a single shared agent core — relayed to a CLI REPL, a WebSocket web UI, and a Telegram bot.

```
npm start        # CLI REPL
npm run ui       # Web UI at http://localhost:3000
npm run telegram # Telegram bot
npm run mcp-server # Also usable as a standalone MCP server
```

It demonstrates a practical pattern for production agents:

- **One agent core, many relays** — model config, system prompt, tools, and MCP client live in one factory (`src/agent/factory.ts`); transports only relay user I/O.
- **Custom tools** — local tools (`hello`, `byebye`) with Zod schema validation.
- **Full MCP integration** — acts as both MCP *client* (stdio, HTTP, SSE) and MCP *server*, with the same tool codebase serving both roles.
- **OpenAI-compatible** — works with the OpenAI API or any `OPENAI_BASE_URL` endpoint.
- **Streaming generative UI** — the model renders live SVG/HTML/Chart.js widgets in the web UI, sandboxed in null-origin iframes with a strict CSP.

## Architecture

The core design is **one agent core, many relays**. All agent logic lives in `createAgent()` (`src/agent/factory.ts`). Transports know nothing about the agent's internals:

```
                ┌─────────────────────────────────────────┐
                │  agent/factory.ts — createAgent()       │
                │  • OpenAI-compatible model              │
                │  • System prompt                        │
                │  • Local tools (hello, byebye, widgets) │
                │  • MCP client (tools via MCP)           │
                └───────────────┬─────────────────────────┘
                                │ invoke() / stream()
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
transports/cli.ts       transports/websocket.ts   transports/telegram.ts
readline REPL           Express + WS server       Bot API long-poll
(npm start)             (npm run ui)              (npm run telegram)
        ▲                       ▲                       ▲
   terminal                  browser                  Telegram
```

Why this scales:

- **Transport-agnostic core.** `createAgent()` has zero knowledge of CLI, WebSocket, or Telegram. Changes to prompts, models, or tools apply to every transport at once — no duplication.
- **Pluggable, isolated transports.** Each transport is a standalone module with its own entry point. Adding Slack, Discord, or an HTTP API is a new file, not a change to existing code.
- **Session isolation.** Each WebSocket connection and Telegram chat gets its own agent instance, so concurrent users never share state.
- **Uniform tool surface.** Local tools, MCP-served tools, and streaming generator tools all sit in the same tools list — every transport gets the same capabilities for free.
- **Transports opt into fidelity.** The WebSocket transport layers `BeforeToolCallEvent`/`AfterToolCallEvent` hooks and delta streaming on top of the shared agent for real-time UX; the CLI uses plain `invoke()`. No forking required.

### Adding a transport

1. Create `src/agent/transports/<name>.ts`: open the channel, create an agent per session with `createAgent()`, and call `agent.invoke(text)` (or `agent.stream(text)` for a streaming UX).
2. Add an entry point and a `package.json` script.
3. Reuse the helpers (`extractText()`, `wasByebyeCalled()`) and logger.

```typescript
import { createAgent } from '../factory.js'
import { extractText } from '../helpers.js'

export async function startMyTransport() {
  const agent = createAgent()
  const result = await agent.invoke(userText)
  sendReplyToUser(extractText(agent) ?? result.toString())
}
```

## Quick Start

**Prerequisites:** Node.js 18+ and an OpenAI API key (or any OpenAI-compatible endpoint).

```bash
npm install
cp .env.example .env   # set OPENAI_API_KEY (optionally OPENAI_BASE_URL, OPENAI_MODEL)
npm start -- Abidh     # CLI REPL; the name argument is used by the hello tool
```

Expected output:

```text
Hello, Abidh! This response came from the hello tool.
```

### Web UI

```bash
npm run ui                # http://localhost:3000
npm run ui -- --port 4000 # custom port
```

Each browser connection gets its own agent instance. The UI (`ui/index.html`, no build step) includes a dark responsive theme, real-time WebSocket chat, auto-reconnect, and a typing indicator.

### Telegram bot

```bash
# 1. Create a bot via @BotFather and copy the token
# 2. Put it in .env:
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
# 3. Start
npm run telegram
```

Each chat gets an isolated agent session. Any text message creates a session if none exists; saying goodbye triggers the `byebye` tool and ends it. Long replies are chunked to respect Telegram's 4096-character limit.

| Command | Description |
|---------|-------------|
| `/start` | Start a new session |
| `/help` | Show available commands |
| `/session` | Check for an active session |
| `/end` | End the current session |

## MCP Integration

The project plays **both MCP roles** with a single tool codebase:

- **MCP server** (`src/mcp/mcp-server.ts`) — exposes the project's tools (`hello`, `hello_with_ui`) to external MCP clients such as Claude Desktop.
- **MCP client** (`src/mcp/mcp-clients.ts`) — lets the Strands agent consume tools from MCP servers, including its own server spawned over stdio.

This works because `mcp-server.ts` separates tool registration (`createServer()`, transport-free) from transport starters (`startStdio` / `startHttp` / `startSse`). Tools never know how they're served.

| Deployment shape | How | Consumer |
|------------------|-----|----------|
| Standalone server | `npm run mcp-server` (stdio), `mcp-server:http`, or `mcp-server:sse` | Any MCP client: Claude Desktop, other agents, remote services |
| Embedded with the agent | `mcpClient` spawns the same server as a child process over stdio; `factory.ts` adds it to the tools list | The agent itself (CLI, UI, Telegram) |

Notes:

- The embedded path runs tools in a spawned child process — isolation and lifecycle separation at the cost of IPC latency per call. The one in-process path is `readMcpResource()` (`src/mcp/resource-reader.ts`), which reads `ui://tools/<name>/html` resources directly for static widget UIs.
- To the agent, MCP tools are indistinguishable from local tools — `mcpClient` sits in the same `tools` array as `helloTool`.
- Chat modes don't use the HTTP/SSE server modes; those exist for external clients.

### Chat flow

```
User input (terminal / browser WS / Telegram)
   │
   ▼
Transport (cli.ts / websocket.ts / telegram.ts)
   │  one agent instance per session
   ▼
Agent (createAgent())  ──►  OpenAI API (or OPENAI_BASE_URL endpoint)
   │                            │ model decides to call a tool
   ▼                            ▼
Local tools (hello, byebye, widget_*)   MCP client (mcpClient)
                                          │ stdio (npx tsx src/mcp/mcp-server.ts)
                                          ▼
                                     MCP server subprocess
                                     (hello, hello_with_ui)
   │
   ▼
Agent final response → back through the transport to the user
```

### Running the MCP server standalone

```bash
npm run mcp-server        # stdio (default)
npm run mcp-server:http   # streamable HTTP at http://localhost:8000/mcp
npm run mcp-server:sse    # SSE (legacy clients)
```

External clients connect via stdio (spawn `npm run mcp-server`), HTTP POST to `http://localhost:8000/mcp`, or SSE.

### Connecting the agent to remote MCP servers

The agent uses stdio transport by default. For remote servers:

```typescript
import { createHttpMcpClient } from './mcp/mcp-clients.js'

const remoteClient = createHttpMcpClient('http://localhost:8000/mcp')
// Or with authentication:
const authClient = createHttpMcpClient('https://api.example.com/mcp', {
  Authorization: `Bearer ${process.env.MCP_TOKEN}`,
})
```

## Tools

### Local tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `hello` | Returns a greeting for a person by name | `name` (string) |
| `byebye` | Ends the conversation | none |

To add one: create a file in `src/tools/`, export a tool via `tool()` from `@strands-agents/sdk`, and add it to the `tools` array in `src/agent/factory.ts`.

### MCP tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `hellomcp` | Returns a greeting for a person by name | `name` (string) |

To add one: create a file in `src/mcp/tools/`, implement a `registerXxxTool(server: McpServer)` function, and register it in `mcp-server.ts`:

```typescript
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerDatabaseTool(server: McpServer) {
  server.tool(
    'query',
    'Execute a database query',
    { sql: z.string().describe('The SQL query to execute') },
    async ({ sql }) => ({
      content: [{ type: 'text' as const, text: `Result: ...` }],
    })
  )
}
```

```typescript
// src/mcp/mcp-server.ts
import { registerDatabaseTool } from './tools/database.js'
registerDatabaseTool(server)
```

## Streaming Generative UI

The web UI renders widgets (SVG graphics, charts, interactive HTML) inline in the chat, **streamed live as the model generates them**, then finalized into a hardened sandbox.

Two tools drive this:

| Tool | Role |
|------|------|
| `widget_instr` | Returns strict production-grade markup/CSS instructions (SVG, HTML, Chart.js conventions). Called silently by the model before its first render. |
| `widget_renderer` | Takes `title` + `widget_code` and delivers the widget to the UI as an `mcp_ui` message. |

```
Model streams toolUseInputDelta (widget_code generated char-by-char)
   │  websocket.ts intercepts modelContentBlockDeltaEvent, correlates
   │  deltas to the active toolUse, forwards over WS:
   ▼
{ type: 'tool_input_delta', toolUseId, tool: 'widget_renderer', delta }   ── live preview
   │  client renders deltas into a progressive "stream card" with a
   │  live sandboxed iframe as the preview surface
   ▼
AfterToolCallEvent hook fires when the tool completes → authoritative finalize
   ▼
{ type: 'mcp_ui', toolUseId, html, streamFinal: true }                    ── final render
   │  client swaps preview → finalized sandboxed widget card
```

Details:

- **Two widget paths** — generator tools like `widget_renderer` stream HTML as it's generated; static-UI tools serve ready-made HTML from the `ui://tools/<name>/html` MCP resource (rendered directly with `fullDoc: true`).
- **Text streaming** runs alongside via `agent_stream_start` / `agent_stream_delta` / `agent_stream_end` messages with a typewriter effect.
- **Tool call visibility** — `BeforeToolCallEvent` / `AfterToolCallEvent` hooks emit `tool_start` / `tool_end` events so the UI shows each tool call (name, args, duration, result) as it happens.
- **Known limitation** — tool-input deltas are correlated by the most recent toolUse start, so two widgets streamed concurrently in one turn may interleave.

### Sandbox security (dual-iframe model)

Untrusted widget HTML never runs in the host page's origin. The UI uses a **host → proxy → widget** chain:

- `ui/sandbox.html` — the trusted proxy, served with a tight CSP (`script-src 'self'`, no eval). Same-origin with the host so it can do `postMessage` bookkeeping.
- The proxy creates an inner iframe with `sandbox="allow-scripts allow-forms"` — deliberately omitting `allow-same-origin`, so the widget gets a **null origin** and cannot touch the host page, the proxy, other widgets, or cookies/DOM.
- A CSP meta tag injected into the widget document restricts script/style loads to a CDN allowlist (`esm.sh`, `cdnjs`, `jsdelivr`, `unpkg`) and sets `form-action 'none'` to block exfiltration via navigation.
- All widget communication is `postMessage`; height is self-reported by an injected bridge script (event-driven via `ResizeObserver`/`MutationObserver`, since a null-origin frame can't be measured from outside).

## Project Structure

```
src/
├── cli.ts                        # CLI entry point → npm start
├── ui-server.ts                  # Web UI entry point → npm run ui
├── telegram.ts                   # Telegram entry point → npm run telegram
├── agent/
│   ├── factory.ts                # createAgent() — shared agent config
│   ├── helpers.ts                # extractText(), wasByebyeCalled()
│   └── transports/
│       ├── cli.ts                # readline REPL transport
│       ├── websocket.ts          # Express + WebSocket transport
│       └── telegram.ts           # Telegram bot transport
├── mcp/
│   ├── index.ts                  # MCP client exports
│   ├── mcp-clients.ts            # MCP client configurations (stdio, HTTP)
│   ├── mcp-server.ts             # MCP server with tool registration
│   └── tools/
│       └── hello.ts              # MCP hello tool
├── tools/
│   ├── index.ts                  # Local tool exports
│   ├── hello.ts                  # Local hello tool
│   └── byebye.ts                 # Local byebye tool
└── telemetry/
    └── openrouter-usage.ts       # Usage telemetry

ui/
├── index.html                    # Chat web interface
├── sandbox.html                  # Trusted sandbox proxy
└── sandbox.js
```

## Further Reading

- [Strands Agents — MCP Tools](https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/)
- [Model Context Protocol](https://modelcontextprotocol.io)
