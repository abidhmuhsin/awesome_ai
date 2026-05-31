#!/usr/bin/env node
/**
 * Telegram Bot entry point
 *
 * Usage: npm run telegram
 */
import 'dotenv/config'
import { startTelegram } from './agent/transports/telegram.js'

startTelegram().catch((err) => {
  console.error('[telegram] Fatal:', err.message)
  process.exit(1)
})
