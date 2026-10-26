import type { TerminalId } from './types'

/** skill 表示全局层；终端层和项目层互相独立，可按变量定义自由组合。 */
export type VariableScope = 'skill' | 'terminal' | 'project'
export interface SkillFile {
  content: string
  encoding?: 'utf8' | 'base64'
  executable?: boolean
}
export interface SkillVariable {
  name: string
  description: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  sensitive: boolean
  scopes: VariableScope[]
  defaultValue?: string
}
export interface SkillPackage {
  version: 1
  name: string
  description: string
  files: Record<string, SkillFile>
  variants?: Partial<Record<TerminalId, string>>
  variables?: SkillVariable[]
  dependencies?: string[]
  source?: string
}
export interface SkillSummary {
  id: string
  name: string
  description: string
  createdAt: number
  source: string | null
  installations: { terminal: TerminalId; installedAt: number }[]
}
export interface SkillExperience {
  id: string
  skillId: string
  folderId: string | null
  content: string
  evidence: string
  revision: number
  createdAt: number
  updatedAt: number
}
export interface VariableTarget {
  scope: VariableScope
  terminal?: TerminalId
  folderId?: string
}
export interface VariableLayerValue {
  value: string | null
  hasValue: boolean
}
export interface TerminalVariableLayerValue extends VariableLayerValue {
  terminal: TerminalId
}
/** 一次返回全局、已安装终端和当前项目的独立取值；敏感值只保留是否已设置。 */
export interface VariableView extends SkillVariable {
  global: VariableLayerValue
  terminals: TerminalVariableLayerValue[]
  project: VariableLayerValue | null
}
export interface SkillDetail extends SkillSummary {
  package: SkillPackage
  experiences: SkillExperience[]
}
export interface SkillRuntime {
  skill: SkillSummary
  folder: { id: string; path: string } | null
  instructions: string
  experiences: SkillExperience[]
  variables: Record<string, string>
  configuration: VariableView[]
  missingVariables: string[]
  directory: string
  scripts: string[]
}
