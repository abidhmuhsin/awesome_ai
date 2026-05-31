import 'dotenv/config'
import { Agent, type ToolResultContent, tool } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { z } from 'zod'

const helloTool = tool({
  name: 'hello',
  description: 'Return a simple greeting for a person by name.',
  inputSchema: z.object({
    name: z.string().min(1).describe('The name to greet'),
  }),
  callback: ({ name }) => {
    return `Hello, ${name}! This response came from the hello tool.`
  },
})

const model = new OpenAIModel({
  api: 'chat',
  apiKey: process.env.OPENAI_API_KEY,
  modelId: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  clientConfig: process.env.OPENAI_BASE_URL
    ? {
        baseURL: process.env.OPENAI_BASE_URL,
      }
    : undefined,
  temperature: 0,
  maxTokens: 300,
})

const agent = new Agent({
  model,
  tools: [helloTool],
  printer: false,
})

function textFromToolResultContent(content: ToolResultContent[]): string {
  return content
    .map((block) => {
      if (block.type === 'textBlock') {
        return block.text
      }

      if (block.type === 'jsonBlock') {
        return JSON.stringify(block.json)
      }

      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function latestToolResultText(): string | undefined {
  for (const message of [...agent.messages].reverse()) {
    for (const block of [...message.content].reverse()) {
      if (block.type === 'toolResultBlock') {
        return textFromToolResultContent(block.content)
      }
    }
  }

  return undefined
}

const name = process.argv[2] ?? 'Abidh'
const result = await agent.invoke(
  `Use the hello tool with name "${name}" and reply with only the tool result.`
)

console.log(latestToolResultText() ?? result.toString())
