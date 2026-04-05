/**
 * TTFB 最终对比：qodercli 直接调用 vs SDK query() vs Plugin doStream()
 * 修正了 CLI 参数问题
 */
import { describe, it } from 'vitest'
import { configure, query } from '../../src/vendor/qoder-agent-sdk.mjs'
import { QoderLanguageModel } from '../../src/qoder-language-model.js'
import { setMcpBridgeServers } from '../../src/mcp-bridge.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const TIMEOUT = 300_000
const PROMPT = 'Reply with exactly one word: PONG'
const MODEL = 'efficient'
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
  hasStreamEvents: boolean
  rawEvents: Array<{ type: string; time: number; detail?: string }>
}

// ── A) qodercli -p "..." -f stream-json ─────────────────────────────────────
async function directCLI(): Promise<Result> {
  const cliPath = resolveQoderCLI()!
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const rawEvents: Array<{ type: string; time: number; detail?: string }> = []
    let tFirstText = 0
    let hasStreamEvents = false
    let buffer = ''

    const child = spawn(cliPath, [
      '--model', MODEL,
      '--dangerously-skip-permissions',
      '-f', 'stream-json',
      '-p', PROMPT,
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk: Buffer) => {
      const now = performance.now()
      const elapsed = now - t0
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          const type = msg.type ?? 'unknown'
          let detail = ''

          if (type === 'stream_event') {
            hasStreamEvents = true
            const ev = msg.event
            detail = `ev=${ev?.type}`
            if (ev?.type === 'content_block_delta') {
              detail += ` delta=${ev?.delta?.type}`
              if (!tFirstText && ev?.delta?.type === 'text_delta' && ev?.delta?.text) {
                tFirstText = elapsed
              }
            }
          } else if (type === 'assistant') {
            const blocks = (msg.message?.content ?? []).map((b: any) => b.type)
            detail = `blocks=[${blocks.join(',')}]`
            if (!tFirstText && blocks.includes('text')) tFirstText = elapsed
          }

          rawEvents.push({ type, time: elapsed, detail })
        } catch {}
      }
    })

    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', () => {
      const total = performance.now() - t0
      resolve({ ttfb: tFirstText || total, total, hasStreamEvents, rawEvents })
    })
    child.stdin.end()
  })
}

// ── B) SDK query() ───────────────────────────────────────────────────────────
async function sdkQuery(): Promise<Result> {
  const cliPath = resolveQoderCLI()
  const rawEvents: Array<{ type: string; time: number; detail?: string }> = []
  let hasStreamEvents = false

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

  let tFirstText = 0

  for await (const msg of iter) {
    const m = msg as Record<string, unknown>
    const elapsed = performance.now() - t0
    let detail = ''

    if (m.type === 'stream_event') {
      hasStreamEvents = true
      const ev = (m as any).event
      detail = `ev=${ev?.type}`
      if (ev?.type === 'content_block_delta' && ev?.delta?.type === 'text_delta' && ev?.delta?.text && !tFirstText) {
        tFirstText = elapsed
        detail += ` FIRST_TEXT`
      }
    } else if (m.type === 'assistant') {
      const blocks = (((m as any).message?.content ?? []) as any[]).map((b: any) => b.type)
      detail = `blocks=[${blocks.join(',')}]`
      if (!tFirstText && blocks.includes('text')) tFirstText = elapsed
    } else if (m.type === 'system') {
      detail = `subtype=${(m as any).subtype}`
    } else if (m.type === 'result') {
      detail = `subtype=${(m as any).subtype}`
    }

    rawEvents.push({ type: String(m.type), time: elapsed, detail })
  }

  const total = performance.now() - t0
  return { ttfb: tFirstText || total, total, hasStreamEvents, rawEvents }
}

// ── C) Plugin doStream() ────────────────────────────────────────────────────
async function pluginStream(): Promise<Result> {
  setMcpBridgeServers({})
  const model = new QoderLanguageModel(MODEL)
  const rawEvents: Array<{ type: string; time: number; detail?: string }> = []
  let hasStreamEvents = false // 在 plugin 层面不直接看到

  const t0 = performance.now()
  const { stream } = await model.doStream({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
  })

  const reader = stream.getReader()
  let tFirstText = 0

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const elapsed = performance.now() - t0
    const part = value as Record<string, unknown>
    rawEvents.push({ type: String(part.type), time: elapsed })
    if (!tFirstText && part.type === 'text-delta') tFirstText = elapsed
  }

  const total = performance.now() - t0
  return { ttfb: tFirstText || total, total, hasStreamEvents, rawEvents }
}

describe.skip(`TTFB Final: CLI vs SDK vs Plugin (${MODEL})`, { timeout: TIMEOUT }, () => {
  it(`${RUNS} 轮对比`, async () => {
    const cliPath = resolveQoderCLI()
    console.log(`\nCLI: ${cliPath}\nModel: ${MODEL}\n`)

    // Warmup
    console.log('── Warmup (1 round each) ──')
    const cliWarmup = await directCLI()
    console.log(`  CLI:    TTFB ${cliWarmup.ttfb.toFixed(0)}ms | stream_event: ${cliWarmup.hasStreamEvents} | [${cliWarmup.rawEvents.map(e => `${e.type}(${e.detail})@${e.time.toFixed(0)}`).join(' → ')}]`)
    const sdkWarmup = await sdkQuery()
    console.log(`  SDK:    TTFB ${sdkWarmup.ttfb.toFixed(0)}ms | stream_event: ${sdkWarmup.hasStreamEvents} | [${sdkWarmup.rawEvents.map(e => `${e.type}(${e.detail})@${e.time.toFixed(0)}`).join(' → ')}]`)
    const pluginWarmup = await pluginStream()
    console.log(`  Plugin: TTFB ${pluginWarmup.ttfb.toFixed(0)}ms | [${pluginWarmup.rawEvents.map(e => `${e.type}@${e.time.toFixed(0)}`).join(' → ')}]`)
    console.log()

    const results: Record<string, Result[]> = { cli: [], sdk: [], plugin: [] }

    for (let i = 0; i < RUNS; i++) {
      console.log(`── Round ${i + 1}/${RUNS} ──`)

      const rc = await directCLI()
      results.cli.push(rc)
      console.log(`  CLI:    TTFB ${rc.ttfb.toFixed(0)}ms | stream: ${rc.hasStreamEvents} | [${rc.rawEvents.slice(0, 8).map(e => `${e.type}(${e.detail})@${e.time.toFixed(0)}`).join(' → ')}]`)

      const rs = await sdkQuery()
      results.sdk.push(rs)
      console.log(`  SDK:    TTFB ${rs.ttfb.toFixed(0)}ms | stream: ${rs.hasStreamEvents} | [${rs.rawEvents.map(e => `${e.type}(${e.detail})@${e.time.toFixed(0)}`).join(' → ')}]`)

      const rp = await pluginStream()
      results.plugin.push(rp)
      console.log(`  Plugin: TTFB ${rp.ttfb.toFixed(0)}ms | [${rp.rawEvents.map(e => `${e.type}@${e.time.toFixed(0)}`).join(' → ')}]`)
    }

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length

    console.log(`\n${'═'.repeat(80)}`)
    console.log(`  CLI    avg TTFB: ${avg(results.cli.map(r => r.ttfb)).toFixed(0)}ms | stream_events: ${results.cli.some(r => r.hasStreamEvents)}`)
    console.log(`  SDK    avg TTFB: ${avg(results.sdk.map(r => r.ttfb)).toFixed(0)}ms | stream_events: ${results.sdk.some(r => r.hasStreamEvents)}`)
    console.log(`  Plugin avg TTFB: ${avg(results.plugin.map(r => r.ttfb)).toFixed(0)}ms`)
    console.log(`  SDK    vs CLI:    +${(avg(results.sdk.map(r => r.ttfb)) - avg(results.cli.map(r => r.ttfb))).toFixed(0)}ms`)
    console.log(`  Plugin vs CLI:    +${(avg(results.plugin.map(r => r.ttfb)) - avg(results.cli.map(r => r.ttfb))).toFixed(0)}ms`)
    console.log(`  Plugin vs SDK:    +${(avg(results.plugin.map(r => r.ttfb)) - avg(results.sdk.map(r => r.ttfb))).toFixed(0)}ms`)
    console.log(`${'═'.repeat(80)}`)

    // 关键分析：SDK 的 system → assistant 之间的时间
    console.log('\n── SDK timeline analysis ──')
    for (const r of results.sdk) {
      const system = r.rawEvents.find(e => e.type === 'system')
      const assistant = r.rawEvents.find(e => e.type === 'assistant')
      const result = r.rawEvents.find(e => e.type === 'result')
      console.log(`  init@${system?.time.toFixed(0)} → assistant@${assistant?.time.toFixed(0)} (wait: ${((assistant?.time ?? 0) - (system?.time ?? 0)).toFixed(0)}ms) → result@${result?.time.toFixed(0)}`)
    }

    // CLI timeline
    console.log('\n── CLI timeline analysis ──')
    for (const r of results.cli) {
      const types = r.rawEvents.map(e => e.type)
      const firstStream = r.rawEvents.find(e => e.type === 'stream_event')
      const firstAssistant = r.rawEvents.find(e => e.type === 'assistant')
      console.log(`  types: [${types.slice(0, 15).join(', ')}] | first stream_event@${firstStream?.time.toFixed(0) ?? 'N/A'} | first assistant@${firstAssistant?.time.toFixed(0) ?? 'N/A'}`)
    }

    fs.writeFileSync('/tmp/ttfb-final.json', JSON.stringify({
      model: MODEL, runs: RUNS, ...results,
      summary: {
        cli: avg(results.cli.map(r => r.ttfb)),
        sdk: avg(results.sdk.map(r => r.ttfb)),
        plugin: avg(results.plugin.map(r => r.ttfb)),
      },
    }, null, 2))
    console.log('\n📊 /tmp/ttfb-final.json')
  })
})
