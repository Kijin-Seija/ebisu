import type { SkillPackage } from './skills'

/** 只改明确的身份字段与调用参数；脚本路径和普通叙述不能做全局名称替换。 */
export function renameSkillPackage(input: SkillPackage, name: string): SkillPackage {
  const pkg = JSON.parse(JSON.stringify(input)) as SkillPackage
  const old = pkg.name
  pkg.name = name
  if (old === name) return pkg
  const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const argument = new RegExp(
    `(?<![\\w-])(--skill(?:[ \\t]+|=))(['"]?)${escaped}\\2(?=[\\s;|&\x60]|$)`,
    'g'
  )
  const entries = new Set(['SKILL.md', ...Object.values(pkg.variants ?? {})])
  for (const [relative, file] of Object.entries(pkg.files)) {
    if (file.encoding === 'base64') continue
    file.content = file.content.replace(
      argument,
      (_all, prefix: string, quote: string) => `${prefix}${quote}${name}${quote}`
    )
    if (entries.has(relative)) {
      file.content = file.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, (header) =>
        header.replace(
          new RegExp(`^(name:[ \\t]*)(['"]?)${escaped}\\2[ \\t]*(?=\\r?$)`, 'm'),
          (_line, prefix: string) => `${prefix}${name}`
        )
      )
    }
  }
  return pkg
}
