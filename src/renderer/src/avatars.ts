import type { ModelFamily, SessionActivity } from '../../shared/types'

/** 只识别明确的模型标识，绝不由终端品牌或静态默认配置猜测当前模型。 */
export function modelFamily(model: string | null): ModelFamily | undefined {
  const value = model?.toLowerCase() ?? ''
  if (/(^|[/\s:_-])(gpt|chatgpt)([\d\s:/_-]|$)/.test(value) || /^(o[134])([\s-]|$)/.test(value))
    return 'gpt'
  for (const family of ['claude', 'deepseek', 'kimi', 'qwen', 'gemini', 'grok'] as const) {
    if (new RegExp(`(^|[/\\s:_-])${family}([\\d\\s:/_-]|$)`).test(value)) return family
  }
  return undefined
}

/** 背景使用同一身份对应的透明轮廓素材；普通头像继续使用原始裁切图。 */
export function avatarUrl(session: SessionActivity, revision: number, background = false): string {
  const family = modelFamily(session.model)
  return `ebisu-asset://avatar/${family ? `model/${family}` : `terminal/${session.terminal}`}?v=${revision}${background ? '&background=1' : ''}`
}
