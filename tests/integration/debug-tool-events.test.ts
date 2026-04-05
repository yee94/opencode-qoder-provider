/**
 * 调试测试：用真实 Qoder API 观察 CLI 发出的工具调用名称和格式
 * 直接运行：npx vitest run tests/integration/debug-tool-events.test.ts
 */
import { describe, it, expect } from 'vitest'
import { QoderLanguageModel } from '../../src/qoder-language-model.js'
import fs from 'node:fs'

const TIMEOUT = 120_000
const DEBUG_LOG = '/tmp/debug-tool-events.log'

describe.skip('Debug: 工具事件观察', { timeout: TIMEOUT }, () => {
  it('观察 CLI 发出的工具调用（有 options.tools 时）', async () => {
    const model = new QoderLanguageModel('auto')

    const functionTools = [
      { type: 'function' as const, name: 'bash', description: 'Run a bash command', inputSchema: { type: 'object' as const, properties: { command: { type: 'string' } } } },
      { type: 'function' as const, name: 'read', description: 'Read a file', inputSchema: { type: 'object' as const, properties: { filePath: { type: 'string' } } } },
    ]

    const { stream } = await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Run `echo hello` using the bash tool. You MUST use the bash tool, do not just type the output.',
            },
          ],
        },
      ],
      tools: functionTools,
    })

    const parts: Array<Record<string, unknown>> = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const p = value as Record<string, unknown>
      parts.push(p)
    }

    const toolStarts = parts.filter((p) => p.type === 'tool-input-start')
    const toolCalls = parts.filter((p) => p.type === 'tool-call')
    const toolResults = parts.filter((p) => p.type === 'tool-result')
    const textDeltas = parts.filter((p) => p.type === 'text-delta')
    const fullText = textDeltas.map((p) => p.delta as string).join('')

    const log = [
      '=== TOOL EVENT SUMMARY ===',
      `tool-input-start: ${JSON.stringify(toolStarts, null, 2)}`,
      `tool-call: ${JSON.stringify(toolCalls, null, 2)}`,
      `tool-result: ${JSON.stringify(toolResults, null, 2)}`,
      `text: ${fullText.slice(0, 500)}`,
      `all parts types: ${JSON.stringify(parts.map((p) => p.type))}`,
      '',
      '=== ALL NON-TEXT PARTS ===',
      ...parts.filter((p) => p.type !== 'text-delta').map((p) => JSON.stringify(p)),
    ].join('\n')

    fs.writeFileSync(DEBUG_LOG, log)

    // 至少有文本或工具事件
    expect(parts.length).toBeGreaterThan(0)
  })
})
