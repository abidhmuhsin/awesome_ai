/**
 * WebSocket Transport — Express + WS server
 *
 * Each connection gets its own agent instance for isolated sessions.
 */
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { logUsage } from '../../telemetry/openrouter-usage.js'
import { createAgent } from '../factory.js'
import { extractText, wasByebyeCalled } from '../helpers.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function startWebSocket(port = 3000) {
  const app = express()
  const server = createServer(app)

  // Serve static UI files (ui/ at project root)
  const uiDir = path.resolve(__dirname, '..', '..', '..', 'ui')
  app.use(express.static(uiDir))

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' })
  })

  // ── WebSocket ────────────────────────────────────────────────────

  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket) => {
    const agent = createAgent()
    console.log(`[ws] client connected  (total: ${wss.clients.size})`)

    ws.send(JSON.stringify({ type: 'system', text: 'Connected to agent. Say hello!' }))

    ws.on('message', async (raw: Buffer) => {
      const text = raw.toString('utf-8').trim()
      if (!text) return

      ws.send(JSON.stringify({ type: 'user', text }))

      try {
        const result = await agent.invoke(text)
        const reply = extractText(agent) ?? '(no response)'

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

  // ── Start ────────────────────────────────────────────────────────

  server.listen(port, () => {
    console.log(`\n🌐  Visual Agent UI server running at http://localhost:${port}`)
    console.log(`    WebSocket endpoint: ws://localhost:${port}/ws\n`)
  })
}
