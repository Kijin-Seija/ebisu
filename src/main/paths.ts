import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

/** 只接受现存绝对目录，并折叠符号链接，避免同一目录重复关联。 */
export function canonicalDirectory(input: string): string {
  if (!path.isAbsolute(input)) throw new Error('目录必须使用绝对路径')
  const canonical = realpathSync.native(input)
  if (!statSync(canonical).isDirectory()) throw new Error('路径不是文件夹')
  return canonical
}

/** 使用路径分隔边界比较，/repo-a 不能匹配 /repo-ab。 */
export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

/** 重叠注册时只归入最具体的目录；各 worktree 按实际路径独立。 */
export function deepestFolder<T extends { path: string }>(
  folders: T[],
  target: string
): T | undefined {
  return folders
    .filter((folder) => containsPath(folder.path, target))
    .sort((a, b) => b.path.length - a.path.length)[0]
}
