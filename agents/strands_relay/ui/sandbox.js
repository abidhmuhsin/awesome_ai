/**
 * MCP Sandbox Proxy
 *
 * Hosts untrusted MCP tool HTML in an isolated inner iframe (dual-iframe
 * model: host → this proxy → widget). The proxy is a trusted shim: it is
 * same-origin with the host so it can do postMessage bookkeeping, but the
 * widget frame itself gets a NULL ORIGIN — its sandbox token deliberately
 * omits `allow-same-origin`, so widget code can never reach the proxy
 * document, the host page, or other widgets. All widget communication is
 * postMessage, and height is self-reported by a bridge script injected
 * into the widget document (a null-origin frame cannot be measured from
 * outside — contentDocument access returns null cross-origin).
 *
 * Hardening adopted from the pi_generative_ui widget pipeline:
 *   - sandbox="allow-scripts allow-forms" (NO allow-same-origin)
 *   - CSP meta tag with a CDN allowlist + form-action 'none' injected
 *     into the widget document (blocks exfiltration via navigation and
 *     script/style loads from anywhere outside the allowlist)
 *   - event-driven height reporting (ResizeObserver + MutationObserver +
 *     load), debounced and change-only — no polling loops
 */
const inner = document.createElement("iframe")
inner.style = "width:100%; height:0; border:none; display:block;"
inner.setAttribute("sandbox", "allow-scripts allow-forms")
inner.setAttribute("scrolling", "no")
document.body.appendChild(inner)

const RESOURCE_READY = "ui/notifications/sandbox-resource-ready"
const PROXY_READY = "ui/notifications/sandbox-proxy-ready"

// CDN allowlist — mirrors the pi_generative_ui widget CSP. Widget scripts
// and styles may only load from these origins; everything else is blocked.
const CDN_LIST = [
  "https://esm.sh",
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
].join(" ")

const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="' +
  "default-src 'unsafe-inline' data:; " +
  "script-src 'unsafe-inline' " + CDN_LIST + "; " +
  "style-src 'unsafe-inline' " + CDN_LIST + "; " +
  "img-src * data: blob:; " +
  "font-src " + CDN_LIST + "; " +
  "connect-src " + CDN_LIST + "; " +
  'form-action \'none\'">'

// Bridge script injected into the widget document. It self-reports height
// (change-only, debounced) and forwards widget→host messages upward. Kept
// as a plain string — it runs inside a null-origin frame with no imports.
const BRIDGE = `<script>(function () {
  var lastHeight = 0, timer = null
  function reportHeight() {
    var h = document.body ? (document.body.offsetHeight || document.documentElement.offsetHeight) : 0
    if (h > 0 && h !== lastHeight) { lastHeight = h; parent.postMessage({ type: "MCP_UI_RESIZE", height: h }, "*") }
  }
  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(function () { timer = null; reportHeight() }, 60)
  }
  window.addEventListener("load", function () { reportHeight(); schedule() })
  document.addEventListener("DOMContentLoaded", function () {
    reportHeight()
    if (document.body) {
      new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true })
      new ResizeObserver(schedule).observe(document.documentElement)
    }
  })
})()<\/script>`

/**
 * Inject the CSP meta tag and bridge script into a full widget HTML doc.
 * The CSP meta must be the first child of <head> to take effect for the
 * whole document; the bridge goes right after <head> opens so height
 * observation starts before body content parses.
 */
function hardenHtml(html) {
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + CSP_META + BRIDGE)
  }
  // No <head> — build one. Fragments and bare body content still get the CSP.
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => m + "<head>" + CSP_META + BRIDGE + "</head>")
  }
  return "<!DOCTYPE html><html><head>" + CSP_META + BRIDGE + "</head><body>" + html + "</body></html>"
}

// The widget document is written once as a hardened srcdoc — the frame is
// null-origin from byte zero, so there is no window where widget code runs
// with more privilege than intended.
function loadWidget(html) {
  inner.srcdoc = hardenHtml(typeof html === "string" ? html : "")
}

window.addEventListener("message", function (event) {
  if (event.source === window.parent) {
    if (event.data && event.data.method === RESOURCE_READY) {
      var html = event.data.params && event.data.params.html
      if (typeof html === "string") loadWidget(html)
    }
    // Anything else from the host is not for the widget — the proxy is the
    // only trusted consumer of host messages. Nothing is forwarded inward:
    // widgets cannot be driven from the host side except by (re)loading.
  } else if (event.source === inner.contentWindow) {
    // Relay widget-originated messages (MCP_UI_RESIZE from the bridge,
    // sendPrompt/openLink requests) up to the host unchanged.
    if (event.data && typeof event.data === "object") {
      window.parent.postMessage(event.data, "*")
    }
  }
})

window.parent.postMessage({ jsonrpc: "2.0", method: PROXY_READY, params: {} }, "*")
