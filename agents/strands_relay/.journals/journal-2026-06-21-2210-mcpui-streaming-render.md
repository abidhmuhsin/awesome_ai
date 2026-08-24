# Journal Entry — 21-Jun-2026

## MCP UI / Tool-UI Streaming + Non-Streaming — Unified Widget Rendering Flow

The agent can produce two kinds of in-chat visual UI, and they reach the
browser through two genuinely different server→client paths that the UI
collapses into one rendering surface. **Generator tools** (`widget_renderer`)
emit model-authored HTML that is *streamed token-by-token* as the model types
it, previewed live, then swapped into a sandboxed iframe. **Static-UI tools**
(`hellomcp-ui`, etc.) ship a complete, pre-written HTML document from an MCP
resource that is fetched in-process and rendered through a nested proxy iframe
with no streaming. Both card kinds live in a single client-side map and share
one message router, so resize, theme-sync, and prompt bridging are handled
uniformly.

This entry documents how each path is implemented and why the design split
exists.

---

## The two delivery channels, at a glance

| Concern | Generator tool (`widget_renderer`) | Static-UI tool (`hellomcp-ui`, …) |
|---|---|---|
| Where the HTML lives | Model-generated `widget_code` arg | `ui://tools/<name>/html` MCP resource |
| Transport | Streamed as `tool_input_delta` | One-shot `mcp_ui` (full doc) |
| Client preview | Progressive render into a content div | None — straight to sandbox |
| Final render | `srcdoc` scaffold iframe (self-reporting height) | Nested proxy iframe (non-cooperative height) |
| Authoritative "done" | `mcp_ui { streamFinal: true }` | Implicit (the message *is* the resource) |

The fork happens server-side in the `AfterToolCallEvent` hook
(`src/agent/transports/websocket.ts:100-128`): if the tool is
`widget_renderer`, the hook reads `widget_code` straight from the tool input
and sends an `mcp_ui` with `streamFinal: true` (an authoritative finalize of
the streaming preview). For any other tool, it tries to read
`ui://tools/<toolName>/html` and sends the result as a plain `mcp_ui` with
`fullDoc: true`. "No UI" — a tool with no resource — is a silent no-op, not an
error.

---

## Streaming path — generator tools (`widget_renderer`)

### The tool itself is a stub on purpose
`widget_renderer`'s callback (`src/tools/widget-renderer.ts`) does almost
nothing: it validates inputs and returns the literal string
`` Rendered widget: ${title} ``. The actual HTML never appears in the tool
*result*. It is the tool's *input* (`widget_code`), and it is delivered to the
UI as a side-channel message read from those same args by the AfterToolCall
hook. Returning the raw HTML as the result would dump kilobytes of markup into
both the tool-call bubble and the model's own context window, where it serves
no reasoning purpose.

### Server: forwarding tool-input deltas
The transport switched from synchronous `agent.invoke()` to
`agent.stream()` (`f73e77c`). Inside the stream loop it listens for
`modelStreamUpdateEvent` and, on a `modelContentBlockDeltaEvent` of type
`toolUseInputDelta`, emits a `tool_input_delta` WS message tagged with the
active tool's id and name (`websocket.ts:177-189`). The client routes each
delta to the correct progressive-render card by that id.

The active tool is correlated by **"most recent `toolUseStart`"**, set on
`modelContentBlockStartEvent` and cleared on `...StopEvent`
(`websocket.ts:160-166`). The OpenAI chat adapter does **not** populate
`contentBlockIndex`, so there is no per-block index to key on — this matches
the SDK's own single-accumulator model. The code calls out the failure mode
explicitly: if a provider interleaves two tools' input deltas in one turn, the
deltas are misattributed, and concurrent widget streaming is therefore
best-effort. (The Responses API would instead collapse all tool input into a
single delta, ending progressive render.)

### Client: progressive preview with RAF batching
`streamDelta()` (`ui/index.html:1525`) runs on every `tool_input_delta`:

1. **Lazy card creation.** It accumulates the raw JSON deltas into
   `card.accumulatedJson` and only builds the card DOM once a `"title"` field
   regex-parses out of the partial JSON (`:1546`). Until a title exists, there
   is nothing to label, so nothing is shown.
2. **Partial extraction.** `extractWidgetCodePartial()` finds the
   `"widget_code"` key and returns everything after its opening quote — i.e.
   it does not wait for the closing quote. `decodeJsonString()` then unescapes
   the common JSON escapes (`\n`, `\t`, `\"`, `\/`, `\\`, `\uXXXX`) so partial
   HTML is valid enough to render.
3. **Throttled DOM writes.** `renderProgressive()` (`:1597`) writes the partial
   HTML into the content div, but batches via `requestAnimationFrame` with a
   **100ms immediate-render threshold**: if more than 100ms have passed since
   the last render it writes immediately (feels responsive); otherwise it
   queues to the next frame. All batch state (`rafId`, `pendingRender`,
   `lastRenderTime`) lives on the per-card object so concurrent widgets don't
   clobber each other's RAF ids. Commit `4ea2fd7` measured this at ~3-5× fewer
   DOM writes during rapid deltas.
4. **Overlay.** While streaming, a semi-transparent overlay (scanlines +
   shimmer bar + pulsing "Building" text, `widget-wave-overlay`) sits over the
   content area. It is a **sibling** of the content div rather than a child, so
   re-rendering the content via `innerHTML` never destroys it.

### Authoritative finalize (not a heuristic)
The transition from live preview to a secure sandboxed iframe happens **only**
in `finalizeCard()` (`:1683`), which is invoked by the `mcp_ui { streamFinal:
true }` message — never from a client-side "is the JSON closed?" guess. The
earlier implementation (`fd28a60`) had an `isWidgetCodeComplete()` heuristic
that looked for the closing quote; that was replaced by trusting the server's
finalize. `finalizeCard` is idempotent on `toolUseId`: it hides the overlay,
flips status to "DONE", adds a `.finalized` class that hides the content div
and reveals the hidden iframe wrapper, then sets
`iframe.srcdoc = buildIframePage(html)`. If a streaming card was never created
(e.g. deltas never carried a title), `finalizeCard` builds one first so the
finalize still lands.

### Aborts and orphans
`abortStreamingCards()` (`:1710`) sweeps any still-streaming card on two
triggers: a stream `error` (e.g. malformed tool JSON that kills the turn) and a
new `typing` indicator (start of a new turn whose prior turn never finalized).
Rendered partials are kept; cards with no content are hidden so they don't hang
on "BUILDING…". Status is set to "INCOMPLETE".

---

## Non-streaming path — static-UI tools (MCP resources)

### Server: reading a resource through the agent's own client
A static-UI tool registers both a tool and an MCP resource at
`ui://tools/<name>/html` with `mimeType: 'text/html;profile=mcp-app'`
(`src/mcp/tools/hello-with-ui.ts:108`). The AfterToolCall hook reads that
resource with `readMcpResource()` (`src/mcp/resource-reader.ts`).

The non-obvious part: **Strands' `McpClient` only wraps tool calls
(`listTools`/`callTool`), not resources** — but it exposes the underlying SDK
`Client` via a public `.client` getter. `readMcpResource` reaches through that
getter to call `client.readResource({ uri })`, reusing the single stdio
connection the agent already maintains. No extra server instance, no HTTP hop,
no per-request allocation. `connect()` is idempotent, so it's a no-op once the
agent has connected. Missing/non-text resources resolve to `null`, so "this
tool has no UI" is a normal branch in the hook, not an exception path.

### Client: the nested proxy iframe
Static docs are **full HTML documents** (they include `<!DOCTYPE>`,
`<head>`, `<style>`, `<script>`). The generator-widget scaffold (`srcdoc`) can
self-report its height because the page is authored by us and posts
`WIDGET_RESIZE`. A loaded third-party-style full document can't be assumed
cooperative, so static UIs render through a **nested proxy**: an outer iframe
loads `/sandbox.html` + `sandbox.js`, which hosts an *inner* iframe that
receives the HTML via `document.write()`.

The handshake (`ui/index.html:1768` `loadMcpSandbox`):

1. Outer iframe is pointed at `/sandbox.html` (served with a permissive CSP
   header, `websocket.ts:28-32`).
2. `sandbox.js` signals `PROXY_READY` to the parent.
3. Parent responds with `RESOURCE_READY` carrying the HTML.
4. Proxy writes the HTML into the inner iframe and begins **non-cooperative
   height measurement**: a `MutationObserver` on the inner body plus a polling
   interval (100ms × 30) to catch async content (images, fonts). On any change
   it relays `MCP_UI_RESIZE` to the parent.

The safety net matters as much as the happy path: if the proxy never
handshakes within 3s, the parent swaps in an in-sandbox "Tool UI failed to
load" `srcdoc`. The comment is explicit that the **old fallback stripped the
`sandbox` attribute and loaded the HTML raw** — a real escape hatch that was
deliberately removed. The sandbox is never weakened to recover from a failure.

---

## The unified router and shared scaffolding

Both card kinds are stored in one `cards` Map keyed by `toolUseId`
(`ui/index.html:1439`), with a `kind` of `'stream'` or `'static'`. A single
`message` listener (`:1798`) handles every iframe-originated event by matching
`event.source` to a card's `iframe.contentWindow`:

- `WIDGET_RESIZE` / `MCP_UI_RESIZE` → set iframe height (the two message names
  are aliased to one case).
- `WIDGET_SEND_PROMPT` → drop the text into the input box (generator widgets
  expose `window.sendPrompt`).
- `WIDGET_OPEN_LINK` → open in a new tab with `noopener,noreferrer`.
- `THEME_REQUEST` → reply with the current theme so the iframe can sync.

Because routing is by source window, the two rendering strategies (self-
reporting scaffold vs. measuring proxy) plug into the same UX layer. A
`finalizedTools` Set gives cross-turn dedup: the same `toolUseId` never renders
twice, even if a stale `mcp_ui` straggles in.

Theme is also pushed proactively: the theme-toggle handler iterates every card
iframe and `postMessage`s a `THEME_CHANGE`, so widget content re-themes live
(`:1100`). The scaffold page resolves `var(--…)` references inside SVGs on load
and on theme change (`buildIframePage`, `:1485`).

---

## Agent text streaming (context, separate from widgets)

`f73e77c` replaced `agent.invoke()` with `agent.stream()`. `textDelta` events
become `agent_stream_start` / `agent_stream_delta` / `agent_stream_end` WS
messages; the UI accumulates them into one message element and uses the
`contentBlockEvent`'s final text as the authoritative content. If nothing
streamed (a tool-only turn), it falls back to `extractText(agent)` sent as a
single `agent` message. This is the text channel; the widget channels ride
alongside it in the same turn.

The recent `helpers.ts` cleanup reinforces the side-channel design: the legacy
`WidgetCache` / `WidgetResult` machinery (which used to *extract* widgets from
the tool's structured `{type:'widget'}` jsonBlock result) was deleted. The
`jsonBlock`-skip in `extractText` is now kept only defensively, because
`widget_renderer` returns a plain string and the HTML no longer flows through
the tool result at all.

---

## Learnings

### 1. Server-authoritative completion beats client-side stream heuristics
The first streaming implementation detected "the widget is done" with
`isWidgetCodeComplete()`, a regex looking for the closing quote of
`widget_code`. That was replaced by trusting the server's `mcp_ui { streamFinal
}` message. Any client-side guess about when a token stream has ended is racing
the producer: a partial JSON payload can momentarily look complete, and a
slow-but-not-finished stream looks identical to a finished one. The only
reliable source of truth for "done" is the component that owns the lifecycle —
emit an explicit transition event from there and have the consumer only ever
*react* to it. *(from commits + code)*

### 2. Deliver generated content through a side channel, not the tool result
The widget HTML is the tool's *input* (`widget_code`), and it reaches the UI
because the AfterToolCall hook reads the same args the model just produced. The
tool *result* is a one-line confirmation. Returning large generated artifacts as
the tool result pollutes two places at once: the visible tool-call bubble, and
— more expensively — the model's own context window on the next turn, where
kilobytes of markup it already authored get fed back with zero reasoning value.
When a tool's purpose is to produce content *for the user* rather than *for the
model*, route it around the model. *(from code)*

### 3. When an adapter has a gap, code the fallback and document its failure mode
The OpenAI chat adapter doesn't populate `contentBlockIndex`, so tool-input
deltas can't be keyed to a specific content block. The code correlates them by
"most recent `toolUseStart`," cleared on `toolUseStop`. This is correct for
serial tool calls and wrong for interleaved concurrent ones — and the comment
says so plainly, including that the Responses API would behave differently
(collapse to one delta). A best-effort fallback is safe to ship and maintain
only when its boundary is named next to it; an undocumented correlation hack
becomes a latent bug the next person "fixes" into a regression. *(from code)*

### 4. Batch streaming DOM writes per-item, with a responsiveness floor
During rapid `tool_input_delta` bursts, naïve per-delta `innerHTML` writes
swamp the main thread. The fix is `requestAnimationFrame` batching — but the
non-obvious requirement is an **immediacy threshold** (100ms): if it's been
that long since the last render, write now instead of queuing, or the UI feels
laggy during gaps in the token stream. The second requirement is that all batch
state (pending payload, RAF id, last-render timestamp) must live on the
*per-card* object. Put it in module-globals and two concurrently-streaming
widgets cancel each other's animation frames. *(from commits)*

### 5. Reuse the framework's connection before standing up a parallel one
`readMcpResource` needs to call `readResource`, which Strands' `McpClient`
doesn't expose — it wraps only tool calls. But `McpClient` exposes the
underlying SDK `Client` via a public `.client` getter, and reaching through it
reuses the single stdio connection the agent already maintains. Before adding a
new transport (a second server instance, an HTTP endpoint, a fresh client),
look for the framework's public escape hatch onto the layer below. One getter
call replaced what would otherwise have been a whole new connection-management
path. *(from code)*

### 6. Encode "absent capability" as a normal value, not an exception
`readMcpResource` returns `null` when the resource doesn't exist or has no text
content. That lets the AfterToolCall hook treat "this tool has no UI" as a
silent skip on the happy path — no try/catch, no branching on error type. When
the absence of something is an expected, common case (most tools have no UI),
modeling it as a nullable return keeps the caller linear; reserving exceptions
for genuine failures makes the real failures legible. *(from code)*

### 7. Different content shapes need different sandbox strategies, unified at the router
A self-authored scaffold page can cooperate: it knows to post its own height.
A loaded full HTML document cannot be trusted to cooperate, so it needs a
nested proxy that measures height *non-cooperatively* (MutationObserver +
polling) from the outside. Forcing one strategy onto both either leaks height
bugs or adds cooperation contracts to untrusted content. The unifying move is
to make the consumer agnostic: route iframe messages by `event.source` rather
than by card type, alias the two resize message names, and let each card kind
plug its own iframe strategy into one shared map. *(from code)*

### 8. Never weaken isolation to recover from a failure — degrade inside it
The proxy's old timeout fallback stripped the `<iframe>` `sandbox` attribute and
loaded the HTML raw, on the theory that a broken-but-visible widget beats a
blank. That was a genuine security escape hatch: removing `sandbox` to recover
from a load failure hands the untrusted content exactly the privileges the
sandbox existed to withhold. The replacement keeps the sandbox intact and shows
an in-sandbox "failed to load" message. A recovery path that disables a safety
control is worse than no recovery — when you find one, the fix is to fail
*within* the constraint, not around it. *(from code)*
