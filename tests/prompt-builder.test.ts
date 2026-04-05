// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { buildPromptFromOptions } from '../src/prompt-builder.js'

const BASE_OPTIONS = { inputFormat: 'prompt', mode: { type: 'regular' } }

describe('buildPromptFromOptions', () => {
  it('纯文本 prompt 返回字符串', () => {
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })

    expect(typeof prompt).toBe('string')
    expect(prompt).toContain('hello')
  })

  it('空 prompt 返回 Hello', () => {
    const prompt = buildPromptFromOptions({ ...BASE_OPTIONS, prompt: [] })
    expect(prompt).toBe('Hello')
  })

  it('system 消息用 <system> 标签包裹', () => {
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    }) as string

    expect(prompt).toContain('<system>')
    expect(prompt).toContain('You are helpful.')
    expect(prompt).toContain('</system>')
    expect(prompt).toContain('hi')
  })

  it('assistant 消息用 <assistant> 标签包裹', () => {
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
        { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
      ],
    }) as string

    expect(prompt).toContain('<assistant>')
    expect(prompt).toContain('world')
    expect(prompt).toContain('</assistant>')
    expect(prompt).toContain('follow-up')
  })

  it('assistant tool-call 用 <tool_call> 子块序列化', () => {
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'list files' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tc-1',
              toolName: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tc-1',
              toolName: 'Bash',
              output: [{ type: 'text', value: 'file.txt\ndir/' }],
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'what did you find?' }] },
      ],
    }) as string

    expect(prompt).toContain('<tool_call id="tc-1" name="Bash">')
    expect(prompt).toContain('"command":"ls"')
    expect(prompt).toContain('</tool_call>')
    expect(prompt).toContain('<tool_result id="tc-1" name="Bash">')
    expect(prompt).toContain('file.txt')
    expect(prompt).toContain('</tool_result>')
    expect(prompt).toContain('what did you find?')
  })

  it('tool 消息 error-text output 格式化为 [Error] 前缀', () => {
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tc-2',
              toolName: 'Read',
              output: [{ type: 'error-text', value: 'file not found' }],
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'ok' }] },
      ],
    }) as string

    expect(prompt).toContain('[Error] file not found')
  })

  it('tool 消息保留结构化 tool_output 标签，避免结果语义丢失', () => {
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tc-struct-1',
              toolName: 'Read',
              output: [
                { type: 'text', value: 'line 1\nline 2' },
                { type: 'json', value: { filePath: '/tmp/a.ts', lines: 2 } },
              ],
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: '继续' }] },
      ],
    }) as string

    expect(prompt).toContain('<tool_output type="text">')
    expect(prompt).toContain('line 1')
    expect(prompt).toContain('<tool_output type="json">')
    expect(prompt).toContain('"filePath": "/tmp/a.ts"')
  })

  it('图片 prompt 返回 AsyncIterable，并产出 image content block', async () => {
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
              mimeType: 'image/png',
            },
            { type: 'text', text: 'describe this image' },
          ],
        },
      ],
    })

    expect(typeof prompt).not.toBe('string')

    const messages: unknown[] = []
    for await (const message of prompt as AsyncIterable<unknown>) {
      messages.push(message)
    }

    expect(messages).toHaveLength(1)
    expect(messages[0].message.content).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
        },
      },
      { type: 'text', text: 'describe this image' },
    ])
  })

  // === TDD: clipboard image fix (type='file' parts) ===

  it('file part (image mediaType) 触发 AsyncIterable 路径', () => {
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [{
          type: 'file',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe',
          mediaType: 'image/png',
        }],
      }],
    })
    expect(typeof result).not.toBe('string')
  })

  it('file part 裸 base64 data → image content block', async () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [
          { type: 'file', data: b64, mediaType: 'image/png' },
          { type: 'text', text: 'describe this' },
        ],
      }],
    })
    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) messages.push(msg)
    expect((messages[0] as any).message.content).toContainEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: b64 },
    })
  })

  it('file part data: URL → 正确提取 base64', async () => {
    const b64 = 'abc123=='
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [{ type: 'file', data: `data:image/png;base64,${b64}`, mediaType: 'image/png' }],
      }],
    })
    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) messages.push(msg)
    expect((messages[0] as any).message.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: b64 },
    })
  })

  it('file part Uint8Array → 转换为 base64', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [{ type: 'file', data: bytes, mediaType: 'image/png' }],
      }],
    })
    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) messages.push(msg)
    const block = (messages[0] as any).message.content[0]
    expect(block.type).toBe('image')
    expect(block.source.type).toBe('base64')
    expect(block.source.media_type).toBe('image/png')
    expect(block.source.data).toBe(Buffer.from(bytes).toString('base64'))
  })

  it('file part 非图片 mediaType 不触发图片路径', () => {
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [{ type: 'file', data: 'aGVsbG8=', mediaType: 'text/plain' }],
      }],
    })
    expect(typeof result).toBe('string')
  })

  it('多模态模式：只产出最后一条 user 消息，完整历史注入为 <conversation_history> 前缀', async () => {
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: [{ type: 'text', text: 'first question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: 'data:image/png;base64,abc123==',
              mimeType: 'image/png',
            },
            { type: 'text', text: 'second question' },
          ],
        },
      ],
    })

    expect(typeof prompt).not.toBe('string')

    const messages: unknown[] = []
    for await (const message of prompt as AsyncIterable<unknown>) {
      messages.push(message)
    }

    // 修复后：只产出 1 条 SDKUserMessage（最后一条 user 消息），而非多条
    expect(messages).toHaveLength(1)

    const content = (messages[0] as any).message.content
    // 第一块：包含全量历史（system + first question + first answer）的 <conversation_history>
    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('<conversation_history>')
    expect(content[0].text).toContain('<system>')
    expect(content[0].text).toContain('You are helpful.')
    expect(content[0].text).toContain('first question')
    expect(content[0].text).toContain('first answer')
    // 第二块：图片
    expect(content[1].type).toBe('image')
    // 第三块：当前问题文本
    expect(content[2].text).toBe('second question')
  })

  it('超长历史会截断并写入 <truncated_history> 标记', () => {
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        { role: 'system', content: 'You are helpful.' },
        ...Array.from({ length: 120 }, (_, idx) => ({
          role: idx % 2 === 0 ? 'user' : 'assistant',
          content: idx % 2 === 0
            ? [{ type: 'text', text: `history-user-${idx}-${'x'.repeat(12000)}` }]
            : [{ type: 'text', text: `history-assistant-${idx}-${'y'.repeat(12000)}` }],
        })),
        { role: 'user', content: [{ type: 'text', text: 'latest question' }] },
      ],
    }) as string

    expect(prompt).toContain('<truncated_history count="')
    expect(prompt).toContain('latest question')
    expect(prompt).not.toContain('history-user-0-')
  })

  // === 上下文优化：compact 模式和工具输出截断 ===

  it('早期历史中 assistant 文本被 compact 截断，最近历史保持完整', () => {
    // 构造 15 条消息（超过 RECENT_HISTORY_MSG_COUNT=8），验证早期 assistant 被截断
    const longText = 'A'.repeat(2000)
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        // 早期轮次（应被 compact 截断）
        { role: 'user', content: [{ type: 'text', text: 'round 1' }] },
        { role: 'assistant', content: [{ type: 'text', text: `early-answer-${longText}` }] },
        { role: 'user', content: [{ type: 'text', text: 'round 2' }] },
        { role: 'assistant', content: [{ type: 'text', text: `early-answer-${longText}` }] },
        { role: 'user', content: [{ type: 'text', text: 'round 3' }] },
        { role: 'assistant', content: [{ type: 'text', text: `early-answer-${longText}` }] },
        // 最近轮次（应保持完整，距离 lastUserIdx 在 RECENT_HISTORY_MSG_COUNT 内）
        { role: 'user', content: [{ type: 'text', text: 'round 4' }] },
        { role: 'assistant', content: [{ type: 'text', text: `recent-answer-${longText}` }] },
        { role: 'user', content: [{ type: 'text', text: 'round 5' }] },
        { role: 'assistant', content: [{ type: 'text', text: `recent-answer-${longText}` }] },
        { role: 'user', content: [{ type: 'text', text: 'round 6' }] },
        { role: 'assistant', content: [{ type: 'text', text: `recent-answer-${longText}` }] },
        // 当前任务
        { role: 'user', content: [{ type: 'text', text: 'current question' }] },
      ],
    }) as string

    // 早期 assistant 应被截断（包含 truncated 标记）
    expect(prompt).toContain('early-answer-')
    expect(prompt).toContain('...[truncated,')
    // 最近 assistant 应完整保留（包含完整 2000 字符的 A）
    const recentAnswerIdx = prompt.lastIndexOf('recent-answer-')
    const recentAnswerEnd = prompt.indexOf('</assistant>', recentAnswerIdx)
    const recentBlock = prompt.slice(recentAnswerIdx, recentAnswerEnd)
    expect(recentBlock).toContain(longText)
    // 当前问题在历史之后
    expect(prompt).toContain('current question')
    // user 消息始终完整（不被 compact 截断）
    expect(prompt).toContain('round 1')
    expect(prompt).toContain('round 6')
  })

  it('早期历史中 tool-call 输入被 compact 截断', () => {
    const longInput = JSON.stringify({ command: 'x'.repeat(1000) })
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        // 早期轮次（距离 lastUserIdx > 8 条消息）
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: 'tc-compact-1',
            toolName: 'Bash',
            input: longInput,
          }],
        },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'tc-compact-1',
            toolName: 'Bash',
            output: [{ type: 'text', value: 'ok' }],
          }],
        },
        // 填充，确保上面的消息在 compact 区
        { role: 'user', content: [{ type: 'text', text: 'filler 1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'filler' }] },
        { role: 'user', content: [{ type: 'text', text: 'filler 2' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'filler' }] },
        { role: 'user', content: [{ type: 'text', text: 'filler 3' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'filler' }] },
        { role: 'user', content: [{ type: 'text', text: 'filler 4' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'filler' }] },
        // 当前任务
        { role: 'user', content: [{ type: 'text', text: 'current' }] },
      ],
    }) as string

    // tool-call 结构保留，但输入应被截断
    expect(prompt).toContain('<tool_call id="tc-compact-1" name="Bash">')
    expect(prompt).toContain('...[truncated,')
    // 不应包含完整的 1000 个 x
    expect(prompt).not.toContain('x'.repeat(1000))
  })

  it('工具输出超过截断阈值时被截断（非 compact 模式）', () => {
    const hugeOutput = 'Z'.repeat(10000)
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'read file' }] },
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: 'tc-trunc-1',
            toolName: 'Read',
            input: { filePath: '/tmp/big.txt' },
          }],
        },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'tc-trunc-1',
            toolName: 'Read',
            output: hugeOutput,
          }],
        },
        { role: 'user', content: [{ type: 'text', text: 'summarize' }] },
      ],
    }) as string

    // 输出应被截断（10000 > 8000 阈值）
    expect(prompt).toContain('...[truncated, 10000 chars total]')
    // 不应包含完整的 10000 个 Z
    expect(prompt).not.toContain(hugeOutput)
    // 结构保留
    expect(prompt).toContain('<tool_result id="tc-trunc-1" name="Read">')
  })

  it('短历史（< RECENT_HISTORY_MSG_COUNT）不触发 compact 截断', () => {
    const text = 'B'.repeat(2000)
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        { role: 'assistant', content: [{ type: 'text', text: `answer-${text}` }] },
        { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      ],
    }) as string

    // 只有 2 条历史消息（< 8），不应触发 compact
    expect(prompt).toContain(`answer-${text}`)
    expect(prompt).not.toContain('...[truncated,')
  })

  // === 回归测试：最后一条 user 之后的 assistant/tool 消息不应被丢弃 ===

  it('[回归] 纯文本路径：最后一条 user 后的 tool-call/tool-result 应保留在历史中', () => {
    // 场景：user 发起请求 → assistant 发起 tool-call → tool 返回结果
    // 此时模型被再次调用，prompt 末尾是 tool 消息而非 user 消息，
    // 但最后一条 user 消息之后的 assistant/tool 不应被丢弃。
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'list files please' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tc-reg-1',
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
              toolCallId: 'tc-reg-1',
              toolName: 'Bash',
              output: [{ type: 'text', value: 'a.txt\nb.txt' }],
            },
          ],
        },
        // 注意：此处没有再追加新的 user 消息，最后一条 user 是 "list files please"
      ],
    }) as string

    // 最后一条 user 消息应作为当前任务
    expect(prompt).toContain('list files please')
    // assistant 的 tool-call 不能被丢弃
    expect(prompt).toContain('<tool_call id="tc-reg-1" name="Bash">')
    expect(prompt).toContain('"command":"ls /tmp"')
    expect(prompt).toContain('</tool_call>')
    // tool-result 不能被丢弃
    expect(prompt).toContain('<tool_result id="tc-reg-1" name="Bash">')
    expect(prompt).toContain('a.txt')
    expect(prompt).toContain('b.txt')
    expect(prompt).toContain('</tool_result>')
    // 后缀消息必须作为 continuation 保留，且顺序在当前 user 之后
    expect(prompt).toContain('<conversation_continuation>')
    const currentMsgPos = prompt.indexOf('list files please')
    const continuationStart = prompt.indexOf('<conversation_continuation>')
    const continuationEnd = prompt.indexOf('</conversation_continuation>')
    const toolCallPos = prompt.indexOf('<tool_call id="tc-reg-1"')
    const toolResultPos = prompt.indexOf('<tool_result id="tc-reg-1"')
    expect(continuationStart).toBeGreaterThan(currentMsgPos)
    expect(toolCallPos).toBeGreaterThan(continuationStart)
    expect(toolCallPos).toBeLessThan(continuationEnd)
    expect(toolResultPos).toBeGreaterThan(continuationStart)
    expect(toolResultPos).toBeLessThan(continuationEnd)
  })

  it('[回归] 多模态路径：带图片的最后 user 后有 tool-call/tool-result，应保留且只产出 1 条 SDKUserMessage', async () => {
    // 场景：多模态对话中，用户上传图片提问后，assistant 调用了工具并拿到结果，
    // 随后模型被再次调用。此时最后一条 user 消息含图片，
    // 其后的 assistant tool-call + tool-result 不应被丢弃，且整体只能产出 1 条 SDKUserMessage。
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        { role: 'system', content: 'You are a vision assistant.' },
        {
          role: 'user',
          content: [
            { type: 'image', image: `data:image/png;base64,${b64}`, mimeType: 'image/png' },
            { type: 'text', text: 'what is in this image?' },
          ],
        },
        // 最后一条 user 之后：assistant 发起 tool-call，tool 返回结果
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tc-mm-1',
              toolName: 'Describe',
              input: { detail: 'high' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tc-mm-1',
              toolName: 'Describe',
              output: [{ type: 'text', value: 'A red circle on white background.' }],
            },
          ],
        },
      ],
    })

    // 必须走 AsyncIterable 路径（因为有图片）
    expect(typeof result).not.toBe('string')

    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) {
      messages.push(msg)
    }

    // 只产出 1 条 SDKUserMessage
    expect(messages).toHaveLength(1)

    const content = (messages[0] as any).message.content as Array<{ type: string; text?: string; source?: unknown }>

    // 第一块：<conversation_history> 文本前缀，包含 system 历史
    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('<conversation_history>')
    expect(content[0].text).toContain('<system>')
    expect(content[0].text).toContain('You are a vision assistant.')

    // 第二块：图片
    expect(content[1].type).toBe('image')
    expect((content[1] as any).source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: b64,
    })

    // 第三块：当前问题文本
    expect(content[2].type).toBe('text')
    expect(content[2].text).toBe('what is in this image?')

    // 第四块：后缀 continuation，保留 tool-call/tool-result，且顺序在当前 user 内容之后
    expect(content[3].type).toBe('text')
    expect(content[3].text).toContain('<conversation_continuation>')
    expect(content[3].text).toContain('<tool_call id="tc-mm-1" name="Describe">')
    expect(content[3].text).toContain('<tool_result id="tc-mm-1" name="Describe">')
    expect(content[3].text).toContain('A red circle on white background.')
  })

  it('buildStringPrompt 多轮对话：历史包在 <conversation_history>，末条 user 消息作为主任务', () => {
    const prompt = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'first question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'second question' }] },
      ],
    }) as string

    // 历史应包在 <conversation_history> 标签中
    expect(prompt).toContain('<conversation_history>')
    expect(prompt).toContain('first question')
    expect(prompt).toContain('<assistant>')
    expect(prompt).toContain('first answer')
    expect(prompt).toContain('</conversation_history>')
    // 末条 user 消息在历史块之外（不重复嵌套）
    const historyEnd = prompt.indexOf('</conversation_history>')
    const secondQuestionPos = prompt.lastIndexOf('second question')
    expect(secondQuestionPos).toBeGreaterThan(historyEnd)
  })

  // === 本地路径 / file:// URL 兼容性测试 ===

  /** 在系统临时目录写一张 1x1 最小 PNG，返回绝对路径 */
  function createTempPng(name: string): string {
    const filePath = join(tmpdir(), name)
    // 最小合法 1x1 PNG（白色像素）
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
      '2e0000000c49444154789c6260f8cfc00000000200016e21bc330000000049454e44ae426082',
      'hex',
    )
    writeFileSync(filePath, pngBytes)
    return filePath
  }

  it('file part 本地绝对路径字符串 → 产出 image content block', async () => {
    const filePath = createTempPng('test-abs-path.png')
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [
          { type: 'file', data: filePath, mediaType: 'image/png' },
          { type: 'text', text: 'what is this?' },
        ],
      }],
    })

    expect(typeof result).not.toBe('string')
    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) messages.push(msg)
    const content = (messages[0] as any).message.content
    const imageBlock = content.find((b: any) => b.type === 'image')
    expect(imageBlock).toBeDefined()
    expect(imageBlock.source.type).toBe('base64')
    expect(imageBlock.source.media_type).toBe('image/png')
    expect(typeof imageBlock.source.data).toBe('string')
    expect(imageBlock.source.data.length).toBeGreaterThan(0)
  })

  it('file part ~/... 风格路径 → 产出 image content block', async () => {
    // 在用户 home 目录的临时子目录写文件，用 ~/... 路径引用
    const subDir = join(homedir(), '.opencode-test-tmp')
    mkdirSync(subDir, { recursive: true })
    const absFilePath = join(subDir, 'test-tilde-path.png')
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
      '2e0000000c49444154789c6260f8cfc00000000200016e21bc330000000049454e44ae426082',
      'hex',
    )
    writeFileSync(absFilePath, pngBytes)
    // 构造 ~/... 形式路径
    const tildePath = '~/.opencode-test-tmp/test-tilde-path.png'

    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [
          { type: 'file', data: tildePath, mediaType: 'image/png' },
          { type: 'text', text: 'tilde path image' },
        ],
      }],
    })

    expect(typeof result).not.toBe('string')
    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) messages.push(msg)
    const content = (messages[0] as any).message.content
    const imageBlock = content.find((b: any) => b.type === 'image')
    expect(imageBlock).toBeDefined()
    expect(imageBlock.source.type).toBe('base64')
    expect(imageBlock.source.media_type).toBe('image/png')
    expect(typeof imageBlock.source.data).toBe('string')
    expect(imageBlock.source.data.length).toBeGreaterThan(0)
  })

  it('file part new URL("file:///...") → 产出 image content block', async () => {
    const filePath = createTempPng('test-file-url.png')
    const fileUrl = new URL(`file://${filePath}`)

    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [
          { type: 'file', data: fileUrl, mediaType: 'image/png' },
          { type: 'text', text: 'file url image' },
        ],
      }],
    })

    expect(typeof result).not.toBe('string')
    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) messages.push(msg)
    const content = (messages[0] as any).message.content
    const imageBlock = content.find((b: any) => b.type === 'image')
    expect(imageBlock).toBeDefined()
    expect(imageBlock.source.type).toBe('base64')
    expect(imageBlock.source.media_type).toBe('image/png')
    expect(typeof imageBlock.source.data).toBe('string')
    expect(imageBlock.source.data.length).toBeGreaterThan(0)
  })

  it('image part URL 对象（file: scheme）→ 产出 image content block', async () => {
    const filePath = createTempPng('test-image-file-url.png')
    const fileUrl = new URL(`file://${filePath}`)

    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [
          { type: 'image', image: fileUrl, mimeType: 'image/png' },
          { type: 'text', text: 'image part file url' },
        ],
      }],
    })

    expect(typeof result).not.toBe('string')
    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) messages.push(msg)
    const content = (messages[0] as any).message.content
    const imageBlock = content.find((b: any) => b.type === 'image')
    expect(imageBlock).toBeDefined()
    expect(imageBlock.source.type).toBe('base64')
    expect(imageBlock.source.media_type).toBe('image/png')
    expect(typeof imageBlock.source.data).toBe('string')
    expect(imageBlock.source.data.length).toBeGreaterThan(0)
  })

  it('image part 本地绝对路径字符串 → 产出 image content block', async () => {
    const filePath = createTempPng('test-image-abs-path.png')

    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [
          { type: 'image', image: filePath, mimeType: 'image/png' },
          { type: 'text', text: 'image part abs path' },
        ],
      }],
    })

    expect(typeof result).not.toBe('string')
    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) messages.push(msg)
    const content = (messages[0] as any).message.content
    const imageBlock = content.find((b: any) => b.type === 'image')
    expect(imageBlock).toBeDefined()
    expect(imageBlock.source.type).toBe('base64')
    expect(imageBlock.source.media_type).toBe('image/png')
    expect(typeof imageBlock.source.data).toBe('string')
    expect(imageBlock.source.data.length).toBeGreaterThan(0)
  })

  it('file part 本地路径读取失败时静默跳过，不产出该 image block', async () => {
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [
          { type: 'file', data: '/nonexistent/path/to/image.png', mediaType: 'image/png' },
          { type: 'text', text: 'fallback text' },
        ],
      }],
    })

    // 有 image mediaType 的 file part → 走 AsyncIterable 路径
    expect(typeof result).not.toBe('string')
    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) messages.push(msg)
    const content = (messages[0] as any).message.content
    // 读取失败跳过，只剩文本 block
    const imageBlocks = content.filter((b: any) => b.type === 'image')
    expect(imageBlocks).toHaveLength(0)
    const textBlock = content.find((b: any) => b.type === 'text' && b.text === 'fallback text')
    expect(textBlock).toBeDefined()
  })

  it('file part 有 mediaType 时以 part.mediaType 为准，不被扩展名推断覆盖', async () => {
    // 验证有 mediaType 但扩展名与 mediaType 不同时，以 part.mediaType 为准
    const filePath = createTempPng('test-ext-infer.png')
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [{
        role: 'user',
        content: [
          { type: 'file', data: filePath, mediaType: 'image/webp' },
        ],
      }],
    })

    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) messages.push(msg)
    const content = (messages[0] as any).message.content
    const imageBlock = content.find((b: any) => b.type === 'image')
    // 以 part.mediaType 为准，而非扩展名推断的 image/png
    expect(imageBlock.source.media_type).toBe('image/webp')
  })

  // === 回归测试：历史序列化时保留图片占位（修复"后续轮次模型误以为没聊过图片"的问题）===

  it('[回归] 历史中 user 只有 image part，后续文本轮 <conversation_history> 应包含图片占位', async () => {
    // 场景：第一轮用户发了一张图；第二轮用户问"刚刚聊了什么"
    // 期望：历史中第一轮 user 消息含 [Image attached: image/png] 占位，不被静默丢弃
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: 'data:image/png;base64,abc123==',
              mimeType: 'image/png',
            },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'This is a red circle.' }] },
        { role: 'user', content: [{ type: 'text', text: 'what did we just chat about?' }] },
      ],
    }) as string

    // 此轮无图片 → 应走字符串路径
    expect(typeof result).toBe('string')
    expect(result).toContain('<conversation_history>')
    // 历史中第一轮 user 图片占位必须保留
    expect(result).toContain('[Image attached: image/png]')
    // 当前问题在历史之后
    const historyEnd = result.indexOf('</conversation_history>')
    const currentPos = result.lastIndexOf('what did we just chat about?')
    expect(historyEnd).toBeGreaterThan(-1)
    expect(currentPos).toBeGreaterThan(historyEnd)
  })

  it('[回归] 历史中 user 为 file(image/png) part，后续文本轮也保留图片占位', async () => {
    // 场景：第一轮用户通过剪贴板/--file 发了一张图片；第二轮纯文本问问题
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe'
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'file', data: b64, mediaType: 'image/png' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'I see a small PNG image.' }] },
        { role: 'user', content: [{ type: 'text', text: 'describe what you see' }] },
      ],
    }) as string

    expect(typeof result).toBe('string')
    expect(result).toContain('<conversation_history>')
    // file(image/*) 历史占位必须保留
    expect(result).toContain('[Image attached: image/png]')
    expect(result).toContain('describe what you see')
  })

  it('[回归] 历史中 user 为 image + text，文本和图片占位都保留', async () => {
    // 场景：第一轮用户同时附上图片和文字说明；第二轮纯文本跟进
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: 'data:image/jpeg;base64,/9j/4AAQSkZJRgAB',
              mimeType: 'image/jpeg',
            },
            { type: 'text', text: 'look at this chart' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'The chart shows an upward trend.' }] },
        { role: 'user', content: [{ type: 'text', text: 'can you summarize again?' }] },
      ],
    }) as string

    expect(typeof result).toBe('string')
    expect(result).toContain('<conversation_history>')
    // 图片占位和文本都必须保留
    expect(result).toContain('[Image attached: image/jpeg]')
    expect(result).toContain('look at this chart')
    expect(result).toContain('can you summarize again?')
  })

  it('[回归] 多模态首轮（图片）→ 文本次轮：AsyncIterable 路径的历史中保留图片占位', async () => {
    // 场景：第一轮有图片走 AsyncIterable；历史序列化的 <conversation_history> 不应遗失图片语义
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    const result = buildPromptFromOptions({
      ...BASE_OPTIONS,
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'image', image: `data:image/png;base64,${b64}`, mimeType: 'image/png' },
            { type: 'text', text: 'what is in this image?' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'A small pixel.' }] },
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: `data:image/png;base64,${b64}`,
              mimeType: 'image/png',
            },
            { type: 'text', text: 'same image again, any new detail?' },
          ],
        },
      ],
    })

    // 当前轮有图片 → AsyncIterable 路径
    expect(typeof result).not.toBe('string')

    const messages: unknown[] = []
    for await (const msg of result as AsyncIterable<unknown>) messages.push(msg)
    expect(messages).toHaveLength(1)

    const content = (messages[0] as any).message.content as Array<{ type: string; text?: string }>
    // 历史块（第一块）必须包含第一轮的图片占位 + 文本
    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('<conversation_history>')
    expect(content[0].text).toContain('[Image attached: image/png]')
    expect(content[0].text).toContain('what is in this image?')
    expect(content[0].text).toContain('A small pixel.')
    // 当前轮图片 block 是真实 base64，不是占位
    const imageBlock = content.find((b) => b.type === 'image') as any
    expect(imageBlock).toBeDefined()
    expect(imageBlock.source.data).toBe(b64)
  })
})
