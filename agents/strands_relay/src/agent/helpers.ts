/**
 * Agent Helpers — extract text and detect tool usage
 */
import type { Agent } from '@strands-agents/sdk'
import { createHash } from 'crypto'

/** Check if a string looks like the widget renderer instructions */
function isInstrText(text: string): boolean {
  return text.startsWith('%%WIDGET_INSTR%%')
}

export function extractText(agent: Agent): string | undefined {
  for (const message of [...agent.messages].reverse()) {
    for (const block of [...message.content].reverse()) {
      if (block.type === 'textBlock') {
        // Skip instr text — it's internal, not for the user
        if (isInstrText(block.text)) continue
        return block.text
      }
      if (block.type === 'toolResultBlock') {
        const text = block.content
          .map((c: any) => {
            if (c.type === 'textBlock') {
              if (isInstrText(c.text)) return ''
              return c.text
            }
            if (c.type === 'jsonBlock') {
              // Skip widget results — those are rendered visually
              if (c.json && typeof c.json === 'object' && c.json.type === 'widget') return ''
              return JSON.stringify(c.json)
            }
            return ''
          })
          .filter(Boolean)
          .join('\n')
        if (text) return text
      }
    }
  }
  return undefined
}

export interface WidgetResult {
  title: string
  widget_code: string
}

export interface WidgetCache {
  /** Scan messages for new widgets not yet seen by this cache */
  extractWidgets(agent: Agent): WidgetResult[]
  /** Clear all tracked widgets (call on new session) */
  reset(): void
}

/**
 * Create an isolated widget dedup cache for a single connection.
 * Each cache tracks which widgets it has already seen, independently.
 */
export function createWidgetCache(): WidgetCache {
  const seen = new Set<string>()

  return {
    reset() {
      seen.clear()
    },

    extractWidgets(agent: Agent): WidgetResult[] {
      /* Agent message history is cumulative — every invoke() appends to the full
       * history, so old widget toolUseBlocks are still present in later turns.
       * Without dedup via the `seen` set, the same widget would be re-sent to the
       * client on every subsequent turn.
       *
       * The MD5 hash of title+code ensures we only return widgets the client
       * hasn't been told about yet, while still detecting updates (same title,
       * different code → new hash → sent again).
       *
       * This also handles the case where the agent calls widget_renderer multiple
       * times in a single invoke() — each call produces a distinct block, and all
       * of them are scanned and deduped independently. */
      const results: WidgetResult[] = []
      for (const message of [...agent.messages].reverse()) {
        for (const block of [...message.content].reverse()) {
          if (block.type === 'toolUseBlock' && block.name === 'widget_renderer') {
            const args = block.input as Record<string, any>
            if (args.title && args.widget_code) {
              const key = createHash('md5').update(args.title + args.widget_code).digest('hex')
              if (!seen.has(key)) {
                seen.add(key)
                results.push({ title: args.title, widget_code: args.widget_code })
              }
            }
          }
        }
      }
      return results
    },
  }
}

export function wasByebyeCalled(agent: Agent): boolean {
  for (const message of agent.messages) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock' && block.name === 'byebye') return true
    }
  }
  return false
}
