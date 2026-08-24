/**
 * WebSocket Transport — Express + WS server
 *
 * Each connection gets its own agent instance for isolated sessions.
 */
import express from 'express'
import { createServer as createHttpServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { logUsage } from '../../telemetry/openrouter-usage.js'
import { createAgent } from '../factory.js'
import { BeforeToolCallEvent, AfterToolCallEvent } from '@strands-agents/sdk'
import { extractText, wasByebyeCalled } from '../helpers.js'
import path from 'path'
import { fileURLToPath } from 'url'
import { wsLogger as log } from '../../logger.js'
import { readMcpResource } from '../../mcp/resource-reader.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function startWebSocket(port = 3000) {
  const app = express()
  const server = createHttpServer(app)

  // Serve static UI files (ui/ at project root)
  const uiDir = path.resolve(__dirname, '..', '..', '..', 'ui')

  // Sandbox HTML needs CSP headers — serve before static middleware
  app.get('/sandbox.html', (_req, res) => {
    // Tightened: the proxy page runs only sandbox.js — no eval needed.
    // 'unsafe-eval' previously let injected content eval() inside the proxy
    // (same-origin with the host), which undermined the sandbox boundary.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'")
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.sendFile(path.join(uiDir, 'sandbox.html'))
  })

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

    // ── Register hook-based tool call streaming (once per connection) ──
    // These fire in real time during agent.invoke(), sending start/end
    // events so the UI can show tool calls as they happen.
    const toolStartMap = new Map<string, { startTime: number }>()

    const unsubBeforeToolCall = agent.addHook(BeforeToolCallEvent, (event) => {
      const args = typeof event.toolUse.input === 'object'
        ? JSON.stringify(event.toolUse.input)
        : String(event.toolUse.input ?? '')
      const toolId = event.toolUse.toolUseId

      toolStartMap.set(toolId, { startTime: Date.now() })
      log.tool(event.toolUse.name, args, undefined, `ws#${id}`)

      ws.send(JSON.stringify({
        type: 'tool_start',
        id: toolId,
        name: event.toolUse.name,
        args,
      }))
    })

    const unsubAfterToolCall = agent.addHook(AfterToolCallEvent, async (event) => {
      const toolId = event.toolUse.toolUseId
      const startData = toolStartMap.get(toolId)
      const duration = startData ? Date.now() - startData.startTime : 0
      const toolName = event.toolUse.name

      // Extract result text from content blocks
      let resultText = ''
      for (const block of event.result.content ?? []) {
        const b = block as any
        if (b.type === 'textBlock') resultText += b.text ?? ''
        else if (b.type === 'jsonBlock') resultText += JSON.stringify(b.json ?? '')
      }

      ws.send(JSON.stringify({
        type: 'tool_end',
        id: toolId,
        name: toolName,
        duration,
        status: event.error ? 'error' : 'success',
        result: resultText,
      }))

      // ── Deliver the tool's UI ──────────────────────────────────────
      // Generator tools (widget_renderer): the HTML is the model-generated
      // `widget_code` arg — already streamed to the client as tool_input_delta.
      // Send an authoritative finalize so the client swaps preview → sandbox.
      // Static-UI tools: read the HTML from the ui://tools/<name>/html resource
      // in-process (no HTTP hop); rendered client-side with no streaming.
      const toolUseId = event.toolUse.toolUseId
      if (toolName === 'widget_renderer') {
        const input = event.toolUse.input as { title?: string; widget_code?: string }
        if (input?.widget_code) {
          ws.send(JSON.stringify({
            type: 'mcp_ui',
            toolUseId,
            tool: toolName,
            title: input.title ?? toolName,
            html: input.widget_code,
            fullDoc: false,
            streamFinal: true,
          }))
        }
      } else {
        const resourceUri = `ui://tools/${toolName}/html`
        const html = await readMcpResource(resourceUri)
        if (html) {
          ws.send(JSON.stringify({ type: 'mcp_ui', toolUseId, tool: toolName, html, fullDoc: true }))
          log.info(`MCP UI resource found for ${toolName} (ws#${id})`)
        }
      }
    })

    ws.on('message', async (raw: Buffer) => {
      const text = raw.toString('utf-8').trim()
      if (!text) return

      log.incoming(`ws#${id}`, text)
      ws.send(JSON.stringify({ type: 'user', text }))

      try {
        // Send typing indicator
        ws.send(JSON.stringify({ type: 'typing', text: '' }))
        const t0 = Date.now()

        // ── Stream agent response ──────────────────────────────────
        let fullReply = ''
        let streamStarted = false
        // Active toolUse whose input the model is currently generating.
        // contentBlockIndex is not populated by the OpenAI chat adapter, so we
        // correlate tool-input deltas by "most recent toolUseStart" — cleared on
        // toolUseStop — matching the SDK's own single-accumulator model.
        // NOTE: if the provider interleaves two tools' input deltas in one turn,
        // this (like the SDK's own aggregation) misattributes them; concurrent
        // widget streaming is therefore best-effort. The Responses API would
        // collapse all tool input into a single delta, ending progressive render.
        let activeToolUse: { id: string; name: string } | null = null

        for await (const event of agent.stream(text)) {
          switch (event.type) {
            case 'modelStreamUpdateEvent': {
              // Handle streaming model events (block start/delta/stop)
              const delta = event.event
              if (delta.type === 'modelContentBlockStartEvent') {
                const start = (delta as any).start
                if (start && start.type === 'toolUseStart') {
                  activeToolUse = { id: start.toolUseId, name: start.name }
                }
              } else if (delta.type === 'modelContentBlockStopEvent') {
                activeToolUse = null
              } else if (delta.type === 'modelContentBlockDeltaEvent') {
                const contentDelta = delta.delta
                if (contentDelta.type === 'textDelta') {
                  if (!streamStarted) {
                    streamStarted = true
                    ws.send(JSON.stringify({ type: 'agent_stream_start', text: '' }))
                  }
                  fullReply += contentDelta.text
                  ws.send(JSON.stringify({ type: 'agent_stream_delta', text: contentDelta.text }))
                }
                // Stream widget_renderer (and any generator) tool input as it's
                // generated, tagged with the active toolUse so the client can
                // route it to the right progressive-render card.
                else if (contentDelta.type === 'toolUseInputDelta') {
                  if (activeToolUse) {
                    ws.send(JSON.stringify({
                      type: 'tool_input_delta',
                      toolUseId: activeToolUse.id,
                      tool: activeToolUse.name,
                      delta: contentDelta.input,
                    }))
                  }
                }
              }
              break
            }
            case 'contentBlockEvent': {
              // Content block completed - extract full text if needed
              const block = event.contentBlock
              if (block.type === 'textBlock' && block.text) {
                // Use this as the authoritative text (replaces accumulated deltas)
                fullReply = block.text
              }
              break
            }
            case 'toolStreamUpdateEvent': {
              // Tool is streaming progress updates
              const toolEvent = event.event
              if (toolEvent.data) {
                ws.send(JSON.stringify({
                  type: 'tool_stream_update',
                  id: event.invocationState?.toolUseId,
                  data: toolEvent.data,
                }))
              }
              break
            }
          }
        }

        const responseTime = Date.now() - t0

        // Send final complete response
        if (streamStarted) {
          ws.send(JSON.stringify({ type: 'agent_stream_end', text: fullReply }))
        } else {
          // No streaming occurred (e.g., tool-only response)
          const reply = extractText(agent) ?? '(no response)'
          ws.send(JSON.stringify({ type: 'agent', text: reply }))
        }

        log.outgoing(`ws#${id}`, fullReply || '(streamed)', responseTime)

        if (wasByebyeCalled(agent)) {
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
      unsubBeforeToolCall()
      unsubAfterToolCall()
      log.connection('disconnected', `client #${id} | Total clients: ${wss.clients.size}`)
    })
  })

  // ── Start ────────────────────────────────────────────────────────

  server.listen(port, () => {
    log.serverStart(`http://localhost:${port}`)
    log.info(`WebSocket endpoint: ws://localhost:${port}/ws`)
  })
}
