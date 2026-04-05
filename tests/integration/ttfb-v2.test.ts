/**
 * TTFB 精确对比测试 v2
 *
 * v1 发现两条路径都没收到 stream_event（走 assistant fallback），
 * 但 Plugin 路径整体慢 ~32%。
 *
 * v2 目标：
 * 1. 排除交替执行的并发干扰（先跑完所有 SDK，再跑所有 Plugin）
 * 2. 增加 warmup run（排除子进程首次启动偏差）
 * 3. 细分 ReadableStream 开销
 * 4. 检查 prompt 序列化开销
 */
import { describe, it } from 'vitest'
import { configure, query } from '../../src/vendor/qoder-agent-sdk.mjs'
import { QoderLanguageModel } from '../../src/qoder-language-model.js'
import { setMcpBridgeServers } from '../../src/mcp-bridge.js'
import { buildPromptFromOptions } from '../../src/prompt-builder.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TIMEOUT = 300_000
const PROMPT = 'Reply with exactly one word: PONG'
const MODEL = 'lite'
const RUNS = 3

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

interface Result {
  ttfb: number
  total: number
  firstEventTime: number
  messageTypes: string[]
  rawEvents: Array<{ type: string; time: number }>
}

/** Direct SDK — 从 query() 调用到首个 text delta */
async function directSDK(): Promise<Result> {
  const cliPath = resolveQoderCLI()
  const rawEvents: Array<{ type: string; time: number }> = []

  const t0 = performance.now()
  const iter = query({
    prompt: PROMPT,
    options: {
      model: MODEL,
      allowDangerouslySkipPermissions: true,
      permissionMode: 'bypassPermissions',
      cwd: process.cwd(),
      ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
    },
  })

  let tFirstEvent = 0
  let tFirstText = 0
  const messageTypes: string[] = []

  for await (const msg of iter) {
    const m = msg as Record<string, unknown>
    const now = performance.now()
    const elapsed = now - t0

    if (tFirstEvent === 0) tFirstEvent = elapsed

    const msgType = String(m.type)
    messageTypes.push(msgType)
    rawEvents.push({ type: msgType, time: elapsed })

    if (tFirstText === 0) {
      if (m.type === 'stream_event') {
        const ev = (m as any).event
        if (ev?.type === 'content_block_delta' && ev?.delta?.type === 'text_delta' && ev?.delta?.text) {
          tFirstText = elapsed
        }
      } else if (m.type === 'assistant') {
        const content = ((m as any).message?.content ?? []) as any[]
        if (content.some((b: any) => b?.type === 'text' && b?.text)) {
          tFirstText = elapsed
        }
      }
    }
  }

  const total = performance.now() - t0
  return {
    ttfb: tFirstText || total,
    total,
    firstEventTime: tFirstEvent,
    messageTypes,
    rawEvents,
  }
}

/** Plugin doStream — 从调用到首个 text-delta */
async function pluginStream(): Promise<Result> {
  setMcpBridgeServers({})
  const model = new QoderLanguageModel(MODEL)
  const rawEvents: Array<{ type: string; time: number }> = []

  const t0 = performance.now()
  const { stream } = await model.doStream({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
  })

  const tStreamReturned = performance.now() - t0
  rawEvents.push({ type: '_stream_returned', time: tStreamReturned })

  const reader = stream.getReader()
  let tFirstEvent = 0
  let tFirstText = 0
  const messageTypes: string[] = []

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const elapsed = performance.now() - t0
    const part = value as Record<string, unknown>

    if (tFirstEvent === 0) tFirstEvent = elapsed

    messageTypes.push(String(part.type))
    rawEvents.push({ type: String(part.type), time: elapsed })

    if (tFirstText === 0 && part.type === 'text-delta') {
      tFirstText = elapsed
    }
  }

  const total = performance.now() - t0
  return {
    ttfb: tFirstText || total,
    total,
    firstEventTime: tFirstEvent,
    messageTypes,
    rawEvents,
  }
}

/** Plugin 路径拆解：只测 prompt 序列化和 CLI 解析耗时 */
function measureOverhead() {
  const options = {
    inputFormat: 'prompt' as const,
    mode: { type: 'regular' as const },
    prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: PROMPT }] }],
  }

  // buildPromptFromOptions
  const t1 = performance.now()
  for (let i = 0; i < 100; i++) buildPromptFromOptions(options)
  const tPrompt = (performance.now() - t1) / 100

  // resolveQoderCLI
  const t2 = performance.now()
  for (let i = 0; i < 100; i++) resolveQoderCLI()
  const tCli = (performance.now() - t2) / 100

  return { buildPromptMs: tPrompt, resolveCliMs: tCli }
}

describe.skip('TTFB v2: Sequential, with warmup', { timeout: TIMEOUT }, () => {
  it('精确对比', async () => {
    const overhead = measureOverhead()
    console.log(`\n[overhead] buildPrompt: ${overhead.buildPromptMs.toFixed(3)}ms | resolveCLI: ${overhead.resolveCliMs.toFixed(3)}ms\n`)

    // Warmup: 各跑一次
    console.log('── Warmup ──')
    console.log('  SDK warmup...')
    await directSDK()
    console.log('  Plugin warmup...')
    await pluginStream()
    console.log('  Warmup done\n')

    // Sequential: 先跑所有 SDK，再跑所有 Plugin
    const sdkResults: Result[] = []
    const pluginResults: Result[] = []

    for (let i = 0; i < RUNS; i++) {
      console.log(`[SDK ${i + 1}/${RUNS}]`)
      const r = await directSDK()
      sdkResults.push(r)
      console.log(`  TTFB: ${r.ttfb.toFixed(0)}ms | Total: ${r.total.toFixed(0)}ms | Events: [${r.rawEvents.map(e => `${e.type}@${e.time.toFixed(0)}`).join(', ')}]`)
    }

    console.log()

    for (let i = 0; i < RUNS; i++) {
      console.log(`[Plugin ${i + 1}/${RUNS}]`)
      const r = await pluginStream()
      pluginResults.push(r)
      console.log(`  TTFB: ${r.ttfb.toFixed(0)}ms | Total: ${r.total.toFixed(0)}ms | Events: [${r.rawEvents.map(e => `${e.type}@${e.time.toFixed(0)}`).join(', ')}]`)
    }

    // Summary
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
    const sdkTTFBs = sdkResults.map(r => r.ttfb)
    const pluginTTFBs = pluginResults.map(r => r.ttfb)

    console.log(`\n${'═'.repeat(80)}`)
    console.log(`  SDK   TTFB: ${sdkTTFBs.map(t => t.toFixed(0)).join(', ')} → avg ${avg(sdkTTFBs).toFixed(0)}ms`)
    console.log(`  Plugin TTFB: ${pluginTTFBs.map(t => t.toFixed(0)).join(', ')} → avg ${avg(pluginTTFBs).toFixed(0)}ms`)
    console.log(`  Delta: ${(avg(pluginTTFBs) - avg(sdkTTFBs)).toFixed(0)}ms (${((avg(pluginTTFBs) / avg(sdkTTFBs) - 1) * 100).toFixed(0)}%)`)
    console.log(`${'═'.repeat(80)}`)

    // 检查关键差异：SDK 的 system→assistant 消息之间的间隔
    console.log('\n── SDK event timeline ──')
    for (const r of sdkResults) {
      console.log(`  [${r.rawEvents.map(e => `${e.type}@${e.time.toFixed(0)}`).join(' → ')}]`)
    }
    console.log('\n── Plugin event timeline ──')
    for (const r of pluginResults) {
      console.log(`  [${r.rawEvents.map(e => `${e.type}@${e.time.toFixed(0)}`).join(' → ')}]`)
    }

    // 写入 JSON
    const data = {
      timestamp: new Date().toISOString(),
      overhead,
      sdk: sdkResults.map(r => ({ ttfb: r.ttfb, total: r.total, rawEvents: r.rawEvents })),
      plugin: pluginResults.map(r => ({ ttfb: r.ttfb, total: r.total, rawEvents: r.rawEvents })),
      summary: {
        avgSDK: avg(sdkTTFBs),
        avgPlugin: avg(pluginTTFBs),
        delta: avg(pluginTTFBs) - avg(sdkTTFBs),
        deltaPct: (avg(pluginTTFBs) / avg(sdkTTFBs) - 1) * 100,
      },
    }
    fs.writeFileSync('/tmp/ttfb-v2.json', JSON.stringify(data, null, 2))
    console.log('\n📊 详细数据: /tmp/ttfb-v2.json')
  })
})
