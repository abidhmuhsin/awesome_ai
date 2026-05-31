import type { AgentResult } from '@strands-agents/sdk'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { agentLogger as log } from '../logger.js'

export interface OpenRouterUsage {
  completion_tokens?: number
  completion_tokens_details?: {
    reasoning_tokens?: number
    image_tokens?: number
    audio_tokens?: number
  }
  cost?: number
  cost_details?: {
    upstream_inference_cost?: number
    upstream_inference_prompt_cost?: number
    upstream_inference_completions_cost?: number
  }
  is_byok?: boolean
  prompt_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_write_tokens?: number
    audio_tokens?: number
    video_tokens?: number
  }
  total_tokens?: number
}

function generateSessionId(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  return `${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}`
}

let accumulatedOpenRouterUsage: OpenRouterUsage | undefined

const SESSION_ID = generateSessionId()
let cycleCounter = 0

const LOG_DIR = join(process.cwd(), 'usage-logs')
const LOG_FILE = join(LOG_DIR, 'openrouter-usage.csv')

function initLogFile(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
  if (!existsSync(LOG_FILE)) {
    const header = 'timestamp,sessionId,cycle,user,system,response,prompt,completion,total,reasoning,cacheRead,cacheWrite,cost,upstreamCost\n'
    appendFileSync(LOG_FILE, header)
  }
}

function addNumbers(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined
  }

  return (a ?? 0) + (b ?? 0)
}

function accumulateOpenRouterUsage(usage: OpenRouterUsage): void {
  accumulatedOpenRouterUsage = {
    prompt_tokens: addNumbers(
      accumulatedOpenRouterUsage?.prompt_tokens,
      usage.prompt_tokens
    ),
    completion_tokens: addNumbers(
      accumulatedOpenRouterUsage?.completion_tokens,
      usage.completion_tokens
    ),
    total_tokens: addNumbers(
      accumulatedOpenRouterUsage?.total_tokens,
      usage.total_tokens
    ),
    cost: addNumbers(accumulatedOpenRouterUsage?.cost, usage.cost),
    is_byok: accumulatedOpenRouterUsage?.is_byok ?? usage.is_byok,
    prompt_tokens_details: {
      cached_tokens: addNumbers(
        accumulatedOpenRouterUsage?.prompt_tokens_details?.cached_tokens,
        usage.prompt_tokens_details?.cached_tokens
      ),
      cache_write_tokens: addNumbers(
        accumulatedOpenRouterUsage?.prompt_tokens_details?.cache_write_tokens,
        usage.prompt_tokens_details?.cache_write_tokens
      ),
      audio_tokens: addNumbers(
        accumulatedOpenRouterUsage?.prompt_tokens_details?.audio_tokens,
        usage.prompt_tokens_details?.audio_tokens
      ),
      video_tokens: addNumbers(
        accumulatedOpenRouterUsage?.prompt_tokens_details?.video_tokens,
        usage.prompt_tokens_details?.video_tokens
      ),
    },
    completion_tokens_details: {
      reasoning_tokens: addNumbers(
        accumulatedOpenRouterUsage?.completion_tokens_details?.reasoning_tokens,
        usage.completion_tokens_details?.reasoning_tokens
      ),
      image_tokens: addNumbers(
        accumulatedOpenRouterUsage?.completion_tokens_details?.image_tokens,
        usage.completion_tokens_details?.image_tokens
      ),
      audio_tokens: addNumbers(
        accumulatedOpenRouterUsage?.completion_tokens_details?.audio_tokens,
        usage.completion_tokens_details?.audio_tokens
      ),
    },
    cost_details: {
      upstream_inference_cost: addNumbers(
        accumulatedOpenRouterUsage?.cost_details?.upstream_inference_cost,
        usage.cost_details?.upstream_inference_cost
      ),
      upstream_inference_prompt_cost: addNumbers(
        accumulatedOpenRouterUsage?.cost_details?.upstream_inference_prompt_cost,
        usage.cost_details?.upstream_inference_prompt_cost
      ),
      upstream_inference_completions_cost: addNumbers(
        accumulatedOpenRouterUsage?.cost_details?.upstream_inference_completions_cost,
        usage.cost_details?.upstream_inference_completions_cost
      ),
    },
  }
}

/**
 * Extracts the user's latest message text and guesses the SSE stream role from the request body.
 */
function extractUserAndLabel(init: RequestInit | undefined): { userText: string; label: string } {
  try {
    const raw = init?.body
    if (typeof raw !== 'string') return { userText: '', label: '' }
    const body = JSON.parse(raw)
    const messages: Array<{ role: string; content?: unknown; tool_calls?: Array<unknown> }> = body.messages ?? []

    // Get the last user message text
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const userContent = lastUser?.content
    let userText = ''
    if (typeof userContent === 'string') {
      userText = userContent.replace(/"/g, "'").slice(0, 25)
    } else if (Array.isArray(userContent)) {
      const textParts = userContent
        .filter((c: any) => c?.type === 'text' || c?.type === 'textBlock')
        .map((c: any) => c.text ?? '')
      const joined = textParts.join(' ').replace(/"/g, "'").slice(0, 25)
      if (joined) userText = joined
    }

    // Check if any message has role 'tool' (tool result has been returned)
    const hasToolResults = messages.some((m) => m.role === 'tool')

    // Find the last assistant message to see if it had tool_calls
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    const toolCalls = (lastAssistant?.tool_calls ?? []) as Array<{ function?: { name?: string } }>
    const hasToolCalls = toolCalls.length > 0

    let label: string
    if (hasToolResults && hasToolCalls) {
      // Follow-up call — model responds after receiving tool results
      const toolName = toolCalls[0]?.function?.name ?? '?'
      label = `tool-result:${toolName}`
    } else if (body.tools?.length > 0) {
      // First call — model is deciding which tool to use
      const names = (body.tools as Array<{ function?: { name?: string } }>).map((t) => t.function?.name ?? '?').join(',')
      label = `tool-decision:[${names}]`
    } else if (userText) {
      label = 'chat'
    } else {
      label = ''
    }

    return { userText, label }
  } catch {
    return { userText: '', label: '' }
  }
}

export function createOpenRouterUsageFetch(
  baseFetch: typeof fetch = fetch
): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init)

    if (!response.body) {
      return response
    }

    const contentType = response.headers.get('content-type') ?? ''

    if (!contentType.includes('text/event-stream')) {
      return response
    }

    // Derive user text and label from the request body before streaming
    const { userText: requestUserText, label: requestLabel } = extractUserAndLabel(init)

    // Track content seen during streaming to refine the label
    let isToolCall = false
    let streamedText = ''
    let capturedToolName = ''
    let capturedToolArgs = ''

    const decoder = new TextDecoder()
    let pending = ''

    const stream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const text = decoder.decode(chunk, { stream: true })
          // Scan for tool call name or text content in SSE data
          const lines = text.split(/\r?\n/)
          for (const line of lines) {
            if (!line.trim().startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (!data || data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{
                  delta?: {
                    tool_calls?: Array<{
                      function?: { name?: string; arguments?: string }
                    }>
                    content?: string
                  }
                }>
              }
              const delta = parsed.choices?.[0]?.delta
              if (delta?.tool_calls) {
                isToolCall = true
                for (const tc of delta.tool_calls) {
                  if (tc.function?.name) {
                    capturedToolName = tc.function.name
                  }
                  if (tc.function?.arguments) {
                    capturedToolArgs += tc.function.arguments
                  }
                }
              }
              if (delta?.content && !isToolCall) {
                streamedText += delta.content
              }
            } catch {
              // ignore non-json
            }
          }

          pending = captureOpenRouterUsageChunk(
            pending + text,
            requestLabel,
            requestUserText,
            isToolCall,
            capturedToolName || (requestLabel.includes('tool-result') ? capturedToolName : ''),
            streamedText,
            capturedToolArgs
          )
          controller.enqueue(chunk)
        },
        flush() {
          const remaining = pending + decoder.decode()
          if (remaining) {
            captureOpenRouterUsageLine(
              remaining,
              requestLabel,
              requestUserText,
              isToolCall,
              capturedToolName || (requestLabel.includes('tool-result') ? capturedToolName : ''),
              streamedText,
              capturedToolArgs
            )
          }
        },
      })
    )

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

// ── module-level SSE parsing state ──────────────────────────────

function logCallToFile(usage: OpenRouterUsage, userText: string, systemLabel: string, response: string): void {
  try {
    initLogFile()
    const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? ''
    const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? ''
    const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? ''
    const cost = usage.cost ?? ''
    const upstreamCost = usage.cost_details?.upstream_inference_cost ?? ''
    const escapedUser = userText.replace(/"/g, '""')
    const escapedSystem = systemLabel.replace(/"/g, '""')
    const escapedResponse = response.replace(/"/g, '""').replace(/\n/g, ' ').slice(0, 25)
    const line = `${new Date().toISOString()},${SESSION_ID},${cycleCounter},"${escapedUser}","${escapedSystem}","${escapedResponse}",${usage.prompt_tokens ?? ''},${usage.completion_tokens ?? ''},${usage.total_tokens ?? ''},${reasoning},${cacheRead},${cacheWrite},${cost},${upstreamCost}\n`
    appendFileSync(LOG_FILE, line)
  } catch {
    // Silently skip file write errors
  }
}

function buildFinalSystemLabel(
  requestLabel: string,
  isToolCall: boolean,
  toolName: string,
  streamedText: string
): string {
  if (toolName) {
    return `tool:${toolName}`
  }
  // If model streamed text and didn't call any tool, it's plain chat
  if (streamedText && !isToolCall && !toolName) {
    return 'chat'
  }
  if (isToolCall && requestLabel.startsWith('tool-decision')) {
    return requestLabel
  }
  if (requestLabel.startsWith('tool-result')) {
    return requestLabel
  }
  return requestLabel || 'unknown'
}

function captureOpenRouterUsageLine(
  line: string,
  requestLabel: string,
  requestUserText: string,
  isToolCall: boolean,
  toolName: string,
  streamedText: string,
  toolArgs: string
): void {
  const trimmed = line.trim()

  if (!trimmed.startsWith('data:')) {
    return
  }

  const data = trimmed.slice('data:'.length).trim()

  if (!data || data === '[DONE]') {
    return
  }

  try {
    const parsed = JSON.parse(data) as { usage?: OpenRouterUsage }

    if (parsed.usage) {
      cycleCounter++
      const systemLabel = buildFinalSystemLabel(requestLabel, isToolCall, toolName, streamedText)
      // Format response: tool calls show name+args, chat shows text
      let response: string
      if (isToolCall && toolName) {
        const args = toolArgs.replace(/\n/g, ' ').slice(0, 25)
        response = `${toolName}(${args})`
      } else {
        response = streamedText
      }
      accumulateOpenRouterUsage(parsed.usage)
      logCallToFile(parsed.usage, requestUserText, systemLabel, response)
    }
  } catch {
    // Ignore non-JSON SSE lines.
  }
}

function captureOpenRouterUsageChunk(
  chunk: string,
  requestLabel: string,
  requestUserText: string,
  isToolCall: boolean,
  toolName: string,
  streamedText: string,
  toolArgs: string
): string {
  const lines = chunk.split(/\r?\n/)
  const partial = lines.pop() ?? ''

  for (const line of lines) {
    captureOpenRouterUsageLine(line, requestLabel, requestUserText, isToolCall, toolName, streamedText, toolArgs)
  }

  return partial
}

function formatOpenRouterUsage(usage: OpenRouterUsage): string {
  const parts = [
    `prompt=${usage.prompt_tokens ?? 0}`,
    `completion=${usage.completion_tokens ?? 0}`,
    `total=${usage.total_tokens ?? 0}`,
  ]

  if (usage.completion_tokens_details?.reasoning_tokens !== undefined) {
    parts.push(`reasoning=${usage.completion_tokens_details.reasoning_tokens}`)
  }

  if (usage.prompt_tokens_details?.cached_tokens !== undefined) {
    parts.push(`cacheRead=${usage.prompt_tokens_details.cached_tokens}`)
  }

  if (usage.prompt_tokens_details?.cache_write_tokens !== undefined) {
    parts.push(`cacheWrite=${usage.prompt_tokens_details.cache_write_tokens}`)
  }

  if (usage.cost !== undefined) {
    parts.push(`cost=${usage.cost}`)
  }

  if (usage.cost_details?.upstream_inference_cost !== undefined) {
    parts.push(`upstreamCost=${usage.cost_details.upstream_inference_cost}`)
  }

  return `OpenRouter usage: ${parts.join(', ')}`
}

export function formatUsage(result: AgentResult): string {
  if (accumulatedOpenRouterUsage) {
    return formatOpenRouterUsage(accumulatedOpenRouterUsage)
  }

  const usage = result.metrics?.accumulatedUsage

  if (!usage) {
    return 'Token usage: unavailable'
  }

  const parts = [
    `input=${usage.inputTokens}`,
    `output=${usage.outputTokens}`,
    `total=${usage.totalTokens}`,
  ]

  if (usage.cacheReadInputTokens) {
    parts.push(`cacheRead=${usage.cacheReadInputTokens}`)
  }

  if (usage.cacheWriteInputTokens) {
    parts.push(`cacheWrite=${usage.cacheWriteInputTokens}`)
  }

  return `Token usage: ${parts.join(', ')}`
}

export function logUsage(result: AgentResult): void {
  const usageStr = formatUsage(result)
  log.info(usageStr)
  log.info(`Per-call usage logged to: ${LOG_FILE}`)
}
