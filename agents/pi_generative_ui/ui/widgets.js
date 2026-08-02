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
 *  Streaming strategy (hybrid: srcdoc shell + postMessage body)
 *  ----------------------------------------------------------------------------
 *  The iframe srcdoc is the SHELL — CSP, theme tokens, the bridge script —
 *  and is loaded ONCE when the card is created. A null-origin srcdoc frame
 *  can't be reached via the parent DOM, but it CAN receive postMessage. So:
 *
 *    • On creation: srcdoc is written once with an empty #viewport.
 *    • During streaming (update()): the host postMessages the latest partial
 *      to the frame, which sets #viewport.innerHTML. innerHTML does NOT run
 *      <script> tags, so partial HTML during streaming is cheap and flicker-
 *      free (no document reload). Rapid deltas are still throttled to one
 *      RENDER_INTERVAL ms (rAF-gated) so bursts coalesce.
 *
 *    • At commit()/finalize(): a final `render` (full DOM) followed by
 *      `run-scripts`, which re-executes <script> nodes by cloning them (the
 *      standard trick: scripts inserted via innerHTML are inert, but a cloned
 *      <script> runs). Scripts therefore execute exactly once against the
 *      complete DOM.
 *
 *  This removes the per-tick document reload that the old srcdoc-rewrite
 *  approach suffered from, while keeping the null-origin isolation intact.
 *
 *  ----------------------------------------------------------------------------
 *  Height reporting (event-driven, no rAF polling)
 *  ----------------------------------------------------------------------------
 *  The iframe reports its own scrollHeight — a null-origin frame can't be
 *  measured from outside. The bridge script observes size changes via
 *  ResizeObserver + MutationObserver + load and posts the height on change
 *  only (debounced). The infinite requestAnimationFrame loop from the old
 *  version burned CPU on every widget for the lifetime of the conversation;
 *  this version only fires when the document actually changes.
 *
 *  The parent applies the reported height to BOTH the iframe and its wrapper
 *  (the two-div pattern) so layout space is reserved and the wrapper animates.
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

/**
 * Minimum gap between streaming body writes, in milliseconds. Each tick
 * posts the latest partial into the iframe, which sets #viewport.innerHTML —
 * cheap, but still coalesced via rAF so a burst of deltas produces at most
 * one innerHTML write per RENDER_INTERVAL ms.
 */
const RENDER_INTERVAL = 50;

// The bridge script injected into every widget iframe. Defines sendPrompt,
// openLink, window.storage, and an event-driven height reporter — all
// postMessage-based. No infinite rAF loop: height is reported only on
// observed change (ResizeObserver / MutationObserver / load), debounced.
const BRIDGE_SCRIPT = `
<script>
(function () {
  var PARENT = window.parent;
  var NS = "widget-bridge";
  var msgId = 0;
  var pending = new Map();
  var lastH = -1;
  var reportTimer = null;

  function send(type, payload) {
    PARENT.postMessage({ __bridge: NS, type: type, payload: payload || {} }, "*");
  }

  // ---- Height reporting (event-driven, debounced) ----
  // Report document height to the parent so it can resize the iframe.
  // Fires only when the height actually changes. Debounced so a burst of DOM
  // mutations coalesces into one measurement (avoids reflow storms during
  // streaming and script-driven layout).
  function reportHeight() {
    var b = document.body;
    var h = b ? (b.scrollHeight || b.offsetHeight || 0) : 0;
    if (h > 0 && h !== lastH) { lastH = h; send("height", { height: h }); }
  }
  function scheduleReport() {
    if (reportTimer != null) return;
    reportTimer = setTimeout(function () { reportTimer = null; reportHeight(); }, 60);
  }
  // Immediate report on load + resize; observed changes go through the debounce.
  window.addEventListener("load", reportHeight);
  window.addEventListener("resize", scheduleReport);
  if (document.readyState !== "loading") { reportHeight(); }
  else { document.addEventListener("DOMContentLoaded", reportHeight); }
  try {
    new ResizeObserver(scheduleReport).observe(document.documentElement);
    new MutationObserver(scheduleReport).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true
    });
  } catch (e) {}

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

  // ---- Render pipeline (host → iframe body via postMessage) ----
  // The host sends a 'render' message with the widget HTML; we set
  // #viewport.innerHTML. innerHTML does NOT execute <script> tags, so
  // streaming partials are safe and cheap (no reload). A 'run-scripts'
  // message re-executes any <script> nodes in #viewport by cloning them —
  // the standard way to make inert innerHTML scripts run. Sent once by the
  // host after the final render.
  var VIEWPORT_ID = "viewport";
  var frozen = true;   // animations suppressed until run-scripts (commit phase)
  function setBody(html) {
    var vp = document.getElementById(VIEWPORT_ID);
    if (!vp) return;
    // During streaming the HTML is always partial/incomplete — there is
    // nothing meaningful to animate yet. Suppressing animations prevents
    // CSS keyframes/transitions from restarting on every innerHTML replace
    // (which destroys and recreates all DOM nodes).
    if (frozen) {
      vp.classList.add("frozen");
      document.body.classList.add("frozen");
    }
    vp.innerHTML = html;
    scheduleReport();
  }
  function unfreeze() {
    var vp = document.getElementById(VIEWPORT_ID);
    if (vp) vp.classList.remove("frozen");
    document.body.classList.remove("frozen");
    frozen = false;
  }
  function runScripts() {
    var vp = document.getElementById(VIEWPORT_ID);
    if (!vp) return;
    var scripts = vp.querySelectorAll("script");
    scripts.forEach(function (old) {
      var s = document.createElement("script");
      for (var i = 0; i < old.attributes.length; i++) {
        s.setAttribute(old.attributes[i].name, old.attributes[i].value);
      }
      s.textContent = old.textContent;
      old.parentNode.replaceChild(s, old);
    });
    scheduleReport();
  }

  // Receive storage responses + render/run-scripts commands from the host.
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__bridge !== NS) return;
    if (d.type === "storage-response") {
      var entry = pending.get(d.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(d.id);
      d.error ? entry.reject(new Error(d.error)) : entry.resolve(d.value);
    } else if (d.type === "render") {
      setBody(d.payload || "");
    } else if (d.type === "run-scripts") {
      unfreeze();  // remove .frozen BEFORE running scripts so they see live CSS
      runScripts();
    }
  });
})();
</script>
`;

// ----------------------------------------------------------------------------
//  Shell document (written to srcdoc ONCE per card)
// ----------------------------------------------------------------------------
//  CSP + theme tokens + the bridge script, with an EMPTY #viewport. Widget
//  bodies are delivered later via postMessage so the document is never
//  reloaded during streaming. Kept as a module function so buildCard() can
//  seed the iframe before WidgetPreview is constructed.
function buildShell() {
  return `<!DOCTYPE html>
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
  /* During streaming, .frozen on <body> hides scrollbars so the reported
   * scrollHeight reflects the true content height (without scrollbar space).
   * Without this, the scrollbar height is baked into the reported value,
   * making the iframe permanently tall enough to show the scrollbar — a
   * feedback loop that causes layout thrash on every innerHTML replace. */
  body.frozen { overflow: hidden !important; }
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
  /*
   * .frozen — applied to #viewport during streaming. Strips all CSS
   * animations and transitions so innerHTML replaces don't restart them on
   * every tick, and elements show their base (non-animated) styles instead
   * of being stuck at a paused pre-animation state. Removed once at commit
   * (run-scripts) so the final render plays animations normally.
   */
  .frozen, .frozen *, .frozen *::before, .frozen *::after {
    animation: none !important;
    transition: none !important;
  }
</style>
</head>
<body>
  <div id="viewport"></div>
  ${BRIDGE_SCRIPT}
</body>
</html>`;
}

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
  preview._markFinalized();   // no live phase — start in finalized state
  const origin = await getWidgetOrigin();
  const filename = filepath.split("/").pop();
  try {
    const fullHtml = await fetchSavedFile(origin, filename);
    const body = stripWrapper(fullHtml);
    preview._renderBody(body, mode || detectMode(body));
    preview._runScripts();
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
    this._aborted  = false;
    this._bridgeHandler = null;

    // Iframe readiness: the shell srcdoc must finish loading before we can
    // postMessage widget bodies into it. Messages sent before `load` are
    // buffered in _pendingMsgs and flushed on load.
    this._iframeReady = false;
    this._pendingMsgs = null;
    this._loadHandler = () => {
      this._iframeReady = true;
      const q = this._pendingMsgs;
      this._pendingMsgs = null;
      if (q) for (const m of q) this.iframe.contentWindow.postMessage(m, "*");
    };
    this.iframe.addEventListener("load", this._loadHandler);

    // Streaming throttle state (see _scheduleStreamRender).
    this._pendingCode  = null;   // latest buffered partial not yet rendered
    this._rafId        = null;   // active rAF, if any
    this._lastRenderTs = 0;      // timestamp of last body write
  }

  /** Wire the postMessage listener that handles height + bridge requests. */
  _wireBridge() {
    this._bridgeHandler = (e) => this._onMessage(e);
    window.addEventListener("message", this._bridgeHandler);
  }

  /**
   * Feed in the latest full widget code (streaming tick). Throttled: rapid
   * deltas coalesce into at most one body write per RENDER_INTERVAL ms.
   */
  update(code) {
    if (this._finalized || this._aborted) return;
    this._setCode(code);
    this._scheduleStreamRender();
  }

  /** Commit final code + render once authoritatively so <script> runs. */
  commit(code, mode) {
    if (this._finalized || this._aborted) return;
    if (typeof code === "string" && code) this._code = code;
    if (mode) this._mode = mode;
    // Cancel any pending throttled render — the commit is authoritative.
    this._cancelStreamRender();
    // Final full render, then execute <script> tags exactly once.
    this._renderBody(this._code, this._mode);
    this._runScripts();
  }

  /** Transition from live preview to the persisted file on disk. */
  async finalize(title, mode, filepath, elapsed) {
    if (this._finalized || this._aborted) return;
    this._markFinalized();
    this._cancelStreamRender();
    this.titleBar.textContent = title;
    this.container.insertBefore(
      buildInfoBar(mode, filepath, elapsed),
      this.container.querySelector(".widget-frame")
    );

    const origin = await getWidgetOrigin();
    const filename = filepath.split("/").pop();
    try {
      const fullHtml = await fetchSavedFile(origin, filename);
      const body = stripWrapper(fullHtml);
      this._mode = mode || detectMode(body);
      this._code = body;
      this._renderBody(body, this._mode);
      this._runScripts();
    } catch {}
    return true;
  }

  markFinalizing(label) {
    if (this._finalized || this._aborted) return;
    this.titleBar.innerHTML = `<span class="live-dot finalized"></span> ${escapeHtml(label || "widget")}`;
  }

  /**
   * Abort an in-progress stream: the turn ended (agent_end / error / new turn)
   * without a finalize. Renders stay if we already drew something; empty or
   * never-rendered cards are collapsed so they don't hang on "BUILDING…".
   * Idempotent.
   */
  abort() {
    if (this._finalized || this._aborted) return;
    this._aborted = true;
    this._cancelStreamRender();
    // If we never rendered visible content, hide the card entirely.
    if (!this._code || !this._code.trim()) {
      this.container.remove();
      return;
    }
    // We have partial content — leave it visible but mark incomplete so it
    // doesn't keep pulsing the live dot forever.
    this.container.classList.remove("live-preview");
    this.titleBar.innerHTML = `<span class="live-dot finalized" style="background:var(--text-muted)"></span> incomplete`;
  }

  destroy() {
    this._cancelStreamRender();
    if (this._bridgeHandler) window.removeEventListener("message", this._bridgeHandler);
    if (this._loadHandler) this.iframe.removeEventListener("load", this._loadHandler);
  }

  // ---- internals ----

  _setCode(code) {
    this._code = String(code || "");
    if (!this._mode) this._mode = detectMode(this._code);
  }

  _markFinalized() {
    this._finalized = true;
    this.container.classList.remove("live-preview");
  }

  /**
   * Throttled streaming render. Buffers the latest partial and posts it into
   * the iframe at most once per RENDER_INTERVAL ms (rAF-gated). Coalescing
   * rapid deltas into fewer innerHTML writes keeps streaming smooth.
   */
  _scheduleStreamRender() {
    this._pendingCode = this._code;
    if (this._rafId) return;                 // already scheduled — latest wins
    this._rafId = requestAnimationFrame((ts) => {
      this._rafId = null;
      if (this._finalized || this._aborted) { this._pendingCode = null; return; }
      // First render always goes through immediately so the preview appears
      // without the interval delay; thereafter respect RENDER_INTERVAL.
      if (this._lastRenderTs && ts - this._lastRenderTs < RENDER_INTERVAL) {
        this._rafId = requestAnimationFrame((t) => { this._rafId = null; this._flushStream(t); });
        return;
      }
      this._flushStream(ts);
    });
  }

  _flushStream(ts) {
    if (this._finalized || this._aborted || this._pendingCode == null) return;
    const code = this._pendingCode;
    this._pendingCode = null;
    this._lastRenderTs = ts;
    // Cheap innerHTML update inside the frame — no document reload.
    this._renderBody(code, this._mode);
  }

  _cancelStreamRender() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._pendingCode = null;
  }

  /**
   * Build the SHELL document (CSP, theme, bridge) with an EMPTY #viewport.
   * Written to srcdoc ONCE on card creation; never rewritten during streaming.
   */
  _buildShell() {
    return buildShell();
  }

  /** Wrap widget code in its section (HTML mode) or leave bare (SVG mode). */
  _wrap(code, mode) {
    return mode === "svg" ? code : `<section class="widget">${code}</section>`;
  }

  /**
   * Send the widget body to the iframe via postMessage (no srcdoc reload).
   * If the iframe isn't ready yet (shell still loading), buffer until `load`.
   */
  _renderBody(code, mode) {
    const html = this._wrap(code, mode);
    this._postOrBuffer({ __bridge: "widget-bridge", type: "render", payload: html });
  }

  /** Tell the iframe to execute <script> tags in #viewport (once, at commit). */
  _runScripts() {
    this._postOrBuffer({ __bridge: "widget-bridge", type: "run-scripts" });
  }

  /** postMessage to the iframe; if it isn't loaded yet, queue the message. */
  _postOrBuffer(msg) {
    if (this._iframeReady) {
      this.iframe.contentWindow.postMessage(msg, "*");
    } else {
      (this._pendingMsgs ||= []).push(msg);
    }
  }

  /** Handle messages from the iframe: height + bridge requests. */
  _onMessage(e) {
    if (e.source !== this.iframe.contentWindow) return;
    const d = e.data;
    if (!d || d.__bridge !== "widget-bridge") return;
    const t = d.type;
    const p = d.payload || {};

    if (t === "height" && typeof p.height === "number") {
      // Apply reported height to BOTH the iframe and its wrapper so the
      // two-div placeholder/wrapper keeps layout space reserved while the
      // wrapper animates to the new height.
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
  iframe.srcdoc = buildShell();

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
 *
 * The wrapper is `<section class="widget">…</section>` but the widget body
 * itself frequently contains NESTED <section> elements AND trailing
 * <script>/<style> blocks that sit after the inner content. A non-greedy
 * regex stops at the FIRST inner </section> and silently drops everything
 * after it — including the scripts that make the widget work.
 *
 * We therefore match the wrapper opening to the LAST </section> in the
 * document (the wrapper is always the outermost section). Falls back to the
 * raw <svg>, then <body> contents.
 */
function stripWrapper(fullHtml) {
  // Anchor the wrapper open to the LAST </section> so nested sections and
  // any trailing <script>/<style> between them are preserved.
  const sec = fullHtml.match(/<section class="widget">([\s\S]*)<\/section>/);
  if (sec) return sec[1].trim();
  // SVG files may not have the section wrapper — grab the raw <svg>…</svg>.
  // Greedy is correct here too: an SVG has exactly one closing </svg>.
  const svg = fullHtml.match(/<svg[\s\S]*<\/svg>/);
  if (svg) return svg[0];
  const body = fullHtml.match(/<body[^>]*>([\s\S]*)<\/body>/);
  return body ? body[1].trim() : fullHtml;
}

async function fetchSavedFile(origin, filename) {
  const r = await fetch(`${origin}/exports/${filename}`);
  return await r.text();
}

function buildInfoBar(mode, filepath, elapsed) {
  const info = document.createElement("div");
  info.className = "widget-info";
  const elapsedHtml = elapsed ? ` <span class="widget-elapsed">${escapeHtml(elapsed)}s</span>` : "";
  info.innerHTML = `
    <span class="widget-mode">${escapeHtml((mode || "").toUpperCase())}</span>
    <span class="widget-path">${escapeHtml(filepath)}</span>${elapsedHtml}
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
