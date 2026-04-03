import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Config } from '@opencode-ai/plugin'

// 动态 import plugin，测试时 mock SDK
vi.mock('../src/vendor/qoder-agent-sdk.mjs', () => ({
  query: vi.fn(),
  IntegrationMode: { QoderWork: 'qoder_work', Quest: 'quest' },
}))

describe('QoderProviderPlugin', () => {
  let pluginModule: typeof import('../index.js')

  beforeEach(async () => {
    vi.resetModules()
    pluginModule = await import('../index.js')
  })

  describe('plugin 导出', () => {
    it('导出 QoderProviderPlugin 函数', () => {
      expect(typeof pluginModule.QoderProviderPlugin).toBe('function')
    })
  })

  describe('config hook', () => {
    it('注入 qoder provider 到 config.provider', async () => {
      const hooks = await pluginModule.QoderProviderPlugin({} as any)
      expect(hooks.config).toBeDefined()

      const config: Config = {} as Config
      await hooks.config!(config)

      expect(config.provider).toBeDefined()
      expect(config.provider!['qoder']).toBeDefined()
    })

    it('provider 包含 name 和 npm 字段', async () => {
      const hooks = await pluginModule.QoderProviderPlugin({} as any)
      const config: Config = {} as Config
      await hooks.config!(config)

      const qoderProvider = config.provider!['qoder']
      expect(qoderProvider.name).toBe('Qoder')
      // npm 字段应为 file:// URL 指向本地 provider.ts
      expect(qoderProvider.npm).toMatch(/^file:\/\//)
      expect(qoderProvider.npm).toMatch(/provider\.ts$/)
    })

    it('provider 包含至少一个 model', async () => {
      const hooks = await pluginModule.QoderProviderPlugin({} as any)
      const config: Config = {} as Config
      await hooks.config!(config)

      const models = config.provider!['qoder'].models
      expect(models).toBeDefined()
      expect(Object.keys(models!).length).toBeGreaterThan(0)
    })

    it('不覆盖用户已有的 npm 配置', async () => {
      const hooks = await pluginModule.QoderProviderPlugin({} as any)
      const config: Config = {
        provider: {
          qoder: {
            npm: 'my-custom-qoder-provider',
            models: {
              'custom-model': { name: 'My Custom Model' } as any,
            },
          } as any,
        },
      } as Config
      await hooks.config!(config)

      // 用户自定义的 npm 不被覆盖
      expect(config.provider!['qoder'].npm).toBe('my-custom-qoder-provider')
      expect(config.provider!['qoder'].models!['custom-model']).toBeDefined()
    })

    it('从 config.mcp 提取 stdio 类型 MCP 服务器并注入 mcpBridge', async () => {
      const hooks = await pluginModule.QoderProviderPlugin({} as any)
      const config: Config = {
        mcp: {
          context7: {
            type: 'local',
            command: ['npx', '-y', '@upstash/context7-mcp@latest'],
          },
        },
      } as Config
      await hooks.config!(config)

      // 注入后，qoder-language-model 应能获取 context7 mcpServer
      const { getMcpBridgeServers } = await import('../src/mcp-bridge.js')
      const servers = getMcpBridgeServers()
      expect(servers).toBeDefined()
      expect(servers['context7']).toBeDefined()
      expect(servers['context7'].type).toBe('stdio')
      expect(servers['context7'].command).toBe('npx')
      expect(servers['context7'].args).toEqual(['-y', '@upstash/context7-mcp@latest'])

      const qoderProvider = config.provider!['qoder'] as any
      expect(qoderProvider.options?.mcpServers?.context7?.type).toBe('stdio')
      expect(qoderProvider.options?.mcpServers?.context7?.command).toBe('npx')
    })

    it('从 config.mcp 提取 remote 类型 MCP 服务器', async () => {
      const hooks = await pluginModule.QoderProviderPlugin({} as any)
      const config: Config = {
        mcp: {
          'github-mcp': {
            type: 'remote',
            url: 'https://mcp.example.com/github',
          },
        },
      } as Config
      await hooks.config!(config)

      const { getMcpBridgeServers } = await import('../src/mcp-bridge.js')
      const servers = getMcpBridgeServers()
      expect(servers['github-mcp']).toBeDefined()
      expect(servers['github-mcp'].type).toBe('http')
      expect(servers['github-mcp'].url).toBe('https://mcp.example.com/github')
    })

    it('config.mcp 中 enabled=false 的服务器不注入', async () => {
      const hooks = await pluginModule.QoderProviderPlugin({} as any)
      const config: Config = {
        mcp: {
          disabled: {
            type: 'local',
            command: ['npx', 'some-mcp'],
            enabled: false,
          },
        },
      } as Config
      await hooks.config!(config)

      const { getMcpBridgeServers } = await import('../src/mcp-bridge.js')
      const servers = getMcpBridgeServers()
      expect(servers['disabled']).toBeUndefined()
    })

    it('config.mcp 为空时不注入 mcpBridge', async () => {
      const hooks = await pluginModule.QoderProviderPlugin({} as any)
      const config: Config = {} as Config
      await hooks.config!(config)

      const { getMcpBridgeServers } = await import('../src/mcp-bridge.js')
      const servers = getMcpBridgeServers()
      expect(Object.keys(servers).length).toBe(0)
    })
  })
})
