/**
 * 调试测试：观察 MCP 工具 (context7) 的 raw SDK 消息
 */
import { describe, it, expect } from 'vitest'
import { configure, query } from '../../src/vendor/qoder-agent-sdk.mjs'
import { setMcpBridgeServers } from '../../src/mcp-bridge.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TIMEOUT = 120_000
const DEBUG_LOG = '/tmp/debug-raw-mcp-messages.log'

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

describe.skip('Debug: Raw MCP SDK Messages', { timeout: TIMEOUT }, () => {
  it('带 mcpServers=context7 时 query() 发出的原始消息', async () => {
    const cliPath = resolveQoderCLI()
    const messages: unknown[] = []

    const iter = query({
      prompt: 'Use context7 to look up what "antd" is. Call resolve-library-id first with libraryName="antd".',
      options: {
        model: 'auto',
        allowDangerouslySkipPermissions: true,
        permissionMode: 'bypassPermissions',
        cwd: process.cwd(),
        ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
        mcpServers: {
          context7: {
            command: 'npx',
            args: ['-y', '@upstash/context7-mcp@latest'],
          },
        },
      },
    })

    for await (const msg of iter) {
      messages.push(msg)
    }

    const log = messages.map((m, i) => {
      const obj = m as Record<string, unknown>
      const typeStr = `${obj.type}${obj.subtype ? '/' + obj.subtype : ''}`

      if (obj.type === 'stream_event') {
        const ev = obj.event as Record<string, unknown>
        return `[${i}] stream_event/${ev.type} ${JSON.stringify(ev).slice(0, 500)}`
      } else if (obj.type === 'assistant') {
        const msg = obj.message as Record<string, unknown>
        const content = Array.isArray(msg?.content) ? msg.content : []
        const blocks = content.map((b: Record<string, unknown>) => {
          if (b.type === 'tool_use') return `tool_use(id=${b.id}, name=${b.name}, input=${JSON.stringify(b.input)?.slice(0, 300)})`
          if (b.type === 'text') return `text(${(b.text as string)?.slice(0, 200)})`
          return `${b.type}(...)`
        })
        return `[${i}] ${typeStr}: [${blocks.join(', ')}]`
      } else if (obj.type === 'user') {
        const msg = obj.message as Record<string, unknown>
        const content = Array.isArray(msg?.content) ? msg.content : []
        const blocks = content.map((b: Record<string, unknown>) => {
          if (b.type === 'tool_result') return `tool_result(id=${b.tool_use_id}, content=${String(b.content)?.slice(0, 300)})`
          return `${b.type}(...)`
        })
        return `[${i}] ${typeStr}: [${blocks.join(', ')}]`
      } else {
        return `[${i}] ${typeStr}: ${JSON.stringify(obj).slice(0, 500)}`
      }
    }).join('\n')

    fs.writeFileSync(DEBUG_LOG, log)
    expect(messages.length).toBeGreaterThan(0)
  })
})
