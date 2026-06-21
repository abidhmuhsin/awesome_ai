/**
 * Hello Tool with UI Resource
 * 
 * A hello tool that includes an interactive UI resource
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const HELLO_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hello MCP Tool</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      padding: 20px;
      background: #f8fafc;
    }
    .container {
      max-width: 400px;
      margin: 0 auto;
    }
    h1 {
      font-size: 24px;
      color: #1e293b;
      margin-bottom: 16px;
    }
    .input-group {
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-weight: 500;
      margin-bottom: 4px;
      color: #374151;
    }
    input {
      width: 100%;
      padding: 10px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 14px;
    }
    button {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      font-weight: 500;
      cursor: pointer;
    }
    button:hover {
      background: #2563eb;
    }
    .result {
      margin-top: 20px;
      padding: 16px;
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
    }
    .greeting {
      font-size: 20px;
      color: #059669;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Hello MCP Tool</h1>
    <div class="input-group">
      <label for="name">Name:</label>
      <input type="text" id="name" value="World" placeholder="Enter name">
    </div>
    <button onclick="sayHello()">Say Hello</button>
    <div class="result" id="result" style="display:none;">
      <div class="greeting" id="greeting"></div>
    </div>
  </div>
  <script>
    function sayHello() {
      const name = document.getElementById('name').value || 'World';
      document.getElementById('greeting').textContent = 'Hello, ' + name + '!';
      document.getElementById('result').style.display = 'block';
    }
  </script>
</body>
</html>`

export function registerHelloWithUiTool(server: McpServer) {
  server.tool(
    'hellomcp-ui',
    'Return a simple greeting for a person by name, with an interactive UI',
    {
      name: z.string().describe('The name of the person to greet'),
    },
    async ({ name }) => ({
      content: [{ type: 'text', text: `Hello, ${name}! 👋` }],
    }),
  )

  // Register UI resource for the tool
  server.resource(
    'hellomcp-ui',
    'ui://tools/hellomcp-ui/html',
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/html;profile=mcp-app',
          text: HELLO_UI_HTML,
        },
      ],
    }),
  )
}
