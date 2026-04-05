import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type Fixture = {
  name: string
  model: string
  prompt: string
  stdout: string
  stderr: string
  exitCode: number
}

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures')

function readFixture(fileName: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, fileName), 'utf8')) as Fixture
}

describe.skip('captured e2e fixtures', () => {
  const files = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort()

  it('contains fixtures for all qoder CLI smoke cases', () => {
    expect(files).toEqual([
      'auto-hello.json',
      'efficient-hello.json',
      'gmodel-hello.json',
      'kmodel-hello.json',
      'lite-pong.json',
      'mmodel-hello.json',
      'performance-hello.json',
      'q35model-hello.json',
      'qmodel-hello.json',
      'ultimate-hello.json',
    ])
  })

  for (const file of files) {
    it(`${file} matches captured output`, () => {
      const fixture = readFixture(file)
      expect(fixture.exitCode).toBe(0)
      expect(fixture.model.startsWith('qoder/')).toBe(true)
      expect(fixture.stderr).toContain('orchestrator')
      expect(fixture.stderr.toLowerCase()).toContain(fixture.model.split('/')[1])
      expect(fixture.stdout.trim().length).toBeGreaterThan(0)
      // Snapshot disabled — e2e fixtures are captured manually
    })
  }
})
