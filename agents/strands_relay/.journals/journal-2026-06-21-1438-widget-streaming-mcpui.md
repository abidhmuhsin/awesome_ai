# Journal Entry — 21-Jun-2026

## widget_renderer as a streaming MCP UI app — unify delivery without migrating the tool

The app had two parallel pipelines that did the same thing — render untrusted HTML in a sandboxed iframe inside the chat: a mature, streaming **widget renderer** (Strands tools, MD5 dedup, theming scaffold) and a newer, static **MCP UI sandbox** (MCP tools ship a UI resource, rendered through a nested proxy). This change makes `widget_renderer` behave as an MCP UI app by routing its output through the unified renderer, preserves streaming, and collapses the two pipelines into one client map keyed by `toolUseId` — **without moving or re-registering any tool**. The key realization: streaming is a model-layer capability and the after-tool hook fires for every tool regardless of registration, so the "conversion" is purely about delivery and rendering.

Sources: chat transcript (design + planning + implementation) + the staged diff (4 files, +266/−397).

---

### The no-migration insight (the central design pivot)

The request — "convert widget renderer into an MCP UI app" — reads as a *migration*: move `widget_renderer` + `widget_instr` into the MCP server so they're delivered like `hellomcp-ui`. A first plan proposed exactly that (new MCP tool files, edits to `factory.ts`, deletions in `src/tools/`).

That plan was rejected and rewritten when it turned out the desired capability doesn't require the migration at all. Three framework facts, confirmed by reading `node_modules`, collapse the scope to zero file moves:

- **Streaming is model-layer.** `toolUseInputDelta` is the model's own `partial_json`; it fires for any tool, Strands or MCP. Streaming is therefore independent of tool *registration*.
- **The after-tool hook is universal.** `AfterToolCallEvent`/`BeforeToolCallEvent` fire for every tool (they already fire for Strands tools like `hello`/`byebye`). So a hook can deliver `widget_renderer`'s HTML as an `mcp_ui` message with no registration change.
- **The tool args are already-parsed JSON by hook time.** The SDK `JSON.parse`s the model's tool input before the event fires, so the HTML is available on `event.toolUse.input.widget_code` — no separate transport needed.

The "conversion" becomes: change what the hook *delivers*, and unify what the client *renders*. `src/tools/widget-renderer.ts` stays where it is; its only edit is to return a short confirmation string instead of a JSON blob.

### `widget_renderer` returns a string instead of a JSON result

Previously the tool returned `{ type: 'widget', title, widget_code }` (a `jsonBlock`), and the client rendered from the *result*. Now that the HTML comes from the *args* (via the hook), the result is just a clean confirmation — `Rendered widget: <title>` — so the tool-call bubble isn't polluted with raw HTML. The `jsonBlock`-skip in `extractText` becomes dead code, left defensively with a comment.

### Server-side streaming correlation by active toolUseStart

Deltas now carry `toolUseId` + `tool` so the client can route each chunk to the right progressive-render card. The transport tracks an `activeToolUse: { id, name }` — set on `toolUseStart`, cleared on `toolUseStop` — and tags each `toolUseInputDelta` with it. This mirrors the SDK's own single-accumulator model (it can't demultiplex two interleaved tools either), so concurrent streaming is honestly best-effort: if a provider interleaves two tools' deltas in one turn, the SDK's parse and our stream degrade together. A comment notes the Responses API would collapse all tool input into a single delta, silently ending progressive render.

### Server-authoritative finalize

The iframe swap now happens *exclusively* on the server's `mcp_ui { streamFinal: true }` message. The client's old closing-quote heuristic — which walked the accumulating JSON guessing when `widget_code` was complete, with its own escape handling — now drives the *preview only* and was deleted (`isWidgetCodeComplete` + the JSON-walking finalize are gone). `finalizeCard` is idempotent on `toolUseId`, so whichever of (preview stops) / (server finalize arrives) comes first is fine. This also eliminates the divergence between the client's `decodeJsonString` and the server's `JSON.parse` for the *final* render.

### Unified client renderer — one map, per-card state

The two client pipelines (a `widgets` Map + an `mcpUiIframes` Map, two message-router branches, two resize/theme handlers) collapse into **one `cards` map keyed by `toolUseId`** and **one message router**. A card is one object holding all per-widget state — DOM refs, accumulated JSON, RAF id, pending render, finalized flag, and a `kind` of `stream` or `static`. `streamDelta` lazily builds a progressive-render card; `finalizeCard` swaps it to the sandboxed scaffold iframe; `renderStaticCard` renders full-doc MCP UIs through the nested proxy; `abortStreamingCards` cleans up cards orphaned by a stream error or a new turn.

All requestAnimationFrame batching state moved from module-globals (`_rafId`/`_pendingRender`) onto the per-card object.

### Proxy hardening + error-path finalization

Two robustness fixes fell out of the unification:

- **The proxy's timeout fallback no longer strips the sandbox.** The old recovery path did `removeAttribute('sandbox')` then `srcdoc = html` — rendering the untrusted HTML unsandboxed to "recover" from a missed handshake. On timeout it now keeps the sandbox and shows a safe in-sandbox error.
- **Error-path finalization.** A stream error (e.g. malformed tool JSON throwing a `SyntaxError` mid-stream) aborts the turn with no finalize. On any `error` message, every open streaming card is finalized-or-marked-failed so none is left dangling on "BUILDING…".

### What got deleted

- `createWidgetCache`, `WidgetResult`, `WidgetCache`, the `createHash` import, and the post-stream `extractWidgets(agent)` scan (`helpers.ts` + `websocket.ts`). The MD5 content-hash dedup is replaced by a `Set<toolUseId>` that's never cleared — `toolUseId` uniqueness inherently handles the cumulative-history re-delivery that the MD5 cache existed to suppress.
- `isWidgetCodeComplete` and the JSON-walking finalize.
- `appendWidget` / `appendMcpUi`, the streaming globals (`activeStreamWidget` etc.), `streamedWidgetTitles`, and the second message-router branch.
- The dead `widget` message type on the wire.

### Verification status (honest)

`npx tsc --noEmit` is clean; the client's inline JS parses (`node --check`); no orphaned references to removed symbols remain; the server boots cleanly on a fresh port (Express + WS + MCP child spawn) and serves the new (smaller) `index.html`. **The live streaming → `mcp_ui{streamFinal}` message flow was not observed end-to-end** — the WS probe script failed on a missing module right as the prior conversation hit its context limit. Single-widget streaming, static-UI rendering, and the concurrent/dedup paths remain to be confirmed against the real model.

> *Update (later, same day) — closed; see the **Follow-up** section below. Short version: the flow runs end-to-end and the refactor is sound. But the same trace that confirmed correctness also showed the configured provider never streams tool input, so progressive streaming is dormant under it — the feature's headline capability depends on a provider that actually chunks `function.arguments`.*

---

### Follow-up — end-to-end verification (21-Jun-2026, later)

The flagged verification gap was closed by replaying the full path against the live model: **raw SSE from the provider → server WS messages → headless-browser DOM.** The verdict inverts the original worry — the refactor is *not* broken, the widget renders correctly — but the trace surfaced a fact that reframes the entire feature.

**The configured provider does not stream tool arguments.** A raw SSE probe against `glm-5.2` (local proxy at `localhost:8080`) shows the tool call arriving in two chunks: the first carries `id` + `function.name` + `"arguments":""` (empty), the second carries the *entire* `arguments` JSON (a full ~6 KB SVG) in one fragment. The model computes the complete tool call, then emits it at once. The SDK therefore fires exactly **one** `toolUseInputDelta`, the server sends exactly **one** `tool_input_delta` (measured: `deltas=1`, ~2.8 KB), and there is nothing for the progressive renderer to progressively render — the "BUILDING…" preview flashes for a single frame before the `mcp_ui{streamFinal}` swap. Streaming widget HTML is impossible with this provider regardless of client/server code.

This reconciles the "it streamed before" report: the old code forwarded the *same* `tool_input_delta`, so under this provider it too received a single delta and never truly streamed. The earlier progressive behavior came from a provider that emits `function.arguments` token-by-token (e.g. the OpenRouter `deepseek` profile still commented in `.env`). The regression tracks the provider switch, not the refactor.

**What the trace confirmed works** (closing prior unknowns):
- The `activeToolUse` correlation (see Learning #3) is correct — the OpenAI chat adapter *does* emit `toolUseStart` with `id` + `name`, so deltas are tagged with the right `toolUseId`.
- The server delivers `tool_input_delta` and `mcp_ui{streamFinal}` keyed by the **same** `toolUseId`; the client matches them and the finalize is idempotent.
- Final iframe render verified in headless Chromium: streaming card `finalized`, iframe `srcdoc` set (~5.8 KB), `WIDGET_RESIZE` applied → 474 px tall, visible. No orphaned cards.

**Two latent renderer bugs surfaced** (pre-existing — *not* introduced by this refactor; both reproduced in the browser console):
1. `buildIframePage`'s inline `<head>` script calls `new MutationObserver(...).observe(document.body, …)`, but inline head scripts execute before `<body>` exists, so it throws `parameter 1 is not of type 'Node'` on every render. It only doesn't break the widget because that line is last and the `load`/`DOMContentLoaded` handlers are already registered by then.
2. `finalizeCard` dereferences `card.iframe.srcdoc = …`, but only the `if (!card)` branch calls `buildStreamCardDom`. If a `streamDelta` created the card object yet the title never parsed before `mcp_ui` arrives (title split across deltas, or empty title), `card.iframe` is `undefined` and the assign throws — silently dropping the render. It doesn't fire on the one-chunk provider (title parses immediately) but would bite a genuinely streaming one.

---

## Learnings

### 1. The capability a request names is often achievable without the migration the name implies

*(from conversation)*

"Convert widget renderer into an MCP UI app" framed the work as a migration — relocate the tool into the MCP server. But the actual goal — a unified render pipeline that keeps streaming — needed **zero file moves**, because streaming is model-layer and the after-tool hook fires for every tool regardless of registration. The architectural axis the request named (MCP vs Strands *tool*) was orthogonal to the real duplication (two *render pipelines*). Before committing to a migration, identify which layer the desired capability actually lives at; "make X behave like Y" frequently reduces to routing and delivery, not relocation.

### 2. When an architectural decision hinges on framework behavior, confirm it in the implementation source

*(from conversation)*

The entire smaller-scope plan rested on three framework facts — streaming is model-layer, the after-tool hook is universal, and tool args are parsed JSON by hook time. Each was confirmed by reading `node_modules` (`streaming.d.ts`, `model.js`), not by trusting docs or examples. A migration plan built on an assumption about "how the SDK must work" would have been far larger than necessary. When a refactor's size turns on a framework guarantee, read the implementation to verify it before planning around it.

### 3. A high-level stream API can expose an identity field that your adapter never populates

*(from conversation + diff)*

`ModelContentBlockDeltaEvent.contentBlockIndex` exists on the event type but is **not populated by the OpenAI chat adapter**, so two concurrent tool streams can't be told apart by index. The working fix was to correlate by "most recent `toolUseStart`, cleared on `toolUseStop`" — deliberately mirroring the SDK's own single-accumulator model rather than inventing an index map. When multiplexing concurrent streams over a callback API, verify the correlation field is actually filled by *your* adapter; if it isn't, copy the framework's own correlation strategy instead of building a parallel one that will silently misattribute interleaved events.

### 4. When client and server both parse the same streaming bytes, make one authoritative and demote the other to non-load-bearing preview

*(from conversation + diff)*

The old client guessed widget completion by walking the JSON for a closing quote, with its own escape handling — which inevitably diverged from the server's `JSON.parse`. Making the server authoritative for the final iframe swap (the swap happens only on the server's `streamFinal` message; the client heuristic now affects only the live preview) deleted `isWidgetCodeComplete` and an entire class of escape-handling bugs. When two sides both derive structure from the same partial bytes, one is the source of truth; do the irreversible state change on its event and let the other be cosmetic.

### 5. Module-global batcher state is a latent concurrency bug — make per-instance state the default

*(from conversation + diff)*

The global requestAnimationFrame batcher (`_rafId` / `_pendingRender`) clobbered concurrent widgets because two cards shared one pending-render slot — a hidden bug that only surfaces with two widgets in one turn. Moving all RAF state onto the per-card object fixed it. Any "currently active X" singleton or global render-queue is a concurrency bug waiting for its second instance; default to per-handle / per-key state, and only share global state when you can prove there's ever just one.

### 6. A recovery path that disables a security control is worse than no recovery path

*(from conversation + diff)*

The proxy's timeout fallback stripped the `sandbox` attribute and rendered the untrusted HTML raw — an escape hatch that defeats the entire reason the sandbox exists, triggered precisely in the failure case where you most want containment. The fix: on timeout, keep the sandbox and show a safe in-sandbox error. Never let error recovery turn off the control the feature is there to provide; a failed-but-sandboxed state beats a recovered-but-unsandboxed one.

### 7. Replacing a content-hash dedup with a natural unique id deletes the hash and its edge cases

*(from conversation + diff)*

The old `createWidgetCache` deduped widgets by `MD5(title + code)` to suppress cumulative agent history re-delivering old widgets each turn — and carried the "same title, different code ⇒ update" rule as a side effect. Once delivery was keyed by `toolUseId`, a `Set<toolUseId>` (never cleared) replaced all of it, because per-call uniqueness handles cumulative history for free. When a dedup hash exists mainly to work around a transport that re-delivers, route on a stable per-call id instead; it removes the hashing, the reset lifecycle, and the false-positive/negative edge cases of content comparison.

### 8. Static gates passing is not "verified" — the end-to-end message sequence is the real test

*(from conversation)*

Typecheck clean, client syntax clean, server boots, assets serve — all green — yet the live streaming → finalize flow was never observed (the probe failed on a missing module at the context limit). A refactor over a streaming control flow is only verified once the actual message sequence has been watched crossing the wire: compile and boot prove the code loads, not that the two halves agree at runtime. Treat the end-to-end trace as the gate that closes the feature, and don't let green static checks stand in for it.

> *Update (later, same day) — the trace was finally watched, and this learning held up in an unexpected way: the flow was correct, but the same trace overturned the feature's premise (Learning #10). The gate didn't just pass/fail the implementation; it re-discovered what the feature actually does in production.*

### 9. A "streaming" feature's value is gated by upstream chunking you don't control — verify the wire before building the UX

*(from conversation)*

The entire progressive-render UI was built on the assumption that `widget_code` arrives in many small deltas. The provider emits the whole tool input — the full `function.arguments` JSON — in a single SSE chunk, so the UI flashes "BUILDING…" for one frame and swaps; the streaming animation never plays. Whether a streaming feature actually streams is decided by the provider's chunking of that one field, which varies by model/proxy and isn't yours to command. Before investing in progressive-render UX, capture the raw transport (SSE/websocket) and confirm the field is chunked the way the UX assumes — otherwise you ship correct code over a one-shot delivery and the headline capability is silently dormant.

### 10. Closing the verification loop can overturn the feature's premise, not just confirm the implementation

*(from conversation)*

The flagged-as-unverified flow was re-run end-to-end and it worked — the refactor was fine. But the trace that confirmed correctness also revealed the provider never streams tool input, meaning the feature's marquee capability (live progressive rendering) is inactive under the configured model. Verification is not binary (works / broken): the act of watching the real message sequence can surface a premise-level fact the design was built without. Treat an end-to-end trace as a way to re-discover what the feature *actually does* in production, not merely as a pass/fail gate on the code you wrote.

### 11. Don't touch `document.body` from an inline `<head>` script — it runs before the body exists

*(from conversation + browser console)*

The scaffold page's resize-on-mutation setup threw on every load because it ran in `<head>`, where `document.body` is still `null`. Inline scripts execute in parse order at the point the parser reaches them; anything in `<head>` runs before `<body>` is constructed. Defer DOM-touching setup to `DOMContentLoaded` (or move the script to the end of `<body>`). This one survived only by accident — the throwing line came last, after the load handlers were already bound, so the next person to add code above it would inherit a broken page with no clue why.

### 12. When an object is built lazily, a function that dereferences its parts must build them on every entry path

*(from conversation + diff)*

`finalizeCard` trusted `card.iframe` to exist, but only the *create-card* branch built the DOM; the "card already exists from streaming" branch skipped the build. So any path where the card exists-but-unbuilt (title parsed late) dereferenced `undefined` and threw. When state is assembled lazily and a later step reaches into its parts, either build the parts unconditionally at first-touch or guard every dereference — the lazy construction has to be idempotent across *all* the ways the object can arrive, not just the one that created it.
