import { z } from 'zod'
import { terminalIds } from '../shared/types'
import { Skills, SkillError, targetSchema } from './skills'

/** 同一套业务方法服务 IPC 和终端协议；只有终端协议公开定义新增/删除能力。 */
export function skillRequest(skills: Skills, action: string, input: unknown): unknown {
  const base = z
    .object({ terminal: z.enum(terminalIds) })
    .passthrough()
    .parse(input)
  skills.assertTerminal(base.terminal)
  const data = base as Record<string, unknown>
  const id = () => z.string().min(1).max(128).parse(data.skillId)
  const name = () => z.string().max(128).parse(data.name)
  switch (action) {
    case 'create':
      return skills.create(data.package, z.string().parse(data.requestId))
    case 'targets':
      return skills.targets()
    case 'list':
      return skills.list()
    case 'detail':
      return skills.detail(id())
    case 'install':
      skills.install(id(), base.terminal)
      return { ok: true }
    case 'uninstall':
      skills.uninstall(id(), base.terminal)
      return { ok: true }
    case 'context':
      return skills.runtime(id(), base.terminal, z.string().parse(data.path))
    case 'run-context':
      return skills.runtime(id(), base.terminal, z.string().parse(data.path), true)
    case 'file':
      return { content: skills.file(id(), base.terminal, z.string().max(1024).parse(data.file)) }
    case 'experiences':
      return skills.experiences(z.array(z.string().uuid()).parse(data.ids))
    case 'experience-add':
      return skills.addExperience({
        skillId: id(),
        ...(data.folderId === undefined ? {} : { folderId: data.folderId }),
        content: data.content,
        evidence: data.evidence
      })
    case 'experience-update':
      return skills.updateExperience(
        z.string().uuid().parse(data.id),
        z.number().int().positive().parse(data.revision),
        { content: data.content, evidence: data.evidence }
      )
    case 'experience-delete':
      skills.deleteExperience(
        z.string().uuid().parse(data.id),
        z.number().int().positive().parse(data.revision)
      )
      return { ok: true }
    case 'variables':
      return skills.variables(
        id(),
        data.folderId == null ? null : z.string().uuid().parse(data.folderId)
      )
    case 'variable-reveal':
      return {
        value: skills.revealVariable(id(), name(), targetSchema.parse(data.target))
      }
    case 'variable-add':
      skills.addVariable(id(), data.variable)
      return { ok: true }
    case 'variable-delete':
      skills.deleteVariable(id(), name())
      return { ok: true }
    case 'variable-set':
      skills.setVariable(
        id(),
        name(),
        targetSchema.parse(data.target),
        z.string().nullable().parse(data.value)
      )
      return { ok: true }
    default:
      throw new SkillError(404, '技能接口不存在')
  }
}
