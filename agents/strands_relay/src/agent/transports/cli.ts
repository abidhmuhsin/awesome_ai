/**
 * CLI Transport — readline REPL
 */
import { createInterface } from 'readline'
import { logUsage } from '../../telemetry/openrouter-usage.js'
import { createAgent } from '../factory.js'
import { extractText, wasByebyeCalled } from '../helpers.js'
import { cliLogger as log } from '../../logger.js'

export async function startCli() {
  const agent = createAgent()
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  log.ready('Type your messages (type "bye" or "exit" to quit)')

  async function ask(): Promise<boolean> {
    return new Promise((resolve) => {
      rl.question('You: ', async (input) => {
        const trimmed = input.trim()
        if (!trimmed) {
          resolve(false)
          return
        }

        try {
          const t0 = Date.now()
          const result = await agent.invoke(trimmed)
          const text = extractText(agent) ?? result.toString()
          const responseTime = Date.now() - t0

          if (text) {
            log.outgoing('cli', text, responseTime)
          }

          if (wasByebyeCalled(agent)) {
            logUsage(result)
            log.sessionEnd('cli')
            resolve(true)
            return
          }
        } catch (err: any) {
          log.error(err.message, 'cli')
        }

        resolve(false)
      })
    })
  }

  while (true) {
    const shouldExit = await ask()
    if (shouldExit) {
      rl.close()
      break
    }
  }
}
