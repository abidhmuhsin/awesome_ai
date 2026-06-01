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

export interface ToolCall {
  name: string
  args: string
}

/**
 * Extract tool calls from the agent's message history.
 * 
 * When tools are used, the message structure is:
 *   [N-3] Assistant: {toolUseBlock}  ← tool call
 *   [N-2] User: {toolResultBlock}   ← tool result (role=user!)
 *   [N-1] Assistant: text response  ← final response
 * 
 * NOTE: Strands SDK gives role="user" for tool results.
 * We must skip past user messages that contain toolResultBlocks
 * to find the actual tool calls in earlier assistant messages.
 * 
 * We stop at the first user message that is NOT a tool result.
 */
export function extractToolCalls(agent: Agent): ToolCall[] {
  const calls: ToolCall[] = []
  
  // Scan backwards through messages to find tool calls
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const msg = agent.messages[i]
    
    // Check if this user message contains tool results (not a real user message)
    // SDK class instances use .type === 'toolResultBlock' discriminator
    const hasToolResult = msg.content?.some((b: any) => b.type === 'toolResultBlock')
    
    // Stop at actual user message (not tool result messages)
    if (msg.role === 'user' && !hasToolResult) break
    
    // Look for tool use blocks in assistant messages
    // SDK class instances use .type === 'toolUseBlock' discriminator
    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if ((block as any).type === 'toolUseBlock') {
          const toolUse = block as any
          const args = typeof toolUse.input === 'object'
            ? JSON.stringify(toolUse.input)
            : String(toolUse.input ?? '')
          calls.push({ name: toolUse.name, args })
        }
      }
    }
  }
  
  // Reverse so tool calls appear in chronological order
  return calls.reverse()
}

export function wasByebyeCalled(agent: Agent): boolean {
  for (const message of agent.messages) {
    for (const block of message.content) {
      if ((block as any).type === 'toolUseBlock' && (block as any).name === 'byebye') return true
    }
  }
  return false
}
