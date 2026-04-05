/**
 * 端到端调试：通过 QoderLanguageModel 观察 MCP tool 事件在 stream 中的输出
 */
import { describe, it, expect } from 'vitest'
import { QoderLanguageModel } from '../../src/qoder-language-model.js'
import { setMcpBridgeServers } from '../../src/mcp-bridge.js'
import fs from 'node:fs'

const TIMEOUT = 120_000
const DEBUG_LOG = '/tmp/debug-e2e-stream.log'

describe.skip('Debug: E2E Stream 事件', { timeout: TIMEOUT }, () => {
  it('MCP context7 工具调用的 stream 事件', async () => {
    // 注入 context7 MCP server（模拟 opencode config hook 行为）
    setMcpBridgeServers({
      context7: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@latest'],
      },
    })

    const model = new QoderLanguageModel('auto')

    // 模拟 opencode 传入的 function tools（bash、read 等）
    const functionTools = [
      { type: 'function' as const, name: 'bash', description: 'Run bash', inputSchema: { type: 'object' as const, properties: {} } },
      { type: 'function' as const, name: 'read', description: 'Read file', inputSchema: { type: 'object' as const, properties: {} } },
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
              text: 'Use context7 to look up "antd". Call resolve-library-id with libraryName="antd" first.',
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
      parts.push(value as Record<string, unknown>)
    }

    const log = [
      '=== ALL STREAM PARTS ===',
      ...parts.map((p, i) => `[${i}] ${p.type}: ${JSON.stringify(p).slice(0, 500)}`),
      '',
      '=== SUMMARY ===',
      `total parts: ${parts.length}`,
      `tool-input-start: ${parts.filter(p => p.type === 'tool-input-start').length}`,
      `tool-call: ${parts.filter(p => p.type === 'tool-call').length}`,
      `tool-result: ${parts.filter(p => p.type === 'tool-result').length}`,
      `text-delta: ${parts.filter(p => p.type === 'text-delta').length}`,
      `tool-calls: ${JSON.stringify(parts.filter(p => p.type === 'tool-call'), null, 2)}`,
      `tool-results: ${JSON.stringify(parts.filter(p => p.type === 'tool-result'), null, 2)}`,
    ].join('\n')

    fs.writeFileSync(DEBUG_LOG, log)
    expect(parts.length).toBeGreaterThan(0)
  })
})
