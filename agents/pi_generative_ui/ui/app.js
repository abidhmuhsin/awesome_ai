/**
 * Generative UI Agent - Frontend
 *
 * Handles:
 * - SSE connection to server for streaming events
 * - Message rendering (user/assistant)
 * - Widget preview display in iframes
 * - Form submission
 */

// --- DOM References ---
const $ = (sel) => document.querySelector(sel);
const chat = $("#chat");
const form = $("#composer");
const input = $("#input");
const statusDot = $("#status-dot");

// Auto-resize textarea as user types
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
});

// --- SSE Connection ---
let evtSource = null;
let currentAssistantDiv = null;
let currentText = "";

function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource("/api/events");

  // Streaming text from agent
  evtSource.addEventListener("text_delta", (e) => {
    const { delta } = JSON.parse(e.data);
    if (!currentAssistantDiv) {
      currentAssistantDiv = addMessageEl("assistant", "");
    }
    currentText += delta;
    currentAssistantDiv.textContent = currentText;
    chat.scrollTop = chat.scrollHeight;
  });

  // Tool started (e.g., show_visual)
  evtSource.addEventListener("tool_start", (e) => {
    const { toolName, args } = JSON.parse(e.data);
    if (toolName === "show_visual") {
      addLoading(`Rendering ${args?.title || "widget"}...`);
    }
  });

  // Tool finished - show widget preview if available
  evtSource.addEventListener("tool_end", (e) => {
    const { toolName, details } = JSON.parse(e.data);
    removeLoading();
    if (toolName === "show_visual" && details?.filepath) {
      addWidgetPreview(details.title, details.mode, details.filepath);
    }
  });

  // Agent finished processing
  evtSource.addEventListener("agent_end", () => {
    currentAssistantDiv = null;
    currentText = "";
    setSending(false);
  });

  // Connection status
  evtSource.onerror = () => setStatus("disconnected");
  evtSource.onopen = () => setStatus("connected");
}

connectSSE();

// --- UI Helpers ---

function setStatus(status) {
  statusDot.className = `status-dot ${status}`;
}

function addMessageEl(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function addLoading(text) {
  const div = document.createElement("div");
  div.className = "loading";
  div.innerHTML = `<div class="dots"><span></span><span></span><span></span></div> <span>${text}</span>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function removeLoading() {
  const el = chat.querySelector(".loading");
  if (el) el.remove();
}

// Display widget preview in an iframe
function addWidgetPreview(title, mode, filepath) {
  const container = document.createElement("div");
  container.className = "widget-container";

  const titleBar = document.createElement("div");
  titleBar.className = "widget-title";
  titleBar.textContent = title;
  container.appendChild(titleBar);

  const info = document.createElement("div");
  info.className = "widget-info";
  info.innerHTML = `
    <span class="widget-mode">${mode.toUpperCase()}</span>
    <span class="widget-path">${filepath}</span>
  `;
  container.appendChild(info);

  const frame = document.createElement("div");
  frame.className = "widget-frame";
  const iframe = document.createElement("iframe");
  iframe.sandbox = "allow-scripts";
  frame.appendChild(iframe);
  container.appendChild(frame);

  chat.appendChild(container);
  chat.scrollTop = chat.scrollHeight;

  // Convert absolute filepath to relative URL for serving
  const filename = filepath.split("/").pop();
  const widgetUrl = `/exports/${filename}`;

  fetch(widgetUrl)
    .then((r) => r.text())
    .then((html) => {
      iframe.srcdoc = html;
      iframe.addEventListener("load", () => {
        try {
          const h = iframe.contentDocument.body.scrollHeight;
          iframe.style.height = Math.min(h + 24, 500) + "px";
        } catch {}
      });
    })
    .catch(() => {
      iframe.remove();
    });
}

// --- Form Submit ---
let sending = false;

function setSending(val) {
  sending = val;
  form.querySelector("button").disabled = val;
}

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

// Enter to send, Shift+Enter for newline
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.dispatchEvent(new Event("submit"));
  }
});
