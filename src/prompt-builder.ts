import type { LanguageModelV2CallOptions, LanguageModelV2Prompt, LanguageModelV2Message } from '@ai-sdk/provider'
import type { SDKUserMessage } from './vendor/qoder-agent-sdk.mjs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, resolve } from 'node:path'

const DEFAULT_CONTEXT_LIMIT = 180000
const APPROX_CHARS_PER_TOKEN = 4
const PROMPT_CONTEXT_BUDGET_RATIO = 0.7

// ── 上下文优化：减少历史注入的 token 损耗 ──────────────────────────────────────
// 工具输出截断阈值（chars）：超过此长度的工具结果会被截断，避免单条工具输出占用过多上下文
const TOOL_OUTPUT_TRUNCATE_THRESHOLD = 8000
// 历史压缩：早期轮次（距当前 > RECENT_HISTORY_MSG_COUNT 条消息）使用紧凑序列化
const RECENT_HISTORY_MSG_COUNT = 8
const COMPACT_TEXT_MAX_CHARS = 500
const COMPACT_TOOL_INPUT_MAX_CHARS = 200
const COMPACT_TOOL_OUTPUT_MAX_CHARS = 500

/** 超出 maxChars 的文本截断，附加原始长度提示 */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + `\n...[truncated, ${text.length} chars total]`
}

/**
 * 从 opencode 传入的 LanguageModelV2CallOptions 中构造 Qoder query 的 prompt。
 *
 * opencode 传入的 prompt 格式为 Vercel AI SDK v2 的 LanguageModelV2Prompt，
 * 包含若干 role=system / user / assistant / tool 的消息。
 *
 * - 纯文本模式：返回字符串（序列化完整对话历史，含 tool-call/tool-result）
 * - 含图片模式：返回 AsyncIterable<SDKUserMessage>（支持 base64 图片块，含完整历史）
 */
export function buildPromptFromOptions(
  options: LanguageModelV2CallOptions,
  sessionId?: string,
): string | AsyncIterable<SDKUserMessage> {
  if (hasImageContent(options.prompt)) {
    return buildAsyncIterablePrompt(options.prompt, sessionId)
  }
  return buildStringPrompt(options.prompt)
}

/**
 * 将本地文件路径字符串（含 `~/...`、绝对路径）或 `file://` URL 读取为 base64 字符串。
 * 若读取失败返回 null（防御性处理，不抛出）。
 */
function readLocalFileAsBase64(pathOrUrl: string): string | null {
  try {
    let filePath: string
    if (pathOrUrl.startsWith('file://')) {
      // file:// URL → 去掉协议前缀得到系统路径
      filePath = decodeURIComponent(new URL(pathOrUrl).pathname)
    } else if (pathOrUrl.startsWith('~/')) {
      // ~/... 风格相对于 home 目录的路径
      filePath = resolve(homedir(), pathOrUrl.slice(2))
    } else {
      // 普通绝对/相对路径
      filePath = resolve(pathOrUrl)
    }
    const buf = readFileSync(filePath)
    return buf.toString('base64')
  } catch {
    return null
  }
}

/**
 * 按文件扩展名推断图片 MIME 类型，默认 image/jpeg。
 * 仅用于无法从 part 取到 mediaType/mimeType 时的回退推断。
 */
function inferMediaTypeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  return map[ext] ?? 'image/jpeg'
}

/** 判断 prompt 中是否含有图片内容（只检测最后一条 user 消息，历史轮次不触发多模态路径） */
function hasImageContent(prompt: LanguageModelV2Prompt): boolean {
  // 找到最后一条 user 消息
  let lastUserMsg: LanguageModelV2Message | null = null
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i].role === 'user') { lastUserMsg = prompt[i]; break }
  }
  if (!lastUserMsg || !Array.isArray(lastUserMsg.content)) return false
  for (const part of lastUserMsg.content) {
    if (part.type === 'image') return true
    if (part.type === 'file' && typeof part.mediaType === 'string' && part.mediaType.startsWith('image/')) return true
  }
  return false
}

/** 序列化工具输出为字符串，超出 maxChars 则截断 */
function serializeToolOutput(output: unknown, maxChars: number = TOOL_OUTPUT_TRUNCATE_THRESHOLD): string {
  if (output == null) return ''
  let result: string
  if (typeof output === 'string') {
    result = output
  } else {
    result = serializeStructuredToolOutput(output)
  }
  return truncateText(result, maxChars)
}

function serializeStructuredToolOutput(output: unknown): string {
  if (!Array.isArray(output)) return JSON.stringify(output, null, 2)

  const parts: string[] = []
  for (const item of output) {
    if (item && typeof item === 'object' && 'type' in item) {
      if (item.type === 'text' && 'value' in item) {
        parts.push(`<tool_output type="text">\n${String((item as { value: unknown }).value)}\n</tool_output>`)
        continue
      }
      if (item.type === 'json' && 'value' in item) {
        parts.push(`<tool_output type="json">\n${JSON.stringify((item as { value: unknown }).value, null, 2)}\n</tool_output>`)
        continue
      }
      if (item.type === 'error-text' && 'value' in item) {
        parts.push(`<tool_output type="error">\n[Error] ${String((item as { value: unknown }).value)}\n</tool_output>`)
        continue
      }
    }
    parts.push(`<tool_output type="raw-json">\n${JSON.stringify(item, null, 2)}\n</tool_output>`)
  }

  return parts.join('\n')
}

function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
}

function trimPromptToBudget(prompt: LanguageModelV2Prompt): LanguageModelV2Prompt {
  const budget = Math.floor(DEFAULT_CONTEXT_LIMIT * PROMPT_CONTEXT_BUDGET_RATIO)
  if (prompt.length <= 1) return prompt

  const working = [...prompt]
  let truncatedCount = 0

  const buildCandidate = (candidate: LanguageModelV2Prompt) => buildStringPrompt(candidate, { truncate: false })

  while (working.length > 1 && approximateTokenCount(buildCandidate(working)) > budget) {
    const dropIdx = working.findIndex((msg) => msg.role !== 'system')
    if (dropIdx === -1) break
    working.splice(dropIdx, 1)
    truncatedCount++
  }

  if (truncatedCount === 0) return working

  const marker: LanguageModelV2Message = {
    role: 'system',
    content: `<truncated_history count="${truncatedCount}" />`,
  }

  const insertAt = working.findLastIndex((msg) => msg.role === 'system') + 1
  working.splice(insertAt, 0, marker)
  return working
}

/**
 * 将单条消息序列化为结构化文本块，保留完整对话历史。
 *
 * 格式设计原则：
 * - system 消息用 <system> 标签包裹
 * - user 消息直接输出文本内容
 * - assistant 消息用 <assistant> 标签，含工具调用时附加 <tool_call> 子块
 * - tool 消息（工具结果）用 <tool_result> 标签，含调用 ID 和工具名
 *
 * compact 模式（用于早期历史消息）：截断 assistant 文本、tool-call 输入和 tool-result 输出，
 * 保留结构信息但减少 token 占用。user 和 system 始终保持完整。
 */
function serializeMessage(message: LanguageModelV2Message, options?: { compact?: boolean }): string {
  const compact = options?.compact ?? false

  switch (message.role) {
    case 'system': {
      if (typeof message.content === 'string') {
        return `<system>\n${message.content}\n</system>`
      }
      return ''
    }

    case 'user': {
      if (!Array.isArray(message.content)) return ''
      const parts: string[] = []
      for (const part of message.content) {
        if (part.type === 'text') {
          parts.push(part.text)
        } else if (part.type === 'image') {
          // 历史序列化时保留图片占位，让模型知道此轮有图片附件
          const mediaType = (part as { mimeType?: string }).mimeType ?? 'image'
          parts.push(`[Image attached: ${mediaType}]`)
        } else if (part.type === 'file' && typeof (part as { mediaType?: string }).mediaType === 'string' && ((part as { mediaType: string }).mediaType).startsWith('image/')) {
          // file part 图片类型（含剪贴板/--file 等来源），同样注入占位
          parts.push(`[Image attached: ${(part as { mediaType: string }).mediaType}]`)
        }
      }
      return parts.join('\n')
    }

    case 'assistant': {
      if (!Array.isArray(message.content)) return ''
      const parts: string[] = []
      for (const part of message.content) {
        if (part.type === 'text' && part.text) {
          parts.push(compact ? truncateText(part.text, COMPACT_TEXT_MAX_CHARS) : part.text)
        } else if (part.type === 'tool-call') {
          const inputStr = typeof part.input === 'string'
            ? part.input
            : JSON.stringify(part.input ?? {})
          const effectiveInput = compact ? truncateText(inputStr, COMPACT_TOOL_INPUT_MAX_CHARS) : inputStr
          parts.push(
            `<tool_call id="${part.toolCallId}" name="${part.toolName}">\n${effectiveInput}\n</tool_call>`,
          )
        }
      }
      if (parts.length === 0) return ''
      return `<assistant>\n${parts.join('\n')}\n</assistant>`
    }

    case 'tool': {
      if (!Array.isArray(message.content)) return ''
      const parts: string[] = []
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          const maxChars = compact ? COMPACT_TOOL_OUTPUT_MAX_CHARS : TOOL_OUTPUT_TRUNCATE_THRESHOLD
          const outputStr = serializeToolOutput(part.output, maxChars)
          parts.push(
            `<tool_result id="${part.toolCallId}" name="${part.toolName}">\n${outputStr}\n</tool_result>`,
          )
        }
      }
      return parts.join('\n')
    }

    default:
      return ''
  }
}

/** 纯文本模式：将完整对话历史序列化为结构化字符串 */
export function buildStringPrompt(
  prompt: LanguageModelV2Prompt,
  options: { truncate?: boolean } = {},
): string {
  const effectivePrompt = options.truncate !== false ? trimPromptToBudget(prompt) : prompt

  // 找到最后一条 user 消息的位置
  let lastUserIdx = -1
  for (let i = effectivePrompt.length - 1; i >= 0; i--) {
    if (effectivePrompt[i].role === 'user') { lastUserIdx = i; break }
  }

  if (lastUserIdx === -1) return 'Hello'

  // 历史压缩：早期消息用紧凑序列化，最近 RECENT_HISTORY_MSG_COUNT 条保持完整
  const recentStartIdx = Math.max(0, lastUserIdx - RECENT_HISTORY_MSG_COUNT)

  // 将最后一条 user 消息之前的历史序列化
  const historyParts = serializePromptRange(effectivePrompt, 0, lastUserIdx, { recentStartIdx })

  // 当前任务：最后一条 user 消息
  const currentMsg = serializeMessage(effectivePrompt[lastUserIdx])

  // 最后一条 user 之后可能还有 assistant/tool 消息（如 tool-call/tool-result），
  // 它们属于已发生的后续上下文，需按原始顺序保留，不能丢弃。
  const trailingParts = serializePromptRange(effectivePrompt, lastUserIdx + 1, effectivePrompt.length)

  if (historyParts.length > 0) {
    const segments = [
      `<conversation_history>\n${historyParts.join('\n\n')}\n</conversation_history>`,
      currentMsg,
    ]
    if (trailingParts.length > 0) {
      segments.push(`<conversation_continuation>\n${trailingParts.join('\n\n')}\n</conversation_continuation>`)
    }
    return segments.filter(Boolean).join('\n\n')
  }
  if (trailingParts.length > 0) {
    return [
      currentMsg,
      `<conversation_continuation>\n${trailingParts.join('\n\n')}\n</conversation_continuation>`,
    ].filter(Boolean).join('\n\n')
  }
  return currentMsg || 'Hello'
}

/** 多模态模式：将完整消息历史转为 AsyncIterable<SDKUserMessage>（含图片） */
async function* buildAsyncIterablePrompt(
  prompt: LanguageModelV2Prompt,
  sessionId?: string,
): AsyncIterable<SDKUserMessage> {
  const effectivePrompt = trimPromptToBudget(prompt)

  // 只产出最后一条 user 消息，避免 SDK 因多条用户消息而在第一条 result 后终止。
  // 历史（最后一条 user 消息之前的所有消息）序列化后作为 <conversation_history> 前缀注入。
  let lastUserIdx = -1
  for (let i = effectivePrompt.length - 1; i >= 0; i--) {
    if (effectivePrompt[i].role === 'user') { lastUserIdx = i; break }
  }
  if (lastUserIdx === -1) return

  // 历史压缩：早期消息用紧凑序列化，最近 RECENT_HISTORY_MSG_COUNT 条保持完整
  const recentStartIdx = Math.max(0, lastUserIdx - RECENT_HISTORY_MSG_COUNT)

  // 构建历史前缀（最后一条 user 之前的消息）
  const historyParts = serializePromptRange(effectivePrompt, 0, lastUserIdx, { recentStartIdx })

  // 最后一条 user 之后可能还有 assistant/tool 消息（如 tool-call/tool-result），
  // 它们属于已发生的后续上下文，需按原始顺序保留，不能丢弃。
  const trailingParts = serializePromptRange(effectivePrompt, lastUserIdx + 1, effectivePrompt.length)

  const contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  > = []

  // 注入历史前缀
  if (historyParts.length > 0) {
    contentBlocks.push({
      type: 'text',
      text: `<conversation_history>\n${historyParts.join('\n\n')}\n</conversation_history>`,
    })
  }

  // 处理最后一条 user 消息的内容块
  const lastMsg = effectivePrompt[lastUserIdx]
  if (lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
    for (const part of lastMsg.content) {
      if (part.type === 'text') {
        contentBlocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'image') {
        const { image } = part
        // AI SDK v2 image 可能是 URL 对象、Uint8Array 或字符串（base64 / data URL / 本地路径）
        if (image instanceof Uint8Array) {
          // 二进制数据，转 base64
          const base64 = Buffer.from(image).toString('base64')
          const mediaType = part.mimeType ?? 'image/jpeg'
          contentBlocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          })
        } else if (image instanceof URL) {
          if (image.protocol === 'file:') {
            // file: URL 对象 → 读取本地文件
            const filePath = decodeURIComponent(image.pathname)
            const base64 = readLocalFileAsBase64(image.toString())
            if (base64 !== null) {
              const mediaType = part.mimeType ?? inferMediaTypeFromPath(filePath)
              contentBlocks.push({
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 },
              })
            }
            // 其他协议（http/https）不支持，跳过
          }
        } else if (typeof image === 'string') {
          // base64 data URL: "data:image/png;base64,..."
          const dataUrlMatch = image.match(/^data:([^;]+);base64,(.+)$/)
          if (dataUrlMatch) {
            contentBlocks.push({
              type: 'image',
              source: { type: 'base64', media_type: dataUrlMatch[1], data: dataUrlMatch[2] },
            })
          } else if (image.startsWith('file://') || image.startsWith('/') || image.startsWith('~/')) {
            // 本地路径字符串（含 file:// URL 字符串、绝对路径、~/... 路径）
            const base64 = readLocalFileAsBase64(image)
            if (base64 !== null) {
              const pathForInfer = image.startsWith('file://') ? decodeURIComponent(new URL(image).pathname) : image
              const mediaType = part.mimeType ?? inferMediaTypeFromPath(pathForInfer)
              contentBlocks.push({
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 },
              })
            }
          } else {
            // 裸 base64 字符串，假设 JPEG
            contentBlocks.push({
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: image },
            })
          }
        }
      } else if (part.type === 'file' && typeof part.mediaType === 'string' && part.mediaType.startsWith('image/')) {
        // clipboard / --file 图片，AI SDK v2 以 type='file' 传入
        const { data, mediaType } = part
        let base64Data: string
        let resolvedMediaType = mediaType
        if (data instanceof Uint8Array) {
          base64Data = Buffer.from(data).toString('base64')
        } else if (typeof data === 'string') {
          const dataUrlMatch = data.match(/^data:([^;]+);base64,(.+)$/)
          if (dataUrlMatch) {
            resolvedMediaType = dataUrlMatch[1]
            base64Data = dataUrlMatch[2]
          } else if (data.startsWith('file://') || data.startsWith('/') || data.startsWith('~/')) {
            // 本地路径字符串（含 file:// URL 字符串、绝对路径、~/... 路径）
            const base64 = readLocalFileAsBase64(data)
            if (base64 === null) continue
            base64Data = base64
            // mediaType 优先用 part.mediaType，没有时按扩展名推断
            if (!resolvedMediaType || !resolvedMediaType.startsWith('image/')) {
              const pathForInfer = data.startsWith('file://') ? decodeURIComponent(new URL(data).pathname) : data
              resolvedMediaType = inferMediaTypeFromPath(pathForInfer)
            }
          } else {
            // 裸 base64 字符串
            base64Data = data
          }
        } else {
          // URL 对象（data URL 或 file: URL）
          const urlStr = (data as URL).toString()
          const dataUrlMatch = urlStr.match(/^data:([^;]+);base64,(.+)$/)
          if (dataUrlMatch) {
            resolvedMediaType = dataUrlMatch[1]
            base64Data = dataUrlMatch[2]
          } else if ((data as URL).protocol === 'file:') {
            // file: URL 对象 → 读取本地文件
            const base64 = readLocalFileAsBase64(urlStr)
            if (base64 === null) continue
            base64Data = base64
            if (!resolvedMediaType || !resolvedMediaType.startsWith('image/')) {
              const filePath = decodeURIComponent((data as URL).pathname)
              resolvedMediaType = inferMediaTypeFromPath(filePath)
            }
          } else {
            continue // HTTP/HTTPS URL 暂不支持
          }
        }
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: resolvedMediaType, data: base64Data },
        })
      }
    }
  }

  if (trailingParts.length > 0) {
    contentBlocks.push({
      type: 'text',
      text: `<conversation_continuation>\n${trailingParts.join('\n\n')}\n</conversation_continuation>`,
    })
  }

  if (contentBlocks.length > 0) {
    yield {
      type: 'user',
      session_id: sessionId ?? 'default',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: contentBlocks,
      },
    } as SDKUserMessage
  }
}

function serializePromptRange(
  prompt: LanguageModelV2Prompt,
  start: number,
  end: number,
  options?: { recentStartIdx?: number },
): string[] {
  const parts: string[] = []
  const recentStart = options?.recentStartIdx ?? end
  for (let i = start; i < end; i++) {
    const compact = i < recentStart
    const serialized = serializeMessage(prompt[i], { compact })
    if (serialized) parts.push(serialized)
  }
  return parts
}
