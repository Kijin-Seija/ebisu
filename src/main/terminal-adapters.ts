import type { TerminalId } from '../shared/types'

export const terminalNames: Record<TerminalId, string> = {
  codex: 'Codex',
  workbuddy: 'WorkBuddy',
  claude: 'Claude Code',
  grok: 'Grok',
  qoder: 'Qoder'
}
interface Adapter {
  commands: string[]
  apps: string[]
  root: string
  skillRoot: string
  rule: string
  hookFile?: string
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
  }
}
