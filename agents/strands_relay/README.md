# Visual Agent

Minimal Strands Agents TypeScript example using the OpenAI API with custom tools and MCP (Model Context Protocol) integration.

## Features

- Custom `hello` and `byebye` tools
- MCP (Model Context Protocol) tool integration
- OpenAI-compatible model support

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

### Running MCP Server Standalone

```bash
npm run mcp-server
```

### Adding New MCP Tools

1. Create a new tool file in `src/mcp/tools/` (e.g., `database.ts`)
2. Implement the `registerXxxTool(server: McpServer)` function with Zod schema validation
3. Import and register the tool in `src/mcp/mcp-server.ts`

### How It Works

- **MCP Server**: Registers tools and runs as a standalone stdio process. Each tool uses Zod for parameter validation and returns structured responses.
- **MCP Client**: Spawns the server as a child process and connects via stdio transport for seamless agent integration.
- **Tool Registration**: Tools are registered in `mcp-server.ts` using the server's `tool()` method with name, description, schema, and handler.

See [Strands Agents MCP Documentation](https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/) for more details.
