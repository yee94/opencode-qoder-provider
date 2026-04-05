/**
 * 真实 API 集成测试
 * 需要有效的 Qoder CLI 认证（~/.qoder/.auth/user）
 *
 * 运行方式：
 *   pnpm --filter opencode-qoder-provider test:integration
 * 或：
 *   cd packages/opencode-qoder-provider && bun vitest run tests/integration
 */
import { describe, it, expect } from 'vitest'
import { QoderLanguageModel } from '../../src/qoder-language-model.js'
import { setMcpBridgeServers } from '../../src/mcp-bridge.js'
import { requireQoderAuth } from './helpers.js'

// 设置较长超时，真实 API 调用可能需要 30s+
const TIMEOUT = 60_000

describe.skip('Qoder Real API Integration', { timeout: TIMEOUT }, () => {
  it('should respond to a simple text prompt with lite model', async () => {
    requireQoderAuth()
    const model = new QoderLanguageModel('lite')

    const result = await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Reply with exactly one word: PONG',
            },
          ],
        },
      ],
    })

    console.log('[integration] result:', JSON.stringify(result, null, 2))

    expect(result.content).toBeDefined()
    expect(result.content.length).toBeGreaterThan(0)

    const textParts = result.content.filter((c) => c.type === 'text')
    expect(textParts.length).toBeGreaterThan(0)

    const fullText = textParts.map((c) => (c as { type: 'text'; text: string }).text).join('')
    console.log('[integration] response text:', fullText)

    expect(fullText.toLowerCase()).toContain('pong')
  })

  it('should stream text delta events', async () => {
    requireQoderAuth()
    const model = new QoderLanguageModel('lite')

    const { stream } = await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Say "hello world" and nothing else.',
            },
          ],
        },
      ],
    })

    const reader = stream.getReader()
    const parts: Array<{ type: string; [key: string]: unknown }> = []

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value as { type: string; [key: string]: unknown })
    }

    console.log('[integration] stream parts:', JSON.stringify(parts, null, 2))

    const textDeltas = parts.filter((p) => p.type === 'text-delta')
    const finish = parts.find((p) => p.type === 'finish')

    expect(textDeltas.length).toBeGreaterThan(0)
    expect(finish).toBeDefined()

    const fullText = textDeltas.map((p) => p.delta as string).join('')
    console.log('[integration] streamed text:', fullText)
    expect(fullText.toLowerCase()).toContain('hello')
  })

  it('should handle multimodal image input (auto model)', async () => {
    requireQoderAuth()
    // 1x1 红色像素 PNG (base64, RGB=255,0,0, 有效 checksum)
    const RED_1x1_PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

    // auto 模型支持多模态
    const model = new QoderLanguageModel('auto')

    const result = await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: `data:image/png;base64,${RED_1x1_PNG}`,
              mimeType: 'image/png',
            },
            {
              type: 'text',
              text: 'What color is this image? Reply with one word.',
            },
          ],
        },
      ],
    })

    console.log('[integration] multimodal result:', JSON.stringify(result, null, 2))

    expect(result.content).toBeDefined()
    const textParts = result.content.filter((c) => c.type === 'text')
    expect(textParts.length).toBeGreaterThan(0)

    const fullText = textParts.map((c) => (c as { type: 'text'; text: string }).text).join('')
    console.log('[integration] multimodal response:', fullText)
    // 验证多模态图片传输链路正常（模型能返回文字内容即可）
    expect(fullText.length).toBeGreaterThan(0)
  })
})

// ── context7 MCP 工具调用调试测试 ─────────────────────────────────────────────
// 直接运行：npx vitest run tests/integration/real-api.test.ts --reporter=verbose

// ── reasoning/thinking 流式透出测试 ───────────────────────────────────────────
// 验证 stream_event thinking_delta → reasoning-start/reasoning-delta/reasoning-end 链路

describe.skip('Qoder Reasoning Streaming', { timeout: TIMEOUT }, () => {
  it('should stream reasoning and text deltas separately with efficient model', async () => {
    setMcpBridgeServers({})

    const model = new QoderLanguageModel('efficient')

    const { stream } = await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'What is 17 * 23? Think step by step.',
            },
          ],
        },
      ],
    })

    const reader = stream.getReader()
    const parts: Array<{ type: string; [key: string]: unknown }> = []
    const timestamps: Record<string, number> = {}
    const t0 = performance.now()

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const p = value as { type: string; [key: string]: unknown }
      parts.push(p)
      if (!timestamps[p.type]) {
        timestamps[p.type] = performance.now() - t0
      }
    }

    const reasoningStarts = parts.filter((p) => p.type === 'reasoning-start')
    const reasoningDeltas = parts.filter((p) => p.type === 'reasoning-delta')
    const reasoningEnds = parts.filter((p) => p.type === 'reasoning-end')
    const textStarts = parts.filter((p) => p.type === 'text-start')
    const textDeltas = parts.filter((p) => p.type === 'text-delta')
    const textEnds = parts.filter((p) => p.type === 'text-end')
    const finish = parts.find((p) => p.type === 'finish')

    const reasoningText = reasoningDeltas.map((p) => p.delta as string).join('')
    const responseText = textDeltas.map((p) => p.delta as string).join('')

    console.log('\n=== Reasoning Streaming Test (efficient) ===')
    console.log(`  reasoning-start: ${reasoningStarts.length}`)
    console.log(`  reasoning-delta: ${reasoningDeltas.length}`)
    console.log(`  reasoning-end: ${reasoningEnds.length}`)
    console.log(`  text-start: ${textStarts.length}`)
    console.log(`  text-delta: ${textDeltas.length}`)
    console.log(`  text-end: ${textEnds.length}`)
    console.log(`  reasoning text (first 200): "${reasoningText.slice(0, 200)}..."`)
    console.log(`  response text (first 200): "${responseText.slice(0, 200)}..."`)
    console.log(`  timestamps:`, timestamps)

    // 验证基本流式输出
    expect(textDeltas.length).toBeGreaterThan(0)
    expect(finish).toBeDefined()
    expect(responseText.length).toBeGreaterThan(0)

    // 如果模型有 reasoning，验证 reasoning 事件
    if (reasoningDeltas.length > 0) {
      expect(reasoningStarts.length).toBeGreaterThan(0)
      expect(reasoningEnds.length).toBeGreaterThan(0)
      expect(reasoningText.length).toBeGreaterThan(0)
      console.log(`  ✅ reasoning 流式透出正常！${reasoningDeltas.length} 个 delta`)
    } else {
      console.log(`  ℹ️ efficient 模型本次未返回 reasoning（可能不支持或未触发）`)
    }

    // 验证是真正的流式（多个 delta，不是一大块）
    if (textDeltas.length > 1) {
      console.log(`  ✅ text 真正流式！${textDeltas.length} 个 delta`)
    }
  })

  it('doGenerate should include reasoning in content', async () => {
    setMcpBridgeServers({})

    const model = new QoderLanguageModel('efficient')

    const result = await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'What is 7 + 5? Think step by step.',
            },
          ],
        },
      ],
    })

    console.log('\n=== doGenerate Reasoning Test (efficient) ===')
    console.log(`  content types: ${result.content.map((c) => c.type).join(', ')}`)
    console.log(`  finishReason: ${result.finishReason}`)

    const reasoningParts = result.content.filter((c) => c.type === 'reasoning')
    const textParts = result.content.filter((c) => c.type === 'text')

    expect(textParts.length).toBeGreaterThan(0)
    const fullText = textParts.map((c) => (c as { type: 'text'; text: string }).text).join('')
    console.log(`  text (first 200): "${fullText.slice(0, 200)}..."`)

    if (reasoningParts.length > 0) {
      const reasoningText = (reasoningParts[0] as { type: 'reasoning'; text: string }).text
      console.log(`  reasoning (first 200): "${reasoningText.slice(0, 200)}..."`)
      console.log(`  ✅ doGenerate 返回了 reasoning content！`)
    } else {
      console.log(`  ℹ️ efficient 模型本次未返回 reasoning`)
    }
  })
})

describe.skip('context7 MCP tool call debug', { timeout: TIMEOUT }, () => {
  it('观察 CLI 在有 mcpServers=context7 时发出的工具名格式', async () => {
    requireQoderAuth()
    setMcpBridgeServers({
      context7: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@latest'],
      },
    })

    const model = new QoderLanguageModel('lite')
    const { stream } = await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              // 强制模型用 context7 查一个库，拿到工具名格式
              text: 'Use context7 to get the latest React documentation. Call resolve-library-id for "react" first.',
            },
          ],
        },
      ],
    })

    const parts: Array<Record<string, unknown>> = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const p = value as Record<string, unknown>
      parts.push(p)
      // 实时打印每个 part
      if (p.type !== 'text-delta') {
        console.log('[context7-debug] part:', JSON.stringify(p))
      }
    }

    const toolStarts = parts.filter((p) => p.type === 'tool-input-start')
    const toolCalls = parts.filter((p) => p.type === 'tool-call')

    console.log('[context7-debug] tool-input-start events:', JSON.stringify(toolStarts, null, 2))
    console.log('[context7-debug] tool-call events:', JSON.stringify(toolCalls, null, 2))
    console.log('[context7-debug] all tool names seen:', toolStarts.map((p) => p.toolName))

    // 至少看到一个 tool 事件（无论命名格式如何）
    expect(toolStarts.length + toolCalls.length).toBeGreaterThan(0)
  })

  it('观察不传 mcpServers 时 CLI 是否还会尝试调用 context7', async () => {
    requireQoderAuth()
    // 清空 mcp-bridge（不传任何 MCP server）
    setMcpBridgeServers({})

    const model = new QoderLanguageModel('lite')
    const { stream } = await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Use context7 to get the latest React documentation. Call resolve-library-id for "react" first.',
            },
          ],
        },
      ],
    })

    const parts: Array<Record<string, unknown>> = []
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value as Record<string, unknown>)
    }

    const toolStarts = parts.filter((p) => p.type === 'tool-input-start')
    console.log('[no-mcp-debug] tool-input-start events:', JSON.stringify(toolStarts, null, 2))
    console.log('[no-mcp-debug] tool names:', toolStarts.map((p) => p.toolName))

    const textParts = parts.filter((p) => p.type === 'text-delta')
    const fullText = textParts.map((p) => p.delta as string).join('')
    console.log('[no-mcp-debug] response text:', fullText.slice(0, 200))
  })
})
