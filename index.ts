import type { Plugin, Hooks } from '@opencode-ai/plugin'
import { QODER_MODELS } from './src/models.js'
import { setMcpBridgeServers } from './src/mcp-bridge.js'
import { setAvailableAgentTypes } from './src/agent-bridge.js'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const QoderProviderPlugin: Plugin = async () => {
  // 解析 provider.ts 的 file:// URL，opencode 识别 file:// 前缀后直接 import
  const providerFileUrl = new URL('./provider.ts', import.meta.url).href

  return {
    async config(config) {
      config.provider = config.provider ?? {}
      const existing = config.provider.qoder ?? {}

      // 将 QODER_MODELS 转换为 opencode provider models 格式
      const builtinModels: Record<string, object> = {}
      for (const [key, m] of Object.entries(QODER_MODELS)) {
        builtinModels[key] = {
          name: m.name,
          attachment: m.attachment,
          reasoning: m.reasoning,
          temperature: m.temperature,
          tool_call: m.tool_call,
          // cost 配置用于 opencode 的费用追踪（虽然目前有 bug，但配置是正确的）
          cost: m.cost,
          // limit 配置用于 opencode 的上下文管理和自动压缩
          limit: m.limit,
          // opencode 通过 modalities.input 判断是否支持图片输入（attachment 字段不参与此判断）
          modalities: {
            input: m.attachment ? ['text', 'image'] : ['text'],
            output: ['text'],
          },
        }
      }

      // 用户在 opencode.json 里覆写的 models 优先级更高
      const mergedModels = { ...builtinModels, ...(existing.models ?? {}) }

      // 将 opencode config.mcp 服务器配置桥接到 Qoder SDK query() mcpServers
      // normalizeMcpServerConfig 的格式转换已内联在 mcp-bridge 中，这里直接转换
      const bridgedMcp = convertOpencodeMcp(config.mcp)
      setMcpBridgeServers(bridgedMcp)

      // 检测可用的 agent 类型：oh-my-opencode-slim 等插件会替换标准 agent 类型
      // 此处从插件配置中提取实际可用的类型，供 normalizeToolInputObject 做映射
      const detectedAgentTypes = detectAgentTypes(config)
      if (detectedAgentTypes.length > 0) {
        setAvailableAgentTypes(detectedAgentTypes)
      }

      const mergedProviderOptions = {
        ...(existing.options ?? {}),
        ...(Object.keys(bridgedMcp).length > 0
          ? {
              mcpServers: {
                ...(((existing.options as Record<string, unknown> | undefined)?.mcpServers as Record<string, unknown> | undefined) ?? {}),
                ...bridgedMcp,
              },
            }
          : {}),
      }

      config.provider.qoder = {
        ...existing,
        // opencode 用 npm 字段来加载 SDK：file:// 开头则直接 import，否则 BunProc.install()
        npm: existing.npm ?? providerFileUrl,
        name: existing.name ?? 'Qoder',
        options: mergedProviderOptions,
        models: mergedModels,
      }
    },

    auth: {
      provider: 'qoder',

      // loader：检查本地登录态，已登录则静默通过，无需用户输入任何东西
      async loader(getAuth) {
        // 优先检查 QoderWork 登录（~/.qoderwork），回退到 Qoder CLI（~/.qoder）
        const authFiles = [
          join(homedir(), '.qoderwork', '.auth', 'user'),
          join(homedir(), '.qoder', '.auth', 'user'),
        ]
        if (authFiles.some(existsSync)) {
          // 已登录，返回空 options 即可，SDK 会自动读取认证文件
          return {}
        }
        // 未登录，返回空对象让 opencode 触发 auth UI
        return {}
      },

      methods: [
        {
          type: 'api',
          // label 作为 opencode auth UI 里的提示文案
          label: 'Open QoderWork and log in, or run `qoder login` in your terminal',
          // 没有需要用户填写的字段
          prompts: [],
          async authorize() {
            const authFiles = [
              join(homedir(), '.qoderwork', '.auth', 'user'),
              join(homedir(), '.qoder', '.auth', 'user'),
            ]
            if (authFiles.some(existsSync)) {
              // 已经完成登录，标记为成功
              return { type: 'success', key: 'qoder-cli-auth' }
            }
            // 未登录，提示用户登录
            return { type: 'failed' }
          },
        },
      ],
    },
  } satisfies Hooks
}

export default QoderProviderPlugin

// ── opencode config.mcp → Qoder SDK mcpServers 格式转换 ──────────────────────

type QoderMcpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }

function convertOpencodeMcp(
  mcp: Record<string, unknown> | undefined,
): Record<string, QoderMcpServerConfig> {
  if (!mcp || typeof mcp !== 'object') return {}
  const result: Record<string, QoderMcpServerConfig> = {}
  for (const [name, raw] of Object.entries(mcp)) {
    const cfg = convertOneMcpEntry(raw)
    if (cfg) result[name] = cfg
  }
  return result
}

function convertOneMcpEntry(raw: unknown): QoderMcpServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const cfg = raw as Record<string, unknown>
  if (cfg.enabled === false) return null

  // stdio / local：command 是数组或字符串
  if (Array.isArray(cfg.command) && cfg.command.every((v) => typeof v === 'string')) {
    if (cfg.command.length === 0) return null
    const [command, ...args] = cfg.command as string[]
    const env = pickStringRecord(cfg.environment) ?? pickStringRecord(cfg.env)
    return { type: 'stdio', command, ...(args.length > 0 ? { args } : {}), ...(env ? { env } : {}) }
  }
  if (typeof cfg.command === 'string') {
    const args = pickStringArray(cfg.args)
    const env = pickStringRecord(cfg.environment) ?? pickStringRecord(cfg.env)
    return {
      type: 'stdio',
      command: cfg.command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
    }
  }

  // remote / http
  const url = typeof cfg.url === 'string' ? cfg.url : undefined
  if (url) {
    const headers = pickStringRecord(cfg.headers)
    return {
      type: cfg.type === 'sse' ? 'sse' : 'http',
      url,
      ...(headers ? { headers } : {}),
    }
  }

  return null
}

function pickStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined
}

function pickStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value as object).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

// ── agent type 检测 ──────────────────────────────────────────────────────────

/**
 * 从 opencode config 和 oh-my-opencode-slim 配置中检测可用的 agent 类型。
 *
 * 检测优先级：
 * 1. config.agent 中非 disabled 的自定义 agent
 * 2. oh-my-opencode-slim 配置文件中活跃 preset 的 agent 类型
 */
function detectAgentTypes(config: Record<string, unknown>): string[] {
  // 方案 1：从 config.agent 读取（oh-my-opencode-slim 可能在此注入）
  const agentConfig = config.agent
  if (agentConfig && typeof agentConfig === 'object' && !Array.isArray(agentConfig)) {
    const types = Object.entries(agentConfig as Record<string, unknown>)
      .filter(([, v]) => {
        if (!v || typeof v !== 'object') return false
        return (v as Record<string, unknown>).disable !== true
      })
      .map(([k]) => k)
    if (types.length > 0) return types
  }

  // 方案 2：直接读取 oh-my-opencode-slim 配置文件
  return detectOhMyOpencodeSlimTypes(config)
}

/**
 * 从 oh-my-opencode-slim 配置文件中检测 agent 类型
 */
function detectOhMyOpencodeSlimTypes(config: Record<string, unknown>): string[] {
  // 检查 plugin 列表中是否包含 oh-my-opencode-slim
  const plugins = Array.isArray(config.plugin) ? config.plugin : []
  const hasOMS = plugins.some((p) =>
    typeof p === 'string' && (p.includes('oh-my-opencode-slim') || p.includes('oh-my-opencode')),
  )
  if (!hasOMS) return []

  // 尝试读取配置文件
  const configPaths = [
    join(homedir(), '.config', 'opencode', 'oh-my-opencode-slim.jsonc'),
    join(homedir(), '.config', 'opencode', 'oh-my-opencode-slim.json'),
    join(homedir(), '.config', 'opencode', 'oh-my-opencode.jsonc'),
    join(homedir(), '.config', 'opencode', 'oh-my-opencode.json'),
  ]

  for (const cfgPath of configPaths) {
    try {
      if (!existsSync(cfgPath)) continue
      const raw = readFileSync(cfgPath, 'utf8')
      // 简单处理 JSONC：去掉行注释和块注释
      const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      const parsed = JSON.parse(cleaned) as Record<string, unknown>

      const preset = typeof parsed.preset === 'string' ? parsed.preset : undefined
      const presets = parsed.presets as Record<string, unknown> | undefined
      if (!preset || !presets) continue

      const activePreset = presets[preset]
      if (!activePreset || typeof activePreset !== 'object') continue

      return Object.keys(activePreset as Record<string, unknown>)
    } catch { /* ignore parse errors */ }
  }

  return []
}
