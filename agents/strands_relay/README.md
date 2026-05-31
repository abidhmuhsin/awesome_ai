# Visual Agent

Minimal Strands Agents TypeScript example using the OpenAI API and a custom `hello` tool.

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
