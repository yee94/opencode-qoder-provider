/**
 * 验证测试：canUseTool 回调能否阻止 qodercli 执行工具
 *
 * 核心假设：
 * - 设置 canUseTool 回调，对所有工具返回 deny
 * - 观察 qodercli 是否仍然执行工具（user 事件中有 tool_result = 工具被执行了）
 * - 如果只有 assistant 事件中的 tool_use 而没有 user 事件中的 tool_result → 工具被拦截成功
 *
 * 运行：npx vitest run tests/integration/canuse-tool-deny.test.ts
 */
import { describe, it, expect } from 'vitest'
import { configure, query } from '../../src/vendor/qoder-agent-sdk.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TIMEOUT = 120_000
const DEBUG_LOG = '/tmp/canuse-tool-deny-messages.log'

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

describe('canUseTool deny 验证', { timeout: TIMEOUT }, () => {
  /**
   * 测试 1: 基线 — bypassPermissions + 无 canUseTool
   * 预期：qodercli 正常执行工具，user 事件中有 tool_result
   */
  it('基线：bypassPermissions 下工具正常执行', async () => {
    const cliPath = resolveQoderCLI()
    const messages: unknown[] = []

    const iter = query({
      prompt: 'Read the file /tmp/canuse-test-marker.txt using the Read tool. Just read it and tell me the content.',
      options: {
        model: 'auto',
        allowDangerouslySkipPermissions: true,
        permissionMode: 'bypassPermissions' as const,
        includePartialMessages: true,
        cwd: '/tmp',
        maxTurns: 2,
        ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
      },
    })

    // 先创建测试标记文件
    fs.writeFileSync('/tmp/canuse-test-marker.txt', 'BASELINE_TEST_CONTENT_12345')

    for await (const msg of iter) {
      messages.push(msg)
    }

    const log = formatMessages(messages, '基线测试')
    fs.writeFileSync(DEBUG_LOG, log)

    // 基线预期：应该有 user 事件包含 tool_result
    const userMessages = messages.filter((m: any) => m.type === 'user')
    console.log(`\n基线测试: ${messages.length} 条消息, ${userMessages.length} 条 user 消息`)
    console.log(`日志已写入 ${DEBUG_LOG}`)

    expect(messages.length).toBeGreaterThan(0)
  })

  /**
   * 测试 2: canUseTool deny all — 不使用 bypassPermissions
   * 预期：canUseTool 回调被调用，所有工具被 deny，qodercli 不执行工具
   */
  it('canUseTool deny all：所有工具被拦截', async () => {
    const cliPath = resolveQoderCLI()
    const messages: unknown[] = []
    const toolDenyLog: string[] = []

    // 创建测试标记文件
    fs.writeFileSync('/tmp/canuse-test-marker.txt', 'DENY_TEST_CONTENT_67890')

    const canUseTool = async (toolName: string, input: unknown, _options: unknown) => {
      const entry = `[DENY] toolName=${toolName} input=${JSON.stringify(input)?.slice(0, 200)}`
      toolDenyLog.push(entry)
      console.log(entry)
      return {
        behavior: 'deny' as const,
        message: `Tool "${toolName}" is denied. opencode will handle tool execution externally.`,
      }
    }

    const iter = query({
      prompt: 'Read the file /tmp/canuse-test-marker.txt using the Read tool. Just read it and tell me the content.',
      options: {
        model: 'auto',
        // 注意：不使用 bypassPermissions！canUseTool 需要权限系统激活
        includePartialMessages: true,
        cwd: '/tmp',
        maxTurns: 3,
        canUseTool,
        ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
      },
    })

    for await (const msg of iter) {
      messages.push(msg)
    }

    const log = formatMessages(messages, 'canUseTool deny 测试') +
      '\n\n=== canUseTool 回调日志 ===\n' +
      toolDenyLog.join('\n')
    fs.appendFileSync(DEBUG_LOG, '\n\n' + '='.repeat(80) + '\n' + log)

    // 分析结果
    const userMessages = messages.filter((m: any) => m.type === 'user')
    const assistantMessages = messages.filter((m: any) => m.type === 'assistant')
    const toolUseBlocks = assistantMessages.flatMap((m: any) => {
      const content = m.message?.content ?? []
      return content.filter((b: any) => b.type === 'tool_use')
    })
    const toolResultBlocks = userMessages.flatMap((m: any) => {
      const content = m.message?.content ?? []
      return content.filter((b: any) => b.type === 'tool_result')
    })

    console.log(`\ncanUseTool deny 测试:`)
    console.log(`  总消息数: ${messages.length}`)
    console.log(`  assistant 消息: ${assistantMessages.length}`)
    console.log(`  user 消息: ${userMessages.length}`)
    console.log(`  tool_use 块: ${toolUseBlocks.length}`)
    console.log(`  tool_result 块: ${toolResultBlocks.length}`)
    console.log(`  canUseTool 回调次数: ${toolDenyLog.length}`)
    console.log(`日志已追加到 ${DEBUG_LOG}`)

    // 关键断言：canUseTool 回调应该被调用
    expect(toolDenyLog.length).toBeGreaterThan(0)

    // 如果 tool_result 中包含成功执行的内容 → deny 失败
    // 如果 tool_result 为空或包含 error → deny 成功
    if (toolResultBlocks.length > 0) {
      console.log('\n⚠️ 发现 tool_result 块，检查是否包含执行结果或 deny 错误:')
      for (const block of toolResultBlocks) {
        const content = typeof block.content === 'string'
          ? block.content.slice(0, 300)
          : JSON.stringify(block.content)?.slice(0, 300)
        console.log(`  tool_use_id=${block.tool_use_id} is_error=${block.is_error}`)
        console.log(`  content: ${content}`)
      }
    }
  })

  /**
   * 测试 3: canUseTool deny all — 同时使用 bypassPermissions
   * 目的：验证 --yolo 是否覆盖 canUseTool 回调
   */
  it('canUseTool + bypassPermissions：测试兼容性', async () => {
    const cliPath = resolveQoderCLI()
    const messages: unknown[] = []
    const toolDenyLog: string[] = []

    fs.writeFileSync('/tmp/canuse-test-marker.txt', 'BYPASS_COMPAT_TEST_11111')

    const canUseTool = async (toolName: string, input: unknown, _options: unknown) => {
      const entry = `[DENY+BYPASS] toolName=${toolName} input=${JSON.stringify(input)?.slice(0, 200)}`
      toolDenyLog.push(entry)
      console.log(entry)
      return {
        behavior: 'deny' as const,
        message: `Tool "${toolName}" denied by opencode.`,
      }
    }

    const iter = query({
      prompt: 'Read the file /tmp/canuse-test-marker.txt using the Read tool. Just read it and tell me the content.',
      options: {
        model: 'auto',
        allowDangerouslySkipPermissions: true,
        permissionMode: 'bypassPermissions' as const,
        includePartialMessages: true,
        cwd: '/tmp',
        maxTurns: 3,
        canUseTool,
        ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
      },
    })

    for await (const msg of iter) {
      messages.push(msg)
    }

    const log = formatMessages(messages, 'canUseTool + bypassPermissions 兼容性测试') +
      '\n\n=== canUseTool 回调日志 ===\n' +
      toolDenyLog.join('\n')
    fs.appendFileSync(DEBUG_LOG, '\n\n' + '='.repeat(80) + '\n' + log)

    console.log(`\ncanUseTool + bypassPermissions 兼容性测试:`)
    console.log(`  总消息数: ${messages.length}`)
    console.log(`  canUseTool 回调次数: ${toolDenyLog.length}`)

    if (toolDenyLog.length === 0) {
      console.log('  ❌ canUseTool 回调未被调用 — bypassPermissions 覆盖了 canUseTool')
    } else {
      console.log('  ✅ canUseTool 回调被调用 — 两者可以共存')
    }

    console.log(`日志已追加到 ${DEBUG_LOG}`)
    expect(messages.length).toBeGreaterThan(0)
  })
})

// 格式化消息用于日志输出
function formatMessages(messages: unknown[], label: string): string {
  return `=== ${label} (${new Date().toISOString()}) ===\n` +
    messages.map((m, i) => {
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
    }).join('\n')
}
