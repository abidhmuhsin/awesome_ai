/**
 * Hello Tool Definition
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerHelloTool(server: McpServer) {
  server.tool(
    'hellomcp',
    'Return a simple greeting for a person by name',
    {
      name: z.string().min(1).describe('The name to greet'),
    },
    async ({ name }) => {
      return {
        content: [{ type: 'text' as const, text: `Hello, ${name}! This response came from the MCP hello tool.` }],
      }
    }
  )
}
