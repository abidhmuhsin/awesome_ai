/**
 * CLI Transport — readline REPL
 */
import { createInterface } from 'readline'
import { logUsage } from '../../telemetry/openrouter-usage.js'
import { createAgent } from '../factory.js'
import { extractText, wasByebyeCalled } from '../helpers.js'

export async function startCli() {
  const agent = createAgent()
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log('🤖 Agent ready! Type your messages (type "bye" or "exit" to quit).\n')

  async function ask(): Promise<boolean> {
    return new Promise((resolve) => {
      rl.question('You: ', async (input) => {
        const trimmed = input.trim()
        if (!trimmed) {
          resolve(false)
          return
        }

        try {
          const result = await agent.invoke(trimmed)
          const text = extractText(agent) ?? result.toString()
          if (text) {
            process.stdout.write(`Agent: ${text}\n\n`)
          }

          if (wasByebyeCalled(agent)) {
            logUsage(result)
            resolve(true)
            return
          }
        } catch (err: any) {
          process.stdout.write(`Agent: (error: ${err.message})\n\n`)
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
