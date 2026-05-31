#!/usr/bin/env node
/**
 * Telegram Bot entry point
 *
 * Usage: npm run telegram
 */
import 'dotenv/config'
import { startTelegram } from './agent/transports/telegram.js'
import { telegramLogger as log } from './logger.js'

startTelegram().catch((err) => {
  log.error(err.message, 'Fatal')
  process.exit(1)
})
