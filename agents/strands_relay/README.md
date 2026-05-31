# Visual Agent

Minimal Strands Agents TypeScript example using the OpenAI API with custom tools and MCP (Model Context Protocol) integration.

## Features

- Custom `hello` and `byebye` local tools
- MCP (Model Context Protocol) integration with stdio, HTTP, and SSE transports
- OpenAI-compatible model support
- Zod schema validation for tool parameters

## Setup

```bash
npm install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`, or export it in your shell.
Optionally set `OPENAI_BASE_URL` for an OpenAI-compatible endpoint.

## Run

```bash
OPENAI_API_KEY=sk-your-key npm start -- Abidh
```

Expected output is the agent response based on the tool result:

```text
Hello, Abidh! This response came from the hello tool.
```

## Project Structure

```
src/
├── agent.ts              # Main agent entry point
├── mcp/
│   ├── index.ts          # MCP client exports
│   ├── mcp-clients.ts    # MCP client configurations (stdio, HTTP)
│   ├── mcp-server.ts     # MCP server with tool registration
│   └── tools/
│       └── hello.ts      # MCP hello tool
└── tools/
    ├── index.ts          # Local tool exports
    ├── hello.ts          # Local hello tool
    └── byebye.ts         # Local byebye tool
```

## Local Tools

The agent includes built-in local tools defined in `src/tools/`:

| Tool | Description | Parameters |
|------|-------------|------------|
| `hello` | Returns a greeting for a person by name | `name` (string) |
| `byebye` | Ends the conversation | none |

These tools are registered directly with the agent and use Zod schema validation for input parameters.

### Adding New Local Tools

1. Create a new file in `src/tools/` (e.g., `weather.ts`)
2. Export a tool using the `tool()` function from `@strands-agents/sdk`
3. Import and add the tool to the `tools` array in `agent.ts`

## MCP Tool Integration

This project includes MCP (Model Context Protocol) tool support for dynamic tool discovery and execution.

### Available MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `hellomcp` | Returns a greeting for a person by name | `name` (string) |

### Running MCP Server

The MCP server supports multiple transport modes:

```bash
# Stdio (default) - used by the agent
npm run mcp-server

# HTTP transport - for remote servers
npm run mcp-server:http

# SSE transport - for legacy clients
npm run mcp-server:sse
```

### MCP Client Transports

The agent uses stdio transport by default. For remote servers, use the HTTP transport:

```typescript
import { createHttpMcpClient } from './mcp/mcp-clients.js'

const remoteClient = createHttpMcpClient('http://localhost:8000/mcp')
// Or with authentication:
const authClient = createHttpMcpClient('https://api.example.com/mcp', {
  Authorization: `Bearer ${process.env.MCP_TOKEN}`,
})
```

### Adding New MCP Tools

1. Create a new tool file in `src/mcp/tools/` (e.g., `database.ts`)
2. Implement the `registerXxxTool(server: McpServer)` function with Zod schema validation:

```typescript
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerDatabaseTool(server: McpServer) {
  server.tool(
    'query',
    'Execute a database query',
    {
      sql: z.string().describe('The SQL query to execute'),
    },
    async ({ sql }) => {
      // Execute query and return results
      return {
        content: [{ type: 'text' as const, text: `Result: ...` }],
      }
    }
  )
}
```

3. Import and register the tool in `src/mcp/mcp-server.ts`:

```typescript
import { registerDatabaseTool } from './tools/database.js'
registerDatabaseTool(server)
```

### How It Works

- **MCP Server**: Registers tools and runs as a standalone process. Each tool uses Zod for parameter validation and returns structured responses.
- **MCP Client**: Spawns the server as a child process (stdio) or connects via HTTP for seamless agent integration.
- **Tool Registration**: Tools are registered in `mcp-server.ts` using the server's `tool()` method with name, description, schema, and handler.

See [Strands Agents MCP Documentation](https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/) for more details.
