/**
 * UI Server - Express + WebSocket transport for the agent
 *
 * Serves the static UI from ../ui and exposes a WebSocket endpoint
 * for real-time chat with the agent.
 *
 * Usage:
 *   npm run ui              # start on port 3000
 *   npm run ui -- --port 4000
 */
import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { createOpenRouterUsageFetch, logUsage } from './telemetry/openrouter-usage.js'
import { helloTool, byebyeTool } from './tools/index.js'
import { mcpClient } from './mcp/index.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Model factory ──────────────────────────────────────────────────────────

function createModel() {
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

// ── Agent factory (one agent per connection) ───────────────────────────────

function createAgent() {
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

// ── Helpers ────────────────────────────────────────────────────────────────

function extractText(agent: Agent): string {
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
  return '(no response)'
}

function wasByebyeCalled(agent: Agent): boolean {
  for (const message of agent.messages) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock' && block.name === 'byebye') return true
    }
  }
  return false
}

// ── Server ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const port = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 3000

const app = express()
const server = createServer(app)

// Serve static UI files
const uiDir = path.resolve(__dirname, '..', 'ui')
app.use(express.static(uiDir))

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' })
})

// ── WebSocket ──────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws: WebSocket) => {
  const agent = createAgent()
  console.log(`[ws] client connected  (total: ${wss.clients.size})`)

  // Send welcome
  ws.send(JSON.stringify({ type: 'system', text: 'Connected to agent. Say hello!' }))

  ws.on('message', async (raw: Buffer) => {
    const text = raw.toString('utf-8').trim()
    if (!text) return

    // Acknowledge receipt
    ws.send(JSON.stringify({ type: 'user', text }))

    try {
      const result = await agent.invoke(text)
      const reply = extractText(agent)

      ws.send(JSON.stringify({ type: 'agent', text: reply }))

      if (wasByebyeCalled(agent)) {
        logUsage(result)
        ws.send(JSON.stringify({ type: 'system', text: 'Session ended.' }))
        ws.close()
      }
    } catch (err: any) {
      console.error('[ws] error:', err.message)
      ws.send(JSON.stringify({ type: 'error', text: err.message }))
    }
  })

  ws.on('close', () => {
    console.log(`[ws] client disconnected (total: ${wss.clients.size})`)
  })
})

// ── Start ──────────────────────────────────────────────────────────────────

server.listen(port, () => {
  console.log(`\n🌐  Visual Agent UI server running at http://localhost:${port}`)
  console.log(`    WebSocket endpoint: ws://localhost:${port}/ws\n`)
})
