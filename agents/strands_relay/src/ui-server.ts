#!/usr/bin/env node
/**
 * UI Server entry point
 *
 * Usage: npm run ui [-- --port 3000]
 */
import 'dotenv/config'
import { startWebSocket } from './agent/transports/websocket.js'

const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const port = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 3000

startWebSocket(port)
