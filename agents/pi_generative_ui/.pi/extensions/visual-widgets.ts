/**
 * Visual Widgets Extension for Pi
 *
 * Registers visual_instructions and show_visual tools so the LLM
 * can generate inline SVG/HTML widgets.
 *
 * In the terminal, show_visual saves the widget to a temp file
 * and opens it in the default browser.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Module guidance ---

type ModuleName =
  | "diagram"
  | "mockup"
  | "interactive"
  | "data_viz"
  | "art"
  | "chart"
  | "elicitation";

const MODULE_GUIDANCE: Record<ModuleName, string[]> = {
  diagram: [
    "Use a clear left-to-right or top-to-bottom flow.",
    "Keep labels short and align connectors to node centers.",
    "Use CSS variables for fills, strokes, and text.",
  ],
  mockup: [
    "Represent the actual interface state, not a marketing page.",
    "Use stable dimensions for controls, lists, and panels.",
    "Avoid nested cards unless the inner item is a real repeated object.",
  ],
  interactive: [
    "Include self-contained JavaScript only when interaction is needed.",
    "Expose obvious controls and preserve layout when state changes.",
    "Use sendPrompt(text) only for deliberate user actions.",
  ],
  data_viz: [
    "Prefer direct labels and readable axis text.",
    "Show units, scale, and empty states where relevant.",
    "Do not imply precision that the data does not support.",
    "For animated bar/shape growth, animate transform (scaleY/translateY on a <g> with transform-origin) — NEVER animate height, y, or width attributes.",
    "For line/area draw-in, use stroke-dasharray + animated stroke-dashoffset.",
  ],
  art: [
    "Keep the canvas transparent unless a background is necessary.",
    "Use reusable CSS variables instead of hard-coded theme colors.",
    "Favor clean shapes and intentional composition over decoration.",
  ],
  chart: [
    "Choose the simplest chart that answers the question.",
    "Use consistent colors for recurring series.",
    "Make legends unnecessary when direct labels can work.",
    "Animate bars via transform: scaleY() on a wrapping <g> (transform-origin at the baseline) — NEVER animate the rect's height or y attribute.",
    "Animate line/area draw-in via stroke-dashoffset, not by animating path d or points.",
  ],
  elicitation: [
    "Use forms or buttons for structured choices.",
    "Keep prompts concise and focused on the next decision.",
    "Send a clear message through sendPrompt(text) after submission.",
  ],
};

// --- Widget directory (relative to project root) ---

let WIDGET_DIR = "";

function setWidgetDir(dir: string) {
  WIDGET_DIR = join(dir, "exports");
}

async function ensureWidgetDir() {
  await mkdir(WIDGET_DIR, { recursive: true });
}

// --- Tools ---

const visualInstructionsTool = defineTool({
  name: "visual_instructions",
  label: "Visual Instructions",
  description:
    "Return visual authoring guidance (theme, viewport, rules) that should be read before rendering a widget.",
  promptSnippet: "Get visual authoring guidance before generating a widget",
  promptGuidelines: [
    "Call visual_instructions before show_visual to get theme variables and authoring rules.",
  ],
  parameters: Type.Object({
    modules: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("diagram"),
          Type.Literal("mockup"),
          Type.Literal("interactive"),
          Type.Literal("data_viz"),
          Type.Literal("art"),
          Type.Literal("chart"),
          Type.Literal("elicitation"),
        ]),
        { description: "Visual modules to load." }
      )
    ),
    platform: Type.Optional(
      Type.Union(
        [
          Type.Literal("mobile"),
          Type.Literal("desktop"),
          Type.Literal("unknown"),
        ],
        { description: "Client platform for sizing guidance." }
      )
    ),
  }),



  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const modules: ModuleName[] = params.modules ?? [
      "diagram",
      "interactive",
    ];
    const platform = params.platform ?? "unknown";

    const viewport = {
      mobile: { width: 380, recommended_svg_viewbox: "0 0 380 520" },
      desktop: { width: 760, recommended_svg_viewbox: "0 0 760 480" },
      unknown: { width: 700, recommended_svg_viewbox: "0 0 700 450" },
    }[platform];

    const result = {
      platform,
      viewport,
      theme: {
        required_css_variables: [
          "--visual-bg", "--visual-surface", "--visual-surface-2",
          "--visual-text", "--visual-muted", "--visual-border",
          "--visual-accent", "--visual-accent-2",
          "--visual-success", "--visual-warning", "--visual-danger",
        ],
        fallback_palette: {
          "--visual-bg": "transparent",
          "--visual-surface": "#ffffff",
          "--visual-surface-2": "#f4f6f8",
          "--visual-text": "#17202a",
          "--visual-muted": "#64748b",
          "--visual-border": "#d7dee8",
          "--visual-accent": "#2563eb",
          "--visual-accent-2": "#14b8a6",
          "--visual-success": "#16a34a",
          "--visual-warning": "#d97706",
          "--visual-danger": "#dc2626",
        },
      },
      rules: [
        "Return raw SVG starting with <svg, or raw HTML without html/head/body tags.",
        "Keep the outer background transparent and avoid top-level padding.",
        "Use CSS variables for theme colors, with sensible fallbacks.",
        "Ensure text fits at mobile and desktop widths.",
        "Scripts may be included in HTML widgets and should be self-contained.",
        "A global sendPrompt(text) function may be called from user-triggered events.",
        // --- Streaming-friendly authoring (content streams in token by token) ---
        "Order code for streaming: <style> first, visible SVG/HTML next, <script> last.",
        "Prefer inline styles over <style> blocks for controls (they apply mid-stream).",
        "Avoid gradients and shadows — they flicker while content streams in.",
        // --- Animation constraints (GPU-composited ONLY) ---
        // Layout-triggering and paint-triggering properties are forbidden because
        // they cause repaint storms across the iframe boundary during streaming
        // and hurt performance. This applies to BOTH CSS and SVG <animate>.
        "ANIMATION RULE (critical): The ONLY properties you may animate are transform, opacity, and stroke-dashoffset. This is non-negotiable.",
        "FORBIDDEN animated properties (CSS AND SVG <animate>): width, height, x, y, cx, cy, r, rx, ry, top, left, right, bottom, margin, padding, font-size, line-height, fill, stroke, stroke-width, background-color, color, border, box-shadow, filter. Animating ANY of these triggers layout recalculation or repaint.",
        "For SVG bars/shapes that need to grow, wrap the shape in a <g> and animate transform: scaleY()/translateY() with transform-origin set, OR animate stroke-dashoffset on an outline. NEVER animate the height/y/x attributes of <rect>, <circle>, <ellipse>, <path>.",
        "For line/area draw-in effects, use stroke-dasharray + animated stroke-dashoffset (the one allowed paint property).",
        "Keep loop durations between 0.8s and 2.0s (sweet spot 1.0–1.6s).",
        "Wrap all animation/transition declarations in @media (prefers-reduced-motion: no-preference) { } so reduced-motion users see a static result.",
        // --- sendPrompt + storage conventions ---
        "sendPrompt(text) should carry full context (values + labels) so the agent can reason about it; suffix sendPrompt buttons with ↗.",
        "Use window.storage for persistence with namespaced keys like 'table:record_id' (< 200 chars, no spaces). storage.get() throws on missing keys — wrap in try/catch.",
      ],
      module_guidance: Object.fromEntries(
        modules.map((m) => [m, MODULE_GUIDANCE[m]])
      ),
      examples: {
        svg_start:
          '<svg viewBox="0 0 700 450" xmlns="http://www.w3.org/2000/svg">',
        html_start: '<section class="widget">...</section>',
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      details: result,
    };
  },
});

const TITLE_RE = /^[a-z][a-z0-9_]{2,80}$/;

const showVisualTool = defineTool({
  name: "show_visual",
  label: "Show Visual",
  description:
    "Render an SVG or HTML widget. Saves to a temp file and opens in the browser.",
  promptSnippet: "Render an SVG or HTML widget in the browser",
  promptGuidelines: [
    "Use show_visual to render widgets after calling visual_instructions.",
    "show_visual saves the widget to a temp file and opens it in the browser.",
  ],
  parameters: Type.Object({
    title: Type.String({
      description:
        "snake_case identifier for this visual. Used as a filename-safe title.",
      minLength: 3,
      maxLength: 80,
    }),
    widget_code: Type.String({
      description:
        "Raw SVG or HTML widget code. SVG must start with <svg. HTML must omit DOCTYPE, html, head, and body tags.",
      minLength: 1,
    }),
    loading_messages: Type.Array(Type.String(), {
      description:
        "One to four short loading messages shown while the widget renders.",
      minLength: 1,
      maxLength: 4,
    }),
  }),



  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const { title, widget_code, loading_messages } = params;

    if (!TITLE_RE.test(title)) {
      return {
        content: [
          {
            type: "text",
            text: "Error: title must be snake_case, start with a letter, lowercase letters/numbers/underscores only.",
          },
        ],
        isError: true,
      };
    }

    const stripped = widget_code.trimStart();
    const lower = stripped.slice(0, 80).toLowerCase();
    const mode = lower.startsWith("<svg") ? "svg" : "html";

    const forbiddenPrefixes = ["<!doctype", "<html", "<head", "<body"];
    if (mode === "html" && forbiddenPrefixes.some((p) => lower.startsWith(p))) {
      return {
        content: [
          {
            type: "text",
            text: "Error: HTML widget_code must not include DOCTYPE, html, head, or body tags.",
          },
        ],
        isError: true,
      };
    }

    const cleaned = loading_messages.map((m) => m.trim());
    if (cleaned.some((m) => !m)) {
      return {
        content: [
          {
            type: "text",
            text: "Error: loading_messages cannot contain empty strings.",
          },
        ],
        isError: true,
      };
    }

    // Build the full HTML page.
    // Both SVG and HTML widgets share the same wrapper document — the only
    // difference is the file extension (and that SVG widgets are wrapped in
    // the same <section class="widget"> so the renderer can extract them
    // uniformly). Theme tokens match the live iframe renderer in widgets.js.
    const ext = mode === "svg" ? "svg" : "html";
    const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  :root {
    --visual-bg: transparent; --visual-surface: #1a1a1a; --visual-surface-2: #222222;
    --visual-text: #ffffff; --visual-muted: #666666; --visual-border: rgba(255,255,255,0.08);
    --visual-accent: #ff4d4d; --visual-accent-2: #ff2020;
    --visual-success: #ff4d4d; --visual-warning: #ff4d4d; --visual-danger: #666666;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #0f0f0f; color: #ffffff; }
  body { font-family: 'Barlow', system-ui, sans-serif; padding: 24px; overflow-x: hidden; }
  .widget { max-width: 800px; margin: 0 auto; width: 100%; }
  svg { max-width: 100%; height: auto; }
</style>
</head>
<body>
<section class="widget">
${widget_code}
</section>
</body>
</html>`;

    // Save to temp directory
    await ensureWidgetDir();
    const filename = `${title}.${ext}`;
    const filepath = join(WIDGET_DIR, filename);
    await writeFile(filepath, fullHtml, "utf8");

    // Relative path for display/transport — the frontend only needs the
    // basename (via split("/").pop()) to fetch the file, and showing an
    // absolute path in the UI leaks the host filesystem layout. Keep `exports/`
    // as the portable prefix so the displayed path is stable across machines.
    const relativePath = `exports/${filename}`;

    const result = {
      type: "visual_widget" as const,
      title,
      mode,
      filename,
      filepath: relativePath,
      loading_messages: cleaned,
      renderer_contract: {
        background: "transparent",
        theme: "css_variables",
        send_prompt_available: mode === "html",
      },
    };

    return {
      content: [
        {
          type: "text",
          text: `Widget saved to ${relativePath} and opened in browser.`,
        },
      ],
      details: result,
    };
  },
});

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
  // Get project root from context or use current working directory
  const projectRoot = (pi as any).cwd || process.cwd();
  setWidgetDir(projectRoot);
  console.log(`  📁 Widget directory: ${WIDGET_DIR}`);
  
  pi.registerTool(visualInstructionsTool);
  pi.registerTool(showVisualTool);
}
