import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2ProviderDefinedTool,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  ProviderV2,
} from '@ai-sdk/provider'

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

import {
  configure,
  QoderAgentSDKClient,
} from './vendor/qoder-agent-sdk.mjs'

import { buildPromptFromOptions } from './prompt-builder.js'
import { getMcpBridgeServers } from './mcp-bridge.js'

// ── storageDir 解析 — 与 qodercli 行为对齐 ──────────────────────────────────
// qodercli login 写入 ~/.qoder；QoderWork.app 写入 ~/.qoderwork。
// 优先取最近更新的 auth/user 文件所在目录，保证 SDK 和 CLI 使用同一份 token。
function resolveStorageDir(): string {
  const candidates = [
    path.join(os.homedir(), '.qoder'),
    path.join(os.homedir(), '.qoderwork'),
  ]
  let best: string | undefined
  let bestMtime = 0
  for (const dir of candidates) {
    const userFile = path.join(dir, '.auth', 'user')
    try {
      const stat = fs.statSync(userFile)
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs
        best = dir
      }
    } catch { /* file doesn't exist */ }
  }
  return best ?? path.join(os.homedir(), '.qoder')
}

// ── SDK 全局配置 — 不设 integrationMode（设置后服务端会按订阅类型鉴权） ──────
configure({
  storageDir: resolveStorageDir(),
})

// ── 调试日志 — 保存原始 stderr 引用，不受 SDK log filter 影响 ────────────────
const _rawStderr = process.stderr.write.bind(process.stderr)
function debugLog(msg: string, traceId?: string): void {
  if (process.env.QODER_DEBUG === '1') {
    _rawStderr(`[QODER_DEBUG${traceId ? ` ${traceId}` : ''}] ${msg}\n`)
  }
}

function decorateFinishReason(reason: LanguageModelV2FinishReason): LanguageModelV2FinishReason {
  if (process.env.OPENCODE !== '1') return reason

  // opencode 1.3.7 的本地 file:// provider 集成链路里，某处会把 finishReason 当作带 unified 字段的对象读取；
  // 直接传原始字符串会导致最终落库时 step-finish.reason 为空并触发 prompt loop 死循环。
  // 这里用 String 对象包装，既保留字符串语义（JSON/stringify 后仍是 "stop"），又补齐 .unified 字段兼容该链路。
  const wrapped = new String(reason) as String & {
    unified?: LanguageModelV2FinishReason
    raw?: string | undefined
  }
  wrapped.unified = reason
  wrapped.raw = undefined
  return wrapped as unknown as LanguageModelV2FinishReason
}

/**
 * 过滤 @ali/qoder-agent-sdk 打到 console 的 [SDK] 系列日志，避免污染 opencode 界面。
 * 在模块加载时立即安装，永久生效，只屏蔽 SDK 特征前缀的行。
 */
function installSdkLogFilter(): void {
  const origLog = console.log
  const origError = console.error

  const isSdkLine = (...args: unknown[]) => {
    const first = String(args[0] ?? '')
    return (
      first.startsWith('[SDK]') ||
      first.startsWith('Platform:') ||
      first.startsWith('Spawn options:')
    )
  }

  console.log = (...args: unknown[]) => {
    if (!isSdkLine(...args)) origLog(...args)
  }
  console.error = (...args: unknown[]) => {
    if (!isSdkLine(...args)) origError(...args)
  }
}

// 模块加载即生效
installSdkLogFilter()

// ── qodercli 二进制路径解析 ───────────────────────────────────────────────────

function resolveQoderCLI(): string | undefined {
  // 1. 全局 PATH 里的 qodercli（用户自行安装，优先）
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter)
  for (const dir of pathDirs) {
    const p = path.join(dir, 'qodercli')
    if (fs.existsSync(p)) return p
  }

  // 2. SDK 默认本地安装路径：~/.qoder/local/qodercli
  const localCli = path.join(os.homedir(), '.qoder', 'local', 'qodercli')
  if (fs.existsSync(localCli)) return localCli

  // 3. 回退：~/.qoder/bin/qodercli/qodercli-<version>（取最新版本）
  const binDir = path.join(os.homedir(), '.qoder', 'bin', 'qodercli')
  if (fs.existsSync(binDir)) {
    try {
      const entries = fs
        .readdirSync(binDir)
        .filter((f) => f.startsWith('qodercli-'))
        .sort()
        .reverse()
      const latest = entries[0]
      if (latest) {
        const p = path.join(binDir, latest)
        if (fs.existsSync(p)) return p
      }
    } catch { /* ignore */ }
  }
  return undefined
}

// ── 工具名称标准化（仅做展示映射，不再用于判断执行权） ─────────────────────────

/**
 * CLI 工具名 → opencode 展示名 的标准化映射：
 *   - 大小写：Read → read, Bash → bash
 *   - CLI 内置特殊名：AskUserQuestion → question, Agent → task
 *   - MCP proxy 格式：mcp__context7__resolve-library-id → context7_resolve-library-id
 *     （CLI 用双下划线 mcp__{server}__{tool}，opencode 用单下划线 {server}_{tool}）
 */
function normalizeToolName(name: string): string {
  const lower = name.toLowerCase()
  if (lower === 'askuserquestion') return 'question'
  if (lower === 'agent') return 'task'
  if (lower === 'exitplanmode') return 'plan_exit'
  if (lower === 'str_replace_based_edit_tool') return 'edit'
  // CLI MCP proxy 格式：mcp__{serverName}__{toolName} → {serverName}_{toolName}
  if (lower.startsWith('mcp__')) {
    const withoutPrefix = lower.slice(5) // 去掉 'mcp__'
    // 找到第二个 __ 分隔符（serverName 和 toolName 之间）
    const separatorIdx = withoutPrefix.indexOf('__')
    if (separatorIdx > 0) {
      const serverName = withoutPrefix.slice(0, separatorIdx)
      const toolName = withoutPrefix.slice(separatorIdx + 2)
      return `${serverName}_${toolName}`
    }
    // 没有第二个 __，直接去掉 mcp__ 前缀
    return withoutPrefix
  }
  return lower
}

function arePromptMessagesEqual(
  left: LanguageModelV2CallOptions['prompt'][number],
  right: LanguageModelV2CallOptions['prompt'][number],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function getSharedPromptPrefixLength(
  previousPrompt: LanguageModelV2CallOptions['prompt'],
  nextPrompt: LanguageModelV2CallOptions['prompt'],
): number {
  const max = Math.min(previousPrompt.length, nextPrompt.length)
  let idx = 0
  while (idx < max && arePromptMessagesEqual(previousPrompt[idx], nextPrompt[idx])) {
    idx++
  }
  return idx
}

function trimResumedDeltaPrompt(
  deltaPrompt: LanguageModelV2CallOptions['prompt'],
): LanguageModelV2CallOptions['prompt'] {
  let start = 0
  while (start < deltaPrompt.length && deltaPrompt[start]?.role === 'assistant') {
    start++
  }
  return deltaPrompt.slice(start)
}


// ── MCP server config 转换 ────────────────────────────────────────────────────

type QoderMcpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'sdk'; name: string; instance: unknown }

type QoderProviderOptions = {
  mcpServers?: Record<string, unknown>
  /** 透传到 SDK query options 的额外 CLI 参数；值为 null 表示仅传 flag 不带值 */
  extraArgs?: Record<string, string | null>
  /** 为 true 时向 CLI 传递 --experimental-mcp-load flag */
  experimentalMcpLoad?: boolean
}

type QoderProviderFactoryOptions = QoderProviderOptions & {
  name?: string
}

const DEFAULT_QODER_MAX_BUFFER_SIZE = 8 * 1024 * 1024

function buildQoderQueryOptions(
  options: LanguageModelV2CallOptions,
  modelId: string,
  cliPath?: string,
  defaultProviderOptions?: QoderProviderOptions,
): {
  model: string
  allowDangerouslySkipPermissions: true
  permissionMode: 'bypassPermissions'
  includePartialMessages: true
  maxBufferSize: number
  sessionId: string
  continue?: boolean
  resume?: string
  cwd: string
  env: Record<string, string>
  pathToQoderCLIExecutable?: string
  mcpServers?: Record<string, QoderMcpServerConfig>
  extraArgs?: Record<string, string | null>
} {
  const providerOptions = {
    ...(defaultProviderOptions ?? {}),
    ...(getQoderProviderOptions(options.providerOptions) ?? {}),
  }

  // 双轨 MCP 策略：CLI 和 opencode 各自独立连接 MCP servers
  // CLI 通过 mcp__{server}__{tool} 格式调用，opencode 通过 {server}_{tool} 格式调用
  // 不过滤 opencode 已管理的 servers — CLI 需要自主使用外部 MCP 工具完成 agent loop
  const mcpServers = {
    ...extractMcpServersFromProviderOptions(defaultProviderOptions?.mcpServers),  // provider factory 默认桥接（跨模块上下文稳定）
    ...getMcpBridgeServers(),                                                  // config.mcp 桥接（全量传递，不过滤）
    ...extractMcpServersFromProviderOptions(providerOptions?.mcpServers),      // providerOptions 覆盖（高优先级）
    ...extractMcpServersFromTools(options.tools),                              // provider-defined tools（最高优先级）
  }

  // 合并 extraArgs：先放用户透传的，再叠加功能开关生成的 flag
  const baseExtraArgs: Record<string, string | null> = isRecord(providerOptions?.extraArgs)
    ? pickNullableStringRecord(providerOptions.extraArgs)
    : {}
  if (providerOptions?.experimentalMcpLoad === true) {
    baseExtraArgs['--experimental-mcp-load'] = null
  }
  const hasExtraArgs = Object.keys(baseExtraArgs).length > 0

  return {
    model: modelId,
    allowDangerouslySkipPermissions: true,
    permissionMode: 'bypassPermissions',
    includePartialMessages: true,
    maxBufferSize: DEFAULT_QODER_MAX_BUFFER_SIZE,
    sessionId: randomUUID(),
    cwd: process.cwd(),
    env: buildQoderQueryEnv(),
    ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(hasExtraArgs ? { extraArgs: baseExtraArgs } : {}),
  }
}

function buildQoderQueryEnv(): Record<string, string> {
  const env = { ...process.env }
  delete env.OPENCODE
  delete env.OPENCODE_PID
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function getQoderProviderOptions(
  providerOptions: LanguageModelV2CallOptions['providerOptions'],
): QoderProviderOptions | undefined {
  if (!isRecord(providerOptions)) return undefined
  const q = providerOptions.qoder
  return isRecord(q) ? (q as QoderProviderOptions) : undefined
}

function extractMcpServersFromProviderOptions(
  mcpServers: unknown,
): Record<string, QoderMcpServerConfig> {
  if (!isRecord(mcpServers)) return {}
  const normalizedEntries = Object.entries(mcpServers)
    .map(([name, config]) => [name, normalizeMcpServerConfig(config)] as const)
    .filter((entry): entry is [string, QoderMcpServerConfig] => entry[1] != null)
  return Object.fromEntries(normalizedEntries)
}

function extractMcpServersFromTools(
  tools: LanguageModelV2CallOptions['tools'],
): Record<string, QoderMcpServerConfig> {
  if (!tools || tools.length === 0) return {}
  const servers: Record<string, QoderMcpServerConfig> = {}
  for (const tool of tools) {
    if (tool.type !== 'provider-defined') continue
    const serverName = inferProviderDefinedToolServerName(tool)
    const serverConfig = normalizeMcpServerConfig(tool.args)
    if (!serverName || !serverConfig) continue
    servers[serverName] = serverConfig
  }
  return servers
}

function inferProviderDefinedToolServerName(tool: LanguageModelV2ProviderDefinedTool): string | undefined {
  const args = isRecord(tool.args) ? tool.args : undefined
  const explicit =
    pickString(args?.serverName) ??
    pickString(args?.mcpServerName) ??
    pickString(args?.server) ??
    pickString(args?.name)
  if (explicit) return explicit
  const [, suffix] = tool.id.split('.', 2)
  return suffix || tool.name
}

function normalizeMcpServerConfig(config: unknown): QoderMcpServerConfig | null {
  if (!isRecord(config)) return null
  if (config.enabled === false) return null

  // SDK in-process MCP server（由 createSdkMcpServer() 创建的 { type: 'sdk', name, instance }）
  if (config.type === 'sdk' && typeof config.name === 'string' && config.instance != null) {
    return { type: 'sdk', name: config.name, instance: config.instance }
  }

  if (Array.isArray(config.command) && config.command.every((v) => typeof v === 'string')) {
    if (config.command.length === 0) return null
    const [command, ...args] = config.command as string[]
    const env = pickStringRecord(config.environment) ?? pickStringRecord(config.env)
    return { type: 'stdio', command, ...(args.length > 0 ? { args } : {}), ...(env ? { env } : {}) }
  }

  if (typeof config.command === 'string') {
    const args = pickStringArray(config.args)
    const env = pickStringRecord(config.environment) ?? pickStringRecord(config.env)
    return {
      type: 'stdio',
      command: config.command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
    }
  }

  const url = pickString(config.url) ?? pickString(config.endpoint)
  if (url) {
    const headers = pickStringRecord(config.headers)
    return {
      type: config.type === 'sse' ? 'sse' : 'http',
      url,
      ...(headers ? { headers } : {}),
    }
  }

  if (isRecord(config.mcpServer)) return normalizeMcpServerConfig(config.mcpServer)
  if (isRecord(config.serverConfig)) return normalizeMcpServerConfig(config.serverConfig)

  return null
}

// ── LanguageModelV2 实现 ──────────────────────────────────────────────────────
//
// 方向 A（providerExecuted 模式）：
//
// Qoder CLI 作为完整 agent，自主执行所有工具（Bash/Read/Write/Grep/MCP 等）。
// Provider 只做"消息格式转换 + 流式转发"：
//   - 所有 tool-call 标记 providerExecuted: true
//   - tool-result 从 SDK user message 中提取并回传给 opencode UI 展示
//   - finishReason 始终为 'stop'（CLI 跑完整个 agent loop 才返回 result）
//
// 相比旧架构，彻底消除了：
//   - normalizeToolInput() 的字段翻译
//   - agent-bridge 的 subagent type 映射
//   - suppressFurtherAssistantContent 外部等待机制
//   - pendingToolCalls / emittedFunctionToolCall 双重追踪
//   - finishReason 'tool-calls' vs 'stop' 的复杂判断

export class QoderLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const
  readonly provider = 'qoder'
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private activeSessionId?: string
  private previousPrompt?: LanguageModelV2CallOptions['prompt']
  private activeClient?: QoderAgentSDKClient
  private activeClientSignature?: string

  constructor(
    public readonly modelId: string,
    private readonly providerOptions?: QoderProviderOptions,
  ) {}

  private buildSessionPlan(options: LanguageModelV2CallOptions): {
    effectivePrompt: LanguageModelV2CallOptions['prompt']
    sessionId: string
    continueSession: boolean
    resumeSessionId?: string
  } {
    const freshSessionId = randomUUID()
    const previousPrompt = this.previousPrompt
    const activeSessionId = this.activeSessionId

    if (!previousPrompt || !activeSessionId) {
      return {
        effectivePrompt: options.prompt,
        sessionId: freshSessionId,
        continueSession: false,
      }
    }

    const sharedPrefixLength = getSharedPromptPrefixLength(previousPrompt, options.prompt)
    const isExtension = sharedPrefixLength === previousPrompt.length && options.prompt.length >= previousPrompt.length
    if (!isExtension) {
      return {
        effectivePrompt: options.prompt,
        sessionId: freshSessionId,
        continueSession: false,
      }
    }

    const rawDeltaPrompt = options.prompt.slice(sharedPrefixLength)
    const deltaPrompt = trimResumedDeltaPrompt(rawDeltaPrompt)
    if (deltaPrompt.length === 0 || deltaPrompt[0]?.role !== 'user') {
      return {
        effectivePrompt: options.prompt,
        sessionId: freshSessionId,
        continueSession: false,
      }
    }

    return {
      effectivePrompt: deltaPrompt,
      sessionId: activeSessionId,
      continueSession: false,
      resumeSessionId: activeSessionId,
    }
  }

  private commitSessionState(prompt: LanguageModelV2CallOptions['prompt'], sessionId: string): void {
    this.previousPrompt = prompt
    this.activeSessionId = sessionId
  }

  private resetSessionState(): void {
    this.previousPrompt = undefined
    this.activeSessionId = undefined
  }

  private buildClientSignature(options: ReturnType<typeof buildQoderQueryOptions>): string {
    const mcpServerKeys = Object.keys(options.mcpServers ?? {}).sort()
    const extraArgKeys = Object.keys(options.extraArgs ?? {}).sort()
    return JSON.stringify({
      model: options.model,
      cwd: options.cwd,
      cli: options.pathToQoderCLIExecutable,
      mcpServerKeys,
      extraArgKeys,
    })
  }

  private async resetClient(): Promise<void> {
    if (this.activeClient) {
      await this.activeClient.disconnect().catch(() => { /* ignore */ })
    }
    this.activeClient = undefined
    this.activeClientSignature = undefined
  }

  private async getOrCreateClient(
    options: ReturnType<typeof buildQoderQueryOptions>,
  ): Promise<QoderAgentSDKClient> {
    const signature = this.buildClientSignature(options)
    if (this.activeClient && this.activeClientSignature === signature) {
      return this.activeClient
    }

    await this.resetClient()
    const client = new QoderAgentSDKClient(options)
    await client.connect()
    this.activeClient = client
    this.activeClientSignature = signature
    return client
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const { stream } = await this.doStream(options)
    const reader = stream.getReader()
    let text = ''
    let reasoning = ''
    let finishReason: LanguageModelV2FinishReason = 'stop'
    let usage: LanguageModelV2Usage | undefined

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      switch (value.type) {
        case 'text-delta':
          text += value.delta
          break
        case 'reasoning-delta':
          reasoning += value.delta
          break
        case 'finish':
          finishReason = value.finishReason
          usage = value.usage
          break
        case 'error':
          throw value.error instanceof Error ? value.error : new Error(String(value.error))
      }
    }

    const content: LanguageModelV2Content[] = []
    if (reasoning) content.push({ type: 'reasoning', text: reasoning })
    if (text) content.push({ type: 'text', text })
    return {
      content,
      finishReason,
      usage: usage ?? { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
      warnings: [],
    }
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>
  }> {
    const sessionPlan = this.buildSessionPlan(options)
    const effectiveOptions = {
      ...options,
      prompt: sessionPlan.effectivePrompt,
    }
    const cliPath = resolveQoderCLI()
    const qoderOptions = {
      ...buildQoderQueryOptions(effectiveOptions, this.modelId, cliPath, this.providerOptions),
      sessionId: sessionPlan.sessionId,
    }
    const prompt = buildPromptFromOptions(effectiveOptions, qoderOptions.sessionId)

    const streamTraceId = randomUUID().slice(0, 8)
    debugLog(`doStream() called, modelId=${this.modelId}, cliPath=${cliPath}`, streamTraceId)
    debugLog(`doStream() prompt length=${typeof prompt === 'string' ? prompt.length : 'non-string'}`, streamTraceId)
    debugLog(`doStream() qoderOptions.mcpServers=[${Object.keys(qoderOptions.mcpServers ?? {}).join(',')}]`, streamTraceId)

    let activeClient: QoderAgentSDKClient | undefined

    // 幂等清理函数：中断当前 client query，避免重复调用抛错
    let cleanupCalled = false
    function cleanup() {
      if (cleanupCalled) return
      cleanupCalled = true
      void activeClient?.interrupt().catch(() => { /* ignore */ })
    }

    // 监听外部 abortSignal：opencode 中断时立即触发清理
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        cleanup()
      } else {
        options.abortSignal.addEventListener('abort', cleanup, { once: true })
      }
    }

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      cancel() {
        // ReadableStream 被取消（reader.cancel() 或 reader 提前释放）时触发清理
        cleanup()
      },
      start: async (controller) => {
        // ── stream-start：AI SDK v2 协议要求在任何内容前显式发出 ──────────
        controller.enqueue({ type: 'stream-start', warnings: [] })

        // ── 状态管理（大幅简化：不再需要 pending/emitted/suppress 三重追踪） ──
        let textBlockCounter = 0
        let hasFinish = false

        // stream_event 路径：按 index 跟踪活跃内容块
        const activeStreamTextBlocks = new Set<number>()
        const activeStreamReasoningBlocks = new Set<number>()
        const streamToolBlocks = new Map<number, { id: string; name: string; inputJson: string }>()

        // 已通过 stream_event 发出的标志（防 assistant 消息重复发）
        let sawStreamEventText = false
        let sawStreamEventTool = false
        let sawStreamEventReasoning = false

        // tool_use_id → toolName 映射（用于 tool_result 时关联工具名）
        const toolCallsById = new Map<string, { name: string }>()

        try {
          if (!sessionPlan.resumeSessionId) {
            this.resetSessionState()
            await this.resetClient()
          }
          activeClient = await this.getOrCreateClient(qoderOptions)
          const qoderMessages = activeClient.receiveMessages()
          await activeClient.query(prompt, sessionPlan.sessionId)
          let sdkMsgCount = 0
          for await (const msg of qoderMessages) {
            sdkMsgCount++
            const m = msg as Record<string, unknown>
            debugLog(`SDK msg #${sdkMsgCount}: type=${m.type}${m.subtype ? ` subtype=${m.subtype}` : ''}`, streamTraceId)
            if (m.type === 'system' && m.subtype === 'init') {
              const tools = Array.isArray(m.tools) ? m.tools.join(',') : ''
              const mcpServers = Array.isArray(m.mcp_servers) ? JSON.stringify(m.mcp_servers) : '[]'
              debugLog(`SDK init: tools=[${tools}] mcp_servers=${mcpServers}`, streamTraceId)
            }

            // ── stream_event：增量文本 / 增量工具输入（流式 CLI 支持时） ──
            if (m.type === 'stream_event') {
              const ev = (m as { event: Record<string, unknown> }).event

              if (ev.type === 'content_block_start' && isRecord(ev.content_block)) {
                const block = ev.content_block
                const idx = typeof ev.index === 'number' ? ev.index : 0

                if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
                  sawStreamEventTool = true
                  const toolName = normalizeToolName(block.name)
                  debugLog(`tool_use block_start: raw=${block.name} → normalized=${toolName}`, streamTraceId)
                  streamToolBlocks.set(idx, { id: block.id, name: toolName, inputJson: '' })
                  // providerExecuted 模式：所有工具都展示给 opencode UI
                  controller.enqueue({
                    type: 'tool-input-start',
                    id: block.id,
                    toolName,
                  } as LanguageModelV2StreamPart)
                } else if (block.type === 'thinking') {
                  activeStreamReasoningBlocks.add(idx)
                  controller.enqueue({ type: 'reasoning-start', id: String(idx) })
                } else if (block.type === 'text') {
                  activeStreamTextBlocks.add(idx)
                  controller.enqueue({ type: 'text-start', id: String(idx) })
                }
              } else if (ev.type === 'content_block_delta' && isRecord(ev.delta)) {
                const delta = ev.delta
                const idx = typeof ev.index === 'number' ? ev.index : 0

                if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
                  sawStreamEventReasoning = true
                  if (!activeStreamReasoningBlocks.has(idx)) {
                    activeStreamReasoningBlocks.add(idx)
                    controller.enqueue({ type: 'reasoning-start', id: String(idx) })
                  }
                  controller.enqueue({ type: 'reasoning-delta', id: String(idx), delta: delta.thinking })
                } else if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
                  sawStreamEventText = true
                  if (!activeStreamTextBlocks.has(idx)) {
                    activeStreamTextBlocks.add(idx)
                    controller.enqueue({ type: 'text-start', id: String(idx) })
                  }
                  controller.enqueue({ type: 'text-delta', id: String(idx), delta: delta.text })
                } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                  const toolBlock = streamToolBlocks.get(idx)
                  if (toolBlock) {
                    toolBlock.inputJson += delta.partial_json
                    controller.enqueue({
                      type: 'tool-input-delta',
                      id: toolBlock.id,
                      delta: delta.partial_json,
                    } as LanguageModelV2StreamPart)
                  }
                }
              } else if (ev.type === 'content_block_stop') {
                const idx = typeof ev.index === 'number' ? ev.index : 0
                const toolBlock = streamToolBlocks.get(idx)

                if (toolBlock) {
                  // 解析输入 JSON
                  let parsedInput: unknown = {}
                  try {
                    parsedInput = JSON.parse(toolBlock.inputJson || '{}')
                  } catch { /* keep empty object */ }

                  controller.enqueue({ type: 'tool-input-end', id: toolBlock.id } as LanguageModelV2StreamPart)
                  // 核心变更：所有 tool-call 标记 providerExecuted: true
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: toolBlock.id,
                    toolName: toolBlock.name,
                    input: JSON.stringify(parsedInput),
                    providerExecuted: true,
                  } as LanguageModelV2StreamPart)
                  debugLog(`emitted providerExecuted tool-call: toolName=${toolBlock.name}, id=${toolBlock.id}`, streamTraceId)

                  toolCallsById.set(toolBlock.id, { name: toolBlock.name })
                  streamToolBlocks.delete(idx)
                } else if (activeStreamReasoningBlocks.has(idx)) {
                  controller.enqueue({ type: 'reasoning-end', id: String(idx) })
                  activeStreamReasoningBlocks.delete(idx)
                } else if (activeStreamTextBlocks.has(idx)) {
                  controller.enqueue({ type: 'text-end', id: String(idx) })
                  activeStreamTextBlocks.delete(idx)
                }
              } else if (ev.type === 'message_delta' && isRecord(ev.delta) && typeof ev.delta.stop_reason === 'string') {
                debugLog(`message_delta: stop_reason=${ev.delta.stop_reason}`, streamTraceId)
              }

            // ── assistant：完整消息块（CLI 不支持流式时走此路径） ──────────
            } else if (m.type === 'assistant') {
              const rawContent = (m.message as Record<string, unknown> | undefined)?.content
              const content = Array.isArray(rawContent) ? rawContent : []
              for (const block of content) {
                if (!isRecord(block)) continue

                if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking && !sawStreamEventReasoning) {
                  const reasoningId = String(textBlockCounter++)
                  controller.enqueue({ type: 'reasoning-start', id: reasoningId })
                  controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta: block.thinking })
                  controller.enqueue({ type: 'reasoning-end', id: reasoningId })
                } else if (block.type === 'text' && typeof block.text === 'string' && block.text && !sawStreamEventText) {
                  const textId = String(textBlockCounter++)
                  controller.enqueue({ type: 'text-start', id: textId })
                  controller.enqueue({ type: 'text-delta', id: textId, delta: block.text })
                  controller.enqueue({ type: 'text-end', id: textId })
                } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && !sawStreamEventTool) {
                  const toolName = normalizeToolName(block.name)
                  const rawInputJson = typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {})

                  controller.enqueue({
                    type: 'tool-input-start',
                    id: block.id,
                    toolName,
                  } as LanguageModelV2StreamPart)
                  controller.enqueue({
                    type: 'tool-input-delta',
                    id: block.id,
                    delta: rawInputJson,
                  } as LanguageModelV2StreamPart)
                  controller.enqueue({ type: 'tool-input-end', id: block.id } as LanguageModelV2StreamPart)
                  // 核心变更：所有 tool-call 标记 providerExecuted: true
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: block.id,
                    toolName,
                    input: rawInputJson,
                    providerExecuted: true,
                  } as LanguageModelV2StreamPart)
                  debugLog(`emitted providerExecuted tool-call (assistant path): toolName=${toolName}, id=${block.id}`, streamTraceId)

                  toolCallsById.set(block.id, { name: toolName })
                }
              }

            // ── user：CLI 内部工具执行结果 → providerExecuted tool-result ──
            } else if (m.type === 'user') {
              const rawContent = (m.message as Record<string, unknown> | undefined)?.content
              const content = Array.isArray(rawContent) ? rawContent : []
              for (const block of content) {
                if (!isRecord(block)) continue
                if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue

                const toolCall = toolCallsById.get(block.tool_use_id)
                debugLog(`tool_result: tool_use_id=${block.tool_use_id}, found=${!!toolCall}, toolName=${toolCall?.name}`, streamTraceId)
                if (!toolCall) continue

                // 提取结果文本
                let resultText = ''
                if (typeof block.content === 'string') {
                  resultText = block.content
                } else if (Array.isArray(block.content)) {
                  resultText = (block.content as unknown[])
                    .filter((c): c is { type: string; text: string } =>
                      isRecord(c) && c.type === 'text' && typeof c.text === 'string'
                    )
                    .map((c) => c.text)
                    .join('\n')
                }

                // 核心新增：回传 providerExecuted tool-result 给 opencode UI 展示
                controller.enqueue({
                  type: 'tool-result',
                  toolCallId: block.tool_use_id,
                  toolName: toolCall.name,
                  result: {
                    output: resultText,
                    title: toolCall.name,
                    metadata: {},
                  },
                  providerExecuted: true,
                } as LanguageModelV2StreamPart)
                debugLog(`emitted providerExecuted tool-result: toolName=${toolCall.name}, id=${block.tool_use_id}`, streamTraceId)

                toolCallsById.delete(block.tool_use_id)
              }

            // ── result：CLI agent loop 结束 ─────────────────────────────
            } else if (m.type === 'result') {
              debugLog(`result: subtype=${m.subtype}, is_error=${m.is_error}`, streamTraceId)

              // 关闭所有未关闭的文本块和推理块
              for (const idx of activeStreamReasoningBlocks) {
                controller.enqueue({ type: 'reasoning-end', id: String(idx) })
              }
              activeStreamReasoningBlocks.clear()

              for (const idx of activeStreamTextBlocks) {
                controller.enqueue({ type: 'text-end', id: String(idx) })
              }
              activeStreamTextBlocks.clear()

              const wasExternallyAbortedResult =
                cleanupCalled && m.subtype === 'error_during_execution'

              if (wasExternallyAbortedResult) {
                debugLog('result: suppressing error_during_execution after external abort/cancel', streamTraceId)
                hasFinish = true
                break
              }

              const isError =
                m.is_error === true ||
                (typeof m.subtype === 'string' && m.subtype !== 'success')

              if (isError) {
                const errMsg = typeof m.subtype === 'string' ? m.subtype : 'error_during_execution'
                const errors = Array.isArray(m.errors) ? JSON.stringify(m.errors) : ''
                console.error('[QoderSDK] result error:', JSON.stringify(m, null, 2))
                controller.enqueue({
                  type: 'error',
                  error: new Error(`Qoder SDK: ${errMsg}${errors ? ` | errors: ${errors}` : ''}`),
                })
                controller.enqueue({
                  type: 'finish',
                  finishReason: decorateFinishReason('error'),
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                })
              } else {
                const usage = m.usage as { input_tokens: number; output_tokens: number } | undefined
                // providerExecuted 模式：finishReason 始终为 'stop'
                // CLI 完整跑完 agent loop 后才发 result，不需要 'tool-calls'
                controller.enqueue({
                  type: 'finish',
                  finishReason: decorateFinishReason('stop'),
                  usage: {
                    inputTokens: usage?.input_tokens ?? 0,
                    outputTokens: usage?.output_tokens ?? 0,
                    totalTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
                  },
                })
                this.commitSessionState(options.prompt, sessionPlan.sessionId)
              }

              hasFinish = true
              break  // result 是终止消息，退出迭代
            }
            // type: 'system' — 忽略
          }

          if (!hasFinish) {
            debugLog('stream ended without result message, emitting fallback finish=stop', streamTraceId)
            controller.enqueue({
              type: 'finish',
              finishReason: decorateFinishReason('stop'),
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            })
          }
          debugLog('stream complete, closing controller', streamTraceId)
          cleanup()
          controller.close()
        } catch (err) {
          this.resetSessionState()
          await this.resetClient()
          // 记录 catch 进入时，abort 是否已由外部（abortSignal / cancel）提前触发
          const wasExternallyAborted = cleanupCalled
          cleanup()
          // 外部 abort/cancel 触发的中断：静默关闭，不 enqueue error/finish（避免混乱）
          if (wasExternallyAborted) {
            if (!hasFinish) {
              controller.close()
            }
            return
          }
          if (!hasFinish) {
            controller.enqueue({
              type: 'error',
              error: err instanceof Error ? err : new Error(String(err)),
            })
            controller.enqueue({
              type: 'finish',
              finishReason: decorateFinishReason('error'),
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            })
          }
          controller.close()
        }
      },
    })

    return { stream }
  }
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function pickStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined
}

function pickStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function pickNullableStringRecord(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (e): e is [string, string | null] => e[1] === null || typeof e[1] === 'string',
    ),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── Provider factory ──────────────────────────────────────────────────────────

export function createQoderProvider(options?: QoderProviderFactoryOptions): ProviderV2 {
  const providerOptions: QoderProviderOptions = {
    ...(isRecord(options?.mcpServers) ? { mcpServers: options?.mcpServers } : {}),
    ...(isRecord(options?.extraArgs) ? { extraArgs: pickNullableStringRecord(options?.extraArgs) } : {}),
    ...(options?.experimentalMcpLoad === true ? { experimentalMcpLoad: true } : {}),
  }

  return {
    languageModel: (modelId: string) => new QoderLanguageModel(modelId, providerOptions),
    textEmbeddingModel: (_modelId: string) => {
      throw new Error('Qoder provider does not support text embeddings')
    },
    imageModel: (_modelId: string) => {
      throw new Error('Qoder provider does not support image models')
    },
  }
}
