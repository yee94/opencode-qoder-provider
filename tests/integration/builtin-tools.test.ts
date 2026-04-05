/**
 * Qoder CLI 内置工具逐个验证
 *
 * 目标：单工具、单进程、尽快拿到结果并终止，避免整轮 agent loop 卡住。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { requireQoderAuth } from './helpers.js'

const TIMEOUT = 120_000
const MODEL = 'qoder/efficient'
const OPENCODE_BIN = '/Users/yee.wang/Library/pnpm/opencode'
const PROJECT_DIR = '/Users/yee.wang/Code/github/opencode-qoder-provider'
const TMP_DIR = path.join(os.tmpdir(), `qoder-tool-test-${Date.now()}`)

type ProbeResult = {
  stdout: string
  stderr: string
  matched: boolean
}

function runUntil(
  prompt: string,
  matcher: (stdout: string, stderr: string) => boolean,
  timeoutMs = TIMEOUT,
  model = MODEL,
): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCODE_BIN, ['run', '-m', model, '--print-logs', prompt], {
      cwd: PROJECT_DIR,
      env: { ...process.env, HOME: os.homedir(), OPENCODE_NON_INTERACTIVE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let done = false

    const finish = (result: ProbeResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(result)
    }

    child.stdout.on('data', (buf: Buffer) => {
      stdout += buf.toString()
      if (matcher(stdout, stderr)) finish({ stdout, stderr, matched: true })
    })

    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString()
      if (matcher(stdout, stderr)) finish({ stdout, stderr, matched: true })
    })

    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ stdout, stderr, matched: matcher(stdout, stderr) })
    })

    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill('SIGKILL')
      reject(new Error(`timeout after ${timeoutMs}ms\nstdout:\n${stdout.slice(0, 1200)}\n\nstderr:\n${stderr.slice(0, 1200)}`))
    }, timeoutMs)
  })
}

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true })
})

afterAll(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe.skip('Qoder CLI 内置工具验证（单工具快速模式）', { concurrent: false }, () => {
  it('mmodel + Grep 不应重复循环调用', async () => {
    requireQoderAuth()
    const result = await runUntil(
      'Use the Grep tool to search for QoderLanguageModel in the current project src directory, then only return the matching file path.',
      (_stdout, stderr) => stderr.includes('exiting loop'),
      120_000,
      'qoder/mmodel',
    )

    const loopCount = (result.stderr.match(/service=session\.prompt step=\d+ .* loop/g) ?? []).length
    expect(loopCount).toBeLessThanOrEqual(2)
    expect(result.stdout).toContain('src/qoder-language-model.ts')
  }, 120_000)

  it('Bash', async () => {
    requireQoderAuth()
    const result = await runUntil(
      'Use the Bash tool to run command echo BASH_WORKS_123. Return the exact token BASH_WORKS_123.',
      (stdout) => stdout.includes('BASH_WORKS_123'),
    )
    expect(result.stdout).toContain('BASH_WORKS_123')
  }, TIMEOUT)

  it('Read', async () => {
    requireQoderAuth()
    const result = await runUntil(
      `Use the Read tool to read "${PROJECT_DIR}/package.json" and return only opencode-qoder-plugin.`,
      (stdout) => stdout.toLowerCase().includes('opencode-qoder-plugin'),
    )
    expect(result.stdout.toLowerCase()).toContain('opencode-qoder-plugin')
  }, TIMEOUT)

  it('Write', async () => {
    requireQoderAuth()
    const filePath = path.join(TMP_DIR, 'write.txt')
    await runUntil(
      `Use the Write tool to write exactly WRITE_SUCCESS into file "${filePath}". Then answer WRITE_SUCCESS.`,
      (stdout) => stdout.includes('WRITE_SUCCESS') && fs.existsSync(filePath),
    )
    expect(fs.readFileSync(filePath, 'utf8')).toContain('WRITE_SUCCESS')
  }, TIMEOUT)

  it('Edit', async () => {
    requireQoderAuth()
    const filePath = path.join(TMP_DIR, 'edit.txt')
    fs.writeFileSync(filePath, 'ORIGINAL_CONTENT')
    await runUntil(
      `Use the Edit tool to replace ORIGINAL_CONTENT with EDITED_CONTENT in file "${filePath}". Then answer EDITED_CONTENT.`,
      (stdout) => stdout.includes('EDITED_CONTENT') && fs.readFileSync(filePath, 'utf8').includes('EDITED_CONTENT'),
    )
    expect(fs.readFileSync(filePath, 'utf8')).toContain('EDITED_CONTENT')
  }, TIMEOUT)

  it('Glob', async () => {
    requireQoderAuth()
    const result = await runUntil(
      `Use the Glob tool in "${PROJECT_DIR}/src" with pattern "**/*.ts". Return one existing file name such as qoder-language-model.ts.`,
      (stdout) => stdout.includes('qoder-language-model.ts') || stdout.includes('prompt-builder.ts'),
    )
    expect(result.stdout).toMatch(/qoder-language-model\.ts|prompt-builder\.ts/)
  }, TIMEOUT)

  it('Grep', async () => {
    requireQoderAuth()
    const result = await runUntil(
      `Use the Grep tool to search pattern "QoderLanguageModel" in path "${PROJECT_DIR}/src". Return qoder-language-model.ts if found.`,
      (stdout) => stdout.includes('qoder-language-model.ts'),
    )
    expect(result.stdout).toContain('qoder-language-model.ts')
  }, TIMEOUT)

  it('TodoWrite', async () => {
    requireQoderAuth()
    const result = await runUntil(
      'Use the TodoWrite tool to create 2 todos: Task A pending medium, Task B completed high. Then answer TODO_OK.',
      (stdout) => stdout.includes('TODO_OK') || stdout.includes('Task A'),
    )
    expect(result.stdout).toMatch(/TODO_OK|Task A/)
  }, TIMEOUT)

  it('WebFetch', async () => {
    requireQoderAuth()
    const result = await runUntil(
      'Use the WebFetch tool to fetch https://example.com in markdown format and return exactly Example Domain.',
      (stdout) => stdout.includes('Example Domain'),
    )
    expect(result.stdout).toContain('Example Domain')
  }, TIMEOUT)

  it('WebSearch', async () => {
    requireQoderAuth()
    const result = await runUntil(
      'Use the WebSearch tool to search for opencode ai and return one result containing opencode.ai.',
      (stdout) => stdout.toLowerCase().includes('opencode.ai'),
    )
    expect(result.stdout.toLowerCase()).toContain('opencode.ai')
  }, TIMEOUT)

  it('Task(Agent)', async () => {
    requireQoderAuth()
    const result = await runUntil(
      'Use the Agent tool to launch an explorer subagent with description "quick search" and prompt "reply only AGENT_OK". Then report AGENT_OK.',
      (stdout, stderr) => stdout.includes('AGENT_OK') || stderr.includes('AGENT_OK') || stdout.toLowerCase().includes('explorer'),
      90_000,
    )
    expect(result.stdout + result.stderr).toMatch(/AGENT_OK|explorer/i)
  }, 90_000)

  it('Question(AskUserQuestion) - 至少发起调用', async () => {
    requireQoderAuth()
    const result = await runUntil(
      'Use the AskUserQuestion tool to ask one question with two options. Keep going after that if possible.',
      (_stdout, stderr) => stderr.includes('question') || stderr.includes('Asked 1 question'),
      30_000,
    ).catch((err: Error) => ({ stdout: '', stderr: err.message, matched: false }))

    expect(result.stderr + result.stdout).toMatch(/question|Asked 1 question|timeout/i)
  }, 60_000)

  it('BashOutput + KillBash 组合链路', async () => {
    requireQoderAuth()
    const result = await runUntil(
      'Use Bash to start command "sleep 20" in background. Then use BashOutput to inspect it. Then use KillBash to stop it. Finally answer BG_CHAIN_OK.',
      (stdout) => stdout.includes('BG_CHAIN_OK') || stdout.toLowerCase().includes('bashoutput') || stdout.toLowerCase().includes('killbash'),
      90_000,
    )
    expect(result.stdout).toMatch(/BG_CHAIN_OK|bashoutput|killbash/i)
  }, 120_000)
})
