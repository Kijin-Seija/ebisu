import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { request } from 'node:https'
import { Store } from '../src/main/database'
import { Skills } from '../src/main/skills'
import { Lan, isLocalAddress } from '../src/main/lan'
import { packageHash, SkillTransfer } from '../src/main/skill-transfer'
import { renameSkillPackage } from '../src/shared/skill-import'
import { deviceViews } from '../src/renderer/src/device-views'
import type { SkillPackage } from '../src/shared/skills'
import type { Snapshot } from '../src/shared/types'

const discoveryEvents = vi.hoisted(() => ({ browsers: [] as import('node:events').EventEmitter[] }))
vi.mock('bonjour-service', async () => {
  const { EventEmitter } = await import('node:events')
  class Browser extends EventEmitter {
    stop() {}
    update() {}
  }
  class Service extends EventEmitter {
    stop() {}
  }
  return {
    Bonjour: class {
      publish() {
        return new Service()
      }
      find() {
        const browser = new Browser()
        discoveryEvents.browsers.push(browser)
        return browser
      }
      destroy() {}
    }
  }
})

let root: string
let oldHome: string | undefined
let at: number
const instances: { store: Store; skills: Skills; lan: Lan; directory: string }[] = []
const pkg = (name = 'remote-tool'): SkillPackage => ({
  version: 1,
  name,
  description: 'portable',
  files: {
    'SKILL.md': {
      content: `---\nname: ${name}\ndescription: portable\n---\nrun --skill ${name} --path "$PWD"\nrun --skill='${name}'\nscript scripts/${name}.sh\n`
    },
    [`scripts/${name}.sh`]: { content: `echo '${name}'\nrun --skill="${name}"`, executable: true },
    'logo.bin': { content: 'AAE=', encoding: 'base64' }
  },
  variables: [
    {
      name: 'TOKEN',
      description: 'private',
      type: 'string',
      required: true,
      sensitive: true,
      scopes: ['skill']
    },
    {
      name: 'MODE',
      description: 'mode',
      type: 'string',
      required: false,
      sensitive: false,
      scopes: ['skill'],
      defaultValue: 'original-default'
    }
  ]
})
async function make(discovery = false) {
  const directory = path.join(root, `device-${instances.length}`)
  const home = path.join(directory, 'home')
  mkdirSync(home, { recursive: true })
  const store = new Store(path.join(directory, 'state.sqlite'))
  const skills = new Skills(store, {
    dataDirectory: directory,
    home,
    client: '/fake/skills',
    resources: directory
  })
  const lan = new Lan(store, skills, {
    directory,
    discovery,
    now: () => at,
    changed() {},
    snapshot: async () => ({
      folders: store.folders().map((folder) => ({
        ...folder,
        available: true,
        git: null,
        sessions: store.sessions(folder.id)
      })),
      skills: skills.list()
    })
  })
  instances.push({ store, skills, lan, directory })
  await lan.initialize()
  return instances[instances.length - 1]
}
async function pair(a: Awaited<ReturnType<typeof make>>, b: Awaited<ReturnType<typeof make>>) {
  await a.lan.configure(true, 'Computer A')
  await b.lan.configure(true, 'Computer B')
  await b.lan.pair(a.lan.invitationString(`127.0.0.1:${a.lan.view().port}`))
  await a.lan.poll()
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ebisu-lan-'))
  oldHome = process.env.HOME
  process.env.HOME = root
  at = Date.now()
})
afterEach(async () => {
  await Promise.all(instances.map(({ lan }) => lan.close()))
  for (const { store } of instances) store.close()
  instances.length = 0
  discoveryEvents.browsers.length = 0
  if (oldHome === undefined) delete process.env.HOME
  else process.env.HOME = oldHome
  rmSync(root, { recursive: true, force: true })
})
function raw(client: Awaited<ReturnType<typeof make>>, port: number, route: string, headers = {}) {
  const identity = JSON.parse(
    readFileSync(path.join(client.directory, 'lan-identity.json'), 'utf8')
  )
  return new Promise<{ status: number; body: string; etag?: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        key: identity.private,
        cert: identity.cert,
        rejectUnauthorized: false,
        headers,
        timeout: 5000
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode!, body, etag: res.headers.etag }))
      }
    )
    req.once('error', reject)
    req.end()
  })
}
it('默认关闭、证书持久化且权限为 0600，配对后只读拉取本机项目，不污染本机表', async () => {
  const a = await make()
  const b = await make()
  expect(a.lan.view().enabled).toBe(false)
  expect(statSync(path.join(a.directory, 'lan-identity.json')).mode & 0o777).toBe(0o600)
  const folder = a.store.addFolder(a.directory)
  a.store.activity({
    path: folder.path,
    terminal: 'codex',
    sessionId: 'same-id',
    action: 'enter',
    phase: 'waiting'
  })
  await pair(a, b)
  expect(b.lan.view().peers[0]).toMatchObject({
    id: a.lan.device().id,
    online: true,
    snapshot: {
      folders: [{ id: folder.id, sessions: [{ sessionId: 'same-id', phase: 'waiting' }] }]
    }
  })
  expect(b.store.folders()).toHaveLength(0)
  expect(b.store.db.prepare('SELECT * FROM activities').all()).toHaveLength(0)
  expect(a.lan.view().peers[0].snapshot?.folders).toHaveLength(0)
  const before = b.store.db.prepare('SELECT value FROM lan_peers').get() as { value: string }
  at += 1000
  await b.lan.poll()
  const after = b.store.db.prepare('SELECT value FROM lan_peers').get() as { value: string }
  expect(JSON.parse(after.value).etag).toBe(JSON.parse(before.value).etag)
  expect(b.lan.view().peers[0].lastSeen).toBe(at)
  const full = await raw(b, a.lan.view().port!, '/lan/v1/snapshot')
  const unchanged = await raw(b, a.lan.view().port!, '/lan/v1/snapshot', {
    'If-None-Match': full.etag!
  })
  expect(unchanged).toMatchObject({ status: 304, body: '' })
})
it('设备证书 pin 校验在发送邀请前完成；过期、重复邀请及未配对证书不能访问', async () => {
  const a = await make()
  const b = await make()
  const c = await make()
  await a.lan.configure(true, 'A')
  await b.lan.configure(true, 'B')
  const invite = a.lan.invitationString(`127.0.0.1:${a.lan.view().port}`)
  const decoded = JSON.parse(Buffer.from(invite.slice(11), 'base64url').toString())
  const forged = `ebisu-pair:${Buffer.from(JSON.stringify({ ...decoded, fingerprint: 'a'.repeat(64) })).toString('base64url')}`
  await expect(b.lan.pair(forged)).rejects.toThrow('证书不匹配')
  expect(a.lan.view().peers).toHaveLength(0)
  expect((await raw(c, a.lan.view().port!, '/lan/v1/snapshot')).status).toBe(401)
  at += 300001
  await expect(b.lan.pair(invite)).rejects.toThrow('过期')
  const fresh = a.lan.invitationString(`127.0.0.1:${a.lan.view().port}`)
  await b.lan.pair(fresh)
  await expect(b.lan.pair(fresh)).rejects.toThrow('邀请无效')
  expect(
    (await raw(b, a.lan.view().port!, '/lan/v1/snapshot', { Origin: 'https://web.example' })).status
  ).toBe(401)
  expect((await raw(b, a.lan.view().port!, '/v1/skills/run')).status).toBe(404)
  a.lan.unpair(b.lan.device().id)
  expect((await raw(b, a.lan.view().port!, '/lan/v1/snapshot')).status).toBe(401)
  expect(a.lan.view().peers).toHaveLength(0)
})
it('离线缓存保留、重新启用恢复；重启保留设备与配对身份，手动地址可恢复连接', async () => {
  const a = await make()
  const b = await make()
  a.store.addFolder(a.directory)
  await pair(a, b)
  const originalId = a.lan.device().id
  const originalCache = b.lan.view().peers[0].snapshot
  await a.lan.configure(false, 'Computer A')
  at += 16000
  expect(b.lan.view().peers[0]).toMatchObject({ online: false, snapshot: originalCache })
  await a.lan.close()
  const restarted = new Lan(a.store, a.skills, {
    directory: a.directory,
    discovery: false,
    now: () => at,
    changed() {},
    snapshot: async () => ({ folders: [], skills: [] })
  })
  a.lan = restarted
  await restarted.initialize()
  expect(restarted.device().id).toBe(originalId)
  expect(restarted.view().peers[0].id).toBe(b.lan.device().id)
  await restarted.configure(true, 'Computer A')
  await b.lan.pair(
    restarted.invitationString(`127.0.0.1:${restarted.view().port}`),
    `127.0.0.1:${restarted.view().port}`
  )
  expect(b.lan.view().peers[0]).toMatchObject({ online: true, snapshot: { folders: [] } })
})
it('导出只有源文件和当前变量定义，不传播经验、配置和终端记录，文件篡改阻止导出', async () => {
  const a = await make()
  const b = await make()
  const skill = a.skills.create(pkg(), 'source')
  a.skills.setVariable(skill.id, 'MODE', { scope: 'skill' }, 'private-value')
  a.skills.addExperience({ skillId: skill.id, content: 'private experience', evidence: 'checked' })
  await pair(a, b)
  const exported = await b.lan.remoteSkill(a.lan.device().id, skill.id)
  expect(JSON.stringify(exported)).not.toMatch(
    /private-value|original-default|private experience|installations|experiences/
  )
  expect(exported.package.files['logo.bin'].content).toBe('AAE=')
  const draft = await b.lan.prepareImport(a.lan.device().id, skill.id)
  const id = b.lan.transfer.confirm(draft.id, { name: skill.name, texts: {} })
  expect(b.skills.detail(id)).toMatchObject({
    name: skill.name,
    experiences: [],
    installations: []
  })
  expect(b.skills.variables(id).every((variable) => !variable.global.hasValue)).toBe(true)
  const provenance = b.store.db.prepare('SELECT * FROM lan_imports').get()
  expect(provenance).toMatchObject({
    deviceId: a.lan.device().id,
    originalSkillId: skill.id,
    originalHash: exported.hash
  })
  writeFileSync(path.join(a.skills.root, skill.id, 'SKILL.md'), 'modified')
  await expect(b.lan.remoteSkill(a.lan.device().id, skill.id)).rejects.toThrow('外部修改')
})
it('同内容去重、异内容冲突；改名仅更新标准引用，草稿可编辑且确认重试幂等', async () => {
  const a = await make()
  const b = await make()
  const source = a.skills.create(pkg(), 'source')
  const exported = a.lan.transfer.export(source.id)
  const first = b.lan.transfer.prepare(a.lan.device(), exported)
  const id = b.lan.transfer.confirm(first.id, { name: 'remote-tool', texts: {} })
  const identical = b.lan.transfer.prepare(a.lan.device(), exported)
  expect(identical.existingId).toBe(id)
  expect(b.lan.transfer.confirm(identical.id, { name: 'remote-tool', texts: {} })).toBe(id)
  const different = structuredClone(exported)
  different.package.description = 'different'
  different.hash = packageHash(different.package)
  const draft = b.lan.transfer.prepare(a.lan.device(), different)
  expect(draft.conflict).toBe(true)
  expect(() => b.lan.transfer.confirm(draft.id, { name: 'remote-tool', texts: {} })).toThrow('改名')
  const edited = renameSkillPackage(different.package, 'new-tool')
  expect(edited.files['SKILL.md'].content).toContain('name: new-tool')
  expect(edited.files['SKILL.md'].content).toContain("--skill='new-tool'")
  expect(edited.files['SKILL.md'].content).toContain('scripts/remote-tool.sh')
  expect(edited.files['scripts/remote-tool.sh'].content).toBe(
    'echo \'remote-tool\'\nrun --skill="new-tool"'
  )
  const edit = {
    name: 'new-tool',
    texts: { 'SKILL.md': edited.files['SKILL.md'].content + '\nmanual correction\n' }
  }
  const renamed = b.lan.transfer.confirm(draft.id, edit)
  expect(b.skills.detail(renamed).package.files['SKILL.md'].content).toContain('manual correction')
  expect(b.lan.transfer.confirm(draft.id, edit)).toBe(renamed)
  expect(() => b.lan.transfer.confirm(draft.id, { ...edit, name: 'other' })).toThrow('重试内容')
  expect(b.skills.list()).toHaveLength(2)
})
it('确认重新校验名称、frontmatter 和路径，失败不留目录，事务失败回滚文件', async () => {
  const a = await make()
  const b = await make()
  const skill = a.skills.create(pkg(), 'source')
  const exported = a.lan.transfer.export(skill.id)
  const draft = b.lan.transfer.prepare(a.lan.device(), exported)
  expect(() => b.lan.transfer.confirm(draft.id, { name: 'ebisu-reserved', texts: {} })).toThrow()
  expect(() =>
    b.lan.transfer.confirm(draft.id, { name: 'safe', texts: { 'SKILL.md': 'no frontmatter' } })
  ).toThrow()
  expect(() =>
    b.lan.transfer.confirm(draft.id, { name: 'safe', texts: { '../outside': 'bad' } })
  ).toThrow('已有文本')
  expect(() =>
    b.lan.transfer.confirm(draft.id, {
      name: 'safe',
      texts: { 'SKILL.md': 'a'.repeat(4 * 1024 * 1024 + 1) }
    })
  ).toThrow()
  b.store.db.exec(
    "CREATE TRIGGER fail_import BEFORE INSERT ON lan_imports BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END"
  )
  expect(() => b.lan.transfer.confirm(draft.id, { name: 'safe', texts: {} })).toThrow(
    'fixture rollback'
  )
  expect(b.skills.list()).toHaveLength(0)
  const { readdirSync } = await import('node:fs')
  expect(readdirSync(b.skills.root)).toHaveLength(0)
  const malicious = structuredClone(exported)
  malicious.package.files['../escape'] = { content: 'bad' }
  malicious.hash = packageHash(malicious.package)
  const unsafe = b.lan.transfer.prepare(a.lan.device(), malicious)
  expect(() => b.lan.transfer.confirm(unsafe.id, { name: 'unsafe', texts: {} })).toThrow()
  at += 15 * 60_000 + 1
  expect(() => b.lan.transfer.confirm(draft.id, { name: 'safe', texts: {} })).toThrow('过期')
})
it('按设备隔离相同项目和会话 ID，远端会话标记禁止本机跳转，过滤只影响视图', async () => {
  const a = await make()
  const b = await make()
  const folder = a.store.addFolder(a.directory)
  a.store.activity({
    path: folder.path,
    terminal: 'codex',
    sessionId: 'duplicate',
    action: 'enter'
  })
  await pair(a, b)
  const remote = b.lan.view().peers[0].snapshot!
  const snapshot: Snapshot = {
    folders: structuredClone(remote.folders),
    skills: [],
    integrations: [],
    settings: { theme: 'system', avatars: {} },
    service: { running: true, port: 1 },
    lan: b.lan.view()
  }
  const views = deviceViews(snapshot, 'all')
  expect(views.folders).toHaveLength(2)
  expect(new Set(views.folders.map((item) => `${item.deviceId}:${item.id}`)).size).toBe(2)
  expect(views.folders[1].sessions[0].remoteDeviceId).toBe(a.lan.device().id)
  expect(views.folders[0].sessions[0].remoteDeviceId).toBeUndefined()
  expect(deviceViews(snapshot, 'local').folders).toHaveLength(1)
  expect(snapshot.folders[0].sessions[0].remoteDeviceId).toBeUndefined()
  expect(isLocalAddress('8.8.8.8')).toBe(false)
  expect(isLocalAddress('172.16.1.1')).toBe(true)
})
it('错误协议和非局域网邀请被拒绝，默认值与不匹配哈希不可进入导入草稿', async () => {
  const a = await make()
  const b = await make()
  await a.lan.configure(true, 'A')
  await b.lan.configure(true, 'B')
  const invitation = a.lan.invitationString(`127.0.0.1:${a.lan.view().port}`)
  const input = JSON.parse(Buffer.from(invitation.slice(11), 'base64url').toString())
  const encode = (data: unknown) =>
    `ebisu-pair:${Buffer.from(JSON.stringify(data)).toString('base64url')}`
  await expect(
    b.lan.pair(encode({ ...input, device: { ...input.device, protocol: 2 } }))
  ).rejects.toThrow('协议版本')
  await expect(b.lan.pair(invitation, '8.8.8.8:443')).rejects.toThrow()
  const exportWithDefault = { skillId: a.lan.device().id, package: pkg(), hash: packageHash(pkg()) }
  expect(() => b.lan.transfer.prepare(a.lan.device(), exportWithDefault)).toThrow('默认取值')
  exportWithDefault.package.variables = []
  expect(() => b.lan.transfer.prepare(a.lan.device(), exportWithDefault)).toThrow('校验失败')
})

it('关闭共享会释放尚未完成 TLS 握手的连接，开启状态下重启仍保留身份和缓存', async () => {
  const a = await make()
  const b = await make()
  await pair(a, b)
  const identity = b.lan.device()
  const cached = b.lan.view().peers[0].snapshot
  const { connect } = await import('node:net')
  const socket = connect(b.lan.view().port!, '127.0.0.1')
  socket.on('error', () => {})
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  await b.lan.close()
  socket.destroy()
  const restarted = new Lan(b.store, b.skills, {
    directory: b.directory,
    discovery: false,
    now: () => at,
    changed() {},
    snapshot: async () => ({ folders: [], skills: [] })
  })
  b.lan = restarted
  await restarted.initialize()
  expect(restarted.device()).toEqual(identity)
  expect(restarted.view()).toMatchObject({ enabled: true, peers: [{ snapshot: cached }] })
  await restarted.poll()
  expect(restarted.view().peers[0].online).toBe(true)
  await restarted.resume()
  expect(restarted.view().port).not.toBeNull()
})

it('多设备互联只发布本机数据，不转发第三台的项目和配对关系', async () => {
  const a = await make()
  const b = await make()
  const c = await make()
  a.store.addFolder(a.directory)
  await pair(a, b)
  await c.lan.configure(true, 'C')
  await c.lan.pair(b.lan.invitationString(`127.0.0.1:${b.lan.view().port}`))
  expect(c.lan.view().peers).toHaveLength(1)
  expect(c.lan.view().peers[0].snapshot?.folders).toHaveLength(0)
  expect(c.lan.view().peers.some((peer) => peer.id === a.lan.device().id)).toBe(false)
})

it('改名保留 CRLF 与路径，只改独立调用参数；超大包确认时被拒绝', async () => {
  const a = await make()
  const b = await make()
  const original = pkg('sample')
  original.files['SKILL.md'].content =
    original.files['SKILL.md'].content.replaceAll('\n', '\r\n') +
    '\nx--skill sample\n--skill sample-other\n'
  const renamed = renameSkillPackage(original, 'renamed')
  expect(renamed.files['SKILL.md'].content).toContain('name: renamed\r\n')
  expect(renamed.files['SKILL.md'].content).toContain('x--skill sample')
  expect(renamed.files['SKILL.md'].content).toContain('--skill sample-other')
  const source = a.skills.create(pkg(), 'source')
  const exported = a.lan.transfer.export(source.id)
  const tooLarge = structuredClone(exported)
  tooLarge.package.files['a.txt'] = { content: 'a'.repeat(4 * 1024 * 1024) }
  tooLarge.package.files['b.txt'] = { content: 'b'.repeat(4 * 1024 * 1024) }
  tooLarge.hash = packageHash(tooLarge.package)
  const draft = b.lan.transfer.prepare(a.lan.device(), tooLarge)
  expect(() => b.lan.transfer.confirm(draft.id, { name: 'large', texts: {} })).toThrow('8 MiB')
  expect(b.skills.list()).toHaveLength(0)
})

it('本机同名源文件损坏时仍可准备并改名导入，不覆盖原文件', async () => {
  const a = await make()
  const b = await make()
  const source = a.skills.create(pkg(), 'source')
  const local = b.skills.create(pkg(), 'local')
  const originalPath = path.join(b.skills.root, local.id, 'SKILL.md')
  writeFileSync(originalPath, 'external edit')
  const draft = b.lan.transfer.prepare(a.lan.device(), a.lan.transfer.export(source.id))
  expect(draft.conflict).toBe(true)
  const imported = b.lan.transfer.confirm(draft.id, { name: 'another-tool', texts: {} })
  expect(b.skills.detail(imported).name).toBe('another-tool')
  expect(readFileSync(originalPath, 'utf8')).toBe('external edit')
})

it('发现新的端口须先通过已配对证书认证，伪造发现不能替换可信地址', async () => {
  const a = await make(true)
  const b = await make(true)
  const c = await make()
  await pair(a, b)
  await c.lan.configure(true, 'untrusted')
  const browser = discoveryEvents.browsers[1]
  const originalAddress = b.lan.view().peers[0].address
  const announce = (port: number) =>
    browser.emit('srv-update', { txt: a.lan.device(), addresses: ['127.0.0.1'], port })
  announce(c.lan.view().port!)
  await b.lan.poll()
  expect(b.lan.view().peers[0]).toMatchObject({ address: originalAddress, online: true })
  await a.lan.resume()
  const nextAddress = `127.0.0.1:${a.lan.view().port}`
  announce(a.lan.view().port!)
  await b.lan.poll()
  expect(b.lan.view().peers[0]).toMatchObject({ address: nextAddress, online: true })
})
