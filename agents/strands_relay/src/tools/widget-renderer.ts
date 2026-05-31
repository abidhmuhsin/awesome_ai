import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

export const widgetRendererTool = tool({
  name: 'widget_renderer',
  description:
    'Render visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — inline alongside your text response.',
  inputSchema: z.object({
    title: z
      .string()
      .describe('Short snake_case identifier for this visual. Used for disambiguation.'),
    widget_code: z
      .string()
      .describe(
        'SVG or HTML code to render. SVG must start with <svg tag. HTML must NOT include DOCTYPE/html/head/body tags.'
      ),
  }),
  callback: async ({ title, widget_code }) => {
    if (!title || !widget_code) {
      return 'Error: "title" and "widget_code" are required.'
    }

    return {
      type: 'widget' as const,
      title,
      widget_code,
    }
  },
})
