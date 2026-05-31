#!/usr/bin/env node
/**
 * CLI entry point
 *
 * Usage: npm start
 */
import 'dotenv/config'
import { startCli } from './agent/transports/cli.js'

startCli()
