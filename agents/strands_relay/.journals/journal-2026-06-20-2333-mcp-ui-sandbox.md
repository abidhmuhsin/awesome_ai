# Journal Entry — 20-Jun-2026

## MCP UI Sandbox Rendering — Untrusted MCP tool UIs in the chat

Adds a path for MCP tools to ship an interactive HTML UI that renders inline in the chat, isolated from the main app. A tool registers a UI as an MCP resource at a fixed URI; the server reads that resource in-process after the tool runs and pushes the HTML to the client; the client renders it in a nested sandboxed iframe whose height auto-fits the content. The untrusted HTML never touches the chat page directly — a trusted proxy measures and relays on its behalf.

---

### UI resources registered alongside tools

`hello-with-ui.ts` shows the pattern: a tool (`hellomcp-ui`) is registered normally, and *separately* a resource is registered at `ui://tools/<toolName>/html` with mime `text/html;profile=mcp-app`. The resource body is a full standalone HTML document (own `<head>`, `<style>`, inline `<script>`). The URI convention is what ties a tool to its UI — it's convention, not a declared link, so the client just *probes* for it.

### Reading the resource in-process

`resource-reader.ts` reads a resource by URI through the agent's existing MCP client. The non-obvious part: the high-level `McpClient` wrapper only exposes tool calls (`listTools`/`callTool`), not resources — but it exposes the underlying SDK `Client` via a public `.client` getter. So the reader calls `mcpClient.client.readResource({uri})` and reuses the single stdio connection the agent already maintains. No second server instance, no HTTP hop, no per-request allocation. Missing/empty resources return `null` so "this tool has no UI" is a normal branch, not an error.

### Server push on tool completion

In `websocket.ts`, the `AfterToolCallEvent` hook is now async. After sending `tool_end`, it builds `ui://tools/<toolName>/html`, reads it in-process, and if present pushes `{type:'mcp_ui', tool, uri, html}` over the socket. `createServer` is imported as `createHttpServer` to avoid a name clash, and a dedicated `/sandbox.html` route is registered *before* the static middleware so it can set CSP + no-cache headers.

### The nested iframe proxy

This is the core of the feature. The chat never renders the tool HTML itself:

```
index.html (chat)
 └─ outer iframe  →  /sandbox.html + sandbox.js   (trusted proxy)
     └─ inner iframe →  untrusted tool HTML written in
```

`sandbox.js` is the trusted middle layer: it creates the inner iframe, writes the HTML in, then — as the same-origin *parent* of that inner doc — reads `body.scrollHeight` directly, observes mutations, and relays `MCP_UI_RESIZE` up to the chat so the outer iframe resizes. It also forwards `postMessage` in both directions. The handshake is JSON-RPC-style: proxy announces `sandbox-proxy-ready`, chat replies with `sandbox-resource-ready` carrying the HTML.

### Client rendering and message routing

`appendMcpUi` builds a card (header "Tool UI" + tool name) and appends the outer iframe. The existing top-level `message` listener was refactored to disambiguate the source: widget iframes and MCP-UI iframes are tracked in separate maps and handled in distinct branches (resize, `THEME_REQUEST` relay, prompt/links).

---

## Learnings

### 1. Insert a same-origin proxy to observe untrusted content that can't be trusted to cooperate

You can't assume arbitrary third-party UI HTML will report its own height, fire resize events, or speak your message protocol. By nesting a *trusted* iframe that is the same-origin parent of the untrusted doc, you get read access to that doc's layout (scrollHeight, MutationObserver) and can measure and relay on its behalf. The nesting — trusted-proxy-owns-untrusted-doc — is what makes non-cooperative measurement possible; a single iframe hosting the content directly can't do it without the content's help. *(from diff + conversation)*

### 2. High-level client wrappers cover the common subset; reach under them before building parallel infrastructure

The MCP client wrapper exposed tool calls but not resources — a scope decision, not a gap to work around. When a capability seems missing from a convenience layer, the lower-level client it wraps is usually still reachable (here, a public getter). Reusing it to read resources avoided a second server instance, an HTTP hop, and per-request allocation. Before spinning up duplicate transport, check whether your wrapper exposes the underlying client. *(from diff)*

### 3. Treat "resource not found" as a normal branch, not an error

Probing `ui://tools/<name>/html` on every tool call means most tools have no UI. Swallowing the read failure and returning `null` lets the caller treat "no UI" as an ordinary no-op. Throwing on absence would turn the overwhelmingly common case into log noise and force every caller to handle an exception for nothing. Reserve errors for things that should never happen. *(from diff)*

### 4. A recovery fallback that disables a security control is worse than no fallback

When the proxy handshake times out, the current code falls back to rendering the untrusted HTML with the `sandbox` attribute *removed*. That trades a hard guarantee (isolation) for soft availability — a single slow handshake silently downgrades security to "render arbitrary code unsandboxed." Graceful degradation must shed functionality, not safety: keep the sandbox, lose only the feature that depended on the handshake (height reporting). *(from conversation)*

### 5. `allow-scripts` + `allow-same-origin` together effectively neutralize a sandbox

Both the outer and inner iframes use this combination. It's the well-known escape pair: same-origin *and* script execution lets framed content reach back and strip its own sandbox attribute, so the "isolation" is weaker than the attribute suggests. For genuinely untrusted content you generally cannot have both without negating the protection — read the combination as "escape hatch present," not as defense. *(from conversation)*

### 6. Async handshake state in a module-level singleton breaks under concurrency

The pending-HTML / pending-iframe variables are held as shared module singletons, which assumes only one iframe ever loads at a time. When messages interleave — multiple tool UIs streaming in — that single slot is clobbered and payloads get misrouted or lost. Async handshake state must be keyed by the entity it belongs to (here, the specific iframe), not parked globally. *(from conversation)*
