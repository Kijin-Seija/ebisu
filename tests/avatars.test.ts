import { expect, it } from 'vitest'
import { avatarUrl, modelFamily } from '../src/renderer/src/avatars'
it('识别明确模型标识，不把 provider 或终端名字作为当前模型', () => {
  expect(modelFamily('openai/gpt-6.1')).toBe('gpt')
  expect(modelFamily('anthropic/claude-opus-4-6')).toBe('claude')
  expect(modelFamily('DeepSeek-V3')).toBe('deepseek')
  expect(modelFamily('moonshot/kimi-k2')).toBe('kimi')
  expect(modelFamily('qwen3-coder')).toBe('qwen')
  expect(modelFamily('gemini-3-pro')).toBe('gemini')
  expect(modelFamily('grok-4')).toBe('grok')
  expect(modelFamily('mygpt-proxy')).toBeUndefined()
  expect(modelFamily(null)).toBeUndefined()
  expect(
    avatarUrl(
      {
        terminal: 'codex',
        model: null,
        sessionId: 'one',
        phase: 'executing',
        lastSeen: 0,
        startedAt: 0
      },
      1
    )
  ).toContain('/terminal/codex')
})
