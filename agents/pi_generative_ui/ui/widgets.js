/**
 * ============================================================================
 *  Widget Renderer — live + final widget display via Shadow DOM
 * ============================================================================
 *
 *  Owns everything about rendering agent-generated SVG/HTML widgets:
 *    - building the preview card (title bar + shadow host)
 *    - a scoped theme (CSS variables, canvas) injected into the shadow root
 *    - detecting svg vs html mode
 *    - INCREMENTAL live updates as code streams in
 *    - finalizing: swap the live preview for the persisted file
 *
 *  DESIGN RULE: this module knows nothing about the chat, SSE, or app state.
 *  The caller (app.js) drives the lifecycle:
 *
 *      const w = widgets.startPreview(parent, "Building widget...")
 *      w.update(code)                      // called as code streams in
 *      w.update(moreCode)
 *      w.finalize(title, mode, filepath)   // swap to saved file
 *
 *  ----------------------------------------------------------------------------
 *  Why Shadow DOM (not iframe + srcdoc)?
 *  ----------------------------------------------------------------------------
 *  The previous design rewrote `iframe.srcdoc` on every streamed token, which
 *  DESTROYS and REBUILDS the entire framed document — causing flash, restarting
 *  animations, and re-running <script>. Shadow DOM fixes all three:
 *
 *    1. ISOLATION   — the shadow root scopes the widget's CSS; host page
 *                     styles can't leak in and widget styles can't leak out.
 *                     (Equivalent to an iframe's document boundary.)
 *    2. DIRECT ACCESS — we hold a live DOM node and patch it incrementally,
 *                     so we never rebuild the whole tree.
 *    3. STATE SURVIVES — <script> runs ONCE (on first render); animations and
 *                     JS state persist across updates because nodes aren't
 *                     destroyed when their tag matches.
 *
 *  Incremental patching is done by morphTree() below — a tiny morphdom-style
 *  diff that walks the live tree vs the parsed target and updates only what
 *  changed (attributes, text, added/removed children).
 * ============================================================================
 */

// ----------------------------------------------------------------------------
//  Public API
// ----------------------------------------------------------------------------

/**
 * Start a new live widget preview.
 *
 * @param {HTMLElement} parent  - element to append the preview card into.
 * @param {string} [title]      - initial title-bar label.
 * @returns {WidgetPreview}     - handle to drive update() / finalize().
 */
export function startPreview(parent, title) {
  const card = buildCard(title || "Generating...");
  parent.appendChild(card.container);
  parent.scrollTop = parent.scrollHeight;
  return new WidgetPreview(card);
}

/**
 * Build a *finished* widget card from scratch (no live phase).
 * Fallback used when streaming events were missed (e.g. page reloaded mid-turn)
 * and we only have the final saved file.
 *
 * @param {HTMLElement} parent
 * @param {string} title
 * @param {"svg"|"html"} mode
 * @param {string} filepath  - only the basename is used to fetch from /exports/.
 */
export function addFinishedWidget(parent, title, mode, filepath) {
  const card = buildCard(title);
  card.titleBar.textContent = title;

  const info = buildInfoBar(mode, filepath);
  card.container.appendChild(info);

  parent.appendChild(card.container);
  parent.scrollTop = parent.scrollHeight;

  // Render the saved file into the shadow root.
  const renderer = new WidgetPreview(card);
  loadSavedFile(filepath)
    .then((html) => renderer._setCode(stripWrapper(html)))
    .catch(() => card.container.remove());
}


// ----------------------------------------------------------------------------
//  WidgetPreview — drives one widget's live → final lifecycle
// ----------------------------------------------------------------------------

class WidgetPreview {
  constructor(card) {
    this.container = card.container;
    this.titleBar  = card.titleBar;
    this.host      = card.host;        // the element whose shadow root we own
    this.root      = card.root;        // the shadowRoot
    this.viewport  = card.viewport;    // the themed canvas inside the shadow

    // Live state (private).
    this._code        = "";
    this._mode        = null;          // "svg" | "html"
    this._finalized   = false;
    this._bootstrapped = false;        // have we set up the viewport + run <script>?
    this._pendingRaf  = null;          // rAF handle for throttled renders
  }

  /**
   * Feed in the latest full widget code (the server sends the complete parsed
   * value each tick, NOT a delta to append). Triggers an incremental patch.
   */
  update(code) {
    if (this._finalized) return;
    this._setCode(code);
    this._scheduleRender();
  }

  /**
   * Commit the final code/mode and render immediately (bypass throttle).
   * Called once when the tool-call arguments are fully received.
   */
  commit(code, mode) {
    if (this._finalized) return;
    if (typeof code === "string" && code) this._code = code;
    if (mode) this._mode = mode;
    this._flush();
    this._render();
  }

  /**
   * Transition from live preview to the persisted file on disk.
   * - stops live updates
   * - shows mode/filepath metadata
   * - loads /exports/<basename> into the shadow root
   */
  finalize(title, mode, filepath) {
    if (this._finalized) return;
    this._flush();
    this._finalized = true;

    this.container.classList.remove("live-preview");
    this.titleBar.textContent = title;

    const info = buildInfoBar(mode, filepath);
    this.container.insertBefore(info, this.host.parentElement);

    loadSavedFile(filepath)
      .then((html) => this._setCode(stripWrapper(html)))
      .catch(() => {});
    return true;
  }

  /** Mark the title bar as "finalized" (code done, now saving). */
  markFinalizing(label) {
    if (this._finalized) return;
    this.titleBar.innerHTML = `<span class="live-dot finalized"></span> ${escapeHtml(label || "widget")}`;
  }

  /** Cancel any pending render (call when the preview is abandoned). */
  destroy() {
    this._flush();
  }

  // ---- internals ----

  /** Store latest code + detect mode. */
  _setCode(code) {
    this._code = String(code || "");
    if (!this._mode) this._mode = detectMode(this._code);
  }

  /**
   * Throttle renders to one per animation frame. Because we now PATCH the DOM
   * instead of rebuilding it, there's no flash — so we can render on every rAF
   * safely. This keeps the preview tightly synced to the stream.
   */
  _scheduleRender() {
    if (this._pendingRaf) return;           // already scheduled
    this._pendingRaf = requestAnimationFrame(() => {
      this._pendingRaf = null;
      this._render();
    });
  }

  /**
   * Patch the latest code into the shadow root's viewport.
   *
   * First call bootstraps: sets the canvas mode (svg vs html), runs any
   * <script> in the code once. Subsequent calls morph the existing tree to
   * match the new code without rebuilding — so animations/state survive.
   */
  _render() {
    if (this._finalized || !this._code) return;

    // Parse the latest widget code into a detached node list.
    const incoming = parseWidget(this._code, this._mode);

    if (!this._bootstrapped) {
      // First render: set up the canvas and adopt the nodes verbatim.
      this.viewport.replaceChildren(...incoming.childNodes);
      this._runScripts(this.viewport);          // widget JS runs exactly once
      this._bootstrapped = true;
    } else {
      // Subsequent renders: morph the existing tree in place.
      morphTree(this.viewport, incoming);
    }
    autoSize(this.host, this.viewport);
  }

  /** Run <script> tags inside `node`, since adopting nodes via the DOM does
   *  not execute them (scripts only run when inserted via innerHTML into the
   *  live document, which we avoid for patching). */
  _runScripts(root) {
    for (const old of root.querySelectorAll("script")) {
      const s = document.createElement("script");
      for (const attr of old.attributes) s.setAttribute(attr.name, attr.value);
      s.textContent = old.textContent;
      old.replaceWith(s);
    }
  }

  /** Cancel a pending rAF render. */
  _flush() {
    if (this._pendingRaf) {
      cancelAnimationFrame(this._pendingRaf);
      this._pendingRaf = null;
    }
  }
}


// ----------------------------------------------------------------------------
//  DOM construction
// ----------------------------------------------------------------------------

/**
 * Build the preview card skeleton: title bar + shadow host.
 * The shadow root is created here and pre-loaded with the scoped theme; the
 * widget code itself is patched into `viewport` on each render.
 */
function buildCard(title) {
  const container = document.createElement("div");
  container.className = "widget-container live-preview";

  const titleBar = document.createElement("div");
  titleBar.className = "widget-title";
  titleBar.innerHTML = `<span class="live-dot"></span> ${escapeHtml(title)}`;
  container.appendChild(titleBar);

  const frame = document.createElement("div");
  frame.className = "widget-frame";
  const host = document.createElement("div");
  host.className = "widget-host";
  frame.appendChild(host);
  container.appendChild(frame);

  // Create the shadow root + inject the isolated theme + a viewport node
  // that widget content gets patched into.
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = SHADOW_THEME;
  const viewport = root.getElementById("viewport");

  return { container, titleBar, host, root, viewport };
}

/**
 * Scoped CSS + canvas injected into every widget's shadow root.
 * Defines the --visual-* theme variables the widgets depend on, and a dark
 * canvas that matches the host UI. Because it's in the shadow root, these
 * styles (and the widget's own <style>) cannot leak into or out of the widget.
 */
const SHADOW_THEME = `
<style>
  :host { display: block; }
  #viewport {
    background: #0f0f0f;
    color: #ffffff;
    font-family: 'Barlow', sans-serif;
    font-weight: 400;
    padding: 24px;
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 120px;
    overflow: hidden;
  }
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
  * { box-sizing: border-box; }
  svg { max-width: 100%; height: auto; }
  .widget { max-width: 800px; margin: 0 auto; width: 100%; }
</style>
<div id="viewport"></div>
`;


// ----------------------------------------------------------------------------
//  Code → DOM parsing & helpers
// ----------------------------------------------------------------------------

/**
 * Decide svg vs html by sniffing the first characters. The show_visual tool
 * does the same check server-side; we replicate it so the live preview picks
 * the right wrapper before the tool executes.
 */
function detectMode(code) {
  return String(code || "").trimStart().slice(0, 4).toLowerCase().startsWith("<svg")
    ? "svg"
    : "html";
}

/**
 * Parse raw widget code into a detached DocumentFragment.
 *
 * SVG needs the SVG namespace so elements render correctly; HTML parses in the
 * default namespace. A <template> gives us a clean detached container whose
 * children we can morph against the live viewport.
 */
function parseWidget(code, mode) {
  const tpl = document.createElement("template");
  if (mode === "svg") {
    // Wrap in an SVG parent so the parser uses the SVG namespace, then unwrap.
    tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${code}</svg>`;
    const svg = tpl.content.firstElementChild;
    const frag = document.createDocumentFragment();
    while (svg.firstChild) frag.appendChild(svg.firstChild);
    return frag;
  }
  // HTML mode: the tool's contract is a fragment (no <html>/<body>).
  // Wrap in a .widget section to match what the saved file produces.
  tpl.innerHTML = `<section class="widget">${code}</section>`;
  return tpl.content;
}

/**
 * Saved widget files are full HTML documents (the tool wraps them). For shadow
 * rendering we only want the widget body. This extracts the inner content of
 * the <section class="widget">…</section> if present, else returns as-is.
 */
function stripWrapper(fullHtml) {
  const m = fullHtml.match(/<section class="widget">([\s\S]*?)<\/section>/);
  return m ? m[1].trim() : fullHtml;
}


// ----------------------------------------------------------------------------
//  morphTree — minimal incremental DOM diff (morphdom-style)
// ----------------------------------------------------------------------------
//
//  Walks the live tree (liveRoot) and the target tree (newFrag) in parallel,
//  updating `liveRoot` to match `newFrag` with the FEWEST possible mutations:
//
//    - matching nodes (same tag) → update attributes + text in place
//    - mismatched nodes          → replace
//    - extra live children       → remove
//    - extra new children        → append
//
//  Because matching nodes are kept (not replaced), running animations, focus,
//  scroll position, and JS-attached state on those nodes survive updates.
//  This is the key difference from innerHTML/srcdoc replacement.

function morphTree(liveRoot, newFrag) {
  const liveKids = [...liveRoot.childNodes];
  const newKids = [...newFrag.childNodes];
  const max = Math.max(liveKids.length, newKids.length);

  for (let i = 0; i < max; i++) {
    const live = liveKids[i];
    const next = newKids[i];

    if (!next) {
      // No corresponding new node → remove the live one.
      live && live.remove();
    } else if (!live) {
      // No corresponding live node → append the new one.
      liveRoot.appendChild(next);
    } else if (isSameNode(live, next)) {
      // Same node → patch attributes/text + recurse into children.
      patchAttributes(live, next);
      if (live.nodeType === Node.TEXT_NODE) {
        if (live.textContent !== next.textContent) live.textContent = next.textContent;
      } else if (live.nodeType === Node.ELEMENT_NODE) {
        morphTree(live, next);
      }
    } else {
      // Different node (tag/name mismatch) → replace.
      live.replaceWith(next);
    }
  }
}

/** Two nodes are "the same" if they share an element tag name, or both are
 *  text/comment nodes of the same type. */
function isSameNode(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType === Node.ELEMENT_NODE) {
    return a.localName === b.localName;
  }
  return true; // text/comment nodes match by type
}

/** Copy attributes from `src` onto `dst`, removing any that were deleted. */
function patchAttributes(dst, src) {
  if (dst.nodeType !== Node.ELEMENT_NODE) return;

  // Remove attributes present on dst but not on src.
  for (const attr of [...dst.attributes]) {
    if (!src.hasAttribute(attr.name)) dst.removeAttribute(attr.name);
  }
  // Set/update attributes from src.
  for (const attr of src.attributes) {
    if (dst.getAttribute(attr.name) !== attr.value) {
      dst.setAttribute(attr.name, attr.value);
    }
  }
}


// ----------------------------------------------------------------------------
//  Sizing & loading helpers
// ----------------------------------------------------------------------------

/**
 * Size the host element to its shadow content height, clamped.
 * Runs after every render so the card grows/shrinks with the widget.
 */
function autoSize(host, viewport) {
  const h = viewport.scrollHeight;
  host.style.height = h + 8 + "px";
}

/** Fetch the persisted widget file from /exports/ and return its HTML. */
function loadSavedFile(filepath) {
  const filename = filepath.split("/").pop();
  return fetch(`/exports/${filename}`).then((r) => r.text());
}

/**
 * Build the metadata bar shown on a finalized widget: mode badge, filepath,
 * and a download button (top-right) that saves the file locally.
 */
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
  btn.addEventListener("click", () => downloadWidget(filepath, mode));

  info.appendChild(btn);
  return info;
}

/** Download the saved widget file with the correct extension. */
function downloadWidget(filepath, mode) {
  const filename = filepath.split("/").pop().replace(/\.[^.]+$/, "");
  const ext = "html";
  loadSavedFile(filepath)
    .then((html) => {
      const blob = new Blob([html], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filename}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    })
    .catch(() => {});
}

/** Escape a string for safe insertion into innerHTML. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
