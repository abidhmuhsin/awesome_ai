#!/usr/bin/env node
/**
 * MCP Server - Registers all tools
 *
 * Supports multiple transport modes:
 *   npm run mcp-server              # stdio (default)
 *   npm run mcp-server -- --http    # HTTP on port 8000
 *   npm run mcp-server -- --sse     # SSE on port 8000
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { registerHelloTool } from './tools/hello.js'
import { registerHelloWithUiTool } from './tools/hello-with-ui.js'
import express from 'express'
import cors from 'cors'
import { mcpLogger as log } from '../logger.js'

// ── Create a new server with tools registered ──────────────────────────────

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'visual-agent-mcp-server',
    version: '1.0.0',
  })
  registerHelloTool(server)
  registerHelloWithUiTool(server)
  return server
}

// ── Transport Modes ────────────────────────────────────────────────────────

async function startStdio() {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log.ready('stdio transport')
}

async function startHttp(port: number) {
  const app = express()
  // CORS needed because browser-based MCP clients make cross-origin requests to this server.
  // Restrict to localhost for development; update origin list for production.
  app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080'] }))
  app.use(express.json())

  const transports = new Map<string, StreamableHTTPServerTransport>()

  app.post('/mcp', async (req, res) => {
    try {
      const server = createServer()
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      })
      await server.connect(transport)
      if (req.body?.method === 'tools/call') {
        const t0 = Date.now()
        await transport.handleRequest(req, res, req.body)
        log.tool(req.body.params.name, JSON.stringify(req.body.params.arguments), Date.now() - t0)
      } else {
        await transport.handleRequest(req, res, req.body)
      }
    } catch (error: any) {
      log.error(error.message ?? error, 'HTTP')
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  app.listen(port, () => {
    log.serverStart(`http://localhost:${port}/mcp [HTTP]`)
  })
}

async function startSse(port: number) {
  const app = express()
  app.use(express.json())

  const transports = new Map<string, SSEServerTransport>()

  // SSE connection endpoint
  app.get('/sse', async (req, res) => {
    try {
      const server = createServer()
      const transport = new SSEServerTransport('/messages', res)
      transports.set(transport.sessionId, transport)

      log.connection('connected', `SSE session ${transport.sessionId}`)

      // Clean up when connection closes
      res.on('close', () => {
        transports.delete(transport.sessionId)
        log.connection('disconnected', `SSE session ${transport.sessionId}`)
      })

      // connect() calls transport.start() which writes headers and the endpoint event
      // This is long-running for SSE — blocks until connection closes
      await server.connect(transport)
    } catch (error) {
      log.error('SSE', `Connection error: ${error}`)
      if (!res.headersSent) {
        res.writeHead(500)
      }
      res.end()
    }
  })

  // Message endpoint for client POSTs
  app.post('/messages', async (req, res) => {
    try {
      const sessionId = req.query.sessionId as string
      const transport = transports.get(sessionId)
      
      if (!transport) {
        res.writeHead(400).json({ error: 'Invalid or missing sessionId' })
        return
      }

      if (req.body?.method === 'tools/call') {
        const t0 = Date.now()
        await transport.handlePostMessage(req, res, req.body)
        log.tool(req.body.params.name, JSON.stringify(req.body.params.arguments), Date.now() - t0)
      } else {
        await transport.handlePostMessage(req, res, req.body)
      }
    } catch (error: any) {
      log.error(error.message ?? error, 'SSE')
      if (!res.headersSent) {
        res.writeHead(500).json({ error: 'Internal server error' })
      }
    }
  })

  app.listen(port, () => {
    log.serverStart(`http://localhost:${port}/sse [SSE]`)
  })
}

// ── Parse Args & Start ─────────────────────────────────────────────────────

const args = process.argv.slice(2)
const mode = args[0] || '--stdio'
const port = parseInt(args[1] || '8000')

switch (mode) {
  case '--http':
    startHttp(port).catch(console.error)
    break
  case '--sse':
    startSse(port).catch(console.error)
    break
  default:
    startStdio().catch(console.error)
}
