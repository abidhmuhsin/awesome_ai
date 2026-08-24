import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

export const helloTool = tool({
  name: 'hello',
  description: 'Return a simple greeting for a person by name. Only use this when the user explicitly introduces themselves or says hello for the first time.',
  inputSchema: z.object({
    name: z.string().min(1).describe('The name to greet'),
  }),
  callback: ({ name }) => {
    return `Hello, ${name}! This response came from the hello tool.`
  },
})
