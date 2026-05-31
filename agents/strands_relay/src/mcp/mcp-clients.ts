/**
 * MCP Clients
 *
 * Creates MCP client instances that connect to the MCP server.
 */
import { McpClient } from '@strands-agents/sdk'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export const mcpClient = new McpClient({
  applicationName: 'visual-agent',
  applicationVersion: '0.1.0',
  transport: new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp/mcp-server.ts'],
  }),
})
