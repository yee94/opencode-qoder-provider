/**
 * 独立脚本：验证 reasoning/thinking 流式透出
 * 运行: npx vitest run tests/integration/reasoning-verify.test.ts
 */
import { describe, it, expect } from 'vitest'
import { QoderLanguageModel } from '../../src/qoder-language-model.js'
import { setMcpBridgeServers } from '../../src/mcp-bridge.js'
import fs from 'node:fs'

const TIMEOUT = 120_000
const OUTPUT_FILE = '/tmp/reasoning-test-output.txt'

interface StreamResult {
  counts: Record<string, number>
  firstSeen: Record<string, number>
  reasoningText: string
  responseText: string
  totalMs: number
}

async function runStreamingTest(model: QoderLanguageModel, prompt: string): Promise<StreamResult> {
  const { stream } = await model.doStream({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  })

  const reader = stream.getReader()
  const counts: Record<string, number> = {}
  const firstSeen: Record<string, number> = {}
  let reasoningText = ''
  let responseText = ''
  const t0 = Date.now()

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const v = value as { type: string; delta?: string; [k: string]: unknown }
    counts[v.type] = (counts[v.type] || 0) + 1
    if (!firstSeen[v.type]) firstSeen[v.type] = Date.now() - t0
    if (v.type === 'reasoning-delta' && v.delta) reasoningText += v.delta
    if (v.type === 'text-delta' && v.delta) responseText += v.delta
  }

  return { counts, firstSeen, reasoningText, responseText, totalMs: Date.now() - t0 }
}

function formatResult(modelName: string, r: StreamResult): string {
  return [
    `=== Reasoning Streaming Test (${modelName}) ===`,
    `Event counts: ${JSON.stringify(r.counts, null, 2)}`,
    `First seen (ms): ${JSON.stringify(r.firstSeen, null, 2)}`,
    `Reasoning (first 300): ${r.reasoningText.slice(0, 300) || '(none)'}`,
    `Response (first 300): ${r.responseText.slice(0, 300)}`,
    `Total: ${r.totalMs}ms`,
    '',
    r.counts['reasoning-delta'] && r.counts['reasoning-delta'] > 0
      ? `✅ reasoning 流式透出成功！${r.counts['reasoning-delta']} 个 delta`
      : 'ℹ️ 未返回 reasoning',
    r.counts['text-delta'] && r.counts['text-delta'] > 1
      ? `✅ text 真正流式！${r.counts['text-delta']} 个 delta`
      : `⚠️ text-delta 仅 ${r.counts['text-delta'] || 0} 个`,
  ].join('\n')
}

describe.skip('Reasoning Streaming Verification', { timeout: TIMEOUT }, () => {
  it('efficient model streaming events analysis', async () => {
    setMcpBridgeServers({})

    const model = new QoderLanguageModel('efficient')
    const result = await runStreamingTest(model, 'What is 17 * 23? Think step by step.')
    fs.writeFileSync(OUTPUT_FILE, formatResult('efficient', result))

    expect(result.counts['text-delta']).toBeGreaterThan(0)
    expect(result.counts['text-start']).toBeGreaterThan(0)
    expect(result.counts['finish']).toBe(1)
    expect(result.responseText.length).toBeGreaterThan(0)
  })

  it('ultimate model should stream reasoning + text', async () => {
    setMcpBridgeServers({})

    const model = new QoderLanguageModel('ultimate')
    const result = await runStreamingTest(model, 'What is 17 * 23? Think step by step.')
    fs.writeFileSync(OUTPUT_FILE + '.ultimate', formatResult('ultimate', result))

    expect(result.counts['text-delta']).toBeGreaterThan(0)
    expect(result.responseText.length).toBeGreaterThan(0)

    // ultimate 模型应该有 reasoning
    if (result.counts['reasoning-delta'] && result.counts['reasoning-delta'] > 0) {
      expect(result.counts['reasoning-start']).toBeGreaterThan(0)
      expect(result.counts['reasoning-end']).toBeGreaterThan(0)
      expect(result.reasoningText.length).toBeGreaterThan(0)
    }
  })
})
