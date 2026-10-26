import { createHash, randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { DeviceIdentity, ImportDraft, ImportEdit, SkillExport } from '../shared/lan'
import { renameSkillPackage } from '../shared/skill-import'
import { Skills, SkillError, packageSchema } from './skills'
import type { Store } from './database'

/** 对象键排序后计算内容身份，避免 JSON 字段顺序导致相同包被误判为不同。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export const packageHash = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex')

export class SkillTransfer {
  private drafts = new Map<string, { draft: ImportDraft; expires: number }>()
  constructor(
    private store: Store,
    private skills: Skills,
    private now = Date.now
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS lan_imports (
      draftId TEXT PRIMARY KEY, inputHash TEXT NOT NULL, skillId TEXT NOT NULL,
      deviceId TEXT NOT NULL, originalSkillId TEXT NOT NULL, originalHash TEXT NOT NULL
    )`)
  }
  export(id: string): SkillExport {
    const exported = this.skills.exportPackage(id)
    return { ...exported, hash: packageHash(exported.package) }
  }
  private sameContent(id: string, hash: string): boolean {
    try {
      return this.export(id).hash === hash
    } catch {
      return false
    } // 本机源文件不可读或被改写时只能判为冲突，仍允许改名另存。
  }
  prepare(device: DeviceIdentity, input: SkillExport): ImportDraft {
    const pkg = packageSchema.parse(input.package)
    // 即使对端实现有误也不接收默认取值；仅接受定义，不让它绕过变量配置入口。
    if (pkg.variables?.some((item) => item.defaultValue !== undefined))
      throw new SkillError(400, '导入包不能包含变量默认取值')
    if (packageHash(pkg) !== input.hash) throw new SkillError(400, '技能包校验失败')
    const existing = this.skills.list().find((skill) => skill.name === pkg.name)
    const identical = existing && this.sameContent(existing.id, input.hash)
    for (const [id, item] of this.drafts) if (item.expires <= this.now()) this.drafts.delete(id)
    if (this.drafts.size >= 16) this.drafts.delete(this.drafts.keys().next().value!)
    const draft: ImportDraft = {
      ...input,
      package: pkg,
      id: randomUUID(),
      device,
      existingId: identical ? existing!.id : null,
      conflict: !!existing && !identical
    }
    this.drafts.set(draft.id, { draft: structuredClone(draft), expires: this.now() + 15 * 60_000 })
    return draft
  }
  confirm(id: string, input: ImportEdit): string {
    z.string().uuid().parse(id)
    const edit = z
      .object({
        name: z.string().max(63),
        texts: z.record(z.string(), z.string().max(4 * 1024 * 1024))
      })
      .strict()
      .parse(input)
    const inputHash = packageHash(edit)
    const done = this.store.db
      .prepare('SELECT inputHash,skillId FROM lan_imports WHERE draftId=?')
      .get(id) as { inputHash: string; skillId: string } | undefined
    if (done) {
      if (done.inputHash !== inputHash) throw new SkillError(409, '重试内容与已导入内容不同')
      return done.skillId
    }
    const entry = this.drafts.get(id)
    if (!entry || entry.expires <= this.now())
      throw new SkillError(410, '导入预览已过期，请重新准备')
    const draft = entry.draft
    const pkg = renameSkillPackage(draft.package, edit.name)
    for (const [relative, content] of Object.entries(edit.texts)) {
      const file = pkg.files[relative]
      if (!Object.hasOwn(pkg.files, relative) || !file || file.encoding === 'base64')
        throw new SkillError(400, '只能修改已有文本文件')
      file.content = content
    }
    const existing = this.skills.list().find((skill) => skill.name === pkg.name)
    let createdId: string | undefined
    try {
      return this.store.db.transaction(() => {
        let skillId: string
        if (existing) {
          if (!this.sameContent(existing.id, packageHash(pkg)))
            throw new SkillError(409, '同名技能内容不同，请改名后导入')
          skillId = existing.id
        } else {
          skillId = this.skills.create(pkg, `lan:${id}`).id
          createdId = skillId
        }
        this.store.db
          .prepare('INSERT INTO lan_imports VALUES(?,?,?,?,?,?)')
          .run(id, inputHash, skillId, draft.device.id, draft.skillId, draft.hash)
        this.drafts.delete(id)
        return skillId
      })()
    } catch (error) {
      if (createdId)
        rmSync(path.join(this.skills.root, createdId), { recursive: true, force: true })
      throw error
    }
  }
}
