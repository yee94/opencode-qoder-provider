import { describe, it, expect } from 'vitest'
import type { LanguageModelV2CallOptions, LanguageModelV2Prompt } from '@ai-sdk/provider'
import { QoderLanguageModel } from '../../src/qoder-language-model.js'
import { requireQoderAuth } from './helpers.js'

const TIMEOUT = 90_000

function buildOptions(prompt: LanguageModelV2Prompt): LanguageModelV2CallOptions {
  return {
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt,
  }
}

function collectText(result: Awaited<ReturnType<QoderLanguageModel['doGenerate']>>): string {
  return result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}

async function runTurn(model: QoderLanguageModel, prompt: LanguageModelV2Prompt): Promise<string> {
  const result = await model.doGenerate(buildOptions(prompt))
  const text = collectText(result)
  console.log('[multi-turn-e2e] response:', text)
  return text
}

describe.skip('Qoder multi-turn strict e2e', { timeout: TIMEOUT, concurrent: false }, () => {
  it('应优先遵循最后一条用户指令，而不是被前序轮次带偏', async () => {
    requireQoderAuth()
    const model = new QoderLanguageModel('lite')

    const turn1Prompt: LanguageModelV2Prompt = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'For this turn, reply with exactly: ALPHA' }],
      },
    ]
    const turn1 = await runTurn(model, turn1Prompt)
    expect(turn1.toUpperCase()).toContain('ALPHA')

    const turn2Prompt: LanguageModelV2Prompt = [
      ...turn1Prompt,
      { role: 'assistant', content: [{ type: 'text', text: turn1 }] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Forget the previous answer. For this turn, reply with exactly: BRAVO' }],
      },
    ]
    const turn2 = await runTurn(model, turn2Prompt)
    expect(turn2.toUpperCase()).toContain('BRAVO')

    const turn3Prompt: LanguageModelV2Prompt = [
      ...turn2Prompt,
      { role: 'assistant', content: [{ type: 'text', text: turn2 }] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Ignore all previous requested words. Reply with exactly: CHARLIE' }],
      },
    ]
    const turn3 = await runTurn(model, turn3Prompt)

    expect(turn3.toUpperCase()).toContain('CHARLIE')
    expect(turn3.toUpperCase()).not.toContain('ALPHA')
    expect(turn3.toUpperCase()).not.toContain('BRAVO')
  })

  it('带工具历史的多轮场景下，最后一条 user 指令仍应可控', async () => {
    requireQoderAuth()
    const model = new QoderLanguageModel('lite')

    const prompt: LanguageModelV2Prompt = [
      {
        role: 'system',
        content: 'You must obey the latest user instruction exactly when it requests an exact token reply.',
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Please inspect the workspace and help me.' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect the workspace.' },
          { type: 'tool-call', toolCallId: 'tc-e2e-1', toolName: 'bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-e2e-1',
            toolName: 'bash',
            output: [
              { type: 'text', value: 'src\ntests\npackage.json' },
              { type: 'json', value: { files: ['src', 'tests', 'package.json'] } },
            ],
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Do not summarize the tool output. Reply with exactly: TOOL_OK' }],
      },
    ]

    const text = await runTurn(model, prompt)
    expect(text.toUpperCase()).toContain('TOOL_OK')
    expect(text.toUpperCase()).not.toContain('PACKAGE.JSON')
  })

  it.fails('已知问题复现：超长多轮历史被截断后，最后一条指令仍可能丢失', async () => {
    requireQoderAuth()
    const model = new QoderLanguageModel('lite')

    const longHistory: LanguageModelV2Prompt = [
      { role: 'system', content: 'You must obey the latest exact-token instruction.' },
      ...Array.from({ length: 24 }, (_, idx) => ({
        role: idx % 2 === 0 ? 'user' : 'assistant',
        content: idx % 2 === 0
          ? [{ type: 'text', text: `history-user-${idx}-${'x'.repeat(15000)}` }]
          : [{ type: 'text', text: `history-assistant-${idx}-${'y'.repeat(15000)}` }],
      })),
      {
        role: 'user',
        content: [{ type: 'text', text: 'Even if history is long, reply with exactly: FINAL_OK' }],
      },
    ]

    const text = await runTurn(model, longHistory)
    expect(text.toUpperCase()).toContain('FINAL_OK')
  })
})
