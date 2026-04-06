/**
 * 验证测试：PreToolUse hook 能否通过 permissionDecision: 'deny' 阻止 qodercli 执行工具
 *
 * 使用 QoderAgentSDKClient 模式（因为 hooks 需要 streaming + initialize 协议）
 *
 * 运行：npx vitest run tests/integration/pretooluse-hook-deny.test.ts
 */
import { describe, it, expect } from 'vitest'
import { configure, QoderAgentSDKClient, query } from '../../src/vendor/qoder-agent-sdk.mjs'
import type { HookInput, HookJSONOutput } from '../../src/vendor/qoder-agent-sdk.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TIMEOUT = 120_000
const DEBUG_LOG = '/tmp/pretooluse-hook-deny-messages.log'

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

describe('PreToolUse hook deny 验证', { timeout: TIMEOUT }, () => {
  /**
   * 测试 1: Client 模式 + PreToolUse hook deny
   */
  it('Client 模式 PreToolUse hook deny all', async () => {
    const cliPath = resolveQoderCLI()
    const messages: unknown[] = []
    const hookLog: string[] = []

    fs.writeFileSync('/tmp/canuse-test-marker.txt', 'PRETOOLUSE_HOOK_DENY_TEST_77777')

    const preToolUseHook = async (input: HookInput, toolUseID: string | undefined, _options: { signal: AbortSignal }): Promise<HookJSONOutput> => {
      const hookInput = input as Record<string, unknown>
      const entry = `[HOOK-DENY] event=${hookInput.hook_event_name} tool=${hookInput.tool_name} toolUseID=${toolUseID} input=${JSON.stringify(hookInput.tool_input)?.slice(0, 200)}`
      hookLog.push(entry)
      console.log(entry)
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny',
          permissionDecisionReason: 'Tool execution denied by opencode. opencode will handle tool execution externally.',
        },
      }
    }

    const client = new QoderAgentSDKClient({
      model: 'auto',
      includePartialMessages: true,
      cwd: '/tmp',
      maxTurns: 3,
      hooks: {
        PreToolUse: [
          {
            hooks: [preToolUseHook],
          },
        ],
      },
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
    const resultMessages = messages.filter((m: Record<string, unknown>) => m.type === 'result')
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

    const log = `=== PreToolUse hook deny 测试 (${new Date().toISOString()}) ===\n` +
      messages.map((m, i) => formatMessage(m, i)).join('\n') +
      `\n\n=== Hook 回调日志 ===\n${hookLog.join('\n')}`
    fs.writeFileSync(DEBUG_LOG, log)

    console.log(`\nPreToolUse hook deny 测试:`)
    console.log(`  总消息数: ${messages.length}`)
    console.log(`  assistant 消息: ${assistantMessages.length}`)
    console.log(`  user 消息: ${userMessages.length}`)
    console.log(`  result 消息: ${resultMessages.length}`)
    console.log(`  tool_use 块: ${toolUseBlocks.length}`)
    console.log(`  tool_result 块: ${toolResultBlocks.length}`)
    console.log(`  PreToolUse hook 回调次数: ${hookLog.length}`)

    if (hookLog.length > 0) {
      console.log('  ✅ PreToolUse hook 回调被调用！')

      // 检查 tool_result 内容
      for (const block of toolResultBlocks) {
        const b = block as Record<string, unknown>
        const content = typeof b.content === 'string' ? b.content.slice(0, 300) : JSON.stringify(b.content)?.slice(0, 300)
        console.log(`  tool_result: is_error=${b.is_error}, content=${content}`)
        if (b.is_error === true || (typeof b.content === 'string' && b.content.includes('denied'))) {
          console.log('  🎉 工具被成功拦截！')
        } else if (typeof b.content === 'string' && b.content.includes('PRETOOLUSE_HOOK_DENY_TEST')) {
          console.log('  ❌ 工具仍然被执行了！')
        }
      }

      if (toolResultBlocks.length === 0) {
        console.log('  🎉 没有 tool_result — 工具完全被拦截！')
      }
    } else {
      console.log('  ❌ PreToolUse hook 回调未被调用')
    }

    // result 内容
    for (const rm of resultMessages) {
      const r = rm as Record<string, unknown>
      console.log(`  result: is_error=${r.is_error} result=${String(r.result)?.slice(0, 200)}`)
    }

    console.log(`日志已写入 ${DEBUG_LOG}`)

    expect(messages.length).toBeGreaterThan(0)
  })

  /**
   * 测试 2: query() 模式 + PreToolUse hook deny
   * 因为 query() 模式也支持 hooks（通过 streaming mode + initialize）
   */
  it('query() 模式 PreToolUse hook deny all', async () => {
    const cliPath = resolveQoderCLI()
    const messages: unknown[] = []
    const hookLog: string[] = []

    fs.writeFileSync('/tmp/canuse-test-marker.txt', 'QUERY_HOOK_DENY_TEST_88888')

    const preToolUseHook = async (input: HookInput, toolUseID: string | undefined, _options: { signal: AbortSignal }): Promise<HookJSONOutput> => {
      const hookInput = input as Record<string, unknown>
      const entry = `[QUERY-HOOK-DENY] event=${hookInput.hook_event_name} tool=${hookInput.tool_name} toolUseID=${toolUseID} input=${JSON.stringify(hookInput.tool_input)?.slice(0, 200)}`
      hookLog.push(entry)
      console.log(entry)
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny',
          permissionDecisionReason: 'Tool execution denied by opencode.',
        },
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
        hooks: {
          PreToolUse: [
            {
              hooks: [preToolUseHook],
            },
          ],
        },
        ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
      },
    })

    for await (const msg of iter) {
      messages.push(msg)
    }

    const userMessages = messages.filter((m: Record<string, unknown>) => m.type === 'user')
    const toolResultBlocks = userMessages.flatMap((m: Record<string, unknown>) => {
      const msg = m.message as Record<string, unknown>
      const content = Array.isArray(msg?.content) ? msg.content : []
      return content.filter((b: Record<string, unknown>) => b.type === 'tool_result')
    })

    const log = `\n\n=== query() PreToolUse hook deny 测试 (${new Date().toISOString()}) ===\n` +
      messages.map((m, i) => formatMessage(m, i)).join('\n') +
      `\n\n=== Hook 回调日志 ===\n${hookLog.join('\n')}`
    fs.appendFileSync(DEBUG_LOG, log)

    console.log(`\nquery() PreToolUse hook deny 测试:`)
    console.log(`  总消息数: ${messages.length}`)
    console.log(`  user 消息: ${userMessages.length}`)
    console.log(`  tool_result 块: ${toolResultBlocks.length}`)
    console.log(`  PreToolUse hook 回调次数: ${hookLog.length}`)

    if (hookLog.length > 0) {
      console.log('  ✅ hook 被调用')
    } else {
      console.log('  ❌ hook 未被调用')
    }

    for (const block of toolResultBlocks) {
      const b = block as Record<string, unknown>
      const content = typeof b.content === 'string' ? b.content.slice(0, 300) : JSON.stringify(b.content)?.slice(0, 300)
      console.log(`  tool_result: is_error=${b.is_error}, content=${content}`)
    }

    console.log(`日志已追加到 ${DEBUG_LOG}`)
    expect(messages.length).toBeGreaterThan(0)
  })
})
