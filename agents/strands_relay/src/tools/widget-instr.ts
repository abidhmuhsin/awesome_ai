import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

const INSTRUCTIONS = `%%WIDGET_INSTR%%
# Visual Widget Instructions

## CSS Variables (use these for theming)
- --bg: #0f0f0f (background)
- --surface: #1a1a1a (card/panel background)
- --text: #ffffff (foreground text)
- --text-muted: #666666 (secondary text)
- --accent: #ff4d4d (accent/highlight color)
- --accent-hover: #ff2020 (hover state)
- --radius: 4px (border radius)

## Layout Rules
- Keep background transparent — the container provides the background
- Avoid top-level padding (the chat card adds its own)
- For SVG: use viewBox for responsive sizing, start with <svg tag
- For HTML: do NOT include DOCTYPE, html, head, or body tags
- Scripts execute after rendering

## SVG Example
<svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="140" width="60" height="50" fill="var(--accent)" rx="2"/>
  <rect x="90" y="80" width="60" height="110" fill="var(--accent)" rx="2" opacity="0.8"/>
  <rect x="170" y="40" width="60" height="150" fill="var(--accent)" rx="2" opacity="0.6"/>
  <text x="40" y="175" text-anchor="middle" fill="var(--text-muted)" font-size="10">A</text>
  <text x="120" y="175" text-anchor="middle" fill="var(--text-muted)" font-size="10">B</text>
  <text x="200" y="175" text-anchor="middle" fill="var(--text-muted)" font-size="10">C</text>
</svg>

## HTML Example
<div style="font-family: sans-serif; color: var(--text);">
  <div style="display: flex; gap: 12px; align-items: center;">
    <div style="width: 48px; height: 48px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 18px;">A</div>
    <div>
      <div style="font-weight: 600;">Card Title</div>
      <div style="color: var(--text-muted); font-size: 0.85em;">Description text here</div>
    </div>
  </div>
</div>`

export const widgetInstrTool = tool({
  name: 'widget_instr',
  description:
    'Get CSS variables, layout rules, and SVG/HTML examples for rendering visual widgets. Call this before your first widget render.',
  inputSchema: z.object({}),
  callback: async () => INSTRUCTIONS,
})
