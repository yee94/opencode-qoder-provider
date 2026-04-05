/**
 * TTFB (Time To First Byte) 对比测试
 *
 * 测量两条路径的首字节延迟差异：
 *   A) 直接 SDK query()  — 最短路径
 *   B) QoderLanguageModel.doStream() — opencode 插件路径
 *
 * 通过对比，定位 opencode 插件层引入的额外延迟。
 *
 * 运行方式：
 *   npx vitest run tests/integration/ttfb-comparison.test.ts --reporter=verbose
 */
import { describe, it } from 'vitest'
import { configure, query } from '../../src/vendor/qoder-agent-sdk.mjs'
import { QoderLanguageModel } from '../../src/qoder-language-model.js'
import { setMcpBridgeServers } from '../../src/mcp-bridge.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TIMEOUT = 120_000
const PROMPT = 'Reply with exactly one word: PONG'
const MODEL = 'lite'
const RUNS = 3 // 每条路径跑多次取平均

// ── SDK 配置 ──────────────────────────────────────────────────────────────────

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
  const binDir = path.join(os.homedir(), '.qoder', 'bin', 'qodercli')
  if (fs.existsSync(binDir)) {
    try {
      const entries = fs
        .readdirSync(binDir)
        .filter((f) => f.startsWith('qodercli-'))
        .sort()
        .reverse()
      if (entries[0]) {
        const p = path.join(binDir, entries[0])
        if (fs.existsSync(p)) return p
      }
    } catch { /* ignore */ }
  }
  return undefined
}

configure({ storageDir: resolveStorageDir() })

// ── 测量函数 ──────────────────────────────────────────────────────────────────

interface TimingResult {
  /** 从调用开始到首个文本 delta 的时间 (ms) */
  ttfb: number
  /** 从调用开始到 stream 结束的总时间 (ms) */
  total: number
  /** 首个文本内容 */
  firstText: string
  /** 消息类型序列（前 20 个） */
  messageTypes: string[]
  /** 各阶段耗时细节 */
  phases: {
    /** 调用 query() / doStream() 本身返回的耗时 */
    callSetup: number
    /** 从 setup 完成到首个任意事件的耗时 */
    firstEvent: number
    /** 从首个事件到首个文本 delta 的耗时 */
    firstTextAfterEvent: number
  }
}

/** 路径 A：直接调用 SDK query() */
async function measureDirectSDK(): Promise<TimingResult> {
  const cliPath = resolveQoderCLI()
  const messageTypes: string[] = []

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

  const tSetup = performance.now()

  let tFirstEvent = 0
  let tFirstText = 0
  let firstText = ''

  for await (const msg of iter) {
    const m = msg as Record<string, unknown>
    const now = performance.now()

    if (tFirstEvent === 0) tFirstEvent = now

    const msgType = String(m.type)
    if (messageTypes.length < 20) messageTypes.push(msgType)

    // 检测首个文本内容
    if (tFirstText === 0) {
      if (m.type === 'stream_event') {
        const ev = (m as { event: Record<string, unknown> }).event
        if (ev?.type === 'content_block_delta') {
          const delta = ev.delta as Record<string, unknown>
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            tFirstText = now
            firstText = delta.text
          }
        }
      } else if (m.type === 'assistant') {
        const content = ((m as any).message?.content ?? []) as any[]
        for (const block of content) {
          if (block?.type === 'text' && block.text) {
            tFirstText = now
            firstText = block.text.slice(0, 50)
            break
          }
        }
      }
    }
  }

  const tEnd = performance.now()
  if (tFirstText === 0) tFirstText = tEnd

  return {
    ttfb: tFirstText - t0,
    total: tEnd - t0,
    firstText,
    messageTypes,
    phases: {
      callSetup: tSetup - t0,
      firstEvent: tFirstEvent > 0 ? tFirstEvent - tSetup : tEnd - tSetup,
      firstTextAfterEvent: tFirstEvent > 0 ? tFirstText - tFirstEvent : 0,
    },
  }
}

/** 路径 B：通过 QoderLanguageModel.doStream()（opencode 插件路径） */
async function measurePluginStream(): Promise<TimingResult> {
  // 确保不注入 MCP servers，保持最小路径
  setMcpBridgeServers({})

  const model = new QoderLanguageModel(MODEL)
  const messageTypes: string[] = []

  const t0 = performance.now()

  const { stream } = await model.doStream({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [
      {
        role: 'user',
        content: [{ type: 'text', text: PROMPT }],
      },
    ],
  })

  const tSetup = performance.now()

  const reader = stream.getReader()
  let tFirstEvent = 0
  let tFirstText = 0
  let firstText = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    const now = performance.now()
    const part = value as Record<string, unknown>

    if (tFirstEvent === 0) tFirstEvent = now
    if (messageTypes.length < 20) messageTypes.push(String(part.type))

    if (tFirstText === 0 && part.type === 'text-delta') {
      tFirstText = now
      firstText = String(part.delta ?? '').slice(0, 50)
    }
  }

  const tEnd = performance.now()
  if (tFirstText === 0) tFirstText = tEnd

  return {
    ttfb: tFirstText - t0,
    total: tEnd - t0,
    firstText,
    messageTypes,
    phases: {
      callSetup: tSetup - t0,
      firstEvent: tFirstEvent > 0 ? tFirstEvent - tSetup : tEnd - tSetup,
      firstTextAfterEvent: tFirstEvent > 0 ? tFirstText - tFirstEvent : 0,
    },
  }
}

/** 路径 C：QoderLanguageModel.doStream() 内部细分计时（额外注入断点） */
async function measurePluginStreamDetailed(): Promise<TimingResult & { buildPromptTime: number; resolveCliTime: number; buildOptionsTime: number }> {
  setMcpBridgeServers({})

  const t0 = performance.now()

  // 手动模拟 doStream 内部步骤，分段计时
  const { buildPromptFromOptions } = await import('../../src/prompt-builder.js')

  const options = {
    inputFormat: 'prompt' as const,
    mode: { type: 'regular' as const },
    prompt: [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: PROMPT }],
      },
    ],
  }

  const tBuildPromptStart = performance.now()
  const prompt = buildPromptFromOptions(options)
  const tBuildPromptEnd = performance.now()

  const tResolveCliStart = performance.now()
  const cliPath = resolveQoderCLI()
  const tResolveCliEnd = performance.now()

  // buildQoderQueryOptions 是内部函数，这里手动构造
  const tBuildOptionsStart = performance.now()
  const qoderOptions = {
    model: MODEL,
    allowDangerouslySkipPermissions: true as const,
    permissionMode: 'bypassPermissions' as const,
    cwd: process.cwd(),
    ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
  }
  const tBuildOptionsEnd = performance.now()

  // 现在调用 SDK query()
  const tQueryStart = performance.now()
  const iter = query({ prompt, options: qoderOptions })
  const tQueryReturn = performance.now()

  const messageTypes: string[] = []
  let tFirstEvent = 0
  let tFirstText = 0
  let firstText = ''

  for await (const msg of iter) {
    const m = msg as Record<string, unknown>
    const now = performance.now()

    if (tFirstEvent === 0) tFirstEvent = now
    if (messageTypes.length < 20) messageTypes.push(String(m.type))

    if (tFirstText === 0) {
      if (m.type === 'stream_event') {
        const ev = (m as { event: Record<string, unknown> }).event
        if (ev?.type === 'content_block_delta') {
          const delta = ev.delta as Record<string, unknown>
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            tFirstText = now
            firstText = delta.text
          }
        }
      } else if (m.type === 'assistant') {
        const content = ((m as any).message?.content ?? []) as any[]
        for (const block of content) {
          if (block?.type === 'text' && block.text) {
            tFirstText = now
            firstText = block.text.slice(0, 50)
            break
          }
        }
      }
    }
  }

  const tEnd = performance.now()
  if (tFirstText === 0) tFirstText = tEnd

  return {
    ttfb: tFirstText - t0,
    total: tEnd - t0,
    firstText,
    messageTypes,
    phases: {
      callSetup: tQueryReturn - t0,
      firstEvent: tFirstEvent > 0 ? tFirstEvent - tQueryReturn : tEnd - tQueryReturn,
      firstTextAfterEvent: tFirstEvent > 0 ? tFirstText - tFirstEvent : 0,
    },
    buildPromptTime: tBuildPromptEnd - tBuildPromptStart,
    resolveCliTime: tResolveCliEnd - tResolveCliStart,
    buildOptionsTime: tBuildOptionsEnd - tBuildOptionsStart,
  }
}

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe.skip('TTFB Comparison: Direct SDK vs Plugin', { timeout: TIMEOUT }, () => {
  it('对比 TTFB 和各阶段耗时', async () => {
    const sdkResults: TimingResult[] = []
    const pluginResults: TimingResult[] = []

    console.log(`\n${'═'.repeat(80)}`)
    console.log('  TTFB 对比测试：Direct SDK query() vs QoderLanguageModel.doStream()')
    console.log(`  Model: ${MODEL} | Prompt: "${PROMPT}" | Runs: ${RUNS}`)
    console.log(`${'═'.repeat(80)}\n`)

    for (let i = 0; i < RUNS; i++) {
      console.log(`── Run ${i + 1}/${RUNS} ──`)

      // 交替执行，避免顺序偏差
      if (i % 2 === 0) {
        console.log('  [A] Direct SDK...')
        const sdk = await measureDirectSDK()
        sdkResults.push(sdk)
        console.log(`      TTFB: ${sdk.ttfb.toFixed(0)}ms | Total: ${sdk.total.toFixed(0)}ms`)
        console.log(`      Phases: setup=${sdk.phases.callSetup.toFixed(0)}ms first_event=${sdk.phases.firstEvent.toFixed(0)}ms text_after_event=${sdk.phases.firstTextAfterEvent.toFixed(0)}ms`)
        console.log(`      First 20 msg types: [${sdk.messageTypes.join(', ')}]`)

        console.log('  [B] Plugin doStream...')
        const plugin = await measurePluginStream()
        pluginResults.push(plugin)
        console.log(`      TTFB: ${plugin.ttfb.toFixed(0)}ms | Total: ${plugin.total.toFixed(0)}ms`)
        console.log(`      Phases: setup=${plugin.phases.callSetup.toFixed(0)}ms first_event=${plugin.phases.firstEvent.toFixed(0)}ms text_after_event=${plugin.phases.firstTextAfterEvent.toFixed(0)}ms`)
        console.log(`      First 20 msg types: [${plugin.messageTypes.join(', ')}]`)
      } else {
        console.log('  [B] Plugin doStream...')
        const plugin = await measurePluginStream()
        pluginResults.push(plugin)
        console.log(`      TTFB: ${plugin.ttfb.toFixed(0)}ms | Total: ${plugin.total.toFixed(0)}ms`)

        console.log('  [A] Direct SDK...')
        const sdk = await measureDirectSDK()
        sdkResults.push(sdk)
        console.log(`      TTFB: ${sdk.ttfb.toFixed(0)}ms | Total: ${sdk.total.toFixed(0)}ms`)
      }
      console.log()
    }

    // 详细拆解测试（跑一次）
    console.log('── [C] Plugin Detailed Breakdown ──')
    const detailed = await measurePluginStreamDetailed()
    console.log(`  buildPrompt: ${detailed.buildPromptTime.toFixed(2)}ms`)
    console.log(`  resolveCLI:  ${detailed.resolveCliTime.toFixed(2)}ms`)
    console.log(`  buildOpts:   ${detailed.buildOptionsTime.toFixed(2)}ms`)
    console.log(`  SDK setup:   ${(detailed.phases.callSetup - detailed.buildPromptTime - detailed.resolveCliTime - detailed.buildOptionsTime).toFixed(0)}ms`)
    console.log(`  First event: ${detailed.phases.firstEvent.toFixed(0)}ms`)
    console.log(`  Text after:  ${detailed.phases.firstTextAfterEvent.toFixed(0)}ms`)
    console.log(`  Total TTFB:  ${detailed.ttfb.toFixed(0)}ms`)
    console.log(`  First 20 msg types: [${detailed.messageTypes.join(', ')}]`)

    // 汇总
    const avgSDK = sdkResults.reduce((s, r) => s + r.ttfb, 0) / sdkResults.length
    const avgPlugin = pluginResults.reduce((s, r) => s + r.ttfb, 0) / pluginResults.length
    const avgSDKSetup = sdkResults.reduce((s, r) => s + r.phases.callSetup, 0) / sdkResults.length
    const avgPluginSetup = pluginResults.reduce((s, r) => s + r.phases.callSetup, 0) / pluginResults.length
    const avgSDKFirstEvent = sdkResults.reduce((s, r) => s + r.phases.firstEvent, 0) / sdkResults.length
    const avgPluginFirstEvent = pluginResults.reduce((s, r) => s + r.phases.firstEvent, 0) / pluginResults.length

    console.log(`\n${'═'.repeat(80)}`)
    console.log('  SUMMARY')
    console.log(`${'═'.repeat(80)}`)
    console.log(`  Avg TTFB   - Direct SDK: ${avgSDK.toFixed(0)}ms | Plugin: ${avgPlugin.toFixed(0)}ms | Delta: ${(avgPlugin - avgSDK).toFixed(0)}ms (${((avgPlugin / avgSDK - 1) * 100).toFixed(0)}%)`)
    console.log(`  Avg Setup  - Direct SDK: ${avgSDKSetup.toFixed(0)}ms | Plugin: ${avgPluginSetup.toFixed(0)}ms | Delta: ${(avgPluginSetup - avgSDKSetup).toFixed(0)}ms`)
    console.log(`  Avg 1stEvt - Direct SDK: ${avgSDKFirstEvent.toFixed(0)}ms | Plugin: ${avgPluginFirstEvent.toFixed(0)}ms | Delta: ${(avgPluginFirstEvent - avgSDKFirstEvent).toFixed(0)}ms`)
    console.log(`${'═'.repeat(80)}\n`)

    // 详细数据写入日志文件
    const logData = {
      timestamp: new Date().toISOString(),
      model: MODEL,
      prompt: PROMPT,
      runs: RUNS,
      directSDK: sdkResults.map(r => ({ ttfb: r.ttfb, total: r.total, phases: r.phases, messageTypes: r.messageTypes })),
      plugin: pluginResults.map(r => ({ ttfb: r.ttfb, total: r.total, phases: r.phases, messageTypes: r.messageTypes })),
      detailed: {
        buildPromptTime: detailed.buildPromptTime,
        resolveCliTime: detailed.resolveCliTime,
        buildOptionsTime: detailed.buildOptionsTime,
        ttfb: detailed.ttfb,
        total: detailed.total,
        phases: detailed.phases,
        messageTypes: detailed.messageTypes,
      },
      summary: {
        avgSDK_TTFB: avgSDK,
        avgPlugin_TTFB: avgPlugin,
        delta_ms: avgPlugin - avgSDK,
        delta_pct: ((avgPlugin / avgSDK - 1) * 100),
      },
    }

    fs.writeFileSync('/tmp/ttfb-comparison.json', JSON.stringify(logData, null, 2))
    console.log('📊 详细数据已写入 /tmp/ttfb-comparison.json')
  })
})
