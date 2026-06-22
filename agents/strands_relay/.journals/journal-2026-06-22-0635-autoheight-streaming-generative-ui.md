# Journal Entry — 22-Jun-2026

## Auto-height & Progressive Scroll for Streaming Generative UI

When the live widget preview moved out of the parent page DOM and into a sandboxed iframe — so that model-generated partial HTML never executes in the app's own context — the iframe needed its own height and scroll story. A `<div>` had sized itself through normal document flow; an iframe will not. This entry documents the auto-height and progressive-scroll work that followed from that shift: parent-owned collapse→measure→set sizing, scroll preservation across the resize tick, eased auto-follow with direction-based user detection, and render throttling. Each capability was pulled into existence by a distinct failure mode that only appeared once content was streaming into the frame.

Source: a single iteration session on `ui/index.html` (chat transcript + resulting unstaged diff; no other files referenced).

---

### 1. The preview surface became the sandbox iframe

The streaming widget preview used to render into a plain `<div>` in the parent page, with the sandboxed iframe created only at finalize and hidden until then. That meant every byte of partial, model-generated HTML — `<script>`, broad `<style>`, `onerror=` handlers, malformed tags — executed in the app's own document while streaming. The fix was architectural rather than a new file: reuse the same scaffold iframe already used at finalize, and write partials into its `contentDocument.body` instead of reloading srcdoc on every frame. This keeps the per-frame write cheap (no frame reinstantiation), makes preview visually identical to final (same scaffold document), and leans on the fact that scripts inserted via `innerHTML` don't execute — acceptable for a preview, since finalize still loads the authoritative srcdoc that runs them. A dedicated streaming-sandbox proxy file was considered and rejected as overkill; tightening the frame's `allow-same-origin` policy was deliberately deferred to a later phase.

### 2. Parent-owned auto-height — collapse → measure → set

Once the iframe was the surface, it had to size itself to its partial content every frame — something a div never needed. The naive approach (read the body's height at the current iframe height, then set the iframe to that value) produced unbounded vertical growth: any content whose height references the viewport (`height:100%`, `vh` units, document-element rounding) reads taller each cycle → set taller → reads taller again. Finalize never exhibited this because it measures once; streaming measured on every delta, so the loop ran live. The cure is structural: drop the iframe to height 0 first, so viewport-coupled content resolves to its true intrinsic height; read the content height; then set. To make this clean, the parent became the sole owner of stream-card height — the frame's own resize reports are ignored for stream cards (they measure at the live height and would re-trigger the loop), and the CSS `min-height` that would have clamped the zero-height collapse step was removed in favor of a JS floor applied only at the final set.

### 3. Scroll preservation across the resize tick

The collapse-to-zero runs on every streaming frame, and that mid-tick drop in the chat's `scrollHeight` lets the browser clamp `scrollTop` upward — each render yanked the view toward the top, and once the reader drifted past the near-bottom threshold, auto-scroll stopped firing entirely (manually scrolling down just got re-yanked on the next frame). The fix brackets the resize with save/restore: capture `isNearBottom()` and the current `scrollTop` before collapsing, then after setting the height either re-pin to the bottom (if the reader was following) or restore the exact prior position. This is safe because the entire collapse → measure → set → restore is one synchronous tick — layout reflows at zero, but no paint occurs there, so the collapse is invisible.

### 4. Eased follow + direction-based user detection

Re-pinning to the bottom on every frame read as discrete jerk, because the bottom itself moves every frame. Replacing the snap with an ease — move a fixed fraction (≈40%) of the remaining distance toward the bottom per animation frame, self-sustaining until it converges — produced a smooth glide. The harder problem was deciding when to *stop* following. The first instinct — bail when no longer "near the bottom" — is wrong for streaming: content growth itself pushes the gap past the threshold on every render, so the ease bailed immediately and follow died. A threshold cannot distinguish "the widget grew" from "the user scrolled up." The robust signal is direction: the ease only ever increases `scrollTop`, so if `scrollTop` decreased since the last step, a human intervened — bail then. That cleanly separates programmatic follow from user intent.

### 5. Render throttling as a perceptual lever

Separately from height and scroll, the partial preview itself flickered: rendering on every delta rebuilt the partial HTML and reflowed the frame document at up to 60fps, so half-written tags visibly jumped as they completed. Capping renders to a steady cadence (≈20fps via a `requestAnimationFrame` time-gate) smooths this — not by saving CPU, but by giving each partial fewer, coalesced moments to settle. The latest partial is always held and never lost; only the write rate is gated. A finalized guard was added so a render scheduled just before finalize can't overwrite the final widget.

---

## Learnings

### 1. Auto-sizing an element by measuring its content at its current height is a feedback loop
*(from conversation)*

Reading an element's content height at the height it's currently rendered at, then setting the element to that height, is self-reinforcing for any content whose dimensions reference the viewport — it reads taller, you set taller, it reads taller again, without bound. The loop is invisible in a one-shot measurement (like a final render) and only bites when measurement repeats on a growing stream. The cure is structural: collapse the element to zero before measuring so viewport-coupled content resolves to its intrinsic size, then set. Apply any minimum only at the final assignment, never at the intermediate collapse — a floor that survives the collapse step silently reinstates the loop.

### 2. A synchronous tick hides every intermediate layout state
*(from conversation)*

Collapsing an element to zero, reading its height, and restoring the original — all within a single synchronous function — produces no visible flash at the collapsed size. Style changes made inside a tick batch together and don't paint until the function returns; only the final state is ever rendered. This is what makes destructive-then-restorative measurement safe: you can momentarily put the DOM into a "wrong" state to read a value, so long as you leave it correct before yielding. It's the reason collapse → measure → set can run live on every frame without the user ever seeing the collapse.

### 3. To distinguish a user from a program, watch direction, not distance
*(from conversation)*

A "near the bottom" threshold is the obvious way to decide whether to keep auto-scrolling, and it breaks the moment the content itself is growing. Growth constantly pushes the reader past the threshold, so the heuristic can't tell "the user scrolled away" from "new content arrived." The robust signal is the direction of change: if a value you only ever increase programmatically has decreased since your last step, a human touched it. Programmatic motion is monotonic; user intervention isn't. Detecting direction lets auto-follow survive content growth while still yielding the instant a reader scrolls up.

### 4. Latent assumptions surface when you change the container
*(from conversation)*

A MutationObserver wired to `document.body` from a script in the document head silently failed — `document.body` is null while head scripts run. It never mattered while the preview was a div that sized itself through normal flow; the moment the container became an iframe that needs an explicit resize, the dead observer meant nothing ever got measured and the stream stayed clipped to an empty-body height. Code that "always worked" is often riding on an assumption the old container satisfied for free. Swapping the container (div → iframe, or any equivalent) is exactly when those free-ride assumptions surface — and a silent failure in wiring that nothing depended on before becomes the active bug.

### 5. Snapping to a moving target reads as jerk; chasing a fraction reads as glide
*(from conversation)*

When the destination itself moves every frame — the bottom of a chat whose content is still streaming — setting `scrollTop` to the exact bottom each frame produces visible discrete jumps, because each frame snaps to a position that's already stale. Moving a fixed fraction of the remaining distance per frame instead chases the moving target continuously and self-sustains until it converges. The target's motion and the easing motion combine into perceived smoothness; a hard snap can't achieve that no matter how fast it runs.

### 6. Render cadence is a perceptual lever, not a throughput lever
*(from conversation)*

Throttling how often you rewrite a progressively-built document smooths perceived flicker for reasons that have little to do with CPU cost. The flicker comes from incomplete markup — half-written tags completing cause layout jumps — and rewriting at the frame rate just re-exposes that half-built state more often. Coalescing writes to a steady, lower cadence gives each partial a moment to settle before the next overwrite. Crucially, the latest content is held and applied at the next gate, so throttling costs no information — it only changes how often the unstable intermediate is shown.

### 7. A measured dimension can have only one owner
*(from conversation)*

When the parent measures an iframe's content to drive that iframe's height, the frame's own height reports become a hazard: they measure at the live (feedback-coupled) height and, if honored, re-trigger the exact loop the parent's collapse-measure-set was built to break. Two systems driving the same dimension under different measurement regimes fight each other. The resolution is single ownership: the parent owns the dimension for the case that needs the collapse dance, and competing reports from inside the frame are ignored for that case alone — while remaining active for other cases (like static cards) where they are the correct owner.
