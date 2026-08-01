/**
 * ============================================================================
 *  Widget Renderer — sandboxed iframe (srcdoc) with null-origin isolation
 * ============================================================================
 *
 *  SECURITY MODEL (from the Claude visualizer architecture article):
 *
 *    Widgets render inside a SANDBOXED IFRAME using srcdoc. Because the
 *    sandbox token does NOT include `allow-same-origin`, the iframe gets a
 *    NULL origin — it is fully cut off from the host page:
 *
 *      ✗ cannot read host cookies / localStorage (origin mismatch)
 *      ✗ cannot touch the host DOM (#chat, #input) (cross-origin DOM access)
 *      ✗ cannot call host endpoints like /api/chat (cross-origin fetch blocked)
 *      ✗ cannot open popups (no allow-popups)
 *
 *    The iframe CAN run scripts (allow-scripts) and submit forms (allow-forms).
 *    All host communication is via postMessage through injected globals.
 *
 *  CDN ALLOWLIST: enforced via a <meta http-equiv="Content-Security-Policy">
 *  tag injected into the srcdoc — scripts may only load from the 4 allowlisted
 *  CDNs. Anything else is blocked by the browser.
 *
 *  ----------------------------------------------------------------------------
 *  Streaming
 *  ----------------------------------------------------------------------------
 *  We rebuild the srcdoc on each tick during streaming (cheap — the browser
 *  paints progressively as SVG/HTML elements arrive). On the FINAL commit we
 *  do one last srcdoc write so <script> tags execute against the complete DOM.
 *
 *  This re-runs scripts on each stream tick, which is acceptable for a local
 *  dev tool — the alternative (postMessage into a cross-origin frame) is far
 *  more fragile and harder to debug.
 *
 *  ----------------------------------------------------------------------------
 *  Height reporting
 *  ----------------------------------------------------------------------------
 *  A null-origin iframe can still postMessage its parent. We inject a small
 *  script that observes document size changes and reports scrollHeight to the
 *  host, which resizes the iframe.
 * ============================================================================
 */

// CDN allowlist — injected as CSP so widget scripts can only load from these.
const CDN_LIST = [
  "https://esm.sh",
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
].join(" ");

const CSP_DIRECTIVES = [
  "default-src 'unsafe-inline' data:",
  `script-src 'unsafe-inline' ${CDN_LIST}`,
  `style-src 'unsafe-inline' ${CDN_LIST}`,
  `img-src 'self' data: ${CDN_LIST}`,
  `font-src ${CDN_LIST}`,
  `connect-src ${CDN_LIST}`,
].join("; ");

// The bridge script injected into every widget iframe. Defines sendPrompt,
// openLink, window.storage, and a height reporter — all postMessage-based.
const BRIDGE_SCRIPT = `
<script>
(function () {
  var PARENT = window.parent;
  var NS = "widget-bridge";
  var msgId = 0;
  var pending = new Map();
  var lastH = -1;

  function send(type, payload) {
    PARENT.postMessage({ __bridge: NS, type: type, payload: payload || {} }, "*");
  }

  // ---- Height reporting ----
  // Report document height to the parent so it can resize the iframe.
  // (A null-origin srcdoc iframe can't be measured from outside.)
  function reportHeight() {
    var b = document.body;
    var h = b ? b.scrollHeight : 0;
    if (h !== lastH) { lastH = h; send("height", { height: h }); }
  }
  function tick() { reportHeight(); requestAnimationFrame(tick); }
  if (document.readyState !== "loading") { tick(); }
  else { document.addEventListener("DOMContentLoaded", tick); }
  try {
    new ResizeObserver(reportHeight).observe(document.documentElement);
    new MutationObserver(reportHeight).observe(document.documentElement, {
      childList: true, subtree: true
    });
  } catch (e) {}
  window.addEventListener("load", reportHeight);
  window.addEventListener("resize", reportHeight);

  // ---- sendPrompt(text) → new agent turn ----
  window.sendPrompt = function (text) { send("sendPrompt", { text: String(text) }); };

  // ---- openLink(url) → host opens it (no popups in sandbox) ----
  window.openLink = function (url) { send("openLink", { url: String(url) }); };

  // ---- window.storage → async KV via postMessage ----
  function storageOp(type, key, value) {
    var id = ++msgId;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { pending.delete(id); reject(new Error("storage " + type + " timeout")); }, 10000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      var p = { key: String(key) };
      if (value !== undefined) p.value = value;
      send(type, Object.assign({ id: id }, p));
    });
  }
  window.storage = {
    get: function (k) { return storageOp("storage-get", k); },
    set: function (k, v) { return storageOp("storage-set", k, v); },
    delete: function (k) { return storageOp("storage-delete", k); },
  };

  // Receive storage responses from the host.
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__bridge !== NS || d.type !== "storage-response") return;
    var entry = pending.get(d.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(d.id);
    d.error ? entry.reject(new Error(d.error)) : entry.resolve(d.value);
  });
})();
</script>
`;

// ----------------------------------------------------------------------------
//  Public API
// ----------------------------------------------------------------------------

let WIDGET_ORIGIN = null;

/** Prefetch the widget-host origin from /api/config. Safe to call early. */
export function initWidgetOrigin() {
  if (WIDGET_ORIGIN) return WIDGET_ORIGIN;
  WIDGET_ORIGIN = fetch("/api/config")
    .then((r) => r.json())
    .then((cfg) => cfg.widgetOrigin || "http://localhost:3001")
    .catch(() => "http://localhost:3001");
  return WIDGET_ORIGIN;
}

async function getWidgetOrigin() {
  return await (WIDGET_ORIGIN || initWidgetOrigin());
}

/**
 * Start a new live widget preview.
 * @returns {Promise<WidgetPreview>}
 */
export async function startPreview(parent, title) {
  const card = buildCard(title || "Generating...");
  parent.appendChild(card.container);
  parent.scrollTop = parent.scrollHeight;
  const preview = new WidgetPreview(card);
  preview._wireBridge();
  return preview;
}

/**
 * Build a *finished* widget card from scratch (no live phase).
 */
export async function addFinishedWidget(parent, title, mode, filepath) {
  const card = buildCard(title);
  card.titleBar.textContent = title;
  card.container.appendChild(buildInfoBar(mode, filepath));
  parent.appendChild(card.container);
  parent.scrollTop = parent.scrollHeight;

  const preview = new WidgetPreview(card);
  preview._wireBridge();
  const origin = await getWidgetOrigin();
  const filename = filepath.split("/").pop();
  try {
    const fullHtml = await fetchSavedFile(origin, filename);
    const body = stripWrapper(fullHtml);
    preview._render(body, mode || detectMode(body));
  } catch {
    card.container.remove();
  }
}


// ----------------------------------------------------------------------------
//  WidgetPreview
// ----------------------------------------------------------------------------

class WidgetPreview {
  constructor(card) {
    this.container = card.container;
    this.titleBar  = card.titleBar;
    this.iframe    = card.iframe;
    this.placeholder = card.placeholder;
    this.wrapper     = card.wrapper;
    this._code     = "";
    this._mode     = null;
    this._finalized = false;
    this._bridgeHandler = null;
  }

  /** Wire the postMessage listener that handles height + bridge requests. */
  _wireBridge() {
    this._bridgeHandler = (e) => this._onMessage(e);
    window.addEventListener("message", this._bridgeHandler);
  }

  /** Feed in the latest full widget code (streaming tick). */
  update(code) {
    if (this._finalized) return;
    this._setCode(code);
    this._render(this._code, this._mode);
  }

  /** Commit final code + render once more so <script> runs against full DOM. */
  commit(code, mode) {
    if (this._finalized) return;
    if (typeof code === "string" && code) this._code = code;
    if (mode) this._mode = mode;
    this._render(this._code, this._mode);
  }

  /** Transition from live preview to the persisted file on disk. */
  async finalize(title, mode, filepath) {
    if (this._finalized) return;
    this._finalized = true;
    this.container.classList.remove("live-preview");
    this.titleBar.textContent = title;
    this.container.insertBefore(
      buildInfoBar(mode, filepath),
      this.container.querySelector(".widget-frame")
    );

    const origin = await getWidgetOrigin();
    const filename = filepath.split("/").pop();
    try {
      const fullHtml = await fetchSavedFile(origin, filename);
      const body = stripWrapper(fullHtml);
      this._mode = mode || detectMode(body);
      this._code = body;
      this._render(body, this._mode);
    } catch {}
    return true;
  }

  markFinalizing(label) {
    if (this._finalized) return;
    this.titleBar.innerHTML = `<span class="live-dot finalized"></span> ${escapeHtml(label || "widget")}`;
  }

  destroy() {
    if (this._bridgeHandler) window.removeEventListener("message", this._bridgeHandler);
  }

  // ---- internals ----

  _setCode(code) {
    this._code = String(code || "");
    if (!this._mode) this._mode = detectMode(this._code);
  }

  /**
   * Render widget code into the iframe via srcdoc.
   * Builds a full HTML document with: CSP meta, theme tokens, the widget
   * body, and the bridge script (so globals exist before widget scripts run).
   */
  _render(code, mode) {
    const body = mode === "svg" ? code : `<section class="widget">${code}</section>`;
    const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${CSP_DIRECTIVES}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --visual-bg: transparent;
    --visual-surface: #1a1a1a;
    --visual-surface-2: #222222;
    --visual-text: #ffffff;
    --visual-muted: #666666;
    --visual-border: rgba(255,255,255,0.08);
    --visual-accent: #ff4d4d;
    --visual-accent-2: #ff2020;
    --visual-success: #ff4d4d;
    --visual-warning: #ff4d4d;
    --visual-danger: #666666;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #0f0f0f; color: #ffffff; }
  body {
    font-family: 'Barlow', system-ui, sans-serif;
    font-weight: 400;
    padding: 20px 24px; overflow-x: auto;
  }
  svg { max-width: 100%; height: auto; }
  .widget { max-width: 800px; margin: 0 auto; width: 100%; }
  /* Slim scrollbar inside the iframe (its own document context). */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 0; }
  ::-webkit-scrollbar-thumb:hover { background: var(--visual-accent); }
  * { scrollbar-width: thin; scrollbar-color: #2a2a2a transparent; }
  /* Respect reduced-motion inside the widget too. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
    }
  }
</style>
</head>
<body>
  <div id="viewport">${body}</div>
  ${BRIDGE_SCRIPT}
</body>
</html>`;
    // Setting srcdoc (re)loads the doc — scripts run against the full DOM.
    // During streaming this re-executes each tick, which is acceptable here.
    this.iframe.srcdoc = doc;
  }

  /** Handle messages from the iframe: height + bridge requests. */
  _onMessage(e) {
    if (e.source !== this.iframe.contentWindow) return;
    const d = e.data;
    if (!d || d.__bridge !== "widget-bridge") return;
    const t = d.type;
    const p = d.payload || {};

    if (t === "height" && typeof p.height === "number") {
      // Resize BOTH the iframe and its placeholder so the placeholder keeps
      // layout space reserved while the wrapper animates to the new height.
      this.iframe.style.height = p.height + "px";
      this.wrapper.style.height = p.height + "px";
      const chat = document.getElementById("chat");
      if (chat) chat.scrollTop = chat.scrollHeight;
    } else if (t === "sendPrompt") {
      handleWidgetPrompt(p.text);
    } else if (t === "openLink") {
      if (p.url) window.open(p.url, "_blank", "noopener");
    } else if (t === "storage-get" || t === "storage-set" || t === "storage-delete") {
      let value, error;
      try { value = widgetStorageOp(t, p.key, p.value); }
      catch (err) { error = err.message; }
      this.iframe.contentWindow.postMessage(
        { __bridge: "widget-bridge", type: "storage-response", id: p.id, value, error },
        "*"
      );
    }
  }
}


// ----------------------------------------------------------------------------
//  In-memory widget storage (per page session)
// ----------------------------------------------------------------------------

const widgetStore = new Map();
function widgetStorageOp(type, key, value) {
  if (type === "storage-get") {
    if (!widgetStore.has(key)) throw new Error("key not found: " + key);
    return widgetStore.get(key);
  }
  if (type === "storage-set") { widgetStore.set(key, value); return undefined; }
  if (type === "storage-delete") { widgetStore.delete(key); return undefined; }
  return undefined;
}


// ----------------------------------------------------------------------------
//  sendPrompt bridge → triggers a new agent turn
// ----------------------------------------------------------------------------

let promptHandler = null;
export function onWidgetPrompt(fn) { promptHandler = fn; }
function handleWidgetPrompt(text) { if (promptHandler) promptHandler(text); }


// ----------------------------------------------------------------------------
//  DOM construction
// ----------------------------------------------------------------------------

function buildCard(title) {
  const container = document.createElement("div");
  container.className = "widget-container live-preview";

  const titleBar = document.createElement("div");
  titleBar.className = "widget-title";
  titleBar.innerHTML = `<span class="live-dot"></span> ${escapeHtml(title)}`;
  container.appendChild(titleBar);

  const frame = document.createElement("div");
  frame.className = "widget-frame";

  // Two-div pattern (from the Claude visualizer architecture): a placeholder
  // reserves layout space so the page doesn't jump when the iframe grows,
  // and an inner wrapper carries the smooth height transition.
  const placeholder = document.createElement("div");
  placeholder.className = "widget-placeholder";

  const wrapper = document.createElement("div");
  wrapper.className = "widget-wrapper";

  const iframe = document.createElement("iframe");
  iframe.setAttribute("title", "widget preview");
  // NO allow-same-origin → null origin → fully isolated from the host page.
  iframe.setAttribute("sandbox", "allow-scripts allow-forms");
  iframe.setAttribute("allow", "fullscreen *; clipboard-write *");
  // Cap width to the widget content (800px + inner padding) so the iframe's
  // scrollbar hugs the widget instead of stretching across the full card.
  iframe.style.cssText =
    "width:100%;max-width:848px;margin:0 auto;height:0;border:0;display:block;background:#0f0f0f;";
  // Seed with an empty shell so the iframe is ready to receive srcdoc.
  iframe.srcdoc =
    "<!DOCTYPE html><html><head><meta charset=utf-8></head><body></body></html>";

  wrapper.appendChild(iframe);
  placeholder.appendChild(wrapper);
  frame.appendChild(placeholder);
  container.appendChild(frame);

  return { container, titleBar, iframe, placeholder, wrapper };
}


// ----------------------------------------------------------------------------
//  Helpers
// ----------------------------------------------------------------------------

function detectMode(code) {
  return String(code || "").trimStart().slice(0, 4).toLowerCase().startsWith("<svg")
    ? "svg"
    : "html";
}

/**
 * Extract the widget body from a saved HTML file. Saved files are full HTML
 * documents; for rendering inside our iframe we only want the widget content.
 * Tries (in order): <section class="widget"> body, then the <svg> element,
 * then <body> contents, else returns as-is.
 */
function stripWrapper(fullHtml) {
  const sec = fullHtml.match(/<section class="widget">([\s\S]*?)<\/section>/);
  if (sec) return sec[1].trim();
  // SVG files may not have the section wrapper — grab the raw <svg>…</svg>.
  const svg = fullHtml.match(/<svg[\s\S]*?<\/svg>/);
  if (svg) return svg[0];
  const body = fullHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  return body ? body[1].trim() : fullHtml;
}

async function fetchSavedFile(origin, filename) {
  const r = await fetch(`${origin}/exports/${filename}`);
  return await r.text();
}

function buildInfoBar(mode, filepath) {
  const info = document.createElement("div");
  info.className = "widget-info";
  info.innerHTML = `
    <span class="widget-mode">${escapeHtml((mode || "").toUpperCase())}</span>
    <span class="widget-path">${escapeHtml(filepath)}</span>
  `;
  const btn = document.createElement("button");
  btn.className = "widget-download";
  btn.type = "button";
  btn.title = "Download";
  btn.setAttribute("aria-label", "Download widget");
  btn.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 2v8m0 0l-3-3m3 3l3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 13h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  btn.addEventListener("click", () => downloadWidget(filepath));
  info.appendChild(btn);
  return info;
}

async function downloadWidget(filepath) {
  const filename = filepath.split("/").pop().replace(/\.[^.]+$/, "");
  const origin = await getWidgetOrigin();
  try {
    const html = await fetchSavedFile(origin, filepath.split("/").pop());
    const blob = new Blob([html], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {}
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
