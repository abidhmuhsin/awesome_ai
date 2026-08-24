import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

export const byebyeTool = tool({
  name: 'byebye',
  description: 'End the conversation when the user says goodbye, bye, exit, or wants to end the chat.',
  inputSchema: z.object({}),
  callback: () => {
    return 'Goodbye! Ending the conversation.'
  },
})
