import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

type WidgetType = 'all' | 'svg' | 'html' | 'chartjs'

const GLOBAL_RULES = `
%%WIDGET_INSTR%%

# Universal Widget Rules

## Core Requirements
- Output must be self-contained
- Output must be valid markup
- No markdown code fences
- No explanations
- No surrounding prose
- No comments unless explicitly requested

## Theming
Use only these CSS variables:

- var(--bg)
- var(--surface)
- var(--text)
- var(--text-muted)
- var(--accent)
- var(--accent-hover)
- var(--radius)

Do not hardcode theme colors unless explicitly requested.

## Layout
- Keep background transparent
- Avoid top-level padding
- Mobile responsive by default
- Avoid fixed widths
- Prefer flexbox or grid
- Do not depend on parent styles

## Reliability
- All IDs must be unique
- Validate markup before returning
- Avoid unnecessary complexity
- Fail gracefully if JS cannot execute
- Never depend on parent scripts

## Forbidden
- fetch()
- websocket connections
- localStorage
- sessionStorage
- document.write()
- alert()
- prompt()
- confirm()
`

const SVG_INSTRUCTIONS = `
# SVG Widget Generation Rules

## Output Requirements
- Output MUST start with <svg
- Output MUST contain exactly one root SVG
- Do NOT wrap SVG inside divs
- Use valid SVG markup only
- Include xmlns="http://www.w3.org/2000/svg"

## Sizing
- Always include viewBox
- Never rely on fixed width/height
- Design for responsive scaling

Example:

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 800 400"
>

## Styling
Use CSS variables:

- var(--bg)
- var(--surface)
- var(--text)
- var(--text-muted)
- var(--accent)
- var(--accent-hover)

## Text
Always define:
- font-size
- fill

Use text-anchor when alignment matters.

## Layout
- Keep all content within viewBox
- Leave safe padding around edges
- Avoid clipping

## Accessibility
Include:

<title>Widget Title</title>
<desc>Widget Description</desc>

## Forbidden
- foreignObject
- external assets
- remote fonts
- scripts
- external CSS

## Reliability Rules
- Coordinates must be numeric
- Close all tags
- Avoid percentage coordinates

## Output
Return SVG markup only.
`

const HTML_INSTRUCTIONS = `
# HTML Widget Generation Rules

## Output Requirements
Return a single HTML fragment.

Do NOT include:
- <!DOCTYPE>
- <html>
- <head>
- <body>

## Root Container

Always use a single wrapper:

<div class="widget-root">
...
</div>

## Styling

Use:
- Inline styles
OR
- One style block

Use CSS variables only.

## Layout Rules

- Responsive by default
- Use flexbox or grid
- Avoid absolute positioning
- Avoid viewport units
- Avoid page layouts

## JavaScript

Only when necessary.

Rules:
- Place scripts after markup
- Execute immediately
- Avoid globals

## IDs

Pattern:

widget_<unique>

Example:

widget_48291

## Accessibility

Interactive elements must include:
- aria-label
- keyboard support

Buttons must include:
- type="button"

## Forbidden

- React
- Vue
- Angular
- jQuery
- fetch()
- localStorage
- sessionStorage

## CSS Rules

Do not use:

*
body
html

Use scoped selectors only.

Good:

.widget-root {}

## Reliability Rules

- Close all tags
- No invalid nesting
- No global CSS resets

## Output

Return HTML fragment only.
`

const CHARTJS_INSTRUCTIONS = `
## Chart.js Instructions

### Core Requirements

- Include Chart.js via CDN:
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

- Return exactly:
  1. Container div
  2. Canvas element
  3. CDN script
  4. Initialization script

- Canvas ID must be unique (chart_<id> pattern recommended)
- Container must define explicit height (required for rendering)
- Width should be 100% (responsive layout)
- Do NOT rely on parent styles

---

### Theme Handling (IMPORTANT)

Chart.js renders to canvas and cannot reliably use CSS variables directly.

Always resolve theme values first:

const styles = getComputedStyle(document.documentElement)

const theme = {
  bg: styles.getPropertyValue('--bg').trim() || '#000000',
  accent: styles.getPropertyValue('--accent').trim() || '#ff4d4d',
  text: styles.getPropertyValue('--text').trim() || '#ffffff',
  textMuted: styles.getPropertyValue('--text-muted').trim() || '#888888',
  surface: styles.getPropertyValue('--surface').trim() || '#1a1a1a'
}

Derive adaptive grid/border colors from theme (NEVER hardcode rgba values):
- Use theme.textMuted with low opacity for subtle grid lines
- Example: grid color from theme.textMuted → parse hex → apply ~0.08–0.12 alpha
- Alternative: use theme.surface with slightly adjusted alpha for contrast

Never use:
- 'var(--accent)'
- 'var(--text)'
- 'var(--text-muted)'
- Hardcoded rgba values like 'rgba(255,255,255,0.08)' — these break on light themes

inside Chart.js config.

---

### Required Safety Checks

Always:

- Verify canvas exists before initializing
- Wrap Chart.js creation in try/catch
- Avoid runtime crashes silently breaking UI

---

### Required Options

Always set:

responsive: true,
maintainAspectRatio: false

Explicitly define:

- x/y axis ticks colors
- grid colors
- legend label colors
- tooltip styling

---

### Chart Type Guidance (Generic)

Apply based on chart type:

- Bar / Column:
  - borderRadius: 4
  - use backgroundColor for bars

- Line:
  - tension: 0.3–0.4
  - use borderColor + optional fill

- Doughnut / Pie:
  - use array of colors
  - ensure good contrast between segments

---

### Data Integrity

- labels.length MUST equal dataset.data.length
- Avoid undefined or null values
- Do not generate random data unless explicitly requested

---

### Example Pattern (Generic)

<div style="width:100%;height:320px;">
  <canvas id="chart_12345"></canvas>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<script>
const styles = getComputedStyle(document.documentElement)

const theme = {
  bg: styles.getPropertyValue('--bg').trim() || '#000000',
  accent: styles.getPropertyValue('--accent').trim() || '#ff4d4d',
  text: styles.getPropertyValue('--text').trim() || '#ffffff',
  textMuted: styles.getPropertyValue('--text-muted').trim() || '#888888',
  surface: styles.getPropertyValue('--surface').trim() || '#1a1a1a'
}

// Helper: derive adaptive grid color from textMuted with low opacity
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')'
}
const gridColor = hexToRgba(theme.textMuted, 0.1)

const canvas = document.getElementById('chart_12345')

if (canvas) {
  try {
    new Chart(canvas, {
      type: 'bar', // can be bar, line, doughnut, etc.
      data: {
        labels: ['A', 'B', 'C'],
        datasets: [{
          label: 'Dataset',
          data: [10, 20, 15],
          backgroundColor: theme.accent
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,

        plugins: {
          legend: {
            labels: {
              color: theme.text
            }
          },
          tooltip: {
            backgroundColor: theme.surface,
            titleColor: theme.text,
            bodyColor: theme.text
          }
        },

        scales: {
          x: {
            ticks: {
              color: theme.textMuted
            },
            grid: {
              color: gridColor
            }
          },
          y: {
            ticks: {
              color: theme.textMuted
            },
            grid: {
              color: gridColor
            }
          }
        }
      }
    })
  } catch (err) {
    console.error(err)
  }
}
</script>

---

### Forbidden

- fetch()
- async data loading
- external plugins
- dynamic imports
- React/Vue/Angular/jQuery
- CSS variables directly inside Chart.js config
- Hardcoded color values like 'rgba(255,255,255,...)' or 'rgba(0,0,0,...)' — always derive from theme

---

### Output Rule

Return only valid widget markup.
No explanations.
No markdown.
`

const INSTRUCTION_MAP: Record<WidgetType, string> = {
  svg: `${GLOBAL_RULES}\n${SVG_INSTRUCTIONS}`,
  html: `${GLOBAL_RULES}\n${HTML_INSTRUCTIONS}`,
  chartjs: `${GLOBAL_RULES}\n${CHARTJS_INSTRUCTIONS}`,
  all: `
${GLOBAL_RULES}

${SVG_INSTRUCTIONS}

${HTML_INSTRUCTIONS}

${CHARTJS_INSTRUCTIONS}
`,
}

export const widgetInstrTool = tool({
  name: 'widget_instr',
  description:
    'Returns strict production-grade widget generation instructions for SVG, HTML, and Chart.js widgets. Optimized for rendering reliability and self-contained output.',

  inputSchema: z.object({
    type: z
      .enum(['all', 'svg', 'html', 'chartjs'])
      .optional()
      .default('all')
      .describe(
        'Instruction set to return. One of: all, svg, html, chartjs'
      ),
  }),

  callback: async ({ type = 'all' }) => {
    return INSTRUCTION_MAP[type]
  },
})
