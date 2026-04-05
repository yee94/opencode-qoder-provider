/**
 * 调试测试：观察 SDK query() 发出的原始消息
 */
import { describe, it, expect } from 'vitest'
import { configure, query } from '../../src/vendor/qoder-agent-sdk.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TIMEOUT = 120_000
const DEBUG_LOG = '/tmp/debug-raw-sdk-messages.log'

// 配置 SDK
function resolveStorageDir(): string {
  const qoderwork = path.join(os.homedir(), '.qoderwork')
  if (fs.existsSync(path.join(qoderwork, '.auth', 'user'))) return qoderwork
  return path.join(os.homedir(), '.qoder')
}
configure({ storageDir: resolveStorageDir() })

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

describe.skip('Debug: Raw SDK Messages', { timeout: TIMEOUT }, () => {
  it('观察 query() 发出的所有原始消息类型', async () => {
    const cliPath = resolveQoderCLI()
    const messages: unknown[] = []

    const iter = query({
      prompt: 'Run `echo hello` using the bash tool. You MUST use the bash tool.',
      options: {
        model: 'auto',
        allowDangerouslySkipPermissions: true,
        permissionMode: 'bypassPermissions',
        cwd: process.cwd(),
        ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
      },
    })

    for await (const msg of iter) {
      messages.push(msg)
    }

    const log = messages.map((m, i) => {
      const obj = m as Record<string, unknown>
      const summary: Record<string, unknown> = { type: obj.type, subtype: obj.subtype }

      if (obj.type === 'stream_event') {
        const ev = obj.event as Record<string, unknown>
        summary.eventType = ev?.type
        if (ev?.type === 'content_block_start') {
          summary.block = ev.content_block
        }
        if (ev?.type === 'content_block_delta') {
          const delta = ev.delta as Record<string, unknown>
          summary.deltaType = delta?.type
          if (delta?.type === 'text_delta') summary.text = (delta.text as string)?.slice(0, 100)
          if (delta?.type === 'input_json_delta') summary.json = (delta.partial_json as string)?.slice(0, 200)
        }
      } else if (obj.type === 'assistant') {
        const msg = obj.message as Record<string, unknown>
        const content = Array.isArray(msg?.content) ? msg.content : []
        summary.blocks = content.map((b: Record<string, unknown>) => ({
          type: b.type,
          ...(b.type === 'tool_use' ? { id: b.id, name: b.name, input: JSON.stringify(b.input)?.slice(0, 200) } : {}),
          ...(b.type === 'text' ? { text: (b.text as string)?.slice(0, 100) } : {}),
        }))
      } else if (obj.type === 'user') {
        const msg = obj.message as Record<string, unknown>
        const content = Array.isArray(msg?.content) ? msg.content : []
        summary.blocks = content.map((b: Record<string, unknown>) => ({
          type: b.type,
          ...(b.type === 'tool_result' ? { tool_use_id: b.tool_use_id, content: String(b.content)?.slice(0, 200) } : {}),
        }))
      } else if (obj.type === 'result') {
        summary.is_error = obj.is_error
        summary.usage = obj.usage
      }

      return `[${i}] ${JSON.stringify(summary)}`
    }).join('\n')

    fs.writeFileSync(DEBUG_LOG, log)

    expect(messages.length).toBeGreaterThan(0)
  })
})
