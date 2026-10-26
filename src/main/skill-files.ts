import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

/** 所有受管路径逐层检查，禁止借既有符号链接把文件写到管理边界之外。 */
export function safeFile(root: string, relative: string): string {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('技能文件必须使用安全的相对路径')
  let current = root
  if (existsSync(root) && lstatSync(root).isSymbolicLink())
    throw new Error('管理目录不能是符号链接')
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`拒绝符号链接：${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return current
}

/** 文件与 SQLite 事务配合；写入失败时恢复原文，不恢复整份用户配置。 */
export class FileChanges {
  private before = new Map<string, { content: Buffer; mode: number } | null>()
  capture(file: string): void {
    if (this.before.has(file)) return
    if (existsSync(file)) {
      if (!lstatSync(file).isFile()) throw new Error(`受管目标不是普通文件：${file}`)
      this.before.set(file, { content: readFileSync(file), mode: statSync(file).mode & 0o777 })
    } else this.before.set(file, null)
  }
  write(file: string, content: string | Buffer, mode = 0o600): void {
    this.capture(file)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, content, { mode })
  }
  remove(file: string): void {
    this.capture(file)
    rmSync(file, { force: true })
  }
  rollback(): void {
    for (const [file, previous] of [...this.before].reverse()) {
      if (previous) writeFileSync(file, previous.content, { mode: previous.mode })
      else rmSync(file, { force: true })
    }
  }
}
