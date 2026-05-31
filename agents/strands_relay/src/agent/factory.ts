/**
 * Agent Factory — shared agent creation for all transports
 */
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { createOpenRouterUsageFetch } from '../telemetry/openrouter-usage.js'
import { helloTool, byebyeTool } from '../tools/index.js'
import { mcpClient } from '../mcp/index.js'

export function createModel() {
  return new OpenAIModel({
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
}

export function createAgent() {
  return new Agent({
    model: createModel(),
    systemPrompt:
      'You are a friendly chat assistant. You have two tools:\n' +
      '- hello: use only when the user says hello or introduces themselves for the first time\n' +
      '- byebye: use only when the user explicitly says goodbye or wants to end the chat\n' +
      'For normal conversation, just reply naturally without calling any tool.',
    tools: [helloTool, byebyeTool, mcpClient],
    printer: false,
  })
}
