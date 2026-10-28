import { terminalNames, type TerminalId } from '../shared/types'

export { terminalNames }
interface Adapter {
  commands: string[]
  apps: string[]
  root: string
  skillRoot: string
  rule: string
  hookFile?: string
  /** 终端不提供可安装的生命周期 hook 时只能依赖规则与 skill 主动上报。 */
  hookSupport?: 'native' | 'none'
  events: string[]
}
/** 不把 Claude 桌面聊天应用误识别成 Claude Code；后者需 CLI 或其专用应用。 */
export const adapters: Record<TerminalId, Adapter> = {
  codex: {
    commands: ['codex'],
    apps: ['Codex.app', 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app'],
    root: '.codex',
    skillRoot: '.agents/skills',
    rule: '.codex/AGENTS.md',
    hookFile: '.codex/hooks.json',
    events: [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Stop',
      'Interrupt',
      'SessionEnd'
    ]
  },
  workbuddy: {
    commands: ['workbuddy'],
    apps: ['WorkBuddy.app'],
    root: '.workbuddy',
    skillRoot: '.workbuddy/skills',
    rule: '.workbuddy/AGENTS.md',
    hookFile: '.workbuddy/settings.json',
    events: [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Notification',
      'Stop',
      'StopFailure',
      'SessionEnd'
    ]
  },
  claude: {
    commands: ['claude'],
    apps: ['Claude Code.app'],
    root: '.claude',
    skillRoot: '.claude/skills',
    rule: '.claude/rules/ebisu-activity.md',
    hookFile: '.claude/settings.json',
    events: [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Notification',
      'Stop',
      'StopFailure',
      'SessionEnd'
    ]
  },
  grok: {
    commands: ['grok'],
    apps: ['Grok CLI.app'],
    root: '.grok',
    skillRoot: '.grok/skills',
    rule: '.grok/rules/ebisu-activity.md',
    hookFile: '.grok/hooks/ebisu.json',
    events: [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Notification',
      'Stop',
      'StopFailure',
      'StopCancelled',
      'SessionEnd'
    ]
  },
  // Qoder Desktop 与 CLI 共用 settings.json hook 协议，见 docs/INTEGRATIONS.md。
  qoder: {
    commands: ['qodercli', 'qoder'],
    apps: ['Qoder.app'],
    root: '.qoder',
    skillRoot: '.qoder/skills',
    rule: '.qoder/AGENTS.md',
    hookFile: '.qoder/settings.json',
    events: [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Notification',
      'Stop',
      'StopFailure',
      'SessionEnd',
      'Elicitation',
      'ElicitationResult'
    ]
  },
  // DSH 0.2.1-rc.3 读取 ~/.dsh/AGENTS.md 与 ~/.dsh/skills，但没有可安装的用户级
  // 生命周期 hook；因此只安装规则和 skill，由模型按规则主动上报，不伪造原生事件。
  dsh: {
    commands: ['dsh'],
    apps: ['DeepSeek Harness.app'],
    root: '.dsh',
    skillRoot: '.dsh/skills',
    rule: '.dsh/AGENTS.md',
    hookSupport: 'none',
    events: []
  }
}
