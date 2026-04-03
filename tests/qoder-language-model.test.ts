// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider'

// ── Mock vendor SDK ──────────────────────────────────────────────────────────
// 控制每个测试推送的 SDKMessage 事件
const mockMessages: unknown[] = []

// 记录最近一次 QoderAgentSDKClient 构造函数的参数
let lastClientOptions: Record<string, unknown> | null = null

// 记录最近一次 query() 调用的 prompt 和 sessionId
let lastQueryPrompt: unknown = null
let lastQuerySessionId: unknown = null

// 控制 connect() 是否抛出异常
let mockConnectError: Error | null = null

// 控制 receiveMessages() 迭代时是否需要自定义行为
let mockReceiveMessagesOverride: (() => AsyncIterableIterator<unknown>) | null = null

// query() 的 vi.fn spy
const mockQueryMethod = vi.fn()

// interrupt() 的 vi.fn spy
const mockInterruptMethod = vi.fn()

vi.mock('../src/vendor/qoder-agent-sdk.mjs', () => ({
  configure: vi.fn(),
  IntegrationMode: { Quest: 'quest', QoderWork: 'qoder_work' },
  QoderAgentSDKClient: class MockQoderAgentSDKClient {
    options: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      lastClientOptions = options
      this.options = options
    }
    async connect() {
      if (mockConnectError) throw mockConnectError
    }
    receiveMessages() {
      if (mockReceiveMessagesOverride) return mockReceiveMessagesOverride()
      return (async function* () {
        for (const msg of mockMessages) {
          yield msg
        }
      })()
    }
    async query(prompt: unknown, sessionId?: string) {
      lastQueryPrompt = prompt
      lastQuerySessionId = sessionId
      mockQueryMethod(prompt, sessionId)
    }
    async interrupt() {
      mockInterruptMethod()
    }
    async disconnect() {}
  },
}))

// ── Test suite ───────────────────────────────────────────────────────────────

describe('QoderLanguageModel', () => {
  let QoderLanguageModel: unknown

  beforeEach(async () => {
    vi.resetModules()
    mockMessages.length = 0
    lastClientOptions = null
    lastQueryPrompt = null
    lastQuerySessionId = null
    mockConnectError = null
    mockReceiveMessagesOverride = null
    mockQueryMethod.mockClear()
    mockInterruptMethod.mockClear()
    delete process.env.OPENCODE
    // 重置 mcp-bridge 全局状态，避免测试间污染
    const bridge = await import('../src/mcp-bridge.js')
    bridge.setMcpBridgeServers({})
    const mod = await import('../src/qoder-language-model.js')
    QoderLanguageModel = mod.QoderLanguageModel
  })

  afterEach(() => {
    delete process.env.OPENCODE
    vi.restoreAllMocks()
  })

  // ── 基本属性 ──────────────────────────────────────────────────────────────

  describe('基本属性', () => {
    it('specificationVersion 为 v2', () => {
      const model = new QoderLanguageModel('auto')
      expect(model.specificationVersion).toBe('v2')
    })

    it('provider 为 qoder', () => {
      const model = new QoderLanguageModel('auto')
      expect(model.provider).toBe('qoder')
    })

    it('modelId 正确设置', () => {
      const model = new QoderLanguageModel('performance')
      expect(model.modelId).toBe('performance')
    })
  })

  // ── doStream ──────────────────────────────────────────────────────────────

  describe('doStream', () => {
    it('stream_event text_delta 正确转换为 text-start + text-delta + text-end', async () => {
      pushTextDelta('Hello, ')
      pushTextDelta('world!')
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const { stream } = await model.doStream(buildCallOptions('Say hello'))
      const parts = await collectStream(stream)

      expect(parts.find((p) => p.type === 'text-start')).toBeDefined()

      const deltas = parts.filter((p) => p.type === 'text-delta')
      expect(deltas).toHaveLength(2)
      expect(deltas.map((p) => p.delta).join('')).toBe('Hello, world!')

      expect(parts.find((p) => p.type === 'text-end')).toBeDefined()
    })

    it('result subtype=success → finishReason stop', async () => {
      pushTextDelta('hi')
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      const finish = parts.find((p) => p.type === 'finish')
      expect(finish?.finishReason).toBe('stop')
    })

    it('result usage 正确映射到 finish.usage', async () => {
      pushTextDelta('hi')
      mockMessages.push({
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 20 },
      })

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      const finish = parts.find((p) => p.type === 'finish')
      expect(finish?.usage?.inputTokens).toBe(10)
      expect(finish?.usage?.outputTokens).toBe(20)
      expect(finish?.usage?.totalTokens).toBe(30)
    })

    it('result subtype=error_during_execution → finishReason error', async () => {
      mockMessages.push({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
      })

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('test'))).stream)

      const error = parts.find((p) => p.type === 'error')
      expect(error).toBeDefined()
      expect(error.error.message).toContain('error_during_execution')

      const finish = parts.find((p) => p.type === 'finish')
      expect(finish?.finishReason).toBe('error')
    })

    it('query() 抛出异常 → error + finish reason=error', async () => {
      mockConnectError = new Error('CLI not found')

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('test'))).stream)

      const error = parts.find((p) => p.type === 'error')
      expect(error?.error.message).toContain('CLI not found')

      const finish = parts.find((p) => p.type === 'finish')
      expect(finish?.finishReason).toBe('error')
    })

    it('stream 结束无 result 事件时，自动补 finish stop', async () => {
      pushTextDelta('hi')
      // 不推 result 事件

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('test'))).stream)

      const finish = parts.find((p) => p.type === 'finish')
      expect(finish?.finishReason).toBe('stop')
    })

    it('OPENCODE=1 时 finishReason 带 unified 兼容字段，但序列化后仍是字符串', async () => {
      process.env.OPENCODE = '1'
      try {
        pushTextDelta('hi')
        pushSuccessResult()

        const model = new QoderLanguageModel('auto')
        const parts = await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

        const finish = parts.find((p) => p.type === 'finish')
        expect(finish).toBeDefined()
        expect(String(finish?.finishReason)).toBe('stop')
        expect((finish?.finishReason as any).unified).toBe('stop')
        expect(JSON.parse(JSON.stringify(finish)).finishReason).toBe('stop')
      } finally {
        delete process.env.OPENCODE
      }
    })

    it('query env 会剥离 OPENCODE 与 OPENCODE_PID，避免 Qoder CLI 隐藏外部 MCP 工具', async () => {
      process.env.OPENCODE = '1'
      process.env.OPENCODE_PID = '12345'
      try {
        pushSuccessResult()

        const model = new QoderLanguageModel('auto')
        await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

        expect(lastClientOptions?.env?.OPENCODE).toBeUndefined()
        expect(lastClientOptions?.env?.OPENCODE_PID).toBeUndefined()
      } finally {
        delete process.env.OPENCODE
        delete process.env.OPENCODE_PID
      }
    })

    it('使用正确的 modelId 传递给 query()', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('ultimate')
      await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      expect(lastClientOptions).toBeDefined()
      expect(lastClientOptions.model).toBe('ultimate')
    })

    it('prompt 文本内容传递到 query()', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('hello world'))).stream)

      expect(mockQueryMethod).toHaveBeenCalledOnce()
      expect(typeof lastQueryPrompt).toBe('string')
      expect(lastQueryPrompt).toContain('hello world')
    })

    it('[回归] 最后一条 user 之后的 tool 上下文会继续传给 query()', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream({
            inputFormat: 'prompt',
            mode: { type: 'regular' },
            prompt: [
              { role: 'user', content: [{ type: 'text', text: 'list files please' }] },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool-call',
                    toolCallId: 'tc-qoder-1',
                    toolName: 'Bash',
                    input: { command: 'ls /tmp' },
                  },
                ],
              },
              {
                role: 'tool',
                content: [
                  {
                    type: 'tool-result',
                    toolCallId: 'tc-qoder-1',
                    toolName: 'Bash',
                    output: [{ type: 'text', value: 'a.txt\nb.txt' }],
                  },
                ],
              },
            ],
          })
        ).stream,
      )

      expect(typeof lastQueryPrompt).toBe('string')
      expect(lastQueryPrompt).toContain('list files please')
      expect(lastQueryPrompt).toContain('<conversation_continuation>')
      expect(lastQueryPrompt).toContain('<tool_call id="tc-qoder-1" name="Bash">')
      expect(lastQueryPrompt).toContain('<tool_result id="tc-qoder-1" name="Bash">')
      expect(lastQueryPrompt.indexOf('list files please')).toBeLessThan(
        lastQueryPrompt.indexOf('<conversation_continuation>') ?? -1,
      )
    })

    it('query() 默认提升 maxBufferSize 到 8MB', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('buffer test'))).stream)

      expect(lastClientOptions?.maxBufferSize).toBe(8 * 1024 * 1024)
    })

    it('多模态 query 使用与 options.sessionId 一致的 SDK user session_id', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream({
        inputFormat: 'prompt',
        mode: { type: 'regular' },
        prompt: [
          {
            role: 'user',
            content: [
              { type: 'image', image: 'data:image/png;base64,abc123==', mimeType: 'image/png' },
              { type: 'text', text: 'describe image' },
            ],
          },
        ],
      })).stream)

      expect(typeof lastClientOptions?.sessionId).toBe('string')
      expect(typeof lastQueryPrompt).not.toBe('string')

      const messages: Array<{ session_id?: string }> = []
      for await (const msg of lastQueryPrompt as AsyncIterable<{ session_id?: string }>) {
        messages.push(msg)
      }

      expect(messages).toHaveLength(1)
      expect(messages[0].session_id).toBe(lastClientOptions?.sessionId)
    })

    it('每次 query() 都使用新的 sessionId，避免错误续用旧会话', async () => {
      pushSuccessResult()
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('first turn'))).stream)
      const firstSessionId = lastClientOptions?.sessionId

      await collectStream((await model.doStream(buildCallOptions('second turn'))).stream)
      const secondSessionId = lastClientOptions?.sessionId

      expect(typeof firstSessionId).toBe('string')
      expect(typeof secondSessionId).toBe('string')
      expect(firstSessionId).not.toBe(secondSessionId)
    })

    it('非 text_delta 的 stream_event 被忽略', async () => {
      // content_block_start 不是文本 delta，应忽略
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      })
      pushTextDelta('real text')
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('test'))).stream)

      const deltas = parts.filter((p) => p.type === 'text-delta')
      expect(deltas).toHaveLength(1)
      expect(deltas[0].delta).toBe('real text')
    })

    it('透传 providerOptions.qoder.mcpServers 到 query() options', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              providerOptions: {
                qoder: {
                  mcpServers: {
                    weather: {
                      command: 'npx',
                      args: ['-y', '@acme/weather-mcp'],
                      env: { API_KEY: 'secret' },
                    },
                  },
                },
              },
            }),
          )
        ).stream,
      )

      expect(lastClientOptions?.mcpServers).toBeDefined()
      const weatherServer = lastClientOptions.mcpServers.weather
      expect(weatherServer).toBeDefined()
      expect(weatherServer.command).toBe('npx')
      expect(weatherServer.args).toEqual(['-y', '@acme/weather-mcp'])
      expect(weatherServer.env).toEqual({ API_KEY: 'secret' })
    })

    it('从 provider-defined tools 推导 mcpServers 并传递', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                {
                  type: 'provider-defined',
                  id: 'qoder.weather',
                  name: 'weather_forecast',
                  args: {
                    serverName: 'weather',
                    command: 'uvx',
                    args: ['weather-mcp'],
                    env: { WEATHER_TOKEN: 'token' },
                  },
                },
              ],
            }),
          )
        ).stream,
      )

      const weatherServer = lastClientOptions?.mcpServers?.weather
      expect(weatherServer).toBeDefined()
      expect(weatherServer.command).toBe('uvx')
      expect(weatherServer.args).toEqual(['weather-mcp'])
      expect(weatherServer.env).toEqual({ WEATHER_TOKEN: 'token' })
    })

    it('doGenerate 返回完整文本', async () => {
      pushTextDelta('generated response')
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const result = await model.doGenerate(buildCallOptions('generate test'))

      const textContent = result.content.find((c) => c.type === 'text')
      expect(textContent?.text).toContain('generated response')
      expect(result.finishReason).toBe('stop')
    })

    // ── SDK in-process MCP server (type: 'sdk') ───────────────────────────────

    it('SDK in-process MCP server via providerOptions 直接透传 type/name/instance', async () => {
      pushSuccessResult()

      const mockInstance = { connect: vi.fn(), close: vi.fn() }
      const sdkServer = { type: 'sdk' as const, name: 'echo', instance: mockInstance }

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              providerOptions: {
                qoder: {
                  mcpServers: {
                    echo: sdkServer,
                  },
                },
              },
            }),
          )
        ).stream,
      )

      expect(lastClientOptions?.mcpServers?.echo).toBeDefined()
      expect(lastClientOptions.mcpServers.echo.type).toBe('sdk')
      expect(lastClientOptions.mcpServers.echo.name).toBe('echo')
      expect(lastClientOptions.mcpServers.echo.instance).toBe(mockInstance)
    })

    it('SDK in-process MCP server via provider-defined tools 透传 type/instance', async () => {
      pushSuccessResult()

      const mockInstance = { connect: vi.fn(), close: vi.fn() }

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                {
                  type: 'provider-defined',
                  id: 'qoder.calc',
                  name: 'calculator',
                  args: {
                    serverName: 'calc',
                    type: 'sdk',
                    name: 'calc',
                    instance: mockInstance,
                  },
                },
              ],
            }),
          )
        ).stream,
      )

      const calcServer = lastClientOptions?.mcpServers?.calc
      expect(calcServer).toBeDefined()
      expect(calcServer.type).toBe('sdk')
      expect(calcServer.instance).toBe(mockInstance)
    })

    it('SDK server enabled=false 时被过滤', async () => {
      pushSuccessResult()

      const mockInstance = { connect: vi.fn(), close: vi.fn() }
      const sdkServer = { type: 'sdk' as const, name: 'echo', instance: mockInstance, enabled: false }

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              providerOptions: {
                qoder: {
                  mcpServers: {
                    echo: sdkServer,
                  },
                },
              },
            }),
          )
        ).stream,
      )

      // enabled=false 应该过滤掉，mcpServers 为空或不含 echo
      expect(lastClientOptions?.mcpServers?.echo).toBeUndefined()
    })

    it('有 mcpServers 时不设置 disallowedTools，允许模型调用工具', async () => {
      pushSuccessResult()

      const mockInstance = { connect: vi.fn(), close: vi.fn() }

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              providerOptions: {
                qoder: {
                  mcpServers: {
                    myserver: { type: 'sdk', name: 'myserver', instance: mockInstance },
                  },
                },
              },
            }),
          )
        ).stream,
      )

      // 提供了 mcpServers，不应设置 disallowedTools: ['*']
      expect(lastClientOptions?.disallowedTools).toBeUndefined()
    })

    it('无 mcpServers 时也不设置 disallowedTools（允许 CLI 内建工具被调用）', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      expect(lastClientOptions?.disallowedTools).toBeUndefined()
    })

    // ── mcp-bridge：opencode config.mcp → query() mcpServers ─────────────────

    it('mcp-bridge 中设置的服务器自动注入到 query() mcpServers', async () => {
      pushSuccessResult()

      // 模拟 config hook 设置了 context7
      const bridge = await import('../src/mcp-bridge.js')
      bridge.setMcpBridgeServers({
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@latest'],
        },
      })

      const mod = await import('../src/qoder-language-model.js')
      const model = new mod.QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      expect(lastClientOptions?.mcpServers?.context7).toBeDefined()
      expect(lastClientOptions.mcpServers.context7.command).toBe('npx')
      expect(lastClientOptions.mcpServers.context7.args).toEqual(['-y', '@upstash/context7-mcp@latest'])
    })

    it('providerOptions.qoder.mcpServers 优先级高于 mcp-bridge', async () => {
      pushSuccessResult()

      // mcp-bridge 设置了 context7（默认 endpoint）
      const bridge = await import('../src/mcp-bridge.js')
      bridge.setMcpBridgeServers({
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@latest'],
        },
      })

      const mod = await import('../src/qoder-language-model.js')
      const model = new mod.QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              providerOptions: {
                qoder: {
                  mcpServers: {
                    context7: {
                      // 用户在 providerOptions 里覆盖 context7 指向不同版本
                      command: 'npx',
                      args: ['-y', '@upstash/context7-mcp@1.0.0'],
                    },
                  },
                },
              },
            }),
          )
        ).stream,
      )

      // providerOptions 覆盖 bridge，版本为 1.0.0
      expect(lastClientOptions?.mcpServers?.context7?.args).toEqual(['-y', '@upstash/context7-mcp@1.0.0'])
    })

    it('mcp-bridge 为空时 query() 不传 mcpServers', async () => {
      pushSuccessResult()

      // bridge 已在 beforeEach 中重置为空
      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      expect(lastClientOptions?.mcpServers).toBeUndefined()
    })

    // ── MCP proxy 工具名转换：mcp__server__tool → server_tool ──

    it('CLI mcp__context7__* 转换为 context7_* 后发出 providerExecuted tool-call', async () => {
      // CLI 发出 mcp__context7__resolve-library-id（CLI MCP proxy 格式）
      // normalizeToolName 转换后匹配 → 以 providerExecuted 发出
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_mcp_001', name: 'mcp__context7__resolve-library-id' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"libraryName":"react"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      pushTextDelta('Done.')
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              // opencode 有 context7 的 function 工具
              tools: [
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
                { type: 'function', name: 'context7_resolve-library-id', description: 'Resolve library', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // mcp__context7__resolve-library-id → context7_resolve-library-id
      // providerExecuted 模式：所有工具都带 providerExecuted: true
      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      expect((toolCall as any).toolName).toBe('context7_resolve-library-id')
      expect((toolCall as any).providerExecuted).toBe(true)

      // 文本仍然正常输出
      const deltas = parts.filter((p) => p.type === 'text-delta')
      expect(deltas.map((p) => (p as any).delta).join('')).toBe('Done.')
    })

    it('CLI mcp__* 工具不在 opencode tools 中时，也以 providerExecuted 发出', async () => {
      // CLI 发出 mcp__context7__resolve-library-id，但 opencode 没有 context7 相关工具
      // providerExecuted 模式：所有工具都发出（带 providerExecuted: true）
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_mcp_002', name: 'mcp__context7__resolve-library-id' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"libraryName":"react"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      mockMessages.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_mcp_002', content: 'react docs' }] },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              // opencode 没有 context7 工具
              tools: [
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
                { type: 'function', name: 'read', description: 'Read file', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // providerExecuted 模式：所有工具都发出（带 providerExecuted: true）
      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      expect((toolCall as any).toolName).toBe('context7_resolve-library-id')
      expect((toolCall as any).providerExecuted).toBe(true)

      // tool-result 也应回传
      const toolResult = parts.find((p) => p.type === 'tool-result')
      expect(toolResult).toBeDefined()
      expect((toolResult as any).providerExecuted).toBe(true)
    })

    it('CLI 大写工具（Read）正确映射到 opencode 小写工具（read）', async () => {
      // CLI 内部调用 Read（大写），opencode tools 有 read（小写）
      // normalizeToolName 统一转小写后能正确匹配 → 作为 providerExecuted 工具发出
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_read_001', name: 'Read' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/file.txt"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      mockMessages.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_read_001', content: 'file contents' }] },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'read', description: 'Read file', inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } } },
              ],
            }),
          )
        ).stream,
      )

      // CLI 的 Read（大写）经 normalizeToolName 转为 read（小写）
      // providerExecuted 模式：所有工具都带 providerExecuted: true
      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      expect((toolCall as any).toolName).toBe('read')
      expect((toolCall as any).providerExecuted).toBe(true)
      // providerExecuted 模式：参数直接透传，不做字段映射
      expect(JSON.parse((toolCall as any).input)).toEqual({ file_path: '/tmp/file.txt' })

      // tool-result 也应回传
      const toolResult = parts.find((p) => p.type === 'tool-result')
      expect(toolResult).toBeDefined()
      expect((toolResult as any).providerExecuted).toBe(true)
    })

    it('options.tools 为空时，CLI 的所有工具调用都发出（不过滤）', async () => {
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_bash_001', name: 'bash' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      mockMessages.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_bash_001', content: 'file.ts' }] },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      // 不传 tools → shouldFilterTools = false → 不过滤
      const parts = await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      expect(toolCalls).toHaveLength(1)
      expect((toolCalls[0] as any).toolName).toBe('bash')
    })

    it('options.tools 有已知工具时，已知工具调用正常发出', async () => {
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_bash_002', name: 'bash' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      mockMessages.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_bash_002', content: '/home' }] },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // bash 在 options.tools 里 → 正常发出
      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      expect(toolCalls).toHaveLength(1)
      expect((toolCalls[0] as any).toolName).toBe('bash')
    })

    // ── providerExecuted 模式：所有工具调用都标记 providerExecuted: true ────────

    it('所有 tool-call 都带 providerExecuted: true（CLI 自主执行所有工具）', async () => {
      // CLI 发出 bash 工具调用（bash 在 options.tools 里）
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_func_001', name: 'bash' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      expect((toolCall as any).toolName).toBe('bash')
      // providerExecuted 模式：所有工具调用都带 providerExecuted: true
      expect((toolCall as any).providerExecuted).toBe(true)
    })

    it('CLI 工具（包括不在 options.tools 中的）向 opencode 发出 providerExecuted tool 事件', async () => {
      // CLI 发出 Bash（大写），不在 options.tools 里
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_cli_001', name: 'Bash' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      mockMessages.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_cli_001', content: 'hi' }] },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      // options.tools 传入一个不同的工具（不含 bash/Bash）
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'read', description: 'Read file', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // providerExecuted 模式：所有工具都向 opencode 发出事件（带 providerExecuted: true）
      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      expect((toolCall as any).toolName).toBe('bash')
      expect((toolCall as any).providerExecuted).toBe(true)

      // tool-result 也应回传（providerExecuted: true）
      const toolResult = parts.find((p) => p.type === 'tool-result')
      expect(toolResult).toBeDefined()
      expect((toolResult as any).providerExecuted).toBe(true)
    })

    it('CLI tool-result 回传给 opencode（带 providerExecuted: true）', async () => {
      // CLI 发出 bash 工具调用，后续发出 user tool_result
      // providerExecuted 模式下，tool-result 应被 re-emit 给 opencode 展示
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_func_002', name: 'bash' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      mockMessages.push({
        type: 'user',
        // CLI 执行 bash 后发出 tool_result，应被转发给 opencode 展示
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_func_002', content: '/home' }] },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // providerExecuted 模式：CLI tool-result 应被 re-emit 给 opencode 展示
      const toolResults = parts.filter((p) => p.type === 'tool-result')
      expect(toolResults).toHaveLength(1)
      expect((toolResults[0] as any).providerExecuted).toBe(true)
      expect((toolResults[0] as any).toolCallId).toBe('call_func_002')
    })

    it('双轨 MCP：即使 opencode 有对应的 function 工具，mcp-bridge 的 servers 仍传给 CLI', async () => {
      pushSuccessResult()

      // mcp-bridge 中设置了 context7，同时 options.tools 里有 function 类型的 context7 工具
      // 双轨策略下 CLI 也需要连接 context7 来自主完成 agent loop
      const bridge = await import('../src/mcp-bridge.js')
      bridge.setMcpBridgeServers({
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@latest'],
        },
      })

      const mod = await import('../src/qoder-language-model.js')
      const model = new mod.QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              // opencode 传入了 context7 的 function 工具
              tools: [
                { type: 'function', name: 'context7_resolve-library-id', description: 'Resolve library', inputSchema: { type: 'object', properties: {} } },
                { type: 'function', name: 'context7_get-library-docs', description: 'Get docs', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // 双轨 MCP：CLI 也需要连接 context7，不过滤
      expect(lastClientOptions?.mcpServers?.context7).toBeDefined()
      expect(lastClientOptions.mcpServers.context7.command).toBe('npx')
      expect(lastClientOptions.mcpServers.context7.args).toEqual(['-y', '@upstash/context7-mcp@latest'])
    })

    // ── tool-call input 格式：必须是已解析的对象，不是 JSON 字符串 ──────────

    it('stream_event 路径：tool-call 的 input 是 JSON 字符串（AI SDK 内部 trim+parse）', async () => {
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_input_001', name: 'bash' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la","timeout":30}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      // AI SDK 期望 input 是 JSON 字符串（内部调用 input.trim() 再 JSON.parse）
      expect(typeof (toolCall as any).input).toBe('string')
      expect(JSON.parse((toolCall as any).input)).toEqual({ command: 'ls -la', timeout: 30 })
    })

    it('assistant 路径：tool-call 的 input 是 JSON 字符串', async () => {
      // assistant 消息中 tool_use 的 input 是对象，需要序列化为 JSON 字符串
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call_input_002', name: 'read', input: { filePath: '/tmp/test.txt' } },
          ],
        },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'read', description: 'Read file', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      expect(typeof (toolCall as any).input).toBe('string')
      expect(JSON.parse((toolCall as any).input)).toEqual({ filePath: '/tmp/test.txt' })
    })

    it('assistant 路径：tool_use input 是字符串时，直接透传', async () => {
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call_input_003', name: 'bash', input: '{"command":"pwd"}' },
          ],
        },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      expect(typeof (toolCall as any).input).toBe('string')
      expect((toolCall as any).input).toBe('{"command":"pwd"}')
    })

    it('query options 不再注入 qoder 内置 agents 定义', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      expect(lastClientOptions?.agents).toBeUndefined()
    })

    it('同一轮中多个工具调用都以 providerExecuted 发出（无抑制）', async () => {
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_task_coexist', name: 'Task' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"d","prompt":"p","subagent_type":"general-purpose"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'call_bash_coexist', name: 'bash' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'task', description: 'Task', inputSchema: { type: 'object', properties: {} } },
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // providerExecuted 模式：两个工具都发出（无抑制）
      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      const taskCall = toolCalls.find((p) => (p as any).toolName === 'task')
      const bashCall = toolCalls.find((p) => (p as any).toolName === 'bash')
      expect(toolCalls).toHaveLength(2)
      expect(taskCall).toBeDefined()
      expect((taskCall as any).providerExecuted).toBe(true)
      expect(bashCall).toBeDefined()
      expect((bashCall as any).providerExecuted).toBe(true)
    })

    it('Task（无论是否在 options.tools 中）都以 providerExecuted 发出', async () => {
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call_task_fallback', name: 'Task', input: { description: 'search', prompt: 'find it', subagent_type: 'general-purpose' } },
          ],
        },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // providerExecuted 模式：Task 也发出（即使 options.tools 中没有 task）
      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      expect(toolCalls).toHaveLength(1)
      expect((toolCalls[0] as any).toolName).toBe('task')
      expect((toolCalls[0] as any).providerExecuted).toBe(true)
    })

    it('Agent 映射为 task（providerExecuted），不依赖 qoder 内置 agents', async () => {
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_agent_stream', name: 'Agent' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"d","prompt":"p","subagent_type":"general-purpose"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'task', description: 'Task', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      expect(toolCalls).toHaveLength(1)
      expect((toolCalls[0] as any).toolName).toBe('task')
      // providerExecuted 模式：Agent 映射为 task，以 providerExecuted: true 发出
      expect((toolCalls[0] as any).providerExecuted).toBe(true)
      expect(lastClientOptions?.agents).toBeUndefined()
    })

    // ── 回归测试：providerExecuted 模式下 finishReason 始终为 stop ─────────────

    it('[回归] tool-call 后同一 query 收到 tool_result，finishReason 仍为 stop', async () => {
      // CLI 发出 bash 工具调用
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_regression_001', name: 'bash' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      // 同一 query 内，tool_result 已到达 → pendingToolCalls 清空
      mockMessages.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_regression_001', content: 'file.ts' }] },
      })
      // message_delta 带 stop_reason=tool_use（CLI 有时在工具完成后仍上报此 stop_reason）
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
      })
      // result 到达时 pendingToolCalls 已为空
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // pendingToolCalls 已清空 → finishReason 必须为 stop，不能为 tool-calls
      const finish = parts.find((p) => p.type === 'finish')
      expect(finish).toBeDefined()
      expect((finish as any).finishReason).toBe('stop')
    })

    it('[回归] 工具调用后同一 query 收到 tool_result，finishReason 仍为 stop（providerExecuted 模式）', async () => {
      // CLI 发出 bash 工具调用，然后发出 tool_result
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_regression_002', name: 'bash' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      // tool_result 到达
      mockMessages.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_regression_002', content: '/home' }] },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // providerExecuted 模式：finishReason 始终为 stop
      const finish = parts.find((p) => p.type === 'finish')
      expect(finish).toBeDefined()
      expect((finish as any).finishReason).toBe('stop')
    })

    it('[回归] Task 工具调用后同一 query 收到 tool_result，finishReason 仍为 stop（providerExecuted 模式）', async () => {
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_subagent_wait_001', name: 'Task' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"Explore","prompt":"Inspect project","subagent_type":"general-purpose"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      mockMessages.push({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'call_subagent_wait_001', content: 'Task completed' },
          ],
        },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'task', description: 'Task', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      expect(toolCalls).toHaveLength(1)
      expect((toolCalls[0] as any).toolName).toBe('task')
      // providerExecuted 模式：tool-call 带 providerExecuted
      expect((toolCalls[0] as any).providerExecuted).toBe(true)

      // tool-result 也应被回传
      const toolResults = parts.filter((p) => p.type === 'tool-result')
      expect(toolResults).toHaveLength(1)
      expect((toolResults[0] as any).providerExecuted).toBe(true)

      const finish = parts.find((p) => p.type === 'finish')
      expect(finish).toBeDefined()
      expect((finish as any).finishReason).toBe('stop')
    })

    it('[回归] 同一 query 中多个工具顺序调用，finishReason 始终为 stop', async () => {
      // Task 工具调用
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_task_text_001', name: 'Task' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"Explore","prompt":"Inspect","subagent_type":"general-purpose"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      mockMessages.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_task_text_001', content: 'Task done' }] },
      })
      // Task 之后还有文本（providerExecuted 模式下正常推流）
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'task', description: 'Task', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // providerExecuted 模式：文本可以正常输出
      const textDeltas = parts.filter((p) => p.type === 'text-delta')
      expect(textDeltas.map((p) => (p as any).delta).join('')).toBe('Done.')

      const finish = parts.find((p) => p.type === 'finish')
      expect((finish as any).finishReason).toBe('stop')
    })

    it('[回归] 同一 query 内多个工具调用都以 providerExecuted 发出', async () => {
      // Task 工具调用
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_task_tool_001', name: 'Task' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"Explore","prompt":"Inspect","subagent_type":"general-purpose"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      mockMessages.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_task_tool_001', content: 'Task done' }] },
      })
      // 后续 bash 工具调用
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'call_bash_after_task', name: 'bash' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      })
      mockMessages.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_bash_after_task', content: 'file.ts' }] },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'task', description: 'Task', inputSchema: { type: 'object', properties: {} } },
                { type: 'function', name: 'bash', description: 'Run bash', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // providerExecuted 模式：两个工具都发出（均带 providerExecuted: true）
      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      expect(toolCalls).toHaveLength(2)
      expect((toolCalls[0] as any).toolName).toBe('task')
      expect((toolCalls[0] as any).providerExecuted).toBe(true)
      expect((toolCalls[1] as any).toolName).toBe('bash')
      expect((toolCalls[1] as any).providerExecuted).toBe(true)

      const finish = parts.find((p) => p.type === 'finish')
      expect((finish as any).finishReason).toBe('stop')
    })

    // ── abort/cancel 清理测试 ─────────────────────────────────────────────────

    it('options.abortSignal.abort() 后，client.interrupt() 被调用', async () => {
      // 构造一个永不结束的 receiveMessages（阻塞在异步迭代中）
      let resolveBlock!: () => void
      const blockPromise = new Promise<void>((resolve) => { resolveBlock = resolve })

      mockReceiveMessagesOverride = () => (async function* () {
        yield* []
        await blockPromise
      })()

      const abortController = new AbortController()
      const model = new QoderLanguageModel('auto')
      const { stream } = await model.doStream(buildCallOptions('ping', {
        abortSignal: abortController.signal,
      }))

      // 启动 reader 消费（异步，后台运行）
      const reader = stream.getReader()
      const readPromise = reader.read()

      // 等一个 microtask 让 start() 中 getOrCreateClient + query 完成
      await new Promise((r) => setTimeout(r, 10))

      // abort 后 unblock 生成器让 stream 能结束
      abortController.abort()
      resolveBlock()

      // stream 应该正常结束（不会永久挂起）
      await readPromise.catch(() => { /* ignore */ })
      // 等一个 microtask 让 cleanup 的 void promise 完成
      await new Promise((r) => setTimeout(r, 10))

      // 验证 client.interrupt() 被调用
      expect(mockInterruptMethod).toHaveBeenCalled()
    })

    it('取消 ReadableStream reader 后，client.interrupt() 被调用', async () => {
      // 构造一个永不结束的 receiveMessages
      mockReceiveMessagesOverride = () => (async function* () {
        await new Promise<never>(() => { /* block forever */ })
      })()

      const model = new QoderLanguageModel('auto')
      const { stream } = await model.doStream(buildCallOptions('ping'))

      const reader = stream.getReader()
      // 先读一次（stream-start 已发出），然后等 start() 完成初始化
      await reader.read() // 得到 stream-start
      // 等 start() 中 getOrCreateClient + query 完成，进入 for-await 循环
      await new Promise((r) => setTimeout(r, 10))
      await reader.cancel()  // 触发 ReadableStream cancel() → cleanup()

      // 等一个 microtask 让 cleanup 的 void promise 完成
      await new Promise((r) => setTimeout(r, 10))

      // cleanup 后，client.interrupt() 应已被调用
      expect(mockInterruptMethod).toHaveBeenCalled()
    })
  })
})

// ── helpers ───────────────────────────────────────────────────────────────────

function pushTextDelta(text: string) {
  mockMessages.push({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  })
}

function pushTextDeltaWithIndex(text: string, index: number) {
  mockMessages.push({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    },
  })
}

function pushTextBlockStart(index: number) {
  mockMessages.push({
    type: 'stream_event',
    event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  })
}

function pushThinkingBlockStart(index: number) {
  mockMessages.push({
    type: 'stream_event',
    event: { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
  })
}

function pushThinkingDelta(thinking: string, index: number) {
  mockMessages.push({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking },
    },
  })
}

function pushContentBlockStop(index: number) {
  mockMessages.push({
    type: 'stream_event',
    event: { type: 'content_block_stop', index },
  })
}

function pushSuccessResult() {
  mockMessages.push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: { input_tokens: 5, output_tokens: 10 },
  })
}

function buildCallOptions(
  userText: string,
  extra: Partial<LanguageModelV2CallOptions> = {},
): LanguageModelV2CallOptions {
  return {
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [
      {
        role: 'user',
        content: [{ type: 'text', text: userText }],
      },
    ],
    ...extra,
  }
}

async function collectStream(
  stream: ReadableStream<LanguageModelV2StreamPart>,
): Promise<LanguageModelV2StreamPart[]> {
  const parts: LanguageModelV2StreamPart[] = []
  const reader = stream.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}
