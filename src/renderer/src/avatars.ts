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

/** 会话头像固定使用终端商标；模型角色只用于卡片背景。 */
export function avatarUrl(session: SessionActivity, revision: number): string {
  return `ebisu-asset://avatar/terminal/${session.terminal}?v=${revision}`
}

/** 只有识别到模型角色时才提供透明轮廓背景；未知模型不渲染装饰层。 */
export function backgroundUrl(session: SessionActivity, revision: number): string | undefined {
  const family = modelFamily(session.model)
  return family ? `ebisu-asset://avatar/model/${family}?v=${revision}&background=1` : undefined
}

/** 托盘使用 Q 版角色单独一版背景，主窗口继续使用原透明轮廓。 */
export function trayBackgroundUrl(session: SessionActivity, revision: number): string | undefined {
  const family = modelFamily(session.model)
  return family
    ? `ebisu-asset://avatar/model/${family}?v=${revision}&background=1&tray=1`
    : undefined
}
