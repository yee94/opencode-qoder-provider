/**
 * Qoder 模型定义
 * 模型 key 对应 @ali/qoder-agent-sdk Options.model 的可选值
 */

export interface QoderModelDefinition {
  id: string
  name: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  cost: {
    input: number
    output: number
    cache_read: number
    cache_write: number
  }
  limit: {
    context: number
    output: number
  }
}

export const QODER_MODELS: Record<string, QoderModelDefinition> = {
  auto: {
    id: 'auto',
    name: 'Auto (1.0x)',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 180000, output: 32768 },
  },
  efficient: {
    id: 'efficient',
    name: 'Efficient (0.3x)',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 180000, output: 32768 },
  },
  performance: {
    id: 'performance',
    name: 'Performance (1.1x)',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 180000, output: 32768 },
  },
  ultimate: {
    id: 'ultimate',
    name: 'Ultimate (1.6x)',
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 180000, output: 32768 },
  },
  lite: {
    id: 'lite',
    name: 'Lite (0x)',
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 180000, output: 32768 },
  },
  q35model_preview: {
    id: 'q35model_preview',
    name: 'Qwen3.6-Plus-DogFooding (0x)',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 180000, output: 32768 },
  },
  qmodel: {
    id: 'qmodel',
    name: 'Qwen3.6-Plus (0.2x)',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 180000, output: 32768 },
  },
  q35model: {
    id: 'q35model',
    name: 'Qwen3.5-Plus (0.2x)',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 180000, output: 32768 },
  },
  gmodel: {
    id: 'gmodel',
    name: 'GLM-5 (0.5x)',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 180000, output: 32768 },
  },
  kmodel: {
    id: 'kmodel',
    name: 'Kimi-K2.5 (0.3x)',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 180000, output: 32768 },
  },
  mmodel: {
    id: 'mmodel',
    name: 'MiniMax-M2.7 (0.2x)',
    attachment: true,
    reasoning: false,
    temperature: false,
    tool_call: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 180000, output: 32768 },
  },
}

export const DEFAULT_MODEL_ID = 'lite'

export function getModelById(id: string): QoderModelDefinition | undefined {
  return QODER_MODELS[id]
}
