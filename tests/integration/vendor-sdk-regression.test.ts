import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { requireQoderAuth } from './helpers.js'

describe.skip('vendored qoder-agent-sdk regressions', { timeout: 120_000 }, () => {
  it('direct SDK 在初始化失败时不应抛 queryHandler.close 或 __dirname 相关错误', () => {
    requireQoderAuth()

    const script = `
import os from 'node:os'
import path from 'node:path'
import { configure, query } from './src/vendor/qoder-agent-sdk.mjs'

configure({ storageDir: path.join(os.homedir(), '.qoder') })

const q = query({
  prompt: 'Reply with exactly PONG',
  options: {
    model: 'efficient',
    cwd: process.cwd(),
    includePartialMessages: true,
    // 故意不传 pathToQoderCLIExecutable，复现之前 prepare 阶段失败后 finally 空指针的问题
  },
})

for await (const msg of q) {
  console.log(JSON.stringify(msg))
  break
}
`

    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      cwd: '/Users/yee.wang/Code/github/opencode-qoder-provider',
      encoding: 'utf8',
      timeout: 60_000,
    })

    const combined = `${result.stdout}\n${result.stderr}`
    expect(combined).not.toContain("queryHandler.close")
    expect(combined).not.toContain("Cannot read properties of null (reading 'close')")
    expect(combined).not.toContain('__dirname is not defined')
  })
})
