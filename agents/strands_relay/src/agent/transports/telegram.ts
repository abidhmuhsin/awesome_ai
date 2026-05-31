/**
 * Telegram Transport — bot with isolated sessions per chat
 *
 * Uses grammy (https://grammy.dev) — a modern, type-safe Telegram bot framework.
 */
import { Bot, GrammyError, HttpError } from 'grammy'
import { logUsage } from '../../telemetry/openrouter-usage.js'
import { createAgent } from '../factory.js'
import { extractText, wasByebyeCalled } from '../helpers.js'

// ── Helpers ────────────────────────────────────────────────────────

const fmt = {
  strip: (s: string) => s.replace(/\n+/g, ' ↵ ').replace(/\s+/g, ' ').trim(),
  preview: (s: string, max = 60) => {
    const one = fmt.strip(s)
    return one.length > max ? one.slice(0, max) + '…' : one
  },
  chat: (id: number | string) => String(id),
  ts: () => new Date().toLocaleTimeString('en-GB', { hour12: false }),
  elapsed: (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`,
}

/** Per-chat agent instances so each conversation is isolated */
const sessions = new Map<number, ReturnType<typeof createAgent>>()

export async function startTelegram() {
  const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
  console.log(`  ${ts()}  ▸ init`)

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is required. Set it in .env or export TELEGRAM_BOT_TOKEN=your-token',
    )
  }

  // Validate token format (must be numeric:alphanumeric)
  if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(
      `TELEGRAM_BOT_TOKEN has invalid format (${token.length} chars, starts with "${token.slice(0, 4)}…"). ` +
      'Expected format from @BotFather: 1234567890:ABCdefGHIjklMNOpqRSTUvwxyz',
    )
  }

  console.log(`  ${ts()}  ▸ bot created`)

  const bot = new Bot(token)

  // ── Debug: log every incoming update ─────────────────────────────

  bot.use(async (ctx, next) => {
    const msg = ctx.message
    const text = msg && 'text' in msg ? fmt.preview(msg.text) : ''
    console.log(`  ${fmt.ts()}  «  🗣 ${fmt.chat(ctx.chat.id)}  ◀  ${text}`)
    await next()
  })

  // ── Commands ────────────────────────────────────────────────────

  bot.command('start', (ctx) => {
    const chatId = ctx.chat.id
    sessions.set(chatId, createAgent())
    ctx.reply(
      '🤖 *Agent ready!*\n\nSend me any message and I\'ll respond.\nSay *bye* or *goodbye* to end the session.',
      { parse_mode: 'Markdown' },
    )
  })

  bot.command('help', (ctx) => {
    ctx.reply(
      '*/start* — Start a new session\n' +
        '*/help* — Show this help\n' +
        '*/session* — Show current session status\n' +
        '*/end* — End the current session\n\n' +
        'Just send any text message to chat with the agent.',
      { parse_mode: 'Markdown' },
    )
  })

  bot.command('session', (ctx) => {
    const chatId = ctx.chat.id
    if (sessions.has(chatId)) {
      ctx.reply('✅ You have an active session. Send a message!')
    } else {
      ctx.reply('❌ No active session. Send /start to begin.')
    }
  })

  bot.command('end', async (ctx) => {
    const chatId = ctx.chat.id
    if (sessions.has(chatId)) {
      sessions.delete(chatId)
      ctx.reply('👋 Session ended. Send /start to begin a new one.')
    } else {
      ctx.reply('No active session to end.')
    }
  })

  // ── Text messages ───────────────────────────────────────────────

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id

    // Auto-start session on first message
    if (!sessions.has(chatId)) {
      sessions.set(chatId, createAgent())
    }

    const agent = sessions.get(chatId)!
    const text = ctx.message.text.trim()
    if (!text) return

    try {
      // Show typing indicator
      await ctx.api.sendChatAction(chatId, 'typing')

      const t0 = Date.now()
      const result = await agent.invoke(text)
      const reply = extractText(agent) ?? '(no response)'
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

      // Send reply (split if longer than Telegram's 4096-char limit)
      const MAX_LENGTH = 4000
      try {
        if (reply.length <= MAX_LENGTH) {
          await ctx.reply(reply)
        } else {
          for (let i = 0; i < reply.length; i += MAX_LENGTH) {
            await ctx.reply(reply.slice(i, i + MAX_LENGTH))
          }
        }
        console.log(`  ${fmt.ts()}  »  @${fmt.chat(chatId)}  ${fmt.elapsed(Date.now() - t0)}  ▶  ${fmt.preview(reply)}`)
      } catch (sendErr: any) {
        console.error(`  ${fmt.ts()}  ✖  🗣 ${fmt.chat(chatId)}  ${sendErr.message}`)
        throw sendErr
      }

      // End session if byebye was called
      if (wasByebyeCalled(agent)) {
        logUsage(result)
        await ctx.reply('👋 Session ended. Send /start to begin a new one.')
        sessions.delete(chatId)
      }
    } catch (err: any) {
      console.error(`  ${fmt.ts()}  ✖  🗣 ${fmt.chat(chatId)}  ${err.message}`)
      ctx.reply(`❌ Error: ${err.message}`).catch(() => {})
    }
  })

  // ── Error handling ─────────────────────────────────────────────

  bot.catch((err) => {
    const chatId = err.ctx.chat?.id ?? '?'
    if (err instanceof GrammyError) {
      console.error(`  ${fmt.ts()}  ✖  🗣 ${fmt.chat(chatId)}  grammy: ${err.description}`)
    } else if (err instanceof HttpError) {
      console.error(`  ${fmt.ts()}  ✖  🗣 ${fmt.chat(chatId)}  http: ${err}`)
    } else {
      console.error(`  ${fmt.ts()}  ✖  🗣 ${fmt.chat(chatId)}  unknown:`, err)
    }
  })

  // ── Graceful shutdown ───────────────────────────────────────────

  process.once('SIGINT', () => bot.stop())
  process.once('SIGTERM', () => bot.stop())

  console.log(`  ${ts()}  ▸ polling`)
  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => console.log(`  ${ts()}  ✓ @${info.username} ready`),
  })
}
