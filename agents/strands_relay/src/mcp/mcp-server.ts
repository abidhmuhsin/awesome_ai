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
import express from 'express'

// ── Create a new server with tools registered ──────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: 'visual-agent-mcp-server',
    version: '1.0.0',
  })
  registerHelloTool(server)
  return server
}

// ── Transport Modes ────────────────────────────────────────────────────────

async function startStdio() {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('MCP Server running on stdio')
}

async function startHttp(port: number) {
  const app = express()
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
        console.error(`tool:[${req.body.params.name}] args:(${JSON.stringify(req.body.params.arguments)})`)
      }
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      console.error(`[HTTP] error:`, error.message ?? error)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  app.listen(port, () => {
    console.error(`MCP Server running on http://localhost:${port}/mcp`)
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

      // connect() calls transport.start() which writes headers and the endpoint event
      await server.connect(transport)

      // Clean up when connection closes
      res.on('close', () => {
        transports.delete(transport.sessionId)
        console.error(`SSE session ${transport.sessionId} disconnected`)
      })

      console.error(`SSE session ${transport.sessionId} connected`)
    } catch (error) {
      console.error('Error handling SSE connection:', error)
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
        console.error(`tool:[${req.body.params.name}] args:(${JSON.stringify(req.body.params.arguments)})`)
      }

      await transport.handlePostMessage(req, res, req.body)
    } catch (error) {
      console.error(`[SSE] error:`, error.message ?? error)
      if (!res.headersSent) {
        res.writeHead(500).json({ error: 'Internal server error' })
      }
    }
  })

  app.listen(port, () => {
    console.error(`MCP SSE Server running on http://localhost:${port}/sse`)
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
