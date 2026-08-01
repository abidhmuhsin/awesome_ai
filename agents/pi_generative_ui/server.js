/**
 * Generative UI Agent Server
 *
 * A Node.js server that:
 * 1. Serves a web frontend for chatting with an AI agent
 * 2. Proxies messages to the agent via Pi SDK
 * 3. Streams agent events back to the frontend via SSE (Server-Sent Events)
 * 4. Serves generated widget files from the exports/ folder
 *
 * Architecture:
 *   Browser <--SSE--> server.js <--Pi SDK--> LLM (OpenRouter/OpenAI)
 */

import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// LOGGER UTILITY
// ============================================================================

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgBlue: "\x1b[44m",
  bgYellow: "\x1b[43m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
};

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

const log = {
  info: (msg, ...args) =>
    console.log(`  ${c.dim}${timestamp()}${c.reset}  ${c.cyan}ℹ${c.reset}  ${msg}`, ...args),

  success: (msg, ...args) =>
    console.log(`  ${c.dim}${timestamp()}${c.reset}  ${c.green}✔${c.reset}  ${c.green}${msg}${c.reset}`, ...args),

  warn: (msg, ...args) =>
    console.warn(`  ${c.dim}${timestamp()}${c.reset}  ${c.yellow}⚠${c.reset}  ${c.yellow}${msg}${c.reset}`, ...args),

  error: (msg, ...args) =>
    console.error(`  ${c.dim}${timestamp()}${c.reset}  ${c.red}✖${c.reset}  ${c.red}${msg}${c.reset}`, ...args),

  tool: (name, phase, args) => {
    const icon = phase === "start" ? "▶" : "◀";
    const color = phase === "start" ? c.magenta : c.green;
    const label = phase === "start" ? "executing" : "completed";
    console.log(
      `  ${c.dim}${timestamp()}${c.reset}  ${color}${icon}${c.reset}  ${c.bold}${c.white}${name}${c.reset} ${c.dim}${label}${c.reset}`
    );
    if (phase === "start" && args) {
      const preview = JSON.stringify(args);
      const truncated = preview.length > 120 ? preview.slice(0, 117) + "..." : preview;
      console.log(`  ${c.dim}${timestamp()}${c.reset}  ${c.gray}  └─${c.reset} ${c.dim}${truncated}${c.reset}`);
    }
  },

  stream: (text) => process.stdout.write(`${c.cyan}${text}${c.reset}`),

  request: (method, url, status) => {
    const statusColor = status >= 400 ? c.red : status >= 300 ? c.yellow : c.green;
    console.log(
      `  ${c.dim}${timestamp()}${c.reset}  ${c.gray}→${c.reset}  ${c.white}${method.padEnd(6)}${c.reset} ${c.dim}${url}${c.reset}  ${statusColor}${status}${c.reset}`
    );
  },
};

function banner() {
  const line = `${c.cyan}━${c.reset}`.repeat(52);
  console.log();
  console.log(`  ${c.cyan}${line}${c.reset}`);
  console.log(`  ${c.cyan}│${c.reset}                                                      ${c.cyan}│${c.reset}`);
  console.log(`  ${c.cyan}│${c.reset}   ${c.bold}${c.white}⚡ Generative UI Agent${c.reset}                             ${c.cyan}│${c.reset}`);
  console.log(`  ${c.cyan}│${c.reset}   ${c.dim}Visual widgets • SSE streaming • Pi SDK${c.reset}       ${c.cyan}│${c.reset}`);
  console.log(`  ${c.cyan}│${c.reset}                                                      ${c.cyan}│${c.reset}`);
  console.log(`  ${c.cyan}${line}${c.reset}`);
  console.log();
}

// ============================================================================
// ENVIRONMENT CONFIGURATION
// ============================================================================

// Load .env file if present (simple key=value parser)
const envPath = join(__dirname, ".env");
try {
  const envContent = await readFile(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

// Read configuration from environment
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY;
const API_BASE = process.env.API_BASE || "https://api.openai.com/v1";
const MODEL_ID = process.env.MODEL_ID || "gpt-4o";

// Validate required config
if (!API_KEY) {
  console.error(
    "\n  ✗ No API key found. Set OPENAI_API_KEY or OPENROUTER_API_KEY in .env\n"
  );
  process.exit(1);
}

// Resolve model ID - handle OpenRouter prefix (e.g., "xiaomi/mimo-v2.5" -> "openrouter/xiaomi/mimo-v2.5")
const RESOLVED_MODEL = MODEL_ID.startsWith("openrouter/")
  ? MODEL_ID
  : API_BASE.includes("openrouter")
    ? `openrouter/${MODEL_ID}`
    : MODEL_ID;

log.info(`API base:    ${c.white}${API_BASE}${c.reset}`);
log.info(`Resolved:    ${c.white}${RESOLVED_MODEL}${c.reset}`);

// ============================================================================
// PI SDK SETUP
// ============================================================================

// Pi agent directory (stores extension state, not session data)
const AGENT_DIR = join(__dirname, ".pi");

// Model runtime - handles API keys and provider configuration
const modelRuntime = await ModelRuntime.create({ agentDir: AGENT_DIR });
modelRuntime.setRuntimeApiKey("openrouter", API_KEY);

// Custom extension to register the OpenRouter provider with custom baseUrl
const customProviderExtension = {
  name: "custom-provider",
  factory: (pi) => {
    if (API_BASE !== "https://api.openai.com/v1") {
      pi.registerProvider("openrouter", { baseUrl: API_BASE });
      log.success(`Custom provider: ${API_BASE}`);
    }
  },
};

// System prompt for the agent
const SYSTEM_PROMPT = `You are a generative UI agent. You can create visual widgets (SVG/HTML) and show them to the user.

You have two tools:
- visual_instructions: Call this first to get theme variables and authoring rules.
- show_visual: Call this with SVG or HTML code to render a widget in the browser.

When the user asks you to visualize, diagram, chart, or create something visual:
1. Call visual_instructions to get the theme and rules
2. Create SVG or HTML widget code following the rules
3. Call show_visual with your widget code

For simple text questions, just reply normally.

Keep widget code self-contained. Use CSS variables from the theme (--visual-accent, --visual-text, etc).`;

// Resource loader - discovers extensions, skills, prompts from the project
const loader = new DefaultResourceLoader({
  cwd: __dirname,
  agentDir: AGENT_DIR,
  additionalExtensionPaths: [join(__dirname, ".pi", "extensions")],
  extensionFactories: [customProviderExtension],
  skillsOverride: () => ({ skills: [], diagnostics: [] }),
  promptsOverride: () => ({ prompts: [], diagnostics: [] }),
  agentsFilesOverride: () => ({ agentsFiles: [], diagnostics: [] }),
  systemPromptOverride: () => SYSTEM_PROMPT,
});
await loader.reload();

// In-memory settings (no file I/O)
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});

// ============================================================================
// AGENT SESSION MANAGEMENT
// ============================================================================

let session = null;

async function getOrCreateSession() {
  if (session) return session;

  // Get model from runtime
  const model = modelRuntime.getModel("openrouter", RESOLVED_MODEL);
  if (!model) {
    log.error(`Model not found: ${RESOLVED_MODEL}`);
    const providers = modelRuntime.getProviders();
    for (const p of providers) {
      if (p.models?.length) {
        log.info(`Available ${p.id}: ${c.white}${p.models.map((m) => m.id).join(", ")}${c.reset}`);
      }
    }
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
// SSE (Server-Sent Events) - Stream events to browser
// ============================================================================

const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(msg);
  }
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

const server = createServer(async (req, res) => {
  // CORS headers for frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // --- SSE Endpoint ---
  // Browser connects here to receive streaming events
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

  // --- Chat Endpoint ---
  // Frontend POSTs user messages here
  if (req.url === "/api/chat" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { message } = JSON.parse(body);

    if (!message) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "message required" }));
    }

    try {
      log.info(`Received: ${c.white}"${message.length > 60 ? message.slice(0, 57) + "..." : message}"${c.reset}`);
      const sess = await getOrCreateSession();

      // Subscribe to agent events and broadcast to all connected browsers
      const unsub = sess.subscribe((event) => {
        switch (event.type) {
          // Streaming text from agent - forward to browser
          case "message_update":
            if (event.assistantMessageEvent?.type === "text_delta") {
              const delta = event.assistantMessageEvent.delta;
              log.stream(delta);
              broadcast("text_delta", { delta });
            }
            break;

          // Tool started (e.g., visual_instructions, show_visual)
          case "tool_execution_start":
            log.tool(event.toolName, "start", event.args);
            broadcast("tool_start", {
              toolName: event.toolName,
              args: event.args,
            });
            break;

          // Tool finished
          case "tool_execution_end":
            log.tool(event.toolName, "end");
            if (event.isError) {
              log.error(`Tool ${event.toolName} failed`);
            }
            broadcast("tool_end", {
              toolName: event.toolName,
              isError: event.isError,
              details: event.result?.details,
            });
            break;

          // Message complete
          case "message_end":
            const reason = event.message?.stopReason;
            log.info(`Response ${c.dim}(${reason})${c.reset}`);
            if (event.message?.errorMessage) {
              log.error(event.message.errorMessage);
            }
            break;

          // Agent finished processing
          case "agent_end":
            console.log();
            log.success("Agent finished");
            broadcast("agent_end", {});
            break;

          default:
            log.info(`${c.dim}[${event.type}]${c.reset} ${JSON.stringify(event).slice(0, 100)}`);
        }
      });

      await sess.prompt(message);
      unsub();
      log.request(req.method, req.url, 200);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      log.error(`Agent error: ${err.message}`);
      if (err.stack) log.info(`${c.dim}${err.stack.split("\n").slice(1, 3).join(" | ")}${c.reset}`);
      log.request(req.method, req.url, 500);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- Widget Files ---
  // Serve generated widgets from /exports/
  if (req.url.startsWith("/exports/")) {
    const widgetPath = join(__dirname, req.url);
    try {
      const data = await readFile(widgetPath);
      const ext = widgetPath.match(/\.[^.]+$/)?.[0] || ".html";
      res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
      res.end(data);
      log.request(req.method, req.url, 200);
    } catch {
      res.writeHead(404);
      res.end("Widget not found");
      log.request(req.method, req.url, 404);
    }
    return;
  }

  // --- Static Files ---
  // Serve index.html, style.css, etc. from ui/ folder
  let filePath = req.url === "/" ? "/ui/index.html" : join("/ui", req.url);
  filePath = join(__dirname, filePath);

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
});

// ============================================================================
// START SERVER
// ============================================================================

server.listen(PORT, () => {
  banner();
  log.success(`Server listening on ${c.bold}${c.white}http://localhost:${PORT}${c.reset}`);
  log.info(`Model:       ${c.white}${MODEL_ID}${c.reset}`);
  log.info(`Extensions:  ${c.white}.pi/extensions/${c.reset}`);
  log.info(`Frontend:    ${c.white}http://localhost:${PORT}${c.reset}`);
  console.log();
});
