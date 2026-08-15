# Journal Entry — 02-Aug-2026

## Generative UI — sandboxed iframe rendering for LLM-generated HTML/SVG

The `pi_generative_ui` agent renders widgets (HTML/SVG emitted by an LLM) into
the host chat page. That content is untrusted and dynamic — an LLM-produced
`<script>` or `<img onerror=…>` in the host document would have full access to
the chat app, cookies, and `/api`. The solution is a per-widget **sandboxed
`<iframe>` loaded via `srcdoc`** that is fully isolated from the host by a
**null origin**, with a **CSP** baked into the `srcdoc`, communicating with the
host only through a narrow **`postMessage`** bridge.

The design was chosen empirically. A standalone **`.demo/` comparison harness**
renders the *same* widget into five differently-sandboxed iframes at once
(approaches A–E), gives each a "probe parent" button, plants canary secrets in
the parent's `localStorage`, wraps `parent.fetch` and
`parent.localStorage.getItem` so breaches surface in a global log, and uses a
`hostile.html` probe widget (`<img src="x" onerror="probe()">`) to codify the
threat model. The production runtime (`agents/pi_generative_ui/ui/widgets.js`
+ `widget-host.js` + `ui/app.js`) ships the winner. This entry walks through
**how each approach was considered and concluded**, then distills the
learnings.

The shipped git history shows the evolution concretely: an early commit
landed the throttled-srcdoc approach (C), and a later "polish widget iframe
pipeline" commit replaced it with the postMessage/innerHTML hybrid (E) —
*“Kill infinite rAF height loop… Throttle streaming srcdoc rewrites to
50ms… Authoritative finalize: commit()/finalize() do one srcdoc write.”* So
the team actually lived through C's drawbacks in production before E replaced
it, and the demo was built to settle the C-vs-D-vs-E question with evidence
rather than argument.

---

## How each approach was considered and concluded

The central design problem has three pulling forces that don't jointly have an
obvious answer:

1. **Isolation** — the untrusted widget must not reach the parent (no
   `parent.document`, `localStorage`, cookies, `fetch`).
2. **Cheap streaming** — LLM tokens arrive faster than paint; per-token work
   must not reload the document or swamp the main thread.
3. **Scripts must run** — but exactly once, against the complete DOM, never
   against a half-written partial.

The naive options each satisfy two of the three and fail the third. The demo
enumerates them as A–E and lets the breach log decide.

### Approach A — same-origin + `innerHTML`  (REJECTED: insecure)

- **Idea.** `sandbox="allow-scripts allow-same-origin allow-forms"`. The
  parent streams the widget by writing
  `iframe.contentDocument.body.innerHTML` per delta. Because the parent and
  iframe share an origin, the parent can reach across and write the body
  directly.
- **Pros.** Cheap streaming (no reload), and `innerHTML` doesn't run
  `<script>` mid-stream.
- **Why it fails.** `allow-same-origin` makes the iframe share the parent's
  origin, so the untrusted widget *is* the host — it can read
  `parent.localStorage`, call `parent.fetch('/api/chat')` as the user, and
  scribble on `#input`. The demo plants `demo_session_token` /
  `demo_user_id` in the parent, and approach A's probe reads them every time.
  In the harness UI, A is tagged `tag-bad` with the `allow-same-origin` token
  glowing red and pulsing — it's the reference for "what not to do."
- **Conclusion.** Rejected outright. The whole point is that LLM output is
  untrusted; giving it the host's origin defeats the exercise.

### Approach B — null-origin + `srcdoc` rewritten every tick  (REJECTED: flicker + script re-runs)

- **Idea.** `sandbox="allow-scripts allow-forms"` (**no** `allow-same-origin`,
  so the frame gets a null/opaque origin). On every token, rewrite
  `iframe.srcdoc` with the growing partial.
- **Pros.** Strong isolation — the frame can't reach the parent at all. The
  demo's probe shows every `parent.*` call throw a `SecurityError`.
- **Why it fails.** Assigning `srcdoc` reloads the *entire document* on every
  delta: visible flicker, scroll/selection lost, and every `<script>` re-runs
  on every tick against whatever partial DOM exists at that moment. At a fast
  token stream that's tens of full document reloads per second. In the harness
  UI, B is tagged `tag-warn` with props `parent unreachable / reload per delta
  / scripts re-run`.
- **Conclusion.** Rejected. Isolation is right, but the streaming UX is
  unusable; this is the naive version of "just use a null-origin iframe."

### Approach C — null-origin + **throttled** `srcdoc`  (SHIPPED FIRST, then superseded)

- **Idea.** Same null-origin sandbox as B, but don't write `srcdoc` per token:
  buffer the latest partial, schedule a `requestAnimationFrame`, and only
  assign `srcdoc` when `ts - lastTs >= 50ms` (latest-wins). At finalize, write
  the authoritative full document once so styles apply and scripts run against
  the complete DOM.
- **Pros.** Keeps B's isolation, collapses a token burst into ≤20
  `srcdoc` writes/sec, and the finalize is a single authoritative load.
- **Why it was superseded.** It's still a **full document reload** per flush.
  20 reloads/sec of a growing document still flickers and re-runs scripts; the
  throttle makes it tolerable, not good. The commit that introduced the
  throttle is literally titled *"Throttle streaming srcdoc rewrites to 50ms
  (rAF-gated, latest-partial buffer) to coalesce rapid deltas and remove
  flicker"* — i.e. this was the first attempt at fixing B, and it only
  *reduced* the symptom. The same commit also had to add *"Kill infinite rAF
  height loop; event-driven reporting via ResizeObserver/MutationObserver"*
  and *"Authoritative finalize: commit()/finalize() do one srcdoc write so
  scripts run once against complete DOM"* — each of those is a patch on a
  symptom of "we're reloading the document during streaming." The demo tags C
  `tag-good` but its props are still `coalesced reloads / ≤20 reloads/sec` —
  *reload*, not *render*.
- **Conclusion.** Shipped as the first production approach, then replaced by E
  once it became clear the throttle was papering over the wrong problem
  (document reloads), not solving it.

### Approach D — same-origin stream → null-origin finalize  (REJECTED: vulnerable mid-stream — the trap)

- **Idea.** The "best of both worlds" that tempts everyone: stream into a
  same-origin iframe via `innerHTML` (cheap, like A), then at finalize swap to
  a fresh null-origin iframe (isolated, like B/C). Get A's cheap streaming and
  B's isolation.
- **Why it fails — the decisive finding.** `innerHTML` does **not** execute
  `<script>` tags, but it **does** fire event-handler attributes like
  `<img src="x" onerror="probe()">` the instant the partial is inserted. That
  handler runs **during streaming, while the frame is still same-origin** — so
  the hostile probe reaches `parent.document`, `parent.localStorage`, and
  `parent.fetch` *before* the finalize swap ever happens. The demo's
  `hostile.html` is exactly this attack, and approach D's global log fills
  with red `REACHED PARENT` lines on its own auto-probe-on-load. The harness
  UI spells it out in the card description: *"Watch the global log: an
  `onerror` in the partial reaches the parent during streaming, before the
  swap."*
- **Why this matters.** Approach D is the design you'd arrive at by pure
  reasoning ("innerHTML is safe, and we isolate at the end") and it's
  *wrong*. It's the case the harness was built to expose: a subtle timing
  property — "is this frame ever same-origin while untrusted content is
  live?" — that's easy to hand-wave away in a design doc and easy to prove
  with a one-line hostile payload.
- **Conclusion.** Rejected. The frame must be null-origin from byte zero; any
  window where untrusted HTML runs same-origin is exploitable.

### Approach E — null-origin shell + `postMessage`/`innerHTML`  (ACCEPTED — shipped)

- **Idea.** Load a null-origin `srcdoc` **shell** exactly once (CSP + theme
  tokens + a bridge script that listens for `render`/`run-scripts` messages).
  During streaming, `postMessage` the latest partial to the frame, which
  applies it with its own `#viewport.innerHTML`. At commit, send a final
  `run-scripts` message; the bridge clones each `<script>` node and replaces
  the original so they execute exactly once against the complete DOM.
- **Why it wins on all three forces.**
  - *Isolation:* the shell is null-origin from byte zero — the same
    `onerror` that exposes D still fires, but in a null-origin context where
    every `parent.*` throws. (The demo's approach-E probe confirms this:
    every `parent.*` call reports `✓ blocked`.)
  - *Cheap streaming:* no document reload — only `#viewport.innerHTML` of a
    single subtree, throttled with the same rAF + 50ms coalescing as C. The
    difference vs C is that each flush is a subtree repaint, not a document
    reload.
  - *Scripts run once:* deferred to the explicit `run-scripts` commit, never
    during partials, so they always see the final DOM.
- **Conclusion.** Accepted and shipped. It's A's cheap streaming + B/C's
  isolation, with D's hole closed because the frame was never same-origin.
  The harness tags E `tag-good` with props `parent unreachable / cheap stream
  (no reload) / no mid-stream scripts`.

### The verdict, and how the harness enforced it

The five approaches reduce to one decision tree: **is the frame ever
same-origin while untrusted HTML is live?** A is always same-origin (reject).
D is same-origin during streaming (reject — the trap). B, C, E are null-origin
throughout. Among those three, the only question is *how the body gets into
the frame during streaming*: rewrite the whole `srcdoc` (B = per-tick reload,
C = throttled reload) vs. `postMessage` into a stable shell and `innerHTML`
the viewport (E = no reload). The harness makes the reload-vs-render
distinction visible in the per-card log ("reload tick N" vs "stream tick N
(innerHTML, throttled)") and the global breach log makes the security
distinction visible (red vs green). The shipped code is E; C is preserved in
git history as the approach that *almost* worked and taught the team what
"cheap streaming" actually requires.

### Approaches not considered: a separate origin / subdomain

A sixth option was consciously set aside: serve widgets from a **separate
origin or subdomain** (e.g. `widgets.app.com`) and embed *that* via a URL
iframe with `allow-same-origin`. Cross-origin framing does provide real
isolation — the frame can't read the parent's cookies, DOM, or `localStorage`
— so on a pure security axis it would have passed the demo's breach log.

**The actual reason it wasn't taken: deployment simplicity, for now.** A
separate origin means standing up a real host: TLS, a serving endpoint, CSP
*headers*, CORS, and cookie-scope discipline. The widget content here is
LLM-generated in the host process and ephemeral until "save" — there's
nothing to serve from a subdomain during streaming, and no ops story for a
second origin yet. `srcdoc` needs zero of that: the shell is a string the
parent assigns, isolation is stronger (null origin, not merely a different
real origin), and there's no second deployment to run, secure, or reason
about. The decision was deliberately "ship the simpler, more-isolating thing
now; revisit a subdomain only if a real requirement forces it."

### What the subdomain pattern would buy (its real advantages)

Setting "deployment simplicity" aside, a separate-origin host is not just a
worse E — it has genuine capabilities the `srcdoc`/null-origin pattern cannot
match, and several are security *wins*, not just features:

- **Server-controlled security policy.** With a real origin you set CSP,
  `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`,
  `Cross-Origin-Resource-Policy`, and `Trusted Types` via **HTTP response
  headers**, which are strictly more powerful than the `<meta>` CSP an
  `srcdoc` shell can carry. Several directives can't be set via `<meta>` at
  all (`report-uri`/`report-to`, `Trusted Types` enforcement, framing and
  embedder policies). A header-based policy is also harder for a buggy parent
  to forget or mis-string-escape.
- **Defense against a compromised parent.** A null-origin `srcdoc` frame
  trusts the parent that spawned it unconditionally — if the host page is
  XSS'd, the attacker controls the shell string and the bridge. A separate
  origin with its own CSP and framing policy can *refuse* to be embedded by
  an unexpected parent (`frame-ancestors`) and enforce its own rules
  regardless of who frames it. This is the only option on the table that is
  resilient to host compromise.
- **A real, addressable origin for the widget.** The frame gets its own
  `localStorage`, its own cookies, and its own authenticated session — so a
  widget can persist preferences, log into a widget backend, or hold an OAuth
  grant *without* routing everything through the parent bridge. The
  `postMessage` storage proxy in the current design exists precisely because
  the null-origin frame has no storage of its own; a subdomain removes that
  constraint.
- **Shareable, cacheable, CDN-served widget URLs.** A widget at
  `https://widgets.app.com/<id>` can be linked, embedded elsewhere,
  cache-busted, served from a CDN, and pre-rendered server-side. The current
  `srcdoc` shell is a private string between one parent and one frame — it
  has no URL to share.
- **Independent lifecycle / scaling.** Widget rendering becomes a service
  with its own deployment cadence, its own load profile, and its own failure
  isolation from the host app. An `srcdoc` shell is coupled to the host
  page's process.

Two of these are pure security advantages (header policy power, host-compromise
resilience); the rest are capability/operational wins that the current design
explicitly forgoes.

### Current pattern vs subdomain pattern

| Aspect | **Current: `srcdoc` + null origin (E)** | **Subdomain: URL iframe + real origin** |
|---|---|---|
| Isolation model | Null/opaque origin — frame has *no* origin | Cross-origin — frame has a *different* origin |
| Strength of isolation | Stronger: can't inherit domain cookies, has no storage of its own | Real but weaker: inherits any cookie scoped to bare domain; has its own origin to abuse |
| Policy mechanism | `<meta http-equiv=CSP>` in `srcdoc` (limited directives) | HTTP response headers (full policy power: COOP/COEP/CORP, Trusted Types, report-uri, frame-ancestors) |
| Streaming | First-class — `postMessage` body into a stable shell, `innerHTML` the viewport, no reload | Awkward — URL iframe only updates by reloading; needs E's bridge *plus* the subdomain to host in-process content |
| Parent-compromise resilience | None — frame trusts the spawning parent unconditionally | Real — separate origin can enforce `frame-ancestors` and its own CSP |
| Widget persistence / identity | None directly — proxied through host via `postMessage` | Native — own `localStorage`, cookies, session |
| Shareable / cacheable URL | No (shell is a private string) | Yes (`widgets.app.com/<id>`) |
| Deployment cost | Zero infra — a string the parent assigns | Real host: TLS, endpoint, CORS, cookie-scope discipline, second deployment to run and secure |
| Ops story today | Single deployment | Not yet justified — content is ephemeral, no second-origin ops exists |

The current pattern optimizes for **strongest isolation + cheapest streaming +
zero infra**, at the cost of any capability that requires a real origin
(server-header policy, host-compromise resilience, widget-owned state,
shareable URLs). The subdomain pattern optimizes for **policy power,
resilience, and widget-as-a-service**, at the cost of deployment complexity
and a streaming story that has to re-derive E's bridge on top of a URL frame.

### Why the current pattern is right *now*, and when to switch

Today the requirements map one-to-one onto `srcdoc`'s strengths: the content
is LLM-generated in-process, ephemeral until "save," needs no URL, and the
strongest-possible isolation (null origin) is the safest default for
untrusted output. The deployment simplicity is the deciding factor, not a
fallback — standing up a second origin for ephemeral, in-process content
would be all cost and no benefit.

The honest caveat worth recording: the A–E harness was framed around `srcdoc`
from the start, so the subdomain option was *pre-empted by framing* rather
than rejected on its merits in the demo. It should be revisited the moment any
requirement from the advantages list above lands — persistent widget state,
header-only policies (`Trusted Types`, `COOP`/`COEP` for `SharedArrayBuffer`),
shareable/cacheable widget URLs, or a threat model that includes host
compromise. The migration path is mostly additive: the `postMessage` bridge,
the throttled `innerHTML` streaming, and the commit-runs-scripts-once logic
all carry over unchanged — what changes is that the shell stops being a
parent-assigned `srcdoc` string and becomes a document served from
`widgets.app.com`, with policy moving from a `<meta>` tag into response
headers.

---

## The security boundary, in one line

`sandbox="allow-scripts allow-forms"` with **no `allow-same-origin`** gives
the frame a null/opaque origin. That withheld token is the entire security
argument: a different origin can't read host cookies or `localStorage`, can't
touch the host DOM, can't `fetch` host endpoints, can't open popups. The
frame *can* run scripts and submit forms — exactly what a widget needs. The
demo marks `allow-same-origin` as the one dangerous token (`tok-danger`,
red, pulsing) because its presence is the single thing that turns a safe
frame into a fully-privileged extension of the host.

## CSP through a `<meta>` tag inside `srcdoc`

An `srcdoc` frame has no HTTP response — its content is a string the parent
assigned — so CSP rides in as `<meta http-equiv="Content-Security-Policy"
content="…">` in the shell's `<head>`. The policy allows inline scripts/styles
but restricts **external** loads to a 4-entry CDN allowlist (`esm.sh`,
`cdnjs`, `jsdelivr`, `unpkg`) across `script-src`, `style-src`, `img-src`,
`font-src`, `connect-src`. So even an LLM-emitted
`<script src="https://evil.example/…">` is refused. The demo's "test CSP"
button proves it live: a blocked domain fires `onerror` → "BLOCKED by CSP ✓",
an allowlisted one fires `onload` → "LOADED ✓", inside the same frame. The
sandbox isolates the frame's *origin*; the CSP confines its *network egress*.
You need both — origin isolation doesn't stop a hostile external script, and
CSP doesn't stop a same-origin script from reading cookies.

## The host↔iframe bridge

Every capability a null-origin frame needs is a `postMessage` the parent
validates and performs on its behalf: `window.sendPrompt(text)` (new turn),
`window.openLink(url)` (parent opens with `noopener`, since the sandbox has no
`allow-popups`), `window.storage.get/set/delete` (a `Map` in the host, with
id + 10s timeout request/response), and `height` reports (the frame measures
its own `scrollHeight` — the parent can't measure a null-origin frame). The
parent gates every message on `e.source === iframe.contentWindow` so widgets
can't impersonate each other. The demo relies on the same property:
`postMessage` is the one channel that crosses the null-origin boundary, so
the probe/grow/CSP buttons work uniformly across every approach.

## Smooth streaming mechanics (approach E)

- **Shell once.** `buildShell()` produces the `srcdoc` (CSP, theme, bridge,
  empty `#viewport`); assigned once, never rewritten.
- **Body via `postMessage`.** `{type:"render", payload}` → bridge sets
  `#viewport.innerHTML`. No `<script>` runs; partials are safe and cheap.
- **Coalesced throttle.** Latest partial buffered; one `requestAnimationFrame`
  scheduled; newer deltas overwrite the buffer (latest-wins); flush gated by
  `ts - lastTs >= RENDER_INTERVAL (50ms)`; first render bypasses the interval
  so the preview appears immediately.
- **Commit runs scripts once.** `{type:"run-scripts"}` → bridge removes
  `.frozen` **before** cloning/running scripts (so script-driven layout
  measurements see live CSS, not the frozen sheet), then clones each
  `<script>` in `#viewport` and replaces the original (a cloned script runs;
  an `innerHTML`-inserted one is inert).
- **`.frozen` during streaming (two distinct fixes).** Applied to both
  `#viewport` *and* `body` for the whole streaming phase, removed once at
  commit:
  - *Animation freeze:* `#viewport.frozen` sets `animation: none !important;
    transition: none !important` on the viewport and all descendants. Without
    it, every `innerHTML` rebuild restarts CSS keyframes/transitions from
    their start state on every tick — two failure modes at once: (a) visible
    **flicker/jerk** as animations re-fire ~20×/s and never settle, and (b)
    elements **stuck at a paused pre-animation state**, because a partial
    `<style>` may define an animation whose element is torn down before the
    animation completes, freezing it mid-state. Freezing forces everything to
    render in its base (non-animated) style instead. Removed once at commit
    so the final render plays animations normally.
  - *Scrollbar-height fix:* `body.frozen { overflow: hidden !important }`
    hides scrollbars during streaming so the reported `scrollHeight` reflects
    *true content height* without scrollbar space. Without this, the
    scrollbar's own height gets baked into the reported value, making the
    iframe permanently tall enough to show the scrollbar — which is itself a
    height change, which re-triggers the report, which re-lays-out… a
    feedback loop causing layout thrash on every `innerHTML` replace.
  Separately, the shell styles the iframe's scrollbars slim (`6px` webkit /
  `scrollbar-width: thin`) and gives `body` `overflow-x: auto` so wide widgets
  scroll horizontally — these are *inside* the iframe's own document context,
  independent of the host.
- **Width capped, height reported.** The iframe is `width:100%;
  max-width:848px; margin:0 auto` — capped to the widget's content width
  (800px content + 24px×2 inner padding) and centered, so the iframe's own
  scrollbar hugs the widget instead of stretching across the full card. Width
  is a fixed host-side concern (the card's column); only **height** is
  reported from the frame, because a null-origin frame can't be measured from
  outside and its height depends on streamed content the parent can't see.
- **Event-driven height.** `ResizeObserver` + `MutationObserver` on
  `document.documentElement` + `load`/`resize`, debounced 60ms — replaces an
  earlier infinite `requestAnimationFrame` poll that burned CPU on every
  widget for the whole conversation. Parent applies the height to both the
  iframe and a wrapper div (the "two-div" pattern) so layout space is reserved
  and the wrapper can animate without page jumps.

## Animation jerks during streaming, and the freeze

This deserves its own treatment because it was the most visible streaming
symptom and the freeze is a deliberate two-part fix, not a single rule.

**The symptom (jerks/flicker).** While the LLM streams, the host `postMessage`s
the latest partial ~20×/s and the bridge sets `#viewport.innerHTML = partial`.
Every one of those replaces **destroys the entire subtree and rebuilds it**,
which has two consequences for anything animated:

1. *Keyframes restart from zero on every tick.* A CSS animation or transition
   defined on a widget element re-fires the instant its node is recreated, so
   an entrance animation that should play once instead stutters — restarting,
   getting torn down, restarting — producing visible flicker/jerk and never
   settling. At a fast token rate this reads as a constantly shimmering,
   never-quitting widget.
2. *Elements freeze mid-state.* A partial `<style>` block may define an
   animation whose target element is created by a *later* partial and then
   torn down before the animation completes — leaving it visually stuck at a
   paused pre-animation state rather than showing its intended base style.

Both stem from the same root cause: animation state is tied to element
identity, and `innerHTML` replaces destroy identity on every tick.

**The fix — `.frozen` during the live phase.** The shell stylesheet ships a
`!important` override applied to `#viewport` and every descendant during
streaming:

```css
.frozen, .frozen *, .frozen *::before, .frozen *::after {
  animation: none !important;
  transition: none !important;
}
```

Stripping all animations/transitions forces every element to render in its
**base (non-animated) state**, which is stable across `innerHTML` replaces —
there's no animation state to lose, so there's no flicker and no frozen-mid-
state. The class is applied the moment streaming starts (the bridge sets it on
receiving the first `render`) and removed **once**, at commit.

**Two ordering details that mattered:**
- The freeze is removed **before** `run-scripts`, not after. Scripts that
  measure layout (`getBoundingClientRect`, `scrollHeight`) or kick off their
  own animations must see the live (un-frozen) stylesheet, otherwise they
  compute against the frozen sheet and produce wrong sizes or never start.
- The freeze is applied to `#viewport` (for animations) *and* separately to
  `body` (`overflow: hidden`) — the latter is the scrollbar-height fix (see
  Learning #10), a distinct bug that happens to share the same lifecycle.

**Complementary mitigation — `prefers-reduced-motion`.** The shell also ships
a `@media (prefers-reduced-motion: reduce)` block that clamps
`animation-duration` / `transition-duration` to ~0 for users who opt out of
motion. This is independent of the freeze: the freeze is about *streaming*
stability, reduced-motion is about *accessibility* — but both neutralize
animations, so a reduced-motion user sees no behavioral change at commit when
the freeze lifts.

---

## Learnings

### 1. Build the comparison harness before committing to an architecture — especially for security timing properties

The `.demo/` folder fires the same hostile widget at five candidate sandboxing
strategies and logs which breach. The production design (E) wasn't chosen by
reasoning; it was chosen because the harness showed A breaching, B/C
flickering, and D breaching *specifically during the streaming phase*. D is
the approach you'd arrive at by pure argument ("innerHTML is safe; we isolate
at the end") and it's wrong — and the only reliable way to catch that is an
executable demo with a one-line hostile payload and a global breach log. When
a decision hinges on a subtle timing property ("is this frame ever
same-origin while untrusted content is live?"), a demo that proves it beats
any design doc. Build the harness first, let it pick the architecture.

### 2. `innerHTML` blocks `<script>` but not `onerror` — that asymmetry is the whole game

The seductive claim is "stream into a same-origin iframe via `innerHTML`; it's
safe because `innerHTML` doesn't run scripts." It's half-true: `innerHTML`
does not execute `<script>` tags, but it **does** fire event-handler
attributes like `<img onerror="…">` the instant the partial is inserted. So a
hostile partial reaches `parent.*` during streaming, before any finalize-time
swap to null-origin can help. `hostile.html` is this attack in one line, and
the demo's approach-D log fills with red the moment it loads. The general
rule: never trust "`innerHTML` is safe" as a security argument on its own —
it buys you no `<script>` execution and nothing else. Run untrusted HTML only
inside a null-origin context, from the first byte. (Approach E leans on
`innerHTML`'s no-`<script>` property for *cheap streaming*, but it's safe only
because the shell is already null-origin.)

### 3. The security of a sandboxed srcdoc iframe comes from omitting `allow-same-origin`

`allow-scripts` without `allow-same-origin` gives the frame an opaque/null
origin, and that single omission is what makes it safe to run untrusted code.
The temptation is always to add `allow-same-origin` back ("I just need the
iframe to read localStorage / reach one resource"), and the moment you do the
iframe is same-origin with the host and the boundary collapses — the
untrusted script can do everything the host can. Approach A is exactly this
failure, and the demo marks the token red and pulsing for that reason. Treat
`allow-same-origin` as a tripwire: if a use case seems to need it, expose the
capability through a `postMessage` bridge instead of weakening the sandbox.

### 4. An srcdoc frame has no HTTP response, so CSP rides in a `<meta>` tag — and complements the sandbox

CSP is normally a response header, but an `srcdoc` frame's "response" is just
the string the parent assigned. The reliable way to enforce a content policy
is `<meta http-equiv="Content-Security-Policy" content="…">` in the shell's
`<head>`, ahead of any content. The sandbox and CSP are **complementary**: the
sandbox isolates the frame's *origin* (access to the host), the CSP confines
its *network egress* (which CDNs it may load from). Origin isolation doesn't
stop a hostile external script; CSP doesn't stop a same-origin script reading
cookies. The demo's "test CSP" button makes the layering visible — a blocked
domain fails, an allowlisted one succeeds, in the same frame.

### 5. "Reload the document per token" vs "repaint a subtree per token" is the real streaming distinction

Approaches B, C, and E are all null-origin and all safe — the only difference
is what happens per token: B rewrites `srcdoc` (full reload), C throttles the
same rewrite, E `postMessage`s into a stable shell and `innerHTML`s one
viewport. C *almost* worked — it shipped — because the throttle made the
reloads tolerable. But a throttled reload is still a reload: scripts re-run,
state is lost, the document is torn down and rebuilt. The insight that
unlocked E was separating the *shell* (loaded once, never touched during
streaming) from the *body* (mutated in place). "Cheap streaming" doesn't mean
"fewer reloads"; it means "no reloads." When a streaming fix is expressed as a
throttle on a heavy operation, ask whether the heavy operation is necessary at
all — the better fix is usually to restructure so the heavy operation happens
once and the per-tick work touches a small subtree.

### 6. Defer script execution to an explicit commit, never run it against partials

A streamed document is, by definition, incomplete — its `<script>` would run
against a half-built DOM and likely throw or misbehave. Both the reload-based
approaches (B/C) and the swap approach (D) get this wrong in different ways
(B/C re-run scripts every tick; D runs `onerror` mid-stream). E's rule is
clean: scripts never run during streaming; a single `run-scripts` message at
commit clones each `<script>` node and replaces the original (the standard
trick: an `innerHTML`-inserted script is inert, a cloned-and-reinserted one
runs), so they execute exactly once against the complete DOM. The general
pattern for streaming anything with executable parts: paint the partials
inert, execute in one authoritative pass at the end.

### 7. Per-token work must be coalesced, not just throttled

LLM token bursts arrive faster than the display refreshes, so per-delta work
is pure waste — but the right fix isn't a fixed timer, it's **latest-wins
coalescing on `requestAnimationFrame`**. Buffer only the newest partial,
schedule one rAF, and if another delta lands before it fires, let it overwrite
the buffer so the whole burst collapses into one render. Combine with a
minimum interval between renders (so a sustained fast stream doesn't paint
every frame) and let the first render bypass the interval so the preview
appears immediately. The demo's C and E use the identical throttle — the
point of learning #5 is *what* gets throttled (reload vs subtree repaint); the
point here is *how* (coalesce, don't just delay).

### 8. Don't measure a sandboxed iframe from the outside — have it report, and only on change

A null-origin iframe can't be measured by the parent, so sizing must be
**self-reported** via `postMessage`. The non-obvious part is *when*: an
infinite `requestAnimationFrame` poll measures every widget on every frame for
the whole conversation and burns CPU forever, even when nothing changed —
which is exactly what the early shipped code did before the "Kill infinite rAF
height loop" fix. The correct trigger is observed change — `ResizeObserver`
and `MutationObserver` plus `load`/`resize`, debounced so a burst of mutations
produces one measurement. The demo's "grow height" button (append rows via
`postMessage`, watch the frame report the new height) proves the channel works
for frames the parent otherwise can't touch. Any "watch this thing" loop
should be event-driven, measured only when the thing changes, and debounced.

### 9. Streaming destroys and recreates DOM — freeze animations for the whole live phase, not per-tick

Every `innerHTML` replace tears down and rebuilds the subtree, and because
CSS animation/transition state is tied to element identity, that produces two
distinct jerks: keyframes restart from zero on every tick (visible flicker,
never settling), and elements can freeze mid-state when a partial `<style>`
defines an animation whose target is created later and torn down before it
completes. The fix is a `.frozen` class (`animation: none !important;
transition: none !important`) applied to the viewport *and all descendants*
for the entire streaming phase, forcing every element to its stable base
state, removed once at commit so the final render plays normally. Two
ordering details matter: remove `.frozen` **before** running scripts (so
script-driven layout measurement sees live CSS, not the frozen sheet), and
apply the freeze to `body` as well — but for a *different* reason (the
scrollbar-height fix, Learning #10). The general rule: any source of visual
instability tied to element identity (animations, transitions, `:hover`,
`:focus`) must be neutralized for the whole partial phase, not patched
tick-by-tick.

### 10. A visible scrollbar bakes its own height into the reported scrollHeight — hide overflow while streaming

This is a distinct bug from animation restart, fixed by the *other* half of
`.frozen`. The frame reports `document.body.scrollHeight` to size the iframe.
If a scrollbar is showing, its height (the scrollbar gutter) is included in
`scrollHeight` — so the reported value is "content height + scrollbar," the
parent sizes the iframe to that, the iframe is now permanently tall enough to
keep the scrollbar visible, which keeps the inflated height, which re-triggers
the report… a feedback loop that causes layout thrash on every `innerHTML`
replace. The fix is `body.frozen { overflow: hidden !important }` during
streaming: hide overflow entirely so the reported height is pure content,
then remove the freeze at commit so the real (post-script) layout — scrollbar
and all — reports honestly. The general lesson: anything that affects layout
*as a side effect of being measured* (scrollbars, `:hover` styles, sticky
headers) can create a measurement feedback loop. Measure from a quiescent
state, not from a state your own measurement is sustaining.

### 11. Width is a host-side constant; height is a frame-reported variable

A sandboxed widget iframe has two dimensions, and they want opposite owners.
Width is determined by the host's card column and is independent of the
widget's content, so the host fixes it (`width:100%; max-width:848px;
margin:0 auto`) — capping to the widget's content width (800px + padding) so
the iframe's own scrollbar hugs the widget rather than spanning the full card.
Height depends on the streamed content, which the parent can't see (a
null-origin frame can't be measured from outside), so it must be *reported*
from the frame. Conflating the two — trying to measure or fix both from the
parent — is where the old infinite-rAF polling and the scrollbar-baked-into-
height feedback loops came from. The clean split: host owns width, frame owns
height and reports it on change.

### 12. Expose host capabilities through a gated postMessage bridge, not by widening the sandbox

A null-origin frame can't open popups, persist state, or talk to the agent —
all of which a real widget needs. The clean way to provide them is not to
grant the corresponding sandbox tokens (each widens the attack surface) but to
expose each capability as a `postMessage` the **parent** validates and
performs on the frame's behalf: storage as a request/response protocol with id
+ timeout living in the host; link opening honored by the parent with
`window.open(..., "noopener")`; a new turn via a single `sendPrompt`. The
parent gates every message on `e.source === iframe.contentWindow` so widgets
can't impersonate each other. Capability-by-proxy keeps the sandbox maximal
and the trust surface explicit — and `postMessage` is the one channel that
crosses the null-origin boundary, so the same bridge works regardless of how
the frame is sandboxed.
