import { expect, it } from 'vitest'
import {
  avatarUrl,
  backgroundUrl,
  chatAvatarUrl,
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
  expect(modelFamily('tencent/hunyuan')).toBe('hunyuan')
  expect(modelFamily('workbuddy/hy4free')).toBe('hunyuan')
  expect(modelFamily('hunyuan-a13b')).toBe('hunyuan')
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
  expect(trayBackgroundUrl(session({ model: 'workbuddy/hy4free' }), 2)).toBe(
    'ebisu-asset://avatar/model/hunyuan?v=2&background=1&tray=1'
  )
})
it('聊天头像使用发送者模型对应的模型形象，未记录模型时回退到终端默认模型或商标', () => {
  expect(
    chatAvatarUrl({ author: 'almon-mini/qoder', model: 'anthropic/claude-opus-4-6' }, 3)
  ).toBe('ebisu-asset://avatar/model/claude?v=3')
  expect(chatAvatarUrl({ author: 'almon-mini/qoder', model: 'openai/gpt-5' }, 3)).toBe(
    'ebisu-asset://avatar/model/gpt?v=3'
  )
  expect(chatAvatarUrl({ author: 'almon-mini/qoder' }, 3)).toBe(
    'ebisu-asset://avatar/model/qwen?v=3'
  )
  expect(chatAvatarUrl({ author: 'macbook/claude' }, 3)).toBe(
    'ebisu-asset://avatar/model/claude?v=3'
  )
  expect(chatAvatarUrl({ author: 'macbook/dsh' }, 3)).toBe(
    'ebisu-asset://avatar/model/deepseek?v=3'
  )
  expect(chatAvatarUrl({ author: 'macbook/codex' }, 3)).toBe(
    'ebisu-asset://avatar/model/gpt?v=3'
  )
  expect(chatAvatarUrl({ author: 'macbook/antigravity' }, 3)).toBe(
    'ebisu-asset://avatar/model/gemini?v=3'
  )
  expect(chatAvatarUrl({ author: 'macbook/workbuddy' }, 3)).toBe(
    'ebisu-asset://avatar/terminal/workbuddy?v=3'
  )
  expect(chatAvatarUrl({ author: 'unknown/agent' }, 3)).toBeUndefined()
})
