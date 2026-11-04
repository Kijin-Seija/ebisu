import {
  terminalIconId,
  terminalIds,
  type ModelFamily,
  type SessionActivity,
  type TerminalId
} from '../../shared/types'

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

/** 终端未显式上报模型时，聊天头像回退到该终端对应的模型形象。 */
const terminalDefaultModels: Partial<Record<TerminalId, ModelFamily>> = {
  codex: 'gpt',
  claude: 'claude',
  dsh: 'deepseek',
  qoder: 'qwen',
  qodercn: 'qwen',
  antigravity: 'gemini',
  grok: 'grok'
}

/**
 * 聊天消息发送者头像：优先使用发送者模型对应的模型形象（与设置页中的模型形象配置一致），
 * 未记录模型时按发送者终端匹配对应模型形象或终端商标。
 */
export function chatAvatarUrl(
  input: { author: string; model?: string | null },
  revision: number
): string | undefined {
  const family = modelFamily(input.model ?? null) ?? modelFamily(input.author)
  if (family) return `ebisu-asset://avatar/model/${family}?v=${revision}`
  const tail = input.author.split('/').pop()?.trim().toLowerCase()
  if (tail && (terminalIds as readonly string[]).includes(tail)) {
    const terminal = tail as TerminalId
    const fallbackFamily = terminalDefaultModels[terminal]
    if (fallbackFamily) return `ebisu-asset://avatar/model/${fallbackFamily}?v=${revision}`
    return `ebisu-asset://avatar/terminal/${terminalIconId(terminal)}?v=${revision}`
  }
  return undefined
}

/** 会话头像固定使用终端商标；Qoder CN 复用 Qoder 商标，模型角色只用于卡片背景。 */
export function avatarUrl(session: SessionActivity, revision: number): string {
  return `ebisu-asset://avatar/terminal/${terminalIconId(session.terminal)}?v=${revision}`
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
