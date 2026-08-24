/**
 * MCP Sandbox Proxy
 *
 * Hosts untrusted MCP tool HTML in an isolated inner iframe.
 * Communicates with the parent via postMessage (JSON-RPC style).
 * Auto-reports inner content height to parent for dynamic resizing.
 */
const inner = document.createElement("iframe")
inner.style = "width:100%; height:0; border:none; display:block;"
inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms")
document.body.appendChild(inner)

const RESOURCE_READY = "ui/notifications/sandbox-resource-ready"
const PROXY_READY = "ui/notifications/sandbox-proxy-ready"

let lastHeight = 0
let resizeTimer = null

function reportHeight() {
  try {
    const doc = inner.contentDocument || inner.contentWindow?.document
    if (!doc) return
    const h = doc.body?.scrollHeight || doc.documentElement?.scrollHeight || 0
    if (h > 0 && h !== lastHeight) {
      lastHeight = h
      inner.style.height = h + "px"
      window.parent.postMessage({ type: "MCP_UI_RESIZE", height: h }, "*")
    }
  } catch (e) {
    // Cross-origin or not ready yet
  }
}

function scheduleReport() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(reportHeight, 50)
}

function observeContent() {
  try {
    const doc = inner.contentDocument || inner.contentWindow?.document
    if (!doc || !doc.body) return

    // Initial report after content loads
    reportHeight()

    // Observe DOM changes
    const observer = new MutationObserver(scheduleReport)
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true })

    // Also poll briefly for async content (images, fonts, etc.)
    let checks = 0
    const interval = setInterval(function () {
      reportHeight()
      if (++checks > 30) clearInterval(interval)
    }, 100)
  } catch (e) {
    // Cross-origin
  }
}

window.addEventListener("message", function (event) {
  if (event.source === window.parent) {
    if (event.data && event.data.method === RESOURCE_READY) {
      var html = event.data.params && event.data.params.html
      if (typeof html === "string") {
        var doc = inner.contentDocument || inner.contentWindow.document
        doc.open()
        doc.write(html)
        doc.close()
        // Wait for content to render, then observe
        inner.onload = observeContent
        // Fallback if onload already fired
        setTimeout(observeContent, 100)
      }
    } else {
      inner.contentWindow.postMessage(event.data, "*")
    }
  } else if (event.source === inner.contentWindow) {
    // Forward messages from inner content (e.g., WIDGET_RESIZE)
    window.parent.postMessage(event.data, "*")
    // Also check height in case content resized itself
    scheduleReport()
  }
})

window.parent.postMessage({ jsonrpc: "2.0", method: PROXY_READY, params: {} }, "*")
