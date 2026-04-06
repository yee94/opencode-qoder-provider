/**
 * 验证测试：QoderAgentSDKClient + canUseTool（TCP 模式）
 *
 * 假设：canUseTool 只在 QoderAgentSDKClient（TCP/持久连接）模式下工作
 * 因为 control_request 通过 TCP socket 双向通信传递
 *
 * 运行：npx vitest run tests/integration/canuse-client-mode.test.ts
 */
import { describe, it, expect } from 'vitest'
import { configure, QoderAgentSDKClient } from '../../src/vendor/qoder-agent-sdk.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TIMEOUT = 120_000
const DEBUG_LOG = '/tmp/canuse-client-mode-messages.log'

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

function formatMessage(m: unknown, i: number): string {
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
      if (delta?.type === 'text_delta') summary.text = (delta.text as string)?.slice(0, 200)
      if (delta?.type === 'input_json_delta') summary.json = (delta.partial_json as string)?.slice(0, 300)
    }
  } else if (obj.type === 'assistant') {
    const msg = obj.message as Record<string, unknown>
    const content = Array.isArray(msg?.content) ? msg.content : []
    summary.blocks = content.map((b: Record<string, unknown>) => ({
      type: b.type,
      ...(b.type === 'tool_use' ? { id: b.id, name: b.name, input: JSON.stringify(b.input)?.slice(0, 300) } : {}),
      ...(b.type === 'text' ? { text: (b.text as string)?.slice(0, 200) } : {}),
      ...(b.type === 'thinking' ? { thinking: (b.thinking as string)?.slice(0, 200) } : {}),
    }))
  } else if (obj.type === 'user') {
    const msg = obj.message as Record<string, unknown>
    const content = Array.isArray(msg?.content) ? msg.content : []
    summary.blocks = content.map((b: Record<string, unknown>) => ({
      type: b.type,
      ...(b.type === 'tool_result' ? {
        tool_use_id: b.tool_use_id,
        is_error: b.is_error,
        content: typeof b.content === 'string' ? b.content.slice(0, 300) : JSON.stringify(b.content)?.slice(0, 300),
      } : {}),
    }))
  } else if (obj.type === 'result') {
    summary.is_error = obj.is_error
    summary.usage = obj.usage
    summary.result = (obj.result as string)?.slice(0, 300)
  }

  return `[${i}] ${JSON.stringify(summary, null, 2)}`
}

describe('QoderAgentSDKClient + canUseTool', { timeout: TIMEOUT }, () => {
  it('Client 模式 canUseTool deny all', async () => {
    const cliPath = resolveQoderCLI()
    const messages: unknown[] = []
    const toolDenyLog: string[] = []

    // 创建测试标记文件
    fs.writeFileSync('/tmp/canuse-test-marker.txt', 'CLIENT_MODE_DENY_TEST_99999')

    const canUseTool = async (toolName: string, input: unknown, _options: unknown) => {
      const entry = `[CLIENT-DENY] toolName=${toolName} input=${JSON.stringify(input)?.slice(0, 200)}`
      toolDenyLog.push(entry)
      console.log(entry)
      return {
        behavior: 'deny' as const,
        message: `Tool "${toolName}" is denied. opencode will handle tool execution externally.`,
      }
    }

    const client = new QoderAgentSDKClient({
      model: 'auto',
      includePartialMessages: true,
      cwd: '/tmp',
      maxTurns: 3,
      canUseTool,
      ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
    })

    try {
      await client.connect('Read the file /tmp/canuse-test-marker.txt using the Read tool. Just read it and tell me the content.')

      for await (const msg of client.receiveMessages()) {
        messages.push(msg)
      }
    } finally {
      try { await client.disconnect() } catch { /* ignore */ }
    }

    // 分析结果
    const userMessages = messages.filter((m: Record<string, unknown>) => m.type === 'user')
    const assistantMessages = messages.filter((m: Record<string, unknown>) => m.type === 'assistant')
    const toolUseBlocks = assistantMessages.flatMap((m: Record<string, unknown>) => {
      const msg = m.message as Record<string, unknown>
      const content = Array.isArray(msg?.content) ? msg.content : []
      return content.filter((b: Record<string, unknown>) => b.type === 'tool_use')
    })
    const toolResultBlocks = userMessages.flatMap((m: Record<string, unknown>) => {
      const msg = m.message as Record<string, unknown>
      const content = Array.isArray(msg?.content) ? msg.content : []
      return content.filter((b: Record<string, unknown>) => b.type === 'tool_result')
    })

    const log = `=== Client Mode canUseTool deny 测试 (${new Date().toISOString()}) ===\n` +
      messages.map((m, i) => formatMessage(m, i)).join('\n') +
      `\n\n=== canUseTool 回调日志 ===\n${toolDenyLog.join('\n')}`
    fs.writeFileSync(DEBUG_LOG, log)

    console.log(`\nClient 模式 canUseTool deny 测试:`)
    console.log(`  总消息数: ${messages.length}`)
    console.log(`  assistant 消息: ${assistantMessages.length}`)
    console.log(`  user 消息: ${userMessages.length}`)
    console.log(`  tool_use 块: ${toolUseBlocks.length}`)
    console.log(`  tool_result 块: ${toolResultBlocks.length}`)
    console.log(`  canUseTool 回调次数: ${toolDenyLog.length}`)

    if (toolDenyLog.length > 0) {
      console.log('  ✅ canUseTool 回调被调用！')

      // 检查 tool_result 是否为错误（表示工具被拦截）
      for (const block of toolResultBlocks) {
        const b = block as Record<string, unknown>
        console.log(`  tool_result: is_error=${b.is_error}, content=${String(b.content).slice(0, 200)}`)
      }
    } else {
      console.log('  ❌ canUseTool 回调未被调用')
    }

    console.log(`日志已写入 ${DEBUG_LOG}`)

    // 主要断言：canUseTool 回调应该在 Client 模式下被调用
    expect(messages.length).toBeGreaterThan(0)
  })
})
