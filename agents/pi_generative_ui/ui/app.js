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
//  `currentWidget` is the handle returned by widgets.startPreview(); it may
//  be null if no show_visual call is in flight this turn.
let currentWidget = null;

// --- Thinking (reasoning) ---
let thinkingDiv = null;
let thinkingText = "";

// --- Tool call card ---
let toolCallDiv = null;
let toolStartTime = null;


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
    toolStartTime = Date.now();

    toolCallDiv = buildToolCard(toolName, args);
    chat.appendChild(toolCallDiv);
    chat.scrollTop = chat.scrollHeight;

    // show_visual is executing → the streamed code is final; mark the title.
    if (toolName === "show_visual" && currentWidget) {
      currentWidget.markFinalizing(args?.title);
    }
  });

  evtSource.addEventListener("tool_end", (e) => {
    const { toolName, isError, details } = JSON.parse(e.data);
    finishToolCard(toolCallDiv, isError, toolStartTime);
    toolCallDiv = null;
    toolStartTime = null;

    // show_visual finished → swap the live preview for the saved file.
    if (toolName === "show_visual" && details?.filepath) {
      if (currentWidget) {
        currentWidget.finalize(details.title, details.mode, details.filepath);
      } else {
        // No live preview (events missed) → build a finished card from scratch.
        widgets.addFinishedWidget(chat, details.title, details.mode, details.filepath);
      }
      currentWidget = null;
    }
  });

  // ---- Widget ARGUMENT streaming (the live preview) ----
  // These are NOT tool executions — they're the LLM streaming the *arguments*
  // of the show_visual tool call before it runs. The server parses the partial
  // JSON and sends the clean widget_code string each tick.

  evtSource.addEventListener("widget_stream_start", () => {
    if (!currentWidget) {
      currentWidget = widgets.startPreview(chat, "Building widget...");
    }
  });

  evtSource.addEventListener("widget_stream_delta", (e) => {
    const { code } = JSON.parse(e.data);
    if (currentWidget && typeof code === "string") {
      currentWidget.update(code);
    }
  });

  evtSource.addEventListener("widget_stream_end", (e) => {
    const { code, mode } = JSON.parse(e.data);
    if (currentWidget) currentWidget.commit(code, mode);
  });

  // ---- Turn complete: reset all per-turn state ----
  evtSource.addEventListener("agent_end", () => {
    currentAssistantDiv = null;
    currentText = "";
    if (currentWidget) {
      currentWidget.destroy(); // cancel any pending rAF
      currentWidget = null;
    }
    thinkingDiv = null;
    thinkingText = "";
    toolCallDiv = null;
    toolStartTime = null;
    setSending(false);
  });

  // ---- Connection health ----
  evtSource.onerror = () => setStatus("disconnected");
  evtSource.onopen = () => setStatus("connected");
}

// Kick off the SSE connection on load.
connectSSE();


// ============================================================================
//  §4  UI HELPERS
// ============================================================================

/** Update the connection status dot's colour via CSS class. */
function setStatus(status) {
  statusDot.className = `status-dot ${status}`;
}

/** Append a user/assistant message bubble and return the element. */
function addMessageEl(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text; // safe: no HTML parsing
  chat.appendChild(div);
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
