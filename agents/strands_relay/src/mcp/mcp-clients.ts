/**
 * MCP Clients
 *
 * Creates MCP client instances that connect to MCP servers.
 */
import { McpClient } from '@strands-agents/sdk'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// ── Stdio Transport (local server) ─────────────────────────────────────────

export const mcpClient = new McpClient({
  applicationName: 'visual-agent',
  applicationVersion: '0.1.0',
  transport: new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp/mcp-server.ts'],
  }),
})

// ── HTTP Transport (remote server) ─────────────────────────────────────────

export function createHttpMcpClient(url: string, headers?: Record<string, string>): McpClient {
  return new McpClient({
    applicationName: 'visual-agent',
    applicationVersion: '0.1.0',
    transport: new StreamableHTTPClientTransport(
      new URL(url),
      headers ? { requestInit: { headers } } : undefined
    ),
  })
}

// ── SSE Transport (legacy remote server) ───────────────────────────────────

// import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
//
// export function createSseMcpClient(url: string, headers?: Record<string, string>): McpClient {
//   return new McpClient({
//     applicationName: 'visual-agent',
//     applicationVersion: '0.1.0',
//     transport: new SSEClientTransport(
//       new URL(url),
//       headers ? { requestInit: { headers } } : undefined
//     ),
//   })
// }

// ── Example Usage ──────────────────────────────────────────────────────────

// For HTTP server:
// const httpClient = createHttpMcpClient('http://localhost:8000/mcp')
// const httpClient = createHttpMcpClient('https://api.example.com/mcp', {
//   Authorization: `Bearer ${process.env.MCP_TOKEN}`,
// })
