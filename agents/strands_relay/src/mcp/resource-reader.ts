/**
 * MCP resource reader — reads tool UI resources (e.g. `ui://tools/<name>/html`)
 * through the agent's existing MCP client connection.
 *
 * Strands' McpClient only wraps tool calls (listTools/callTool), not
 * resources, but it exposes the underlying SDK Client via its public `client`
 * getter. We use that to call `readResource`, reusing the single stdio
 * connection the agent already maintains — no extra server instance, no HTTP
 * hop, no per-request allocation.
 */
import { mcpClient } from './mcp-clients.js'

/**
 * Read an MCP resource's first text content by URI.
 * Returns null when the resource doesn't exist or has no text (e.g. a tool
 * without a UI), so callers can treat "no UI" as a normal, non-error case.
 */
export async function readMcpResource(uri: string): Promise<string | null> {
  try {
    // Idempotent: a no-op once the agent has connected the client.
    await mcpClient.connect()
    const result = await mcpClient.client.readResource({ uri })
    const content = result.contents?.[0]
    return content && 'text' in content ? content.text : null
  } catch {
    return null
  }
}
