/**
 * TTFB 对比 v3：修复 CLI 解析 + 深入排查 stream_event 缺失
 * Model: efficient, 3 轮
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
  const binDir = path.join(os.homedir(), '.qoder', 'bin', 'qodercli')
  if (fs.existsSync(binDir)) {
    try {
      const entries = fs.readdirSync(binDir).filter(f => f.startsWith('qodercli-')).sort().reverse()
      if (entries[0]) return path.join(binDir, entries[0])
    } catch {}
  }
  return undefined
}

configure({ storageDir: resolveStorageDir() })

interface Result {
  ttfb: number
  total: number
  rawEvents: Array<{ type: string; time: number; detail?: string }>
  allStdout?: string
  allStderr?: string
}

// ── A) 直接 spawn qodercli ──────────────────────────────────────────────────
async function directCLI(): Promise<Result> {
  const cliPath = resolveQoderCLI()
  if (!cliPath) throw new Error('qodercli not found')

  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const rawEvents: Array<{ type: string; time: number; detail?: string }> = []
    let tFirstText = 0
    let allStdout = ''
    let allStderr = ''

    const child = spawn(cliPath, [
      '--model', MODEL,
      '--allowedTools', '',
      '--print',
      '--output-format', 'stream-json',
      '-p', PROMPT,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, QODER_STORAGE_DIR: resolveStorageDir() },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk: Buffer) => {
      const now = performance.now()
      const text = chunk.toString()
      allStdout += text

      if (rawEvents.length === 0) {
        rawEvents.push({ type: '_first_stdout', time: now - t0, detail: text.slice(0, 200) })
      }

      // 尝试按行解析 JSON
      const lines = text.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          rawEvents.push({ type: msg.type ?? 'unknown', time: now - t0, detail: msg.subtype })
          if (tFirstText === 0 && msg.type === 'assistant') {
            const content = msg.message?.content ?? []
            if (content.some((b: any) => b?.type === 'text' && b?.text)) tFirstText = now - t0
          }
          if (tFirstText === 0 && msg.type === 'stream_event') {
            const ev = msg.event
            if (ev?.type === 'content_block_delta' && ev?.delta?.type === 'text_delta' && ev?.delta?.text) tFirstText = now - t0
          }
        } catch {
          // 非 JSON 行 — 可能是纯文本输出
          if (!tFirstText && text.trim().length > 0) {
            rawEvents.push({ type: '_raw_text', time: now - t0, detail: line.slice(0, 100) })
          }
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      allStderr += text
      const now = performance.now()
      rawEvents.push({ type: '_stderr', time: now - t0, detail: text.slice(0, 200) })
    })

    child.on('close', (code) => {
      const total = performance.now() - t0
      rawEvents.push({ type: '_exit', time: total, detail: `code=${code}` })

      // 如果从未检测到文本事件，尝试从完整 stdout 中检测
      if (!tFirstText && allStdout.trim().length > 0) {
        // 找第一个有效文本的时间
        tFirstText = rawEvents.find(e => e.type === '_first_stdout')?.time ?? total
      }

      resolve({ ttfb: tFirstText || total, total, rawEvents, allStdout: allStdout.slice(0, 2000), allStderr: allStderr.slice(0, 1000) })
    })

    child.on('error', reject)
    child.stdin.end()
  })
}

// ── B) SDK query() — 额外记录每条消息的详细类型 ─────────────────────────────
async function sdkQuery(): Promise<Result> {
  const cliPath = resolveQoderCLI()
  const rawEvents: Array<{ type: string; time: number; detail?: string }> = []

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
      const ev = (m as any).event
      detail = `event=${ev?.type}`
      if (ev?.type === 'content_block_delta') {
        detail += ` delta=${ev?.delta?.type}`
        if (ev?.delta?.type === 'text_delta' && ev?.delta?.text && !tFirstText) {
          tFirstText = elapsed
        }
      }
    } else if (m.type === 'assistant') {
      const content = ((m as any).message?.content ?? []) as any[]
      detail = `blocks=[${content.map((b: any) => b.type).join(',')}]`
      if (!tFirstText && content.some((b: any) => b?.type === 'text' && b?.text)) {
        tFirstText = elapsed
      }
    } else if (m.type === 'system') {
      detail = `subtype=${(m as any).subtype}`
    } else if (m.type === 'result') {
      detail = `subtype=${(m as any).subtype} is_error=${(m as any).is_error}`
    }

    rawEvents.push({ type: String(m.type), time: elapsed, detail })
  }

  const total = performance.now() - t0
  return { ttfb: tFirstText || total, total, rawEvents }
}

// ── C) Plugin doStream() ────────────────────────────────────────────────────
async function pluginStream(): Promise<Result> {
  setMcpBridgeServers({})
  const model = new QoderLanguageModel(MODEL)
  const rawEvents: Array<{ type: string; time: number; detail?: string }> = []

  const t0 = performance.now()
  const { stream } = await model.doStream({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
  })

  rawEvents.push({ type: '_doStream_returned', time: performance.now() - t0 })

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
  return { ttfb: tFirstText || total, total, rawEvents }
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe.skip(`TTFB v3: CLI vs SDK vs Plugin (${MODEL})`, { timeout: TIMEOUT }, () => {
  it(`${RUNS} 轮对比`, async () => {
    const cliPath = resolveQoderCLI()
    console.log(`\nCLI: ${cliPath}`)
    console.log(`StorageDir: ${resolveStorageDir()}`)
    console.log(`Model: ${MODEL}\n`)

    // 先用 CLI 看一下输出格式
    console.log('── CLI Output Format Check ──')
    const check = await directCLI()
    console.log(`  stdout (first 500): ${check.allStdout?.slice(0, 500)}`)
    console.log(`  stderr (first 500): ${check.allStderr?.slice(0, 500)}`)
    console.log(`  events: ${JSON.stringify(check.rawEvents.slice(0, 10), null, 2)}`)
    console.log()

    // Warmup
    console.log('── Warmup ──')
    await sdkQuery()
    await pluginStream()
    console.log('  done\n')

    const results: Record<string, Result[]> = { cli: [], sdk: [], plugin: [] }

    for (let i = 0; i < RUNS; i++) {
      console.log(`── Round ${i + 1}/${RUNS} ──`)

      const rc = await directCLI()
      results.cli.push(rc)
      console.log(`  CLI:    TTFB ${rc.ttfb.toFixed(0)}ms | Total ${rc.total.toFixed(0)}ms`)

      const rs = await sdkQuery()
      results.sdk.push(rs)
      console.log(`  SDK:    TTFB ${rs.ttfb.toFixed(0)}ms | Total ${rs.total.toFixed(0)}ms | [${rs.rawEvents.map(e => `${e.type}(${e.detail})@${e.time.toFixed(0)}`).join(' → ')}]`)

      const rp = await pluginStream()
      results.plugin.push(rp)
      console.log(`  Plugin: TTFB ${rp.ttfb.toFixed(0)}ms | Total ${rp.total.toFixed(0)}ms`)
    }

    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

    console.log(`\n${'═'.repeat(80)}`)
    console.log(`  CLI    avg TTFB: ${avg(results.cli.map(r => r.ttfb)).toFixed(0)}ms | [${results.cli.map(r => r.ttfb.toFixed(0)).join(', ')}]`)
    console.log(`  SDK    avg TTFB: ${avg(results.sdk.map(r => r.ttfb)).toFixed(0)}ms | [${results.sdk.map(r => r.ttfb.toFixed(0)).join(', ')}]`)
    console.log(`  Plugin avg TTFB: ${avg(results.plugin.map(r => r.ttfb)).toFixed(0)}ms | [${results.plugin.map(r => r.ttfb.toFixed(0)).join(', ')}]`)
    console.log(`${'═'.repeat(80)}`)

    fs.writeFileSync('/tmp/ttfb-v3.json', JSON.stringify({
      model: MODEL, runs: RUNS,
      cliPath,
      ...results,
      summary: {
        cli: avg(results.cli.map(r => r.ttfb)),
        sdk: avg(results.sdk.map(r => r.ttfb)),
        plugin: avg(results.plugin.map(r => r.ttfb)),
      },
    }, null, 2))
    console.log('\n📊 /tmp/ttfb-v3.json')
  })
})
