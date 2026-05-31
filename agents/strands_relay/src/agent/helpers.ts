/**
 * Agent Helpers — extract text and detect tool usage
 */
import type { Agent } from '@strands-agents/sdk'

export function extractText(agent: Agent): string | undefined {
  for (const message of [...agent.messages].reverse()) {
    for (const block of [...message.content].reverse()) {
      if (block.type === 'textBlock') return block.text
      if (block.type === 'toolResultBlock') {
        const text = block.content
          .map((c: any) =>
            c.type === 'textBlock' ? c.text : c.type === 'jsonBlock' ? JSON.stringify(c.json) : '',
          )
          .filter(Boolean)
          .join('\n')
        if (text) return text
      }
    }
  }
  return undefined
}

export function wasByebyeCalled(agent: Agent): boolean {
  for (const message of agent.messages) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock' && block.name === 'byebye') return true
    }
  }
  return false
}
