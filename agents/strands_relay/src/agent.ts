import 'dotenv/config'
import { Agent, type ToolResultContent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { createOpenRouterUsageFetch, logUsage } from './telemetry/openrouter-usage.js'
import { createInterface } from 'readline'
import { helloTool, byebyeTool } from './tools/index.js'
import { mcpClient } from './mcp/index.js'

const model = new OpenAIModel({
  api: 'chat',
  apiKey: process.env.OPENAI_API_KEY,
  modelId: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  clientConfig: process.env.OPENAI_BASE_URL
    ? {
        baseURL: process.env.OPENAI_BASE_URL,
        fetch: createOpenRouterUsageFetch(),
      }
    : undefined,
  temperature: 0.7,
  maxTokens: 500,
})



const agent = new Agent({
  model,
  systemPrompt: 'You are a friendly chat assistant. You have two tools:\n' +
    '- hello: use only when the user says hello or introduces themselves for the first time\n' +
    '- byebye: use only when the user explicitly says goodbye or wants to end the chat\n' +
    'For normal conversation, just reply naturally without calling any tool.',
  tools: [helloTool, byebyeTool, mcpClient],
  printer: false,
})

function latestText(): string | undefined {
  for (const message of [...agent.messages].reverse()) {
    for (const block of [...message.content].reverse()) {
      if (block.type === 'textBlock') return block.text
      if (block.type === 'toolResultBlock') {
        const text = block.content
          .map((c) => (c.type === 'textBlock' ? c.text : c.type === 'jsonBlock' ? JSON.stringify(c.json) : ''))
          .filter(Boolean)
          .join('\n')
        if (text) return text
      }
    }
  }
  return undefined
}

function wasByebyeCalled(): boolean {
  for (const message of agent.messages) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock' && block.name === 'byebye') return true
    }
  }
  return false
}

// ── REPL loop ──────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout })

console.log('🤖 Agent ready! Type your messages (type "bye" or "exit" to quit).\n')

async function ask(): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed) {
        resolve(false)
        return
      }

      try {
        const result = await agent.invoke(trimmed)

        const text = latestText() ?? result.toString()
        if (text) {
          process.stdout.write(`Agent: ${text}\n\n`)
        }

        if (wasByebyeCalled()) {
          logUsage(result)
          resolve(true)
          return
        }
      } catch (err: any) {
        process.stdout.write(`Agent: (error: ${err.message})\n\n`)
      }

      resolve(false)
    })
  })
}

;(async () => {
  while (true) {
    const shouldExit = await ask()
    if (shouldExit) {
      rl.close()
      break
    }
  }
})()
