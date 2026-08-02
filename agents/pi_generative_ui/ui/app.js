/**
 * ============================================================================
 *  Generative UI Agent — Frontend (browser)
 * ============================================================================
 *
 *  Talks to server.js over two channels:
 *    1. HTTP POST  /api/chat    — send a user message to the agent.
 *    2. SSE        /api/events  — receive a live stream of agent events.
 *
 *  This file is the "controller": it owns chat state, wires SSE events to
 *  the UI, and delegates widget RENDERING to widgets.js. Keeping rendering
 *  separate means the event-flow logic stays short and readable.
 *
 *  Sections:
 *    §1  DOM references & utilities
 *    §2  Streaming state (per-turn variables)
 *    §3  SSE connection & event handlers  ← the heart of the file
 *    §4  UI helpers (messages, status, loading)
 *    §5  Form & input handling
 * ============================================================================
 */

import * as widgets from "./widgets.js";


// ============================================================================
//  §1  DOM REFERENCES & UTILITIES
// ============================================================================

/** Shortcut for document.querySelector. */
const $ = (sel) => document.querySelector(sel);

const chat = $("#chat");            // scrollable transcript
const form = $("#composer");        // <form> wrapping textarea + send button
const input = $("#input");          // the <textarea>
const statusDot = $("#status-dot"); // coloured dot showing SSE state

/** Escape a string for safe insertion into innerHTML. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Auto-grow the textarea as the user types, up to a max height.
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
});


// ============================================================================
//  §2  STREAMING STATE
// ============================================================================
//  Per-turn state. Reset on `agent_end` (§3). A "turn" = everything between
//  the user sending a message and the agent finishing (text + tools + widget).

let evtSource = null;

// --- Assistant text ---
let currentAssistantDiv = null; // <div> we append text deltas into
let currentText = "";           // accumulated assistant text this turn

// --- Widget preview (delegated to widgets.js) ---
//  A stack of in-flight widget previews. Each widget_stream_start pushes a
//  new entry; tool_end(show_visual) pops the matching one. This lets
//  multiple widgets stream concurrently without overwriting each other.
let widgetStack = [];   // [{ widget }]

// --- Thinking (reasoning) ---
let thinkingDiv = null;
let thinkingText = "";

// --- Tool call cards (keyed by tool name, since multiple can overlap) ---
//  A stack of currently-open tool cards, newest last. tool_end matches by
//  toolName; if multiple open cards share a name, the most recent is finished.
let openToolCards = [];   // [{ name, details, startTime }]`


// ============================================================================
//  §3  SSE CONNECTION & EVENT HANDLERS
// ============================================================================
//  SSE is a one-way server→browser stream. We open one persistent connection
//  to /api/events; the server pushes named events. Each handler below covers
//  one event type.
//
//  Typical widget turn:
//    tool_start(visual_instructions) → tool_end
//    widget_stream_start             → empty preview card
//    widget_stream_delta × N         → code streams in, preview re-renders
//    widget_stream_end               → final code committed
//    tool_start(show_visual)         → preview title marked "saving"
//    tool_end(show_visual)           → preview swaps to saved file
//    text_delta × N                  → agent's description
//    agent_end                       → reset state

function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource("/api/events");

  // ---- Assistant text (normal reply) ----
  // textContent (not innerHTML) so streamed text is never parsed as markup.
  evtSource.addEventListener("text_delta", (e) => {
    const { delta } = JSON.parse(e.data);
    if (!currentAssistantDiv) currentAssistantDiv = addMessageEl("assistant", "");
    currentText += delta;
    currentAssistantDiv.textContent = currentText;
    chat.scrollTop = chat.scrollHeight;
  });

  // ---- Thinking / reasoning ----
  evtSource.addEventListener("thinking_delta", (e) => {
    const { delta } = JSON.parse(e.data);
    if (delta == null) return;
    thinkingText += delta;

    if (!thinkingDiv) {
      thinkingDiv = document.createElement("details");
      thinkingDiv.className = "thinking-block";
      thinkingDiv.innerHTML = `<summary>Thinking...</summary><div class="thinking-content"></div>`;
      thinkingDiv.open = true;
      chat.appendChild(thinkingDiv);
    }
    thinkingDiv.querySelector(".thinking-content").textContent = thinkingText;
    chat.scrollTop = chat.scrollHeight;
  });

  // ---- Tool execution lifecycle (the tool ACTUALLY ran) ----
  evtSource.addEventListener("tool_start", (e) => {
    const { toolName, args } = JSON.parse(e.data);
    const startTime = Date.now();

    const card = buildToolCard(toolName, args);
    chat.appendChild(card);
    chat.scrollTop = chat.scrollHeight;
    openToolCards.push({ name: toolName, details: card, startTime });

    // show_visual is executing → the streamed code is final; mark the title.
    // No separate timer here — elapsed is computed from widget_stream_start
    // in tool_end so it captures the full wait (streaming + save).
    if (toolName === "show_visual") {
      const entry = widgetStack[widgetStack.length - 1];
      if (entry) entry.widget.markFinalizing(args?.title);
    }
  });

  evtSource.addEventListener("tool_end", (e) => {
    const { toolName, isError, details } = JSON.parse(e.data);
    // Match the most recent OPEN card for this tool name (LIFO).
    const idx = (() => {
      for (let i = openToolCards.length - 1; i >= 0; i--) {
        if (openToolCards[i].name === toolName) return i;
      }
      return -1;
    })();
    const entry = idx >= 0 ? openToolCards.splice(idx, 1)[0] : null;
    finishToolCard(entry?.details, isError, entry?.startTime);

    // show_visual finished → pop the matching widget and finalize it.
    if (toolName === "show_visual" && details?.filepath) {
      const entry = widgetStack.pop();
      if (entry) {
        // Use the streaming start time (not tool_start) so the elapsed
        // includes the full wait: LLM code generation + file save.
        const elapsed = entry.startTime
          ? ((Date.now() - entry.startTime) / 1000).toFixed(2)
          : "?";
        entry.widget.finalize(details.title, details.mode, details.filepath, elapsed);
      } else {
        // No live preview (events missed) → build a finished card from scratch.
        widgets.addFinishedWidget(chat, details.title, details.mode, details.filepath);
      }
    }
  });

  // ---- Widget ARGUMENT streaming (the live preview) ----
  // These are NOT tool executions — they're the LLM streaming the *arguments*
  // of the show_visual tool call before it runs. The server parses the partial
  // JSON and sends the clean widget_code string each tick.

  evtSource.addEventListener("widget_stream_start", async () => {
    const widget = await widgets.startPreview(chat, "Building widget...");
    widgetStack.push({ widget, startTime: Date.now() });
  });

  evtSource.addEventListener("widget_stream_delta", (e) => {
    const { code } = JSON.parse(e.data);
    const top = widgetStack[widgetStack.length - 1];
    if (top && typeof code === "string") {
      top.widget.update(code);
    }
  });

  evtSource.addEventListener("widget_stream_end", (e) => {
    const { code, mode } = JSON.parse(e.data);
    const top = widgetStack[widgetStack.length - 1];
    if (top) top.widget.commit(code, mode);
  });

  // ---- Turn complete: reset all per-turn state ----
  // If a widget was streaming but never got its finalize (agent ended early,
  // errored, or produced no show_visual result), abort it: partial renders
  // stay visible but stop pulsing "BUILDING…"; empty cards are removed.
  evtSource.addEventListener("agent_end", () => {
    currentAssistantDiv = null;
    currentText = "";
    // Abort any widgets still in the stream (never got their tool_end).
    for (const entry of widgetStack) entry.widget.abort();
    widgetStack = [];
    thinkingDiv = null;
    thinkingText = "";
    openToolCards = [];
    setSending(false);
  });

  // ---- Connection health ----
  evtSource.onerror = () => setStatus("disconnected");
  evtSource.onopen = () => setStatus("connected");
}

// Kick off the SSE connection on load.
connectSSE();

// Prefetch the widget-host origin so the first streamed widget isn't blocked
// on a config fetch when it tries to finalize/download.
widgets.initWidgetOrigin();

// Wire the widget bridge: when a sandboxed widget calls sendPrompt(text),
// treat it like the user typed it and run a new agent turn.
widgets.onWidgetPrompt((text) => {
  if (!text || sending) return;
  addMessageEl("user", text);
  setSending(true);
  fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text }),
  }).catch((err) => {
    addMessageEl("assistant", `❌ Error: ${err.message}`);
    setSending(false);
  });
});


// ============================================================================
//  §4  UI HELPERS
// ============================================================================

/** Update the connection status dot's colour via CSS class. */
function setStatus(status) {
  statusDot.className = `status-dot ${status}`;
}

/** Append a user/assistant message bubble and return the element. */
function addMessageEl(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `message-row ${role}`;

  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text; // safe: no HTML parsing

  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.type = "button";
  btn.title = "Copy";
  btn.setAttribute("aria-label", "Copy message");
  btn.innerHTML = `<svg class="copy-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4h8v8H4z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3h8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(div.textContent || "").then(() => {
      btn.classList.add("copied");
      btn.innerHTML = `<svg class="copy-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.innerHTML = `<svg class="copy-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4h8v8H4z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3h8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
      }, 1400);
    });
  });

  wrap.appendChild(div);
  wrap.appendChild(btn);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

/** Show a "loading" indicator with animated dots. */
function addLoading(text) {
  const div = document.createElement("div");
  div.className = "loading";
  div.innerHTML = `<div class="dots"><span></span><span></span><span></span></div> <span>${escapeHtml(text)}</span>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

/** Remove any loading indicator currently in the chat. */
function removeLoading() {
  chat.querySelector(".loading")?.remove();
}

/**
 * Build a collapsible tool-call card: name + params + "running..." status.
 * Returns the <details> element (not yet appended).
 */
function buildToolCard(toolName, args) {
  const details = document.createElement("details");
  details.className = "tool-call";
  details.open = false;

  const paramsStr = args ? JSON.stringify(args, null, 2) : "{}";
  details.innerHTML = `
    <summary>
      <span class="tool-call-icon">⚙</span>
      <span class="tool-call-name">${escapeHtml(toolName)}</span>
      <span class="tool-call-status">running...</span>
    </summary>
    <pre class="tool-call-params">${escapeHtml(paramsStr)}</pre>
  `;
  return details;
}

/** Flip a tool card to its done/error state with elapsed time. */
function finishToolCard(details, isError, startTime) {
  if (!details) return;
  const elapsed = startTime ? ((Date.now() - startTime) / 1000).toFixed(2) : "?";
  const summary = details.querySelector("summary");
  const status = summary?.querySelector(".tool-call-status");
  const icon = summary?.querySelector(".tool-call-icon");
  if (status) {
    status.textContent = isError ? `error (${elapsed}s)` : `done (${elapsed}s)`;
    status.className = `tool-call-status ${isError ? "error" : "success"}`;
  }
  if (icon) {
    icon.textContent = isError ? "✖" : "✔";
    icon.className = `tool-call-icon ${isError ? "error" : "success"}`;
  }
}


// ============================================================================
//  §5  FORM & INPUT HANDLING
// ============================================================================

let sending = false;

/** Toggle "sending" state: disables the send button while the agent works. */
function setSending(val) {
  sending = val;
  form.querySelector("button").disabled = val;
}

// Submit handler: send the message, let SSE drive the rest. We don't await a
// response body — the server replies 200 immediately and output streams via SSE.
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || sending) return;

  addMessageEl("user", text);
  input.value = "";
  input.style.height = "auto";
  setSending(true);

  try {
    await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
  } catch (err) {
    addMessageEl("assistant", `❌ Error: ${err.message}`);
    setSending(false);
  }
});

// Enter sends; Shift+Enter inserts a newline.
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.dispatchEvent(new Event("submit"));
  }
});
