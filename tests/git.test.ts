import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseGitStatus, readGitStatus } from '../src/main/git'

let root: string
const git = (...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' })
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ebisu-git-'))
  git('init', '-b', 'main')
  git('config', 'user.name', 'Ebisu Test')
  git('config', 'user.email', 'test@ebisu.local')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function commit() {
  git('add', '.')
  git('commit', '-m', 'fixture')
}

it('空仓库有分支且 clean，普通目录没有 Git 状态', async () => {
  expect(await readGitStatus(root)).toMatchObject({ branch: 'main', clean: true })
  const ordinary = mkdtempSync(path.join(tmpdir(), 'ebisu-ordinary-'))
  try {
    expect(await readGitStatus(ordinary)).toBeNull()
  } finally {
    rmSync(ordinary, { recursive: true })
  }
})
it('按文件统计 staged/unstaged，支持中文与换行文件名', async () => {
  writeFileSync(path.join(root, 'modify.txt'), 'a')
  writeFileSync(path.join(root, 'delete.txt'), 'b')
  commit()
  writeFileSync(path.join(root, 'modify.txt'), 'c')
  git('add', 'modify.txt')
  writeFileSync(path.join(root, 'modify.txt'), 'd')
  rmSync(path.join(root, 'delete.txt'))
  writeFileSync(path.join(root, '中文\n文件.txt'), 'new')
  expect(await readGitStatus(root)).toMatchObject({
    clean: false,
    added: 1,
    deleted: 1,
    modified: 1
  })
})
it('重命名按一个修改文件统计，旧路径不会被解析成另一条记录', async () => {
  writeFileSync(path.join(root, 'old'), 'hello')
  commit()
  git('mv', 'old', 'new')
  expect(await readGitStatus(root)).toMatchObject({ added: 0, deleted: 0, modified: 1 })
})
it('worktree 与 detached HEAD 分别读取自身状态', async () => {
  writeFileSync(path.join(root, 'file'), 'hello')
  commit()
  const worktree = `${root}-worktree`
  try {
    git('worktree', 'add', '-b', 'feature', worktree)
    writeFileSync(path.join(worktree, 'new'), 'x')
    expect(await readGitStatus(worktree)).toMatchObject({ branch: 'feature', added: 1 })
    expect(await readGitStatus(root)).toMatchObject({ branch: 'main', clean: true })
    git('checkout', '--detach')
    expect((await readGitStatus(root))?.branch).toMatch(/^detached · [a-f0-9]{7}$/)
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})
it('真实合并冲突按一个修改文件统计', async () => {
  writeFileSync(path.join(root, 'file'), 'base\n')
  commit()
  git('checkout', '-b', 'other')
  writeFileSync(path.join(root, 'file'), 'other\n')
  commit()
  git('checkout', 'main')
  writeFileSync(path.join(root, 'file'), 'main\n')
  commit()
  try {
    git('merge', 'other')
  } catch {
    /* 预期出现合并冲突。 */
  }
  expect(await readGitStatus(root)).toMatchObject({ modified: 1, clean: false })
})
it('命令失败显示异常，而非错误标成 clean', async () => {
  const result = await readGitStatus(path.join(root, 'missing'))
  expect(result?.error).toBeTruthy()
  expect(result?.clean).toBe(false)
})
