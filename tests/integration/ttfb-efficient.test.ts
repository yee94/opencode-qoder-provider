/**
 * TTFB 对比：Direct qodercli vs SDK query() vs Plugin doStream()
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
  rawEvents: Array<{ type: string; time: number }>
}

// ── A) 直接 spawn qodercli 子进程 ────────────────────────────────────────────
async function directCLI(): Promise<Result> {
  const cliPath = resolveQoderCLI()
  if (!cliPath) throw new Error('qodercli not found')

  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const rawEvents: Array<{ type: string; time: number }> = []
    let tFirstText = 0
    let buffer = ''

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
      buffer += chunk.toString()

      // 解析 JSONL
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          const elapsed = now - t0
          rawEvents.push({ type: msg.type ?? 'unknown', time: elapsed })

          if (tFirstText === 0) {
            if (msg.type === 'assistant') {
              const content = msg.message?.content ?? []
              if (content.some((b: any) => b?.type === 'text' && b?.text)) {
                tFirstText = elapsed
              }
            } else if (msg.type === 'stream_event') {
              const ev = msg.event
              if (ev?.type === 'content_block_delta' && ev?.delta?.type === 'text_delta' && ev?.delta?.text) {
                tFirstText = elapsed
              }
            }
          }
        } catch {}
      }
    })

    child.stderr.on('data', () => {}) // ignore

    child.on('close', () => {
      const total = performance.now() - t0
      resolve({ ttfb: tFirstText || total, total, rawEvents })
    })

    child.on('error', reject)

    // 关闭 stdin
    child.stdin.end()
  })
}

// ── B) SDK query() ───────────────────────────────────────────────────────────
async function sdkQuery(): Promise<Result> {
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

  let tFirstText = 0

  for await (const msg of iter) {
    const m = msg as Record<string, unknown>
    const elapsed = performance.now() - t0
    rawEvents.push({ type: String(m.type), time: elapsed })

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
  return { ttfb: tFirstText || total, total, rawEvents }
}

// ── C) Plugin doStream() ────────────────────────────────────────────────────
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

  const reader = stream.getReader()
  let tFirstText = 0

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const elapsed = performance.now() - t0
    const part = value as Record<string, unknown>
    rawEvents.push({ type: String(part.type), time: elapsed })

    if (tFirstText === 0 && part.type === 'text-delta') {
      tFirstText = elapsed
    }
  }

  const total = performance.now() - t0
  return { ttfb: tFirstText || total, total, rawEvents }
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe.skip(`TTFB: CLI vs SDK vs Plugin (${MODEL})`, { timeout: TIMEOUT }, () => {
  it(`${RUNS} 轮对比`, async () => {
    const cliPath = resolveQoderCLI()
    console.log(`\nCLI path: ${cliPath}`)
    console.log(`Model: ${MODEL} | Runs: ${RUNS}\n`)

    // Warmup
    console.log('── Warmup ──')
    if (cliPath) { console.log('  CLI...'); await directCLI() }
    console.log('  SDK...'); await sdkQuery()
    console.log('  Plugin...'); await pluginStream()
    console.log()

    const results: Record<string, Result[]> = { cli: [], sdk: [], plugin: [] }

    for (let i = 0; i < RUNS; i++) {
      console.log(`── Round ${i + 1}/${RUNS} ──`)

      if (cliPath) {
        const r = await directCLI()
        results.cli.push(r)
        console.log(`  CLI:    TTFB ${r.ttfb.toFixed(0)}ms | Total ${r.total.toFixed(0)}ms | [${r.rawEvents.map(e => `${e.type}@${e.time.toFixed(0)}`).join(', ')}]`)
      }

      const rs = await sdkQuery()
      results.sdk.push(rs)
      console.log(`  SDK:    TTFB ${rs.ttfb.toFixed(0)}ms | Total ${rs.total.toFixed(0)}ms | [${rs.rawEvents.map(e => `${e.type}@${e.time.toFixed(0)}`).join(', ')}]`)

      const rp = await pluginStream()
      results.plugin.push(rp)
      console.log(`  Plugin: TTFB ${rp.ttfb.toFixed(0)}ms | Total ${rp.total.toFixed(0)}ms | [${rp.rawEvents.map(e => `${e.type}@${e.time.toFixed(0)}`).join(', ')}]`)
    }

    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

    console.log(`\n${'═'.repeat(80)}`)
    if (results.cli.length) console.log(`  CLI    avg TTFB: ${avg(results.cli.map(r => r.ttfb)).toFixed(0)}ms | runs: ${results.cli.map(r => r.ttfb.toFixed(0)).join(', ')}`)
    console.log(`  SDK    avg TTFB: ${avg(results.sdk.map(r => r.ttfb)).toFixed(0)}ms | runs: ${results.sdk.map(r => r.ttfb.toFixed(0)).join(', ')}`)
    console.log(`  Plugin avg TTFB: ${avg(results.plugin.map(r => r.ttfb)).toFixed(0)}ms | runs: ${results.plugin.map(r => r.ttfb.toFixed(0)).join(', ')}`)
    if (results.cli.length) {
      console.log(`  SDK vs CLI:    ${(avg(results.sdk.map(r => r.ttfb)) - avg(results.cli.map(r => r.ttfb))).toFixed(0)}ms`)
      console.log(`  Plugin vs CLI: ${(avg(results.plugin.map(r => r.ttfb)) - avg(results.cli.map(r => r.ttfb))).toFixed(0)}ms`)
    }
    console.log(`  Plugin vs SDK: ${(avg(results.plugin.map(r => r.ttfb)) - avg(results.sdk.map(r => r.ttfb))).toFixed(0)}ms`)
    console.log(`${'═'.repeat(80)}`)

    fs.writeFileSync('/tmp/ttfb-efficient.json', JSON.stringify({ model: MODEL, runs: RUNS, ...results, summary: {
      cli: avg(results.cli.map(r => r.ttfb)),
      sdk: avg(results.sdk.map(r => r.ttfb)),
      plugin: avg(results.plugin.map(r => r.ttfb)),
    }}, null, 2))
    console.log('\n📊 /tmp/ttfb-efficient.json')
  })
})
