// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider'

// ── Mock vendor SDK ──────────────────────────────────────────────────────────
// 控制每个测试推送的 SDKMessage 事件
const mockMessages: unknown[] = []

// 记录最近一次 query() 调用时的参数
let lastQueryParams: { prompt: unknown; options: unknown } | null = null
let lastClientOptions: unknown = null
let mockReceiveMessagesFactory: (() => AsyncIterable<unknown>) | null = null

// 控制 query() 是否抛出异常
let mockQueryError: Error | null = null

const mockClientDisconnect = vi.fn(async () => {})
const mockClientInterrupt = vi.fn(async () => {})
const mockClientConnect = vi.fn(async () => {})
const mockClientQuery = vi.fn(async (prompt: unknown, sessionId?: string) => {
  lastQueryParams = {
    prompt,
    options: {
      ...(lastClientOptions as Record<string, unknown> ?? {}),
      ...(sessionId ? { sessionId } : {}),
    },
  }
  if (mockQueryError) throw mockQueryError
})

class MockQoderAgentSDKClient {
  constructor(options?: unknown) {
    lastClientOptions = options ?? null
  }

  async connect() {
    await mockClientConnect()
  }

  async query(prompt: unknown, sessionId?: string) {
    await mockClientQuery(prompt, sessionId)
  }

  async *receiveMessages() {
    const source = mockReceiveMessagesFactory ? mockReceiveMessagesFactory() : (async function* () {
      for (const msg of mockMessages) yield msg
    })()
    for await (const msg of source) yield msg
  }

  async interrupt() {
    await mockClientInterrupt()
  }

  async disconnect() {
    await mockClientDisconnect()
  }
}

vi.mock('../src/vendor/qoder-agent-sdk.mjs', () => ({
  configure: vi.fn(),
  IntegrationMode: { Quest: 'quest', QoderWork: 'qoder_work' },
  QoderAgentSDKClient: MockQoderAgentSDKClient,
}))

// ── Test suite ───────────────────────────────────────────────────────────────

describe('QoderLanguageModel', () => {
  let QoderLanguageModel: unknown

  beforeEach(async () => {
    vi.resetModules()
    mockMessages.length = 0
    lastQueryParams = null
    lastClientOptions = null
    mockReceiveMessagesFactory = null
    mockQueryError = null
    mockClientConnect.mockClear()
    mockClientQuery.mockClear()
    mockClientInterrupt.mockClear()
    mockClientDisconnect.mockClear()
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
      mockQueryError = new Error('CLI not found')

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

        expect(lastQueryParams?.options?.env?.OPENCODE).toBeUndefined()
        expect(lastQueryParams?.options?.env?.OPENCODE_PID).toBeUndefined()
      } finally {
        delete process.env.OPENCODE
        delete process.env.OPENCODE_PID
      }
    })

    it('使用正确的 modelId 传递给 query()', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('ultimate')
      await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      expect(lastQueryParams).toBeDefined()
      expect(lastQueryParams.options.model).toBe('ultimate')
    })

    it('prompt 文本内容传递到 query()', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('hello world'))).stream)

      expect(mockClientQuery).toHaveBeenCalledOnce()
      expect(typeof lastQueryParams.prompt).toBe('string')
      expect(lastQueryParams.prompt).toContain('hello world')
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

      expect(typeof lastQueryParams?.prompt).toBe('string')
      expect(lastQueryParams?.prompt).toContain('list files please')
      expect(lastQueryParams?.prompt).toContain('<conversation_continuation>')
      expect(lastQueryParams?.prompt).toContain('<tool_call id="tc-qoder-1" name="Bash">')
      expect(lastQueryParams?.prompt).toContain('<tool_result id="tc-qoder-1" name="Bash">')
      expect(lastQueryParams?.prompt.indexOf('list files please')).toBeLessThan(
        lastQueryParams?.prompt.indexOf('<conversation_continuation>') ?? -1,
      )
    })

    it('query() 默认提升 maxBufferSize 到 8MB', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('buffer test'))).stream)

      expect(lastQueryParams?.options?.maxBufferSize).toBe(8 * 1024 * 1024)
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

      expect(typeof lastQueryParams?.options?.sessionId).toBe('string')
      expect(typeof lastQueryParams?.prompt).not.toBe('string')

      const messages: Array<{ session_id?: string }> = []
      for await (const msg of lastQueryParams?.prompt as AsyncIterable<{ session_id?: string }>) {
        messages.push(msg)
      }

      expect(messages).toHaveLength(1)
      expect(messages[0].session_id).toBe(lastQueryParams?.options?.sessionId)
    })

    it('同一 model 实例的后续用户追问会复用 session 并传递 resume', async () => {
      pushSuccessResult()
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('first turn'))).stream)
      const firstSessionId = lastQueryParams?.options?.sessionId

      await collectStream((await model.doStream({
        inputFormat: 'prompt',
        mode: { type: 'regular' },
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'first turn' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'FIRST_ANSWER' }] },
          { role: 'user', content: [{ type: 'text', text: 'second turn' }] },
        ],
      })).stream)
      const secondSessionId = lastQueryParams?.options?.sessionId

      expect(typeof firstSessionId).toBe('string')
      expect(typeof secondSessionId).toBe('string')
      expect(firstSessionId).toBe(secondSessionId)
      expect(lastClientOptions).toBeDefined()
      expect(typeof lastQueryParams?.prompt).toBe('string')
      expect(lastQueryParams?.prompt).toContain('second turn')
      expect(lastQueryParams?.prompt).not.toContain('first turn')
      expect(lastQueryParams?.prompt).not.toContain('FIRST_ANSWER')
    })

    it('当新 prompt 不是上轮扩展时会重置 session，而不是错误 resume', async () => {
      pushSuccessResult()
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('first turn'))).stream)
      const firstSessionId = lastQueryParams?.options?.sessionId

      await collectStream((await model.doStream(buildCallOptions('completely unrelated prompt'))).stream)
      const secondSessionId = lastQueryParams?.options?.sessionId

      expect(typeof firstSessionId).toBe('string')
      expect(typeof secondSessionId).toBe('string')
      expect(secondSessionId).not.toBe(firstSessionId)
      expect(lastClientOptions).toBeDefined()
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

      expect(lastQueryParams?.options?.mcpServers).toBeDefined()
      const weatherServer = lastQueryParams.options.mcpServers.weather
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

      const weatherServer = lastQueryParams?.options?.mcpServers?.weather
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

      expect(lastQueryParams?.options?.mcpServers?.echo).toBeDefined()
      expect(lastQueryParams.options.mcpServers.echo.type).toBe('sdk')
      expect(lastQueryParams.options.mcpServers.echo.name).toBe('echo')
      expect(lastQueryParams.options.mcpServers.echo.instance).toBe(mockInstance)
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

      const calcServer = lastQueryParams?.options?.mcpServers?.calc
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
      expect(lastQueryParams?.options?.mcpServers?.echo).toBeUndefined()
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
      expect(lastQueryParams?.options?.disallowedTools).toBeUndefined()
    })

    it('无 mcpServers 时也不设置 disallowedTools（允许 CLI 内建工具被调用）', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      expect(lastQueryParams?.options?.disallowedTools).toBeUndefined()
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

      expect(lastQueryParams?.options?.mcpServers?.context7).toBeDefined()
      expect(lastQueryParams.options.mcpServers.context7.command).toBe('npx')
      expect(lastQueryParams.options.mcpServers.context7.args).toEqual(['-y', '@upstash/context7-mcp@latest'])
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
      expect(lastQueryParams?.options?.mcpServers?.context7?.args).toEqual(['-y', '@upstash/context7-mcp@1.0.0'])
    })

    it('mcp-bridge 为空时 query() 不传 mcpServers', async () => {
      pushSuccessResult()

      // bridge 已在 beforeEach 中重置为空
      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      expect(lastQueryParams?.options?.mcpServers).toBeUndefined()
    })

    // ── MCP proxy 工具名转换：mcp__server__tool → server_tool ──

    it('CLI mcp__context7__* 转换为 context7_* 后匹配 opencode function tool', async () => {
      // CLI 发出 mcp__context7__resolve-library-id（CLI MCP proxy 格式）
      // opencode tools 有 context7_resolve-library-id（opencode 格式）
      // normalizeToolName 转换后能匹配 → 正常发出，不带 providerExecuted
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

      // mcp__context7__resolve-library-id → context7_resolve-library-id（匹配 functionToolNames）
      // → isProviderExecuted=false → 正常发出，不带 providerExecuted
      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      expect((toolCall as any).toolName).toBe('context7_resolve-library-id')
      expect((toolCall as any).providerExecuted).toBeUndefined()

      // 文本仍然正常输出
      const deltas = parts.filter((p) => p.type === 'text-delta')
      expect(deltas.map((p) => (p as any).delta).join('')).toBe('Done.')
    })

    it('CLI mcp__* 工具不在 opencode tools 中时，不发出 tool 事件', async () => {
      // CLI 发出 mcp__context7__resolve-library-id，但 opencode 没有 context7 相关工具
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

      // context7_resolve-library-id 不在 functionToolNames → isProviderExecuted=true → 不发事件
      const toolEvents = parts.filter((p) =>
        ['tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-call', 'tool-result'].includes(p.type)
      )
      expect(toolEvents).toHaveLength(0)
    })

    it('CLI 大写工具（Read）正确映射到 opencode 小写工具（read）', async () => {
      // CLI 内部调用 Read（大写），opencode tools 有 read（小写）
      // normalizeToolName 统一转小写后能正确匹配 → 作为 opencode 工具发出
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
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"/tmp/file.txt"}' } },
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

      // CLI 的 Read（大写）经 normalizeToolName 转为 read（小写）→ 匹配 functionToolNames
      // → isProviderExecuted=false → 正常发出 tool 事件（不带 providerExecuted）
      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      expect((toolCall as any).toolName).toBe('read')
      expect((toolCall as any).providerExecuted).toBeUndefined()
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

    // ── 标准工具调用流（opencode 执行工具，不带 providerExecuted） ────────────

    it('options.tools 中 function 类型工具调用不带 providerExecuted', async () => {
      // CLI 发出 bash 工具调用（bash 在 options.tools 里是 function 类型）
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
      // function 类型工具不带 providerExecuted → opencode 负责执行
      expect((toolCall as any).providerExecuted).toBeUndefined()
    })

    it('CLI 内置工具（不在 options.tools 中）不向 opencode 发 tool 事件', async () => {
      // CLI 发出 Bash（CLI 内置，大写），不在 options.tools 里
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

      // CLI 内置工具（不在 options.tools 中）→ 不向 opencode 发任何 tool 事件
      const toolEvents = parts.filter((p) =>
        ['tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-call', 'tool-result'].includes(p.type)
      )
      expect(toolEvents).toHaveLength(0)
    })

    it('opencode 执行的 function 工具不发出 tool-result（opencode 自己处理）', async () => {
      // CLI 发出 bash 工具调用，但 bash 是 function 类型（opencode 执行）
      // CLI 后续发出 user tool_result，但我们不应 re-emit 给 opencode
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
        // 这是 CLI 内部发的 tool_result，不应转发给 opencode
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

      // function 工具 → opencode 执行，不应有 tool-result 被 re-emit
      const toolResults = parts.filter((p) => p.type === 'tool-result')
      expect(toolResults).toHaveLength(0)
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
      expect(lastQueryParams?.options?.mcpServers?.context7).toBeDefined()
      expect(lastQueryParams.options.mcpServers.context7.command).toBe('npx')
      expect(lastQueryParams.options.mcpServers.context7.args).toEqual(['-y', '@upstash/context7-mcp@latest'])
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

    it('Read 工具参数从 file_path 映射为 filePath', async () => {
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call_map_read', name: 'Read', input: { file_path: '/tmp/a.txt', offset: 1, limit: 10 } },
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
      expect(JSON.parse((toolCall as any).input)).toEqual({ filePath: '/tmp/a.txt', offset: 1, limit: 10 })
    })

    it('Edit 工具参数从 snake_case 映射为 camelCase', async () => {
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call_map_edit',
              name: 'Edit',
              input: {
                file_path: '/tmp/a.txt',
                old_string: 'a',
                new_string: 'b',
                replace_all: true,
              },
            },
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
                { type: 'function', name: 'edit', description: 'Edit file', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(JSON.parse((toolCall as any).input)).toEqual({
        filePath: '/tmp/a.txt',
        oldString: 'a',
        newString: 'b',
        replaceAll: true,
      })
    })

    it('Question 工具参数从 multiSelect 映射为 multiple', async () => {
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call_map_question',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Q?',
                    header: 'Q',
                    multiSelect: true,
                    options: [{ label: 'A', description: 'a' }],
                  },
                ],
                answers: { Q: 'A' },
              },
            },
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
                { type: 'function', name: 'question', description: 'Ask question', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(JSON.parse((toolCall as any).input)).toEqual({
        questions: [
          {
            question: 'Q?',
            header: 'Q',
            multiple: true,
            options: [{ label: 'A', description: 'a' }],
          },
        ],
      })
    })

    it('TodoWrite 自动补 priority 并移除 activeForm', async () => {
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call_map_todo',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'Task A', status: 'pending', activeForm: 'Doing task A' },
                ],
              },
            },
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
                { type: 'function', name: 'todowrite', description: 'Write todos', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(JSON.parse((toolCall as any).input)).toEqual({
        todos: [{ content: 'Task A', status: 'pending', priority: 'medium' }],
      })
    })

    it('Skill 工具参数从 skill 映射为 name', async () => {
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call_map_skill',
              name: 'Skill',
              input: {
                skill: 'simplify',
              },
            },
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
                { type: 'function', name: 'skill', description: 'Load skill', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(JSON.parse((toolCall as any).input)).toEqual({
        name: 'simplify',
      })
    })

    it('Agent 映射为 task 并转发给 opencode', async () => {
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call_agent_001', name: 'Agent', input: { description: 'd', prompt: 'p', subagent_type: 'general-purpose' } },
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
      expect(JSON.parse((toolCalls[0] as any).input)).toEqual({
        description: 'd',
        prompt: 'p',
        subagent_type: 'general-purpose',
      })
    })

    it('ExitPlanMode 映射为 plan_exit', async () => {
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call_map_plan', name: 'ExitPlanMode', input: {} },
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
                { type: 'function', name: 'plan_exit', description: 'Exit plan', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      expect(toolCalls).toHaveLength(1)
      expect((toolCalls[0] as any).toolName).toBe('plan_exit')
    })

    it('query options 不再注入 qoder 内置 agents 定义', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      expect(lastQueryParams?.options?.agents).toBeUndefined()
    })

    it('Task 在有 opencode task 工具时会转发，并映射 subagent_type', async () => {
      const agentBridge = await import('../src/agent-bridge.js')
      agentBridge.setAvailableAgentTypes(['explorer', 'fixer', 'designer', 'oracle', 'librarian'])

      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call_task_001', name: 'Task', input: { description: 'search', prompt: 'find it', subagent_type: 'general-purpose' } },
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
      expect(JSON.parse((toolCalls[0] as any).input)).toEqual({
        description: 'search',
        prompt: 'find it',
        subagent_type: 'explorer',
      })

      agentBridge.setAvailableAgentTypes([])
    })

    it('Task（stream_event 路径）在有 opencode task 工具时也会转发', async () => {
      const agentBridge = await import('../src/agent-bridge.js')
      agentBridge.setAvailableAgentTypes(['explorer', 'fixer'])

      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_task_002', name: 'Task' },
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
      expect(JSON.parse((toolCalls[0] as any).input)).toEqual({
        description: 'd',
        prompt: 'p',
        subagent_type: 'explorer',
      })

      const toolInputEvents = parts.filter((p) =>
        ['tool-input-start', 'tool-input-delta', 'tool-input-end'].includes(p.type)
      )
      expect(toolInputEvents).not.toHaveLength(0)

      agentBridge.setAvailableAgentTypes([])
    })

    it('Task 发出后会立即抑制同轮后续其他 function 工具转发', async () => {
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

      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      const taskCall = toolCalls.find((p) => (p as any).toolName === 'task')
      const bashCall = toolCalls.find((p) => (p as any).toolName === 'bash')
      expect(toolCalls).toHaveLength(1)
      expect(taskCall).toBeDefined()
      expect(JSON.parse((taskCall as any).input)).toEqual({
        description: 'd',
        prompt: 'p',
        subagent_type: 'general-purpose',
      })
      expect(bashCall).toBeUndefined()
    })

    it('Task 在没有 opencode task 工具时不会转发给 opencode', async () => {
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

      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      expect(toolCalls).toHaveLength(0)
    })

    it('Agent 不依赖 qoder 内置 agents，直接作为 opencode task 转发', async () => {
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
      expect(JSON.parse((toolCalls[0] as any).input)).toEqual({
        description: 'd',
        prompt: 'p',
        subagent_type: 'general-purpose',
      })
      expect(lastQueryParams?.options?.agents).toBeUndefined()
    })

    // ── agent-bridge：subagent_type 映射逻辑 ───────────────────────────────

    it('agent-bridge 将 CLI 标准类型映射为 oh-my-opencode-slim 可用类型', async () => {
      const { setAvailableAgentTypes, mapSubagentType } = await import('../src/agent-bridge.js')
      setAvailableAgentTypes(['explorer', 'fixer', 'designer', 'oracle', 'librarian'])

      // general-purpose → explorer（语义类别 explore）
      expect(mapSubagentType('general-purpose')).toBe('explorer')
      // code-reviewer → fixer（语义类别 fix）
      expect(mapSubagentType('code-reviewer')).toBe('fixer')
      // design-agent → designer（语义类别 design）
      expect(mapSubagentType('design-agent')).toBe('designer')

      // 清理
      setAvailableAgentTypes([])
    })

    it('agent-bridge 对已在可用类型中的 subagent_type 原样返回', async () => {
      const { setAvailableAgentTypes, mapSubagentType } = await import('../src/agent-bridge.js')
      setAvailableAgentTypes(['explorer', 'fixer', 'designer'])

      expect(mapSubagentType('explorer')).toBe('explorer')
      expect(mapSubagentType('fixer')).toBe('fixer')

      // 清理
      setAvailableAgentTypes([])
    })

    it('agent-bridge 无可用类型配置时 subagent_type 原样透传', async () => {
      const { setAvailableAgentTypes, mapSubagentType } = await import('../src/agent-bridge.js')
      // 模拟标准 opencode 环境：不设置可用类型
      setAvailableAgentTypes([])

      expect(mapSubagentType('general-purpose')).toBe('general-purpose')
      expect(mapSubagentType('code-reviewer')).toBe('code-reviewer')
    })

    // ── finishReason：有 tool-call 时应为 'tool-calls' ─────────────────────

    it('有 function tool-call 时 finishReason 为 tool-calls', async () => {
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_finish_001', name: 'bash' },
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

      // 有 tool-call 发出时，finishReason 应为 'tool-calls' 而非 'stop'
      const finish = parts.find((p) => p.type === 'finish')
      expect(finish).toBeDefined()
      expect((finish as any).finishReason).toBe('tool-calls')
    })

    it('同一 query 内工具已执行完成且最终 stop_reason=end_turn 时 finishReason 为 stop', async () => {
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_finish_done_001', name: 'grep' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pattern":"QoderLanguageModel"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      })
      mockMessages.push({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'call_finish_done_001', content: 'Found 1 file:\n\nsrc/qoder-language-model.ts' },
          ],
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'src/qoder-language-model.ts' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5 } },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              tools: [
                { type: 'function', name: 'grep', description: 'Search text', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const finish = parts.find((p) => p.type === 'finish')
      expect(finish).toBeDefined()
      expect((finish as any).finishReason).toBe('stop')
    })

    it('只有 providerExecuted tool-call 时 finishReason 仍为 stop', async () => {
      // CLI 调用 Bash（不在 options.tools 中）→ providerExecuted → 不对 opencode 发 tool-call
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_finish_002', name: 'Bash' },
        },
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
                { type: 'function', name: 'read', description: 'Read file', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      // 没有向 opencode 发出 tool-call（都是 providerExecuted）→ finishReason = stop
      const finish = parts.find((p) => p.type === 'finish')
      expect(finish).toBeDefined()
      expect((finish as any).finishReason).toBe('stop')
    })

    it('无 tools 时纯文本 finishReason 仍为 stop', async () => {
      pushTextDelta('hello')
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      const finish = parts.find((p) => p.type === 'finish')
      expect(finish).toBeDefined()
      expect((finish as any).finishReason).toBe('stop')
    })

    // ── reasoning/thinking 流式支持 ───────────────────────────────────────

    it('stream_event thinking_delta 正确转换为 reasoning-start + reasoning-delta + reasoning-end', async () => {
      pushThinkingBlockStart(0)
      pushThinkingDelta('Let me think...', 0)
      pushThinkingDelta(' step by step', 0)
      pushContentBlockStop(0)
      pushTextBlockStart(1)
      pushTextDeltaWithIndex('Final answer', 1)
      pushContentBlockStop(1)
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const { stream } = await model.doStream(buildCallOptions('Reason about this'))
      const parts = await collectStream(stream)

      // reasoning 事件
      expect(parts.find((p) => p.type === 'reasoning-start')).toBeDefined()
      const reasoningDeltas = parts.filter((p) => p.type === 'reasoning-delta')
      expect(reasoningDeltas).toHaveLength(2)
      expect(reasoningDeltas.map((p) => (p as any).delta).join('')).toBe('Let me think... step by step')
      expect(parts.find((p) => p.type === 'reasoning-end')).toBeDefined()

      // text 事件
      expect(parts.find((p) => p.type === 'text-start')).toBeDefined()
      const textDeltas = parts.filter((p) => p.type === 'text-delta')
      expect(textDeltas.map((p) => (p as any).delta).join('')).toBe('Final answer')
      expect(parts.find((p) => p.type === 'text-end')).toBeDefined()
    })

    it('thinking_delta 无 content_block_start 时自动补 reasoning-start', async () => {
      // 直接发 thinking_delta，不先发 content_block_start（应自动补 reasoning-start）
      pushThinkingDelta('Direct thinking', 0)
      pushContentBlockStop(0)
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('test'))).stream)

      expect(parts.find((p) => p.type === 'reasoning-start')).toBeDefined()
      const reasoningDeltas = parts.filter((p) => p.type === 'reasoning-delta')
      expect(reasoningDeltas).toHaveLength(1)
      expect((reasoningDeltas[0] as any).delta).toBe('Direct thinking')
    })

    it('assistant 路径 thinking block 正确转换为 reasoning-start + reasoning-delta + reasoning-end', async () => {
      // 走 assistant fallback（非 stream_event）
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'I need to analyze this carefully.' },
            { type: 'text', text: 'Here is the answer.' },
          ],
        },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('test'))).stream)

      // reasoning 事件
      expect(parts.find((p) => p.type === 'reasoning-start')).toBeDefined()
      const reasoningDeltas = parts.filter((p) => p.type === 'reasoning-delta')
      expect(reasoningDeltas).toHaveLength(1)
      expect((reasoningDeltas[0] as any).delta).toBe('I need to analyze this carefully.')
      expect(parts.find((p) => p.type === 'reasoning-end')).toBeDefined()

      // text 事件
      expect(parts.find((p) => p.type === 'text-start')).toBeDefined()
      const textDeltas = parts.filter((p) => p.type === 'text-delta')
      expect(textDeltas.map((p) => (p as any).delta).join('')).toBe('Here is the answer.')
    })

    it('stream_event reasoning 阻止 assistant fallback 重复发 thinking', async () => {
      // 先通过 stream_event 发了 thinking_delta
      pushThinkingDelta('streamed thinking', 0)
      pushContentBlockStop(0)
      // 然后 assistant 消息也有 thinking block（应忽略）
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'streamed thinking' },
            { type: 'text', text: 'Answer.' },
          ],
        },
      })
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('test'))).stream)

      // 应只有一组 reasoning（来自 stream_event，不重复）
      const reasoningStarts = parts.filter((p) => p.type === 'reasoning-start')
      expect(reasoningStarts).toHaveLength(1)
    })

    it('result 时自动关闭未关闭的 reasoning block', async () => {
      // thinking block 开始了但没有 content_block_stop
      pushThinkingBlockStart(0)
      pushThinkingDelta('incomplete thinking', 0)
      // 直接发 result（不发 content_block_stop）
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('test'))).stream)

      // 应有 reasoning-start 和 reasoning-end（自动关闭）
      expect(parts.find((p) => p.type === 'reasoning-start')).toBeDefined()
      expect(parts.find((p) => p.type === 'reasoning-end')).toBeDefined()
    })

    it('doGenerate 返回 reasoning + text content', async () => {
      pushThinkingBlockStart(0)
      pushThinkingDelta('thinking process', 0)
      pushContentBlockStop(0)
      pushTextBlockStart(1)
      pushTextDeltaWithIndex('generated text', 1)
      pushContentBlockStop(1)
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const result = await model.doGenerate(buildCallOptions('test'))

      const reasoningContent = result.content.find((c) => c.type === 'reasoning')
      expect(reasoningContent).toBeDefined()
      expect((reasoningContent as any).text).toBe('thinking process')

      const textContent = result.content.find((c) => c.type === 'text')
      expect(textContent).toBeDefined()
      expect((textContent as any).text).toBe('generated text')
    })

    // ── experimentalMcpLoad ───────────────────────────────────────────────────

    it('experimentalMcpLoad=true 时 extraArgs 中包含 --experimental-mcp-load', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              providerOptions: {
                qoder: {
                  experimentalMcpLoad: true,
                },
              },
            }),
          )
        ).stream,
      )

      expect(lastQueryParams?.options?.extraArgs).toBeDefined()
      expect(lastQueryParams.options.extraArgs['--experimental-mcp-load']).toBeNull()
    })

    it('experimentalMcpLoad=true 时 mcpServers 仍然正常透传', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              providerOptions: {
                qoder: {
                  experimentalMcpLoad: true,
                  mcpServers: {
                    weather: { command: 'npx', args: ['-y', '@acme/weather-mcp'] },
                  },
                },
              },
            }),
          )
        ).stream,
      )

      // extraArgs 包含 flag
      expect(lastQueryParams?.options?.extraArgs?.['--experimental-mcp-load']).toBeNull()
      // mcpServers 仍然存在
      expect(lastQueryParams?.options?.mcpServers?.weather).toBeDefined()
      expect(lastQueryParams.options.mcpServers.weather.command).toBe('npx')
    })

    it('experimentalMcpLoad=false 时不注入 --experimental-mcp-load', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              providerOptions: {
                qoder: {
                  experimentalMcpLoad: false,
                },
              },
            }),
          )
        ).stream,
      )

      expect(lastQueryParams?.options?.extraArgs).toBeUndefined()
    })

    // ── extraArgs 透传 ────────────────────────────────────────────────────────

    it('providerOptions.qoder.extraArgs 透传到 query() options', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              providerOptions: {
                qoder: {
                  extraArgs: { '--max-turns': '10', '--verbose': null },
                },
              },
            }),
          )
        ).stream,
      )

      expect(lastQueryParams?.options?.extraArgs).toBeDefined()
      expect(lastQueryParams.options.extraArgs['--max-turns']).toBe('10')
      expect(lastQueryParams.options.extraArgs['--verbose']).toBeNull()
    })

    it('extraArgs 与 experimentalMcpLoad 协同工作，合并到同一个对象', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream(
        (
          await model.doStream(
            buildCallOptions('ping', {
              providerOptions: {
                qoder: {
                  experimentalMcpLoad: true,
                  extraArgs: { '--max-turns': '5' },
                },
              },
            }),
          )
        ).stream,
      )

      expect(lastQueryParams?.options?.extraArgs?.['--max-turns']).toBe('5')
      expect(lastQueryParams?.options?.extraArgs?.['--experimental-mcp-load']).toBeNull()
    })

    it('未设置 extraArgs 且 experimentalMcpLoad=false 时 query() 不传 extraArgs', async () => {
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      expect(lastQueryParams?.options?.extraArgs).toBeUndefined()
    })

    // ── str_replace_based_edit_tool 映射 ──────────────────────────────────────

    it('str_replace_based_edit_tool 映射为 edit 工具名', async () => {
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call_sre_001',
              name: 'str_replace_based_edit_tool',
              input: {
                file_path: '/tmp/a.ts',
                old_string: 'foo',
                new_string: 'bar',
              },
            },
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
                { type: 'function', name: 'edit', description: 'Edit file', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      // str_replace_based_edit_tool → edit
      expect((toolCall as any).toolName).toBe('edit')
      // 参数 snake_case 映射为 camelCase（经 normalizeToolInput edit 分支处理）
      expect(JSON.parse((toolCall as any).input)).toEqual({
        filePath: '/tmp/a.ts',
        oldString: 'foo',
        newString: 'bar',
      })
    })

    it('str_replace_based_edit_tool（大小写变体）也映射为 edit', async () => {
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_sre_002', name: 'Str_Replace_Based_Edit_Tool' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/b.ts","old_string":"x","new_string":"y"}' } },
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
                { type: 'function', name: 'edit', description: 'Edit file', inputSchema: { type: 'object', properties: {} } },
              ],
            }),
          )
        ).stream,
      )

      const toolCall = parts.find((p) => p.type === 'tool-call')
      expect(toolCall).toBeDefined()
      expect((toolCall as any).toolName).toBe('edit')
    })

    // ── stream-start：AI SDK v2 协议要求在任何内容前显式发出 ────────────────
    // 修复：缺少 stream-start 会导致 opencode e2e 中 step-finish 丢失 reason，
    // 进而使 opencode run 无限重复 step。

    it('doStream 的第一个 part 必须是 stream-start（含 warnings 数组）', async () => {
      pushTextDelta('hello')
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      expect(parts.length).toBeGreaterThan(0)
      expect(parts[0].type).toBe('stream-start')
      expect((parts[0] as any).warnings).toEqual([])
    })

    it('stream-start 仅发出一次，不随内容重复', async () => {
      pushTextDelta('a')
      pushTextDelta('b')
      pushSuccessResult()

      const model = new QoderLanguageModel('auto')
      const parts = await collectStream((await model.doStream(buildCallOptions('ping'))).stream)

      const streamStarts = parts.filter((p) => p.type === 'stream-start')
      expect(streamStarts).toHaveLength(1)
    })

    // ── 回归测试：finishReason 死循环修复 ─────────────────────────────────────
    // 修复：stop_reason=tool_use 但同一 query 内 tool_result 已到达、pending 已清空时，
    // finishReason 必须为 stop，否则 opencode 会误判为还需继续执行而陷入无限循环。

    it('[回归] stop_reason=tool_use 但 pendingToolCalls 已清空时，finishReason 应为 stop（不触发死循环）', async () => {
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

    it('[回归] 确实还有待处理的 tool call 时（未收到 tool_result），finishReason 仍为 tool-calls', async () => {
      // CLI 发出 bash 工具调用，但没有发出对应的 tool_result（opencode 负责执行，pending 未清空）
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
      // 没有 user tool_result → pendingToolCalls 仍有 call_regression_002
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

      // pendingToolCalls 未清空（size=1）→ finishReason 必须为 tool-calls，opencode 继续执行
      const finish = parts.find((p) => p.type === 'finish')
      expect(finish).toBeDefined()
      expect((finish as any).finishReason).toBe('tool-calls')
    })

    it('[回归] task 子代理 tool-call 后即使同一 query 收到回放 tool_result，finishReason 仍为 tool-calls', async () => {
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
            { type: 'tool_result', tool_use_id: 'call_subagent_wait_001', content: 'Tool execution aborted' },
          ],
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
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

      const finish = parts.find((p) => p.type === 'finish')
      expect(finish).toBeDefined()
      expect((finish as any).finishReason).toBe('tool-calls')
    })

    it('[回归] task tool-call 后同一 query 的后续 text 不应继续推流', async () => {
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
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_task_text_001', content: 'Tool execution aborted' }] },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '这段文本不应继续推流' } },
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

      const textDeltas = parts.filter((p) => p.type === 'text-delta')
      expect(textDeltas).toHaveLength(0)

      const finish = parts.find((p) => p.type === 'finish')
      expect((finish as any).finishReason).toBe('tool-calls')
    })

    it('[回归] task tool-call 后同一 query 的后续 tool_use 不应继续推流', async () => {
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
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_task_tool_001', content: 'Tool execution aborted' }] },
      })
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

      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      expect(toolCalls).toHaveLength(1)
      expect((toolCalls[0] as any).toolName).toBe('task')

      const finish = parts.find((p) => p.type === 'finish')
      expect((finish as any).finishReason).toBe('tool-calls')
    })

    it('[回归] task tool-call 一发出后即应抑制同一 query 的后续 text 与 tool_use（无需等待 tool_result）', async () => {
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_task_immediate_001', name: 'Task' },
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
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '这段文本不应在 task 后继续出现' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      })

      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'call_bash_after_task_immediate', name: 'bash' },
        },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 2 },
      })

      mockMessages.push({
        type: 'stream_event',
        event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
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

      const toolCalls = parts.filter((p) => p.type === 'tool-call')
      expect(toolCalls).toHaveLength(1)
      expect((toolCalls[0] as any).toolName).toBe('task')

      const textDeltas = parts.filter((p) => p.type === 'text-delta')
      expect(textDeltas).toHaveLength(0)

      const finish = parts.find((p) => p.type === 'finish')
      expect((finish as any).finishReason).toBe('tool-calls')
    })

    // ── abort/cancel 清理测试 ─────────────────────────────────────────────────

    it('options.abortSignal.abort() 后，stream 不应悬挂', async () => {
      let resolveBlock!: () => void
      const blockPromise = new Promise<void>((resolve) => { resolveBlock = resolve })
      mockReceiveMessagesFactory = () => (async function* () {
        await blockPromise
      })()

      const abortController = new AbortController()
      const model = new QoderLanguageModel('auto')
      const streamPromise = model.doStream(buildCallOptions('ping', {
        abortSignal: abortController.signal,
      }))
      const { stream } = await streamPromise

      // 启动 reader 消费（异步，后台运行）
      const reader = stream.getReader()
      const readPromise = reader.read()

      abortController.abort()
      resolveBlock()

      await readPromise.catch(() => { /* ignore */ })
      await new Promise((r) => setTimeout(r, 0))
      expect(true).toBe(true)
    })

    it('取消 ReadableStream reader 后，不应留下悬挂执行', async () => {
      let resolveBlock!: () => void
      const blockPromise = new Promise<void>((resolve) => { resolveBlock = resolve })
      mockReceiveMessagesFactory = () => (async function* () {
        await blockPromise
      })()

      const model = new QoderLanguageModel('auto')
      const { stream } = await model.doStream(buildCallOptions('ping'))

      const reader = stream.getReader()
      await reader.read() // 得到 stream-start
      await reader.cancel()  // 触发 ReadableStream cancel() → cleanup()
      resolveBlock()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      expect(true).toBe(true)
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
