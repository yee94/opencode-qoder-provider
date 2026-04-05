import { describe, it, expect } from 'vitest'
import { QoderLanguageModel } from '../../src/qoder-language-model.js'
import { requireQoderAuth } from './helpers.js'

describe.skip('real provider smoke', { timeout: 120_000 }, () => {
  it('efficient 基础生成至少返回内容', async () => {
    requireQoderAuth()
    const model = new QoderLanguageModel('efficient')
    const result = await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Reply with exactly the word: PONG' }],
        },
      ],
    })

    const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
    expect(text.length).toBeGreaterThan(0)
  })
})
