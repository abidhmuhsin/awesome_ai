/**
 * ============================================================================
 *  Generative UI Agent — Server (Node.js)
 * ============================================================================
 *
 *  A single-process server with three jobs:
 *
 *    1. Serve the web frontend        (ui/index.html, app.js, style.css)
 *    2. Bridge chat to the Pi agent    (POST /api/chat → agent.prompt())
 *    3. Stream agent events to browsers (SSE /api/events)
 *
 *  Architecture:
 *
 *     ┌──────────┐   POST /api/chat      ┌──────────┐   tool calls    ┌─────┐
 *     │ Browser  │ ────────────────────► │ server.js│ ──────────────► │ LLM │
 *     │ (app.js) │ ◄──── SSE stream ──── │          │ ◄── deltas ──── │     │
 *     └──────────┘   /api/events         └──────────┘                 └─────┘
 *                                          │
 *                                          └─ subscribes to the Pi AgentSession,
 *                                             translates its events into SSE
 *                                             messages for the browser.
 *
 *  File layout (read top-to-bottom):
 *    §1  Logger (coloured terminal output)
 *    §2  Environment config (.env, API key, model resolution)
 *    §3  Pi SDK setup (model runtime, resource loader, system prompt)
 *    §4  Agent session management (lazy singleton)
 *    §5  SSE plumbing (connected clients, broadcast helper)
 *    §6  HTTP server & routes (SSE, chat, widgets, static)
 *    §7  Start
 * ============================================================================
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { startWidgetHost } from "./widget-host.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// ============================================================================
//  §1  LOGGER
// ============================================================================
//  A tiny zero-dependency logger with ANSI colours. Each method prints a
//  timestamped, icon-prefixed line. Keeps the rest of the code readable.

/** ANSI escape codes for terminal colours / styles. */
const c = {
  reset: "\x1b[0m",  dim: "\x1b[2m",   bold: "\x1b[1m",
  red: "\x1b[31m",   green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m",  magenta: "\x1b[35m", cyan: "\x1b[36m",
  white: "\x1b[37m", gray: "\x1b[90m",
};

/** HH:MM:SS.mmm — short, sortable timestamp for log lines. */
function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

const log = {
  info:    (msg) => console.log(`${c.dim}${timestamp()}${c.reset}  ${c.cyan}ℹ${c.reset}  ${msg}`),
  success: (msg) => console.log(`${c.dim}${timestamp()}${c.reset}  ${c.green}✔${c.reset}  ${c.green}${msg}${c.reset}`),
  warn:    (msg) => console.warn(`${c.dim}${timestamp()}${c.reset}  ${c.yellow}⚠${c.reset}  ${c.yellow}${msg}${c.reset}`),
  error:   (msg) => console.error(`${c.dim}${timestamp()}${c.reset}  ${c.red}✖${c.reset}  ${c.red}${msg}${c.reset}`),

  /** Tool lifecycle: ▶ start (with arg preview) / ◀ end. */
  tool: (name, phase, args) => {
    const icon  = phase === "start" ? "▶" : "◀";
    const color = phase === "start" ? c.magenta : c.green;
    const label = phase === "start" ? "executing" : "completed";
    console.log(`${c.dim}${timestamp()}${c.reset}  ${color}${icon}${c.reset}  ${c.bold}${c.white}${name}${c.reset} ${c.dim}${label}${c.reset}`);
    if (phase === "start" && args) {
      const preview = JSON.stringify(args);
      const truncated = preview.length > 120 ? preview.slice(0, 117) + "..." : preview;
      console.log(`${c.dim}${timestamp()}${c.reset}  ${c.gray}  └─${c.reset} ${c.dim}${truncated}${c.reset}`);
    }
  },

  /** Raw stream text (no newline) — used for assistant text deltas. */
  stream: (text) => process.stdout.write(`${c.cyan}${text}${c.reset}`),

  /** HTTP request log with colour-coded status. */
  request: (method, url, status) => {
    const statusColor = status >= 400 ? c.red : status >= 300 ? c.yellow : c.green;
    console.log(`${c.dim}${timestamp()}${c.reset}  ${c.gray}→${c.reset}  ${c.white}${method.padEnd(6)}${c.reset} ${c.dim}${url}${c.reset}  ${statusColor}${status}${c.reset}`);
  },
};

/** Print the startup banner. */
function banner() {
  const line = `${c.cyan}━${c.reset}`.repeat(52);
  console.log();
  console.log(`  ${c.cyan}${line}${c.reset}`);
  console.log(`  ${c.cyan}│${c.reset}   ${c.bold}${c.white}⚡ Generative UI Agent${c.reset}                             ${c.cyan}│${c.reset}`);
  console.log(`  ${c.cyan}│${c.reset}   ${c.dim}Visual widgets • SSE streaming • Pi SDK${c.reset}       ${c.cyan}│${c.reset}`);
  console.log(`  ${c.cyan}${line}${c.reset}`);
  console.log();
}


// ============================================================================
//  §2  ENVIRONMENT CONFIGURATION
// ============================================================================
//  Load a minimal .env (KEY=VALUE) ourselves so we have zero deps. Real apps
//  would use dotenv, but this keeps the example self-contained.

const envPath = join(__dirname, ".env");
try {
  const envContent = await readFile(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;   // skip blanks/comments
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;                              // skip malformed lines
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    // Only set if not already in the real environment (env wins over .env).
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // No .env file — that's fine if env vars are set directly.
}

const PORT     = process.env.PORT     || 3000;
const WIDGET_ORIGIN = process.env.WIDGET_ORIGIN || `http://localhost:${process.env.WIDGET_PORT || 3001}`;
// API key for the OpenAI-compatible endpoint configured by API_BASE.
const API_KEY  = process.env.OPENAI_API_KEY;
const API_BASE = process.env.API_BASE || "https://api.openai.com/v1";
const MODEL_ID = process.env.MODEL_ID || "xiaomi/mimo-v2.5";

if (!API_KEY) {
  console.error("\n  ✗ No API key found. Set OPENAI_API_KEY in .env\n");
  process.exit(1);
}

log.info(`API base:    ${c.white}${API_BASE}${c.reset}`);
log.info(`Model:       ${c.white}${MODEL_ID}${c.reset}`);


// ============================================================================
//  §3  PI SDK SETUP
// ============================================================================
//  The Pi SDK provides the agent loop: it calls the LLM, parses tool calls,
//  executes tools, and emits events we can subscribe to. Setup happens once
//  at module load; the session itself is created lazily (§4).

const AGENT_DIR = join(__dirname, ".pi");

// Identifier of the custom OpenAI-compatible provider we register below.
const PROVIDER_ID = "native-local";

// ModelRuntime manages provider config + API keys.
const modelRuntime = await ModelRuntime.create({ agentDir: AGENT_DIR });
modelRuntime.setRuntimeApiKey(PROVIDER_ID, API_KEY);

/**
 * Register a custom OpenAI-compatible provider pointed at API_BASE.
 * Legacy provider-config form (see custom-provider.md "Register New Provider").
 * We declare exactly one model (MODEL_ID) so getModel() can resolve it;
 * cost/window defaults are placeholders — tune if you need usage accounting.
 *
 * The config is shared between the ModelRuntime (registered synchronously below
 * so getModel() resolves the model BEFORE a session starts) and the resource
 * loader's extension factory. This matters because pi.registerProvider() inside
 * an extension factory only *queues* the registration — it is flushed into the
 * runtime during ExtensionRunner.bindCore(), which runs inside
 * createAgentSession. Without the direct registration, getModel() would return
 * undefined and getOrCreateSession() would fall back to an unrelated default.
 */
const providerConfig = {
  name: "Native Local",
  baseUrl: API_BASE,
  apiKey: "$OPENAI_API_KEY",
  api: "openai-completions",
  models: [
    {
      id: MODEL_ID,
      name: MODEL_ID,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ],
};

// Register on the runtime directly so the model is resolvable now.
modelRuntime.registerProvider(PROVIDER_ID, providerConfig);
log.success(`Custom provider: ${API_BASE}`);

/**
 * System prompt — tells the LLM how to behave.
 *
 * Key instruction: the LLM must put widget code INSIDE the show_visual tool
 * call, NOT as plain text. This is what makes live-preview streaming possible
 * (we intercept the tool-call argument deltas rather than parsing chat text).
 */
const SYSTEM_PROMPT = `You are a generative UI agent. You can create visual widgets (SVG/HTML) and show them to the user.

You have two tools:
- visual_instructions: Call this first to get theme variables and authoring rules.
- show_visual: Call this with SVG or HTML code to render a widget in the browser.

When the user asks you to visualize, diagram, chart, or create something visual:
1. Call visual_instructions to get the theme and rules
2. Then call show_visual directly with the complete widget code. Do NOT output the raw code as text.
3. After calling show_visual, write a brief description of what you created.

IMPORTANT: Do NOT output raw SVG/HTML code as text. Only use show_visual tool to display widgets.

For simple text questions, just reply normally.

Keep widget code self-contained. Use CSS variables from the theme (--visual-accent, --visual-text, etc).`;

// The resource loader discovers extensions, tools, prompts, etc. Here we:
//   - point it at our .pi/extensions/ folder (visual-widgets.ts),
//   - inject the custom-provider extension factory,
//   - override skills/prompts/agents-files to empty (we only want our tools),
//   - force our system prompt.
const loader = new DefaultResourceLoader({
  cwd: __dirname,
  agentDir: AGENT_DIR,
  additionalExtensionPaths: [join(__dirname, ".pi", "extensions")],
  extensionFactories: [],
  skillsOverride:    () => ({ skills: [], diagnostics: [] }),
  promptsOverride:   () => ({ prompts: [], diagnostics: [] }),
  agentsFilesOverride: () => ({ agentsFiles: [], diagnostics: [] }),
  systemPromptOverride: () => SYSTEM_PROMPT,
});
await loader.reload();

// In-memory settings: disable compaction & retry for this stateless demo.
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});


// ============================================================================
//  §4  AGENT SESSION MANAGEMENT
// ============================================================================
//  A session holds the conversation + agent loop. We create exactly ONE and
//  reuse it for every message (in-memory session → single shared conversation).
//  For multi-user apps you'd create one session per user instead.

let session = null;

async function getOrCreateSession() {
  if (session) return session;

  const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
  if (!model) {
    log.error(`Model not found: ${MODEL_ID}`);
  } else {
    log.success(`Model ready: ${model.provider}/${model.id}`);
  }

  const result = await createAgentSession({
    cwd: __dirname,
    model: model || undefined,
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    settingsManager,
    tools: ["visual_instructions", "show_visual"],
  });

  session = result.session;
  return session;
}


// ============================================================================
//  §5  SSE PLUMBING
// ============================================================================
//  Server-Sent Events: the server holds a long-lived HTTP response open per
//  browser and writes "event:" frames to it. Browsers decode them via the
//  EventSource API (see app.js). We keep every connected response in a Set
//  so broadcast() can fan out to all of them.

/** Every currently-connected SSE response (one per open browser tab). */
const clients = new Set();

/**
 * Send a named SSE event to ALL connected browsers.
 *
 * An SSE frame looks like:
 *   event: text_delta\n
 *   data: {"delta":"Hello"}\n
 *   \n
 * The trailing blank line is required — it terminates the event.
 */
function broadcast(eventName, data) {
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}


// ============================================================================
//  §6  HTTP SERVER & ROUTES
// ============================================================================

/** MIME types for static file serving. */
const MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
};

// Hostnames this server answers to. A foreign Host header (e.g. a
// DNS-rebinding domain pointed at 127.0.0.1) is refused.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const server = createServer(async (req, res) => {
  // Everything the page fetches here is same-origin → no CORS headers needed.
  if (!ALLOWED_HOSTS.has(req.headers.host || "")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  // ---- Route: SSE stream ----
  // Open a persistent response. We DON'T end it here — broadcast() writes to
  // it over time. When the browser disconnects, "close" fires and we drop it.
  if (req.url === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    clients.add(res);
    log.info(`SSE client connected ${c.dim}(${clients.size} total)${c.reset}`);
    req.on("close", () => {
      clients.delete(res);
      log.info(`SSE client disconnected ${c.dim}(${clients.size} total)${c.reset}`);
    });
    log.request(req.method, req.url, 200);
    return;
  }

  // ---- Route: chat ----
  // The browser POSTs a message. We run the agent and translate its events
  // into SSE frames for the browser. The HTTP response itself just says "ok".
  if (req.url === "/api/chat" && req.method === "POST") {
    return handleChat(req, res);
  }

  // ---- Route: client config (widget origin etc.) ----
  if (req.url === "/api/config" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ widgetOrigin: WIDGET_ORIGIN }));
  }

  // ---- Route: static frontend files (ui/) ----
  // "/" maps to the index page; everything else is resolved under ui/.
  // The path is normalized and confined under ui/ to block traversal attacks
  // (e.g. "/../package.json") from reaching files outside the frontend folder.
  const uiDir = join(__dirname, "ui");
  const requested = req.url === "/" ? "index.html" : req.url;
  const filePath = join(uiDir, normalize(requested));
  if (!(filePath + sep).startsWith(uiDir + sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  return serveFile(req, res, filePath);
});

/**
 * Handle POST /api/chat.
 *
 * This is the most important function: it subscribes to the Pi AgentSession's
 * event stream and translates each event into an SSE event for the browser.
 *
 * Two categories of events matter:
 *
 *   A) "message_update" — the LLM is PRODUCING content. Sub-types:
 *        text_delta       → assistant text   (broadcast "text_delta")
 *        thinking_delta   → reasoning text   (broadcast "thinking_delta")
 *        toolcall_start   → a tool call begins streaming its arguments
 *        toolcall_delta   → tool-call argument JSON is growing
 *        toolcall_end     → tool-call arguments are complete
 *
 *      For show_visual specifically, we stream the parsed `widget_code`
 *      argument so the browser can render a LIVE preview as it's generated.
 *
 *   B) tool_execution_* — the tool is ACTUALLY RUNNING (after args complete).
 *      These give us the final result (saved filepath) to finalize the widget.
 */
/** Cap for POST bodies — a chat message is a few KB; anything bigger is abuse. */
const MAX_BODY_BYTES = 1_000_000; // 1 MB

// Guards against two overlapping prompt() calls interleaving on the shared session.
let chatInFlight = false;

async function handleChat(req, res) {
  // Read & parse the request body (small JSON). Guarded on three fronts:
  // oversize → 413, malformed → 400, and neither may reject the handler —
  // an unhandled rejection here would kill the process (Node ≥15 default).
  let body = "";
  let size = 0;
  let message;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ error: "body too large" }));
        res.on("finish", () => req.destroy()); // drop the rest of the upload
        return;
      }
      body += chunk;
    }
    ({ message } = JSON.parse(body));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid JSON body" }));
  }

  if (!message) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "message required" }));
  }

  if (chatInFlight) {
    res.writeHead(409, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "agent is busy, try again shortly" }));
  }
  chatInFlight = true;

  try {
    log.info(`Received: ${c.white}"${message.length > 60 ? message.slice(0, 57) + "..." : message}"${c.reset}`);
    const sess = await getOrCreateSession();

    // Subscribe BEFORE prompting so we don't miss early events.
    const unsub = sess.subscribe((event) => translateAgentEvent(event));

    await sess.prompt(message);
    unsub();
    log.request(req.method, req.url, 200);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    log.error(`Agent error: ${err.message}`);
    log.request(req.method, req.url, 500);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  } finally {
    chatInFlight = false;
  }
}

/**
 * Map one Pi AgentSession event → one (or more) SSE broadcasts.
 * Kept separate from handleChat so the routing logic is easy to read.
 */
function translateAgentEvent(event) {
  switch (event.type) {
    // ---- LLM content streaming (text, thinking, tool-call arguments) ----
    case "message_update": {
      // `assistantMessageEvent` describes what the LLM just produced.
      // It carries a `contentIndex` pointing into message.content[] for the
      // specific text/tool-call/thinking block it belongs to.
      const ae = event.assistantMessageEvent;
      if (!ae) break;

      if (ae.type === "text_delta") {
        log.stream(ae.delta);
        broadcast("text_delta", { delta: ae.delta });

      } else if (ae.type === "thinking_delta") {
        broadcast("thinking_delta", { delta: ae.delta });

      } else if (ae.type === "toolcall_start") {
        // A tool call began. Look up the (partial) toolCall object at this
        // index so we know WHICH tool is being called.
        const tc = event.message?.content?.[ae.contentIndex];
        if (tc?.type === "toolCall" && tc.name === "show_visual") {
          broadcast("widget_stream_start", {});
        }

      } else if (ae.type === "toolcall_delta") {
        // The tool-call argument JSON is growing. The Pi reducer parses the
        // streaming JSON incrementally, so `arguments.widget_code` is already
        // a clean HTML/SVG string at every tick. We forward the FULL current
        // value (not a delta) so the browser can replace-then-render.
        const tc = event.message?.content?.[ae.contentIndex];
        if (tc?.type === "toolCall" && tc.name === "show_visual") {
          const code = tc.arguments?.widget_code;
          if (typeof code === "string") {
            broadcast("widget_stream_delta", { code });
          }
        }

      } else if (ae.type === "toolcall_end") {
        // Arguments are final. Send the complete code + computed mode so the
        // browser renders the definitive version.
        const tc = ae.toolCall;
        if (tc?.type === "toolCall" && tc.name === "show_visual") {
          const args = tc.arguments || {};
          const stripped = String(args.widget_code || "").trimStart().toLowerCase();
          const mode = stripped.startsWith("<svg") ? "svg" : "html";
          log.tool("show_visual/stream", "end", { mode, len: stripped.length });
          broadcast("widget_stream_end", { code: args.widget_code || "", mode, title: args.title });
        }
      }
      break;
    }

    // ---- Tool EXECUTION lifecycle (the tool actually ran) ----
    case "tool_execution_start":
      log.tool(event.toolName, "start", event.args);
      broadcast("tool_start", { toolName: event.toolName, args: event.args });
      break;

    case "tool_execution_end":
      log.tool(event.toolName, "end");
      if (event.isError) log.error(`Tool ${event.toolName} failed`);
      // `details` carries the tool's structured result — for show_visual that's
      // { title, mode, filepath, ... } which the browser uses to finalize.
      broadcast("tool_end", {
        toolName: event.toolName,
        isError: event.isError,
        details: event.result?.details,
      });
      break;

    // ---- Message / turn lifecycle ----
    case "message_end": {
      const reason = event.message?.stopReason;
      log.info(`Response ${c.dim}(${reason})${c.reset}`);
      if (event.message?.errorMessage) log.error(event.message.errorMessage);
      break;
    }

    case "agent_end":
      console.log();
      log.success("Agent finished");
      broadcast("agent_end", {});
      break;

    default:
      // Surface anything unexpected so we notice new event types.
      log.info(`${c.dim}[${event.type}]${c.reset} ${JSON.stringify(event).slice(0, 100)}`);
  }
}

/**
 * Serve a file from disk with the right Content-Type, or 404.
 * Shared by the static-ui route.
 */
async function serveFile(req, res, filePath) {
  try {
    const data = await readFile(filePath);
    const ext = filePath.match(/\.[^.]+$/)?.[0] || ".html";
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
    if (req.url !== "/favicon.ico") log.request(req.method, req.url, 200);
  } catch {
    res.writeHead(404);
    res.end("Not found");
    log.request(req.method, req.url, 404);
  }
}


// ============================================================================
//  §7  START SERVER
// ============================================================================

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log.error(`Port ${PORT} is already in use.`);
    process.exit(1);
  }
  throw err;
});

// 127.0.0.1 only — keeps the agent (and its API key) off the LAN.
server.listen(PORT, "127.0.0.1", () => {
  banner();
  log.success(`Server listening on ${c.bold}${c.white}http://localhost:${PORT}${c.reset}`);
  log.info(`Extensions:  ${c.white}.pi/extensions/${c.reset}`);
  log.info(`Frontend:    ${c.white}http://localhost:${PORT}${c.reset}`);
  log.info(`Widget host: ${c.white}${WIDGET_ORIGIN}${c.reset}`);
  console.log();

  // Start the cross-origin widget sandbox server.
  try {
    startWidgetHost();
  } catch (err) {
    log.warn(`Widget host failed to start: ${err.message}`);
  }
});
