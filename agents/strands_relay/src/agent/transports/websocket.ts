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
import { wsLogger as log } from '../../logger.js'

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

  log.init('Express server configured')

  // ── WebSocket ────────────────────────────────────────────────────

  const wss = new WebSocketServer({ server, path: '/ws' })
  let connId = 0

  wss.on('connection', (ws: WebSocket) => {
    const id = ++connId
    const agent = createAgent()
    log.connection('connected', `client #${id} | Total clients: ${wss.clients.size}`)

    ws.send(JSON.stringify({ type: 'system', text: 'Connected to agent. Say hello!' }))

    ws.on('message', async (raw: Buffer) => {
      const text = raw.toString('utf-8').trim()
      if (!text) return

      log.incoming(`ws#${id}`, text)
      ws.send(JSON.stringify({ type: 'user', text }))

      try {
        const t0 = Date.now()
        const result = await agent.invoke(text)
        const reply = extractText(agent) ?? '(no response)'
        const responseTime = Date.now() - t0

        ws.send(JSON.stringify({ type: 'agent', text: reply }))
        log.outgoing(`ws#${id}`, reply, responseTime)

        if (wasByebyeCalled(agent)) {
          logUsage(result)
          ws.send(JSON.stringify({ type: 'system', text: 'Session ended.' }))
          ws.close()
        }
      } catch (err: any) {
        // Log the full error message for debugging
        log.error(err.message ?? String(err), `ws#${id}`)
        ws.send(JSON.stringify({ type: 'error', text: err.message ?? 'Unknown error' }))
      }
    })

    ws.on('close', () => {
      log.connection('disconnected', `client #${id} | Total clients: ${wss.clients.size}`)
    })
  })

  // ── Start ────────────────────────────────────────────────────────

  server.listen(port, () => {
    log.serverStart(`http://localhost:${port}`)
    log.info(`WebSocket endpoint: ws://localhost:${port}/ws`)
  })
}
