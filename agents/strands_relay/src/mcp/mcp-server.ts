#!/usr/bin/env node
/**
 * MCP Server - Registers all tools
 *
 * Run: npm run mcp-server
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerHelloTool } from './tools/hello.js'

const server = new McpServer({
  name: 'visual-agent-mcp-server',
  version: '1.0.0',
})

// ── Register Tools ─────────────────────────────────────────────────────────

registerHelloTool(server)
// registerDatabaseTool(server)
// registerGithubTool(server)

// ── Start Server ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('MCP Server running on stdio')
}

main().catch(console.error)
