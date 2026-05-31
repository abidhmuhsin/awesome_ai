/**
 * Agent Factory — shared agent creation for all transports
 */
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { createOpenRouterUsageFetch } from '../telemetry/openrouter-usage.js'
import { helloTool, byebyeTool, widgetInstrTool, widgetRendererTool } from '../tools/index.js'
// TODO: widgetInstrTool & widgetRendererTool are UI-only. Accept a transport param
// and only include them for the websocket/UI server — not for telegram or CLI.
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
    maxTokens: 4096,
  })
}

export function createAgent() {
  return new Agent({
    model: createModel(),
    systemPrompt:
      'You are a friendly chat assistant. You have these tools:\n' +
      '- hello: use only when the user says hello or introduces themselves for the first time\n' +
      '- byebye: use only when the user explicitly says goodbye or wants to end the chat\n' +
      '- widget_instr: get CSS variables and layout rules. Call silently before your first widget render.\n' +
      '- widget_renderer: render SVG/HTML visual content inline.\n' +
      'For normal conversation, just reply naturally without calling any tool.',
    tools: [helloTool, byebyeTool, widgetInstrTool, widgetRendererTool, mcpClient],
    printer: false,
  })
}
