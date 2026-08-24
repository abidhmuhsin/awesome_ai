/**
 * Agent Helpers — extract text and detect tool usage
 */
import type { Agent } from '@strands-agents/sdk'

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
              // widget_renderer now returns a plain text string, so this
              // jsonBlock-skip is effectively dead — kept defensively in case a
              // tool ever returns a legacy {type:'widget'} object.
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
