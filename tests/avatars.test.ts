import { expect, it } from 'vitest'
import {
  avatarUrl,
  backgroundUrl,
  modelFamily,
  trayBackgroundUrl
} from '../src/renderer/src/avatars'
import type { SessionActivity } from '../src/shared/types'

function session(patch: Partial<SessionActivity> = {}): SessionActivity {
  return {
    terminal: 'codex',
    model: null,
    sessionId: 'one',
    phase: 'executing',
    lastSeen: 0,
    startedAt: 0,
    ...patch
  }
}
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
})
it('会话头像固定使用终端商标，卡片背景只使用已识别模型的角色形象', () => {
  expect(avatarUrl(session({ model: 'anthropic/claude-opus-4-6' }), 1)).toBe(
    'ebisu-asset://avatar/terminal/codex?v=1'
  )
  expect(avatarUrl(session({ terminal: 'grok' }), 1)).toBe('ebisu-asset://avatar/terminal/grok?v=1')
  expect(backgroundUrl(session({ model: 'anthropic/claude-opus-4-6' }), 2)).toBe(
    'ebisu-asset://avatar/model/claude?v=2&background=1'
  )
  expect(backgroundUrl(session({ model: null }), 2)).toBeUndefined()
  expect(backgroundUrl(session({ model: 'mygpt-proxy' }), 2)).toBeUndefined()
  expect(trayBackgroundUrl(session({ model: 'openai/gpt-6.1' }), 2)).toBe(
    'ebisu-asset://avatar/model/gpt?v=2&background=1&tray=1'
  )
  expect(trayBackgroundUrl(session({ model: null }), 2)).toBeUndefined()
  expect(trayBackgroundUrl(session({ model: 'mygpt-proxy' }), 2)).toBeUndefined()
})
