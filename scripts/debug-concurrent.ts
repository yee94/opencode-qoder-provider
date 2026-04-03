/**
 * 并发 doStream 调试脚本
 * 用法: QODER_DEBUG=1 bun run scripts/debug-concurrent.ts
 *
 * 模拟 opencode 委派多个并发 subagent 时的场景：
 * 同一 QoderLanguageModel 实例被同时调用 doStream() N 次
 */
import { createQoderProvider } from '../src/qoder-language-model.js'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'

const CONCURRENT_CALLS = 3
const SHORT_PROMPT = (i: number) =>
  `Reply with exactly: "CALL_${i}_OK" and nothing else.`

// ── 颜色标记 ──────────────────────────────────────────────────────────────────
const colors = ['\x1b[33m', '\x1b[36m', '\x1b[35m', '\x1b[32m']
const reset = '\x1b[0m'
function tag(i: number, msg: string) {
  const c = colors[i % colors.length]
  const ts = new Date().toISOString().slice(11, 23)
  process.stderr.write(`${c}[CALL-${i} ${ts}]${reset} ${msg}\n`)
}

async function runCall(model: ReturnType<ReturnType<typeof createQoderProvider>['languageModel']>, i: number) {
  tag(i, 'doStream() START')
  try {
    const { stream } = await model.doStream({
      inputFormat: 'messages',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: SHORT_PROMPT(i) }] },
      ],
    })
    tag(i, 'doStream() returned stream, reading...')

    const reader = stream.getReader()
    let text = ''
    let partCount = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      partCount++
      const part = value as LanguageModelV2StreamPart
      if (part.type === 'text-delta') text += part.delta
      if (part.type === 'error') {
        tag(i, `⚠️  stream error: ${part.error}`)
      }
      if (part.type === 'finish') {
        tag(i, `finish reason=${part.finishReason}`)
      }
    }
    tag(i, `✅ DONE  parts=${partCount}  text="${text.trim().slice(0, 80)}"`)
    return { ok: true, text }
  } catch (err) {
    tag(i, `❌ THREW: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false, error: err }
  }
}

async function main() {
  const provider = createQoderProvider()

  // opencode 会缓存同一个 model 实例 → 测试同一实例的并发行为
  const model = provider.languageModel('auto')

  console.error(`\n🚀 Launching ${CONCURRENT_CALLS} concurrent doStream() calls on the SAME model instance\n`)

  const start = Date.now()
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_CALLS }, (_, i) => runCall(model, i + 1))
  )
  const elapsed = Date.now() - start

  console.error(`\n──────────────────────────────────────────────`)
  console.error(`Results after ${elapsed}ms:`)
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    console.error(`  Call ${i + 1}: ${r.ok ? `✅ "${String((r as {text: string}).text).trim().slice(0, 40)}"` : `❌ FAILED`}`)
  }

  const passed = results.filter((r) => r.ok).length
  console.error(`\n${passed}/${CONCURRENT_CALLS} calls succeeded`)
  process.exit(passed === CONCURRENT_CALLS ? 0 : 1)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
