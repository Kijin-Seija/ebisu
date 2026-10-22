import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitStatus } from '../shared/types'
const execute = promisify(execFile)

/** porcelain v2 的 NUL 分隔记录可正确处理换行、空格和中文文件名。 */
export function parseGitStatus(output: string): GitStatus {
  const result: GitStatus = { branch: '', clean: true, added: 0, deleted: 0, modified: 0 }
  let oid = ''
  const records = output.split('\0')
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record.startsWith('# branch.head ')) result.branch = record.slice(14)
    else if (record.startsWith('# branch.oid ')) oid = record.slice(13)
    else if (record.startsWith('? ')) result.added++
    else if (/^[12u] /.test(record)) {
      const xy = record.split(' ', 3)[1]
      // 一条记录只计一次；重命名额外携带旧路径，必须跳过而非当作新记录。
      if (record[0] === '2') {
        result.modified++
        index++
      } else if (record[0] === 'u') result.modified++
      else if (xy.includes('D')) result.deleted++
      else if (xy.includes('A')) result.added++
      else result.modified++
    }
  }
  if (result.branch === '(detached)') result.branch = `detached · ${oid.slice(0, 7)}`
  result.branch ||= '未创建提交'
  result.clean = result.added + result.deleted + result.modified === 0
  return result
}

/** 无 shell 拼接，也不执行 fetch、checkout 或任何会修改仓库的操作。 */
export async function readGitStatus(directory: string): Promise<GitStatus | null> {
  try {
    const { stdout } = await execute(
      'git',
      ['-C', directory, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
      {
        encoding: 'utf8',
        timeout: 12000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
      }
    )
    return parseGitStatus(stdout)
  } catch (error) {
    const failure = error as Error & { stderr?: string }
    if (failure.stderr?.includes('not a git repository')) return null
    return {
      branch: 'Git 状态不可用',
      clean: false,
      added: 0,
      deleted: 0,
      modified: 0,
      error: failure.stderr?.trim() || failure.message
    }
  }
}
