/**
 * Centralized Logger — Clean, minimal formatting
 *
 * Inspired by old Telegram's clean aesthetic with simple unicode symbols.
 */

// ── Minimal Symbol Constants ──────────────────────────────────────

export const ICONS = {
  // Message flow — simple arrows
  INCOMING: '→',
  OUTGOING: '←',

  // Status — minimal checkmarks
  SUCCESS: '✓',
  ERROR: '✗',
  WARNING: '!',
  INFO: '·',

  // Session
  SESSION_START: '▸',
  SESSION_END: '▹',

  // Server
  SERVER_START: '▸',
  SERVER_STOP: '▹',
  CONNECTION: '◆',
  DISCONNECTION: '◇',

  // Tool
  TOOL: '⚙',

  // System
  INIT: '○',
  READY: '●',
  POLLING: '◎',
} as const

// ── Color Codes (ANSI) ──────────────────────────────────────────

export const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
} as const

// ── Formatting Helpers ───────────────────────────────────────────

/**
 * Get current timestamp in HH:MM:SS format
 */
export function timestamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false })
}

/**
 * Format elapsed time as human-readable string
 */
export function elapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60000)
  const seconds = ((ms % 60000) / 1000).toFixed(0)
  return `${minutes}m ${seconds}s`
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, max: number = 50): string {
  const cleaned = text.replace(/\n+/g, ' ↵ ').replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? cleaned.slice(0, max) + '…' : cleaned
}

/**
 * Format chat ID for display
 */
export function chatId(id: number | string): string {
  return String(id)
}

/**
 * Wrap text with ANSI color
 */
export function color(text: string, colorCode: string): string {
  return `${colorCode}${text}${COLORS.reset}`
}

/**
 * Create a padded label
 */
export function label(text: string, width: number = 8): string {
  return text.padEnd(width)
}

// ── Log Formatters ───────────────────────────────────────────────

/**
 * Format incoming message log
 * 
 * Example:  12:34:56  → 6469196143  →  Hello, how are you?
 */
export function incomingMessage(chat: number | string, text: string): string {
  return `${color(timestamp(), COLORS.dim)}  ${color(ICONS.INCOMING, COLORS.green)}  ${color(chatId(chat), COLORS.cyan)}  ${truncate(text)}`
}

/**
 * Format outgoing message log
 * 
 * Example:  12:34:57  ← 6469196143  ←  I'm doing well, thanks! (1.2s)
 */
export function outgoingMessage(chat: number | string, text: string, duration?: number): string {
  const durationStr = duration !== undefined ? `  ${color(`(${elapsed(duration)})`, COLORS.dim)}` : ''
  return `${color(timestamp(), COLORS.dim)}  ${color(ICONS.OUTGOING, COLORS.magenta)}  ${color(chatId(chat), COLORS.cyan)}  ${truncate(text)}${durationStr}`
}

/**
 * Format error log
 * 
 * Example:  12:34:58  ✗ 6469196143  Error message
 */
export function error(chat: number | string, message: string): string {
  return `${color(timestamp(), COLORS.dim)}  ${color(ICONS.ERROR, COLORS.red)}  ${color(chatId(chat), COLORS.red)}  ${message}`
}

/**
 * Format tool usage log
 * 
 * Example:  12:34:59  ⚙ ws#3  TOOL  hello  ({name: "World"})
 */
export function toolUse(toolName: string, args: string, duration?: number, chat?: number | string): string {
  const durationStr = duration !== undefined ? `  ${color(`(${elapsed(duration)})`, COLORS.dim)}` : ''
  const chatStr = chat !== undefined ? `  ${color(chatId(chat), COLORS.cyan)}` : ''
  return `${color(timestamp(), COLORS.dim)}  ${color(ICONS.TOOL, COLORS.yellow)}${chatStr}  ${color('TOOL', COLORS.yellow)}  ${color(toolName, COLORS.yellow)}  ${color(`(${truncate(args, 30)})`, COLORS.dim)}${durationStr}`
}

/**
 * Format session event log
 */
export function sessionStart(chat: number | string): string {
  return `${color(timestamp(), COLORS.dim)}  ${color(chatId(chat), COLORS.cyan)}  ${ICONS.SESSION_START}  session started`
}

export function sessionEnd(chat: number | string): string {
  return `${color(timestamp(), COLORS.dim)}  ${color(chatId(chat), COLORS.cyan)}  ${ICONS.SESSION_END}  session ended`
}

/**
 * Format server events
 */
export function serverStart(service: string, details?: string): string {
  const detailsStr = details ? `  ${color(details, COLORS.dim)}` : ''
  return `${color(timestamp(), COLORS.dim)}  ${color(ICONS.SERVER_START, COLORS.green)}  ${color(service, COLORS.green)}  started${detailsStr}`
}

export function serverStop(service: string): string {
  return `${color(timestamp(), COLORS.dim)}  ${color(ICONS.SERVER_STOP, COLORS.yellow)}  ${color(service, COLORS.yellow)}  stopped`
}

/**
 * Format connection events
 */
export function connection(event: 'connected' | 'disconnected', service: string, details?: string): string {
  const icon = event === 'connected' ? ICONS.CONNECTION : ICONS.DISCONNECTION
  const colorCode = event === 'connected' ? COLORS.green : COLORS.yellow
  const detailsStr = details ? `  ${color(details, COLORS.dim)}` : ''
  return `${color(timestamp(), COLORS.dim)}  ${color(icon, colorCode)}  ${color(service, colorCode)}  ${event}${detailsStr}`
}

/**
 * Format initialization log
 */
export function init(service: string, details?: string): string {
  const detailsStr = details ? `  ${color(details, COLORS.dim)}` : ''
  return `${color(timestamp(), COLORS.dim)}  ${color(ICONS.INIT, COLORS.blue)}  ${color(service, COLORS.blue)}  init${detailsStr}`
}

/**
 * Format ready log
 */
export function ready(service: string, details?: string): string {
  const detailsStr = details ? `  ${color(details, COLORS.dim)}` : ''
  return `${color(timestamp(), COLORS.dim)}  ${color(ICONS.READY, COLORS.green)}  ${color(service, COLORS.green)}  ready${detailsStr}`
}

/**
 * Format polling log
 */
export function polling(service: string): string {
  return `${color(timestamp(), COLORS.dim)}  ${color(ICONS.POLLING, COLORS.cyan)}  ${color(service, COLORS.cyan)}  polling`
}

/**
 * Format usage statistics
 */
export function usage(stats: {
  prompt?: number
  completion?: number
  total?: number
  cost?: number
  duration?: number
}): string {
  const parts: string[] = []
  
  if (stats.prompt !== undefined) parts.push(`prompt=${stats.prompt}`)
  if (stats.completion !== undefined) parts.push(`completion=${stats.completion}`)
  if (stats.total !== undefined) parts.push(`total=${stats.total}`)
  if (stats.cost !== undefined) parts.push(`cost=$${stats.cost.toFixed(4)}`)
  if (stats.duration !== undefined) parts.push(`time=${elapsed(stats.duration)}`)
  
  return `${color(timestamp(), COLORS.dim)}  ${ICONS.INFO} ${color('USAGE', COLORS.magenta)}  ${color(parts.join(' │ '), COLORS.dim)}`
}

// ── Logger Class ─────────────────────────────────────────────────

export class Logger {
  private prefix: string

  constructor(prefix: string) {
    this.prefix = prefix
  }

  info(message: string): void {
    console.log(`${color(timestamp(), COLORS.dim)}  ${color(ICONS.INFO, COLORS.blue)}  ${color(this.prefix, COLORS.blue)}  ${message}`)
  }

  success(message: string): void {
    console.log(`${color(timestamp(), COLORS.dim)}  ${color(ICONS.SUCCESS, COLORS.green)}  ${color(this.prefix, COLORS.green)}  ${message}`)
  }

  warn(message: string): void {
    console.log(`${color(timestamp(), COLORS.dim)}  ${color(ICONS.WARNING, COLORS.yellow)}  ${color(this.prefix, COLORS.yellow)}  ${message}`)
  }

  error(message: string, details?: string): void {
    const detailsStr = details ? ` ${color(details, COLORS.dim)}` : ''
    console.error(`${color(timestamp(), COLORS.dim)}  ${color(ICONS.ERROR, COLORS.red)}  ${color(this.prefix, COLORS.red)}  ${message}${detailsStr}`)
  }

  incoming(chat: number | string, text: string): void {
    console.log(incomingMessage(chat, text))
  }

  outgoing(chat: number | string, text: string, duration?: number): void {
    console.log(outgoingMessage(chat, text, duration))
  }

  tool(name: string, args: string, duration?: number, chat?: number | string): void {
    console.log(toolUse(name, args, duration, chat))
  }

  sessionStart(chat: number | string): void {
    console.log(sessionStart(chat))
  }

  sessionEnd(chat: number | string): void {
    console.log(sessionEnd(chat))
  }

  serverStart(details?: string): void {
    console.log(serverStart(this.prefix, details))
  }

  serverStop(): void {
    console.log(serverStop(this.prefix))
  }

  connection(event: 'connected' | 'disconnected', details?: string): void {
    console.log(connection(event, this.prefix, details))
  }

  init(details?: string): void {
    console.log(init(this.prefix, details))
  }

  ready(details?: string): void {
    console.log(ready(this.prefix, details))
  }

  polling(): void {
    console.log(polling(this.prefix))
  }

  usage(stats: Parameters<typeof usage>[0]): void {
    console.log(usage(stats))
  }
}

// ── Export Pre-configured Loggers ─────────────────────────────────

export const telegramLogger = new Logger('TELEGRAM')
export const wsLogger = new Logger('WEBSOCKET')
export const cliLogger = new Logger('CLI')
export const mcpLogger = new Logger('MCP')
export const agentLogger = new Logger('AGENT')
