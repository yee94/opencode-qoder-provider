/**
 * 验证 includePartialMessages: true 修复后，stream_event 消息确实会被接收。
 * 对比修复前（无 includePartialMessages）和修复后（有 includePartialMessages）的差异。
 */
import { describe, it, expect } from 'vitest'
import { configure, query } from '../../src/vendor/qoder-agent-sdk.mjs'
import { QoderLanguageModel } from '../../src/qoder-language-model.js'
import { setMcpBridgeServers } from '../../src/mcp-bridge.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TIMEOUT = 120_000
const PROMPT = 'Reply with exactly one word: PONG'
const MODEL = 'efficient'

function resolveStorageDir(): string {
  const qoderwork = path.join(os.homedir(), '.qoderwork')
  if (fs.existsSync(path.join(qoderwork, '.auth', 'user'))) return qoderwork
  return path.join(os.homedir(), '.qoder')
}

function resolveQoderCLI(): string | undefined {
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter)
  for (const dir of pathDirs) {
    const p = path.join(dir, 'qodercli')
    if (fs.existsSync(p)) return p
  }
  const localCli = path.join(os.homedir(), '.qoder', 'local', 'qodercli')
  if (fs.existsSync(localCli)) return localCli
  return undefined
}

configure({ storageDir: resolveStorageDir() })

describe.skip('stream_event 验证', () => {
  it('SDK query() 不带 includePartialMessages — 应该没有 stream_event', async () => {
    const t0 = performance.now()
    const eventTypes: string[] = []
    let tFirstStreamEvent = 0
    let tFirstAssistant = 0

    const iter = query({
      prompt: PROMPT,
      options: {
        model: MODEL,
        allowDangerouslySkipPermissions: true,
        permissionMode: 'bypassPermissions',
        cwd: process.cwd(),
        pathToQoderCLIExecutable: resolveQoderCLI(),
        // 注意：不设置 includePartialMessages
      },
    })

    for await (const m of iter) {
      const elapsed = performance.now() - t0
      eventTypes.push(m.type)
      if (m.type === 'stream_event' && tFirstStreamEvent === 0) {
        tFirstStreamEvent = elapsed
      }
      if (m.type === 'assistant' && tFirstAssistant === 0) {
        tFirstAssistant = elapsed
      }
      if (m.type === 'result') break
    }

    console.log('\n=== 不带 includePartialMessages ===')
    console.log(`  事件序列: [${eventTypes.join(', ')}]`)
    console.log(`  stream_event 数量: ${eventTypes.filter(t => t === 'stream_event').length}`)
    console.log(`  首个 stream_event: ${tFirstStreamEvent ? tFirstStreamEvent.toFixed(0) + 'ms' : 'N/A'}`)
    console.log(`  首个 assistant: ${tFirstAssistant ? tFirstAssistant.toFixed(0) + 'ms' : 'N/A'}`)

    // 预期：没有 stream_event
    expect(eventTypes.filter(t => t === 'stream_event').length).toBe(0)
    expect(tFirstAssistant).toBeGreaterThan(0)
  }, TIMEOUT)

  it('SDK query() 带 includePartialMessages: true — 应该有 stream_event', async () => {
    const t0 = performance.now()
    const eventTypes: string[] = []
    let tFirstStreamEvent = 0
    let tFirstAssistant = 0

    const iter = query({
      prompt: PROMPT,
      options: {
        model: MODEL,
        allowDangerouslySkipPermissions: true,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        cwd: process.cwd(),
        pathToQoderCLIExecutable: resolveQoderCLI(),
      },
    })

    for await (const m of iter) {
      const elapsed = performance.now() - t0
      eventTypes.push(m.type)
      if (m.type === 'stream_event' && tFirstStreamEvent === 0) {
        tFirstStreamEvent = elapsed
      }
      if (m.type === 'assistant' && tFirstAssistant === 0) {
        tFirstAssistant = elapsed
      }
      if (m.type === 'result') break
    }

    console.log('\n=== 带 includePartialMessages: true ===')
    console.log(`  事件序列: [${eventTypes.slice(0, 20).join(', ')}${eventTypes.length > 20 ? '...' : ''}]`)
    console.log(`  stream_event 数量: ${eventTypes.filter(t => t === 'stream_event').length}`)
    console.log(`  首个 stream_event: ${tFirstStreamEvent ? tFirstStreamEvent.toFixed(0) + 'ms' : 'N/A'}`)
    console.log(`  首个 assistant: ${tFirstAssistant ? tFirstAssistant.toFixed(0) + 'ms' : 'N/A'}`)

    // 预期：有 stream_event，并且比 assistant 更早出现
    const streamEventCount = eventTypes.filter(t => t === 'stream_event').length
    expect(streamEventCount).toBeGreaterThan(0)
    if (tFirstStreamEvent > 0 && tFirstAssistant > 0) {
      expect(tFirstStreamEvent).toBeLessThan(tFirstAssistant)
      console.log(`  ✅ stream_event 比 assistant 早 ${(tFirstAssistant - tFirstStreamEvent).toFixed(0)}ms — 真正的流式传输！`)
    }
  }, TIMEOUT)

  it('Plugin doStream() 修复后 — 应该通过 stream_event 路径输出', async () => {
    setMcpBridgeServers({})

    const model = new QoderLanguageModel('efficient', {
      id: 'efficient',
      name: 'Efficient',
      limit: { context: 180_000, output: 32768 },
    })

    const t0 = performance.now()
    let tFirstText = 0
    let textChunks = 0
    let fullText = ''

    const result = await model.doStream({
      inputFormat: 'messages',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: PROMPT }] },
      ],
    })

    const reader = result.stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') {
        if (tFirstText === 0) tFirstText = performance.now() - t0
        textChunks++
        fullText += value.textDelta
      }
    }
    const totalTime = performance.now() - t0

    console.log('\n=== Plugin doStream() 修复后 ===')
    console.log(`  首个 text-delta: ${tFirstText.toFixed(0)}ms`)
    console.log(`  总 text-delta 数: ${textChunks}`)
    console.log(`  总时间: ${totalTime.toFixed(0)}ms`)
    console.log(`  输出文本: "${fullText.trim()}"`)

    // 修复后，应该收到多个 text-delta 片段（流式），而不是一个大块
    expect(tFirstText).toBeGreaterThan(0)
    expect(textChunks).toBeGreaterThan(0)
    // 如果 stream_event 正常工作，text chunks 应该大于 1（逐 token 流式）
    console.log(`  ${textChunks > 1 ? '✅ 多个 text-delta 片段 — 真正的流式！' : '⚠️ 仅一个 text-delta — 仍是批量模式'}`)
  }, TIMEOUT)
})
