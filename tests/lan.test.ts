import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync
} from 'node:fs'
import { createHash } from 'node:crypto'
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
import type { DeviceMetrics } from '../src/shared/lan'

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
/** 每个实例启动后创建的发现浏览器；测试用它向指定设备注入附近设备信息。 */
const browsers = new Map<Lan, import('node:events').EventEmitter>()
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
async function make(discovery = true, metrics?: () => DeviceMetrics | null) {
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
    metrics,
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
type Device = Awaited<ReturnType<typeof make>>
/** 开启共享并把当前实例新创建的发现浏览器记录下来。 */
async function start(device: Device, name: string) {
  const before = device.lan.view().port
  await device.lan.configure(true, name)
  const after = device.lan.view().port
  const latest = discoveryEvents.browsers[discoveryEvents.browsers.length - 1]
  if (latest && (after !== before || !browsers.has(device.lan))) browsers.set(device.lan, latest)
  return device
}
/** 用真实身份文件和证书指纹模拟一条 mDNS 发现记录。 */
function announce(
  target: Device,
  source: Device,
  overrides: { fingerprint?: string; protocol?: number; address?: string } = {}
) {
  const identity = JSON.parse(
    readFileSync(path.join(source.directory, 'lan-identity.json'), 'utf8')
  ) as { id: string; name: string; protocol: number; fingerprint: string }
  const browser = browsers.get(target.lan)
  if (!browser) throw new Error('目标设备没有发现浏览器')
  const address = overrides.address ?? '127.0.0.1'
  browser.emit('srv-update', {
    txt: {
      id: identity.id,
      name: identity.name,
      protocol: String(overrides.protocol ?? identity.protocol),
      fingerprint: overrides.fingerprint ?? identity.fingerprint
    },
    addresses: [address],
    port: source.lan.view().port!
  })
}
async function until(predicate: () => boolean, timeout = 5000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
/** 走完整配对流程：发起请求 -> 对方确认 -> 双方保存配对。 */
async function pair(a: Device, b: Device) {
  await start(a, 'Computer A')
  await start(b, 'Computer B')
  announce(b, a)
  const pending = b.lan.requestPair(a.lan.device().id)
  await until(() => a.lan.view().requests.length > 0)
  await a.lan.respondPair(a.lan.view().requests[0].id, true)
  await b.lan.poll()
  expect(await pending).toBe('paired')
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
it('附近设备请求配对后由对方确认，双方建立配对并从附近列表移除；拒绝不建立配对', async () => {
  const a = await make()
  const b = await make()
  await start(a, 'A')
  await start(b, 'B')
  announce(a, b)
  announce(b, a)
  expect(a.lan.view().discovered.map((device) => device.id)).toEqual([b.lan.device().id])
  const pending = b.lan.requestPair(a.lan.device().id)
  await until(() => a.lan.view().requests.length === 1)
  // 目标设备只看到待确认请求，尚未建立任何访问权限。
  expect(a.lan.view().requests[0]).toMatchObject({ device: { name: 'B' } })
  expect(a.lan.view().peers).toHaveLength(0)
  await a.lan.respondPair(a.lan.view().requests[0].id, true)
  await b.lan.poll()
  expect(await pending).toBe('paired')
  expect(a.lan.view().requests).toHaveLength(0)
  expect(a.lan.view().peers.map((peer) => peer.id)).toEqual([b.lan.device().id])
  expect(b.lan.view().peers.map((peer) => peer.id)).toEqual([a.lan.device().id])
  expect(a.lan.view().discovered).toHaveLength(0)
  expect(b.lan.view().discovered).toHaveLength(0)
  a.lan.unpair(b.lan.device().id)
  b.lan.unpair(a.lan.device().id)
  announce(b, a)
  const declined = b.lan.requestPair(a.lan.device().id)
  await until(() => a.lan.view().requests.length === 1)
  await a.lan.respondPair(a.lan.view().requests[0].id, false)
  await b.lan.poll()
  expect(await declined).toBe('declined')
  expect(a.lan.view().peers).toHaveLength(0)
  expect(b.lan.view().peers).toHaveLength(0)
})
it('配对必须由对方确认；错误证书指纹、过期请求、重复确认及未配对证书均被拒绝', async () => {
  const a = await make()
  const b = await make()
  const c = await make()
  await start(a, 'A')
  await start(b, 'B')
  // 发现信息中的指纹与真实证书不匹配时，连接在发送请求体前就被拒绝。
  announce(b, a, { fingerprint: 'a'.repeat(64) })
  await expect(b.lan.requestPair(a.lan.device().id)).rejects.toThrow('证书不匹配')
  expect(a.lan.view().requests).toHaveLength(0)
  expect(a.lan.view().peers).toHaveLength(0)
  expect((await raw(c, a.lan.view().port!, '/lan/v1/snapshot')).status).toBe(401)
  announce(b, a)
  const expired = b.lan.requestPair(a.lan.device().id)
  await until(() => a.lan.view().requests.length === 1)
  const stale = a.lan.view().requests[0]
  at += 300001
  await expect(a.lan.respondPair(stale.id, true)).rejects.toThrow('过期')
  await b.lan.poll()
  expect(await expired).toBe('pending')
  const pending = b.lan.requestPair(a.lan.device().id)
  await until(() => a.lan.view().requests.length === 1)
  const fresh = a.lan.view().requests[0]
  expect(fresh.id).not.toBe(stale.id)
  await a.lan.respondPair(fresh.id, true)
  await expect(a.lan.respondPair(fresh.id, true)).rejects.toThrow('不存在')
  await b.lan.poll()
  expect(await pending).toBe('paired')
  expect(
    (await raw(b, a.lan.view().port!, '/lan/v1/snapshot', { Origin: 'https://web.example' })).status
  ).toBe(401)
  expect((await raw(b, a.lan.view().port!, '/v1/skills/run')).status).toBe(404)
  a.lan.unpair(b.lan.device().id)
  expect((await raw(b, a.lan.view().port!, '/lan/v1/snapshot')).status).toBe(401)
  expect(a.lan.view().peers).toHaveLength(0)
})
it('离线缓存保留、重新启用恢复；重启保留设备与配对身份，重新发现后自动恢复连接', async () => {
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
    discovery: true,
    now: () => at,
    changed() {},
    snapshot: async () => ({ folders: [], skills: [] })
  })
  a.lan = restarted
  await restarted.initialize()
  expect(restarted.device().id).toBe(originalId)
  expect(restarted.view().peers[0].id).toBe(b.lan.device().id)
  await start(a, 'Computer A')
  // 端口变化由发现信息更新，不再需要手动填写对端地址。
  announce(b, a)
  await b.lan.poll()
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
it('删除技能后清理局域网导入记录；对端导出与经验写入返回不存在，同名可重新导入', async () => {
  const a = await make()
  const b = await make()
  const source = a.skills.create(pkg(), 'source')
  await pair(a, b)
  const draft = await b.lan.prepareImport(a.lan.device().id, source.id)
  const imported = b.lan.transfer.confirm(draft.id, { name: source.name, texts: {} })
  expect(b.store.db.prepare('SELECT COUNT(*) AS n FROM lan_imports').get()).toEqual({ n: 1 })
  b.skills.delete(imported, source.name)
  expect(b.store.db.prepare('SELECT COUNT(*) AS n FROM lan_imports').get()).toEqual({ n: 0 })
  // 草稿已消费，重试确认不会返回指向已删除技能的旧 ID。
  expect(() => b.lan.transfer.confirm(draft.id, { name: source.name, texts: {} })).toThrow('过期')
  const again = await b.lan.prepareImport(a.lan.device().id, source.id)
  expect(again).toMatchObject({ existingId: null, conflict: false })
  const reimported = b.lan.transfer.confirm(again.id, { name: source.name, texts: {} })
  expect(reimported).not.toBe(imported)
  // 源端删除后：已缓存的技能 ID 导出与经验写入均为 404，不影响服务。
  const experience = a.skills.addExperience({
    skillId: source.id,
    content: '源经验',
    evidence: '验证'
  })
  const local = b.skills.addExperience({ skillId: reimported, content: '经验', evidence: '验证' })
  a.skills.delete(source.id, source.name)
  await expect(b.lan.remoteSkill(a.lan.device().id, source.id)).rejects.toThrow('技能不存在')
  await expect(
    b.lan.copyExperiences({
      ids: [local.id],
      targetDeviceId: a.lan.device().id,
      targetSkillId: source.id,
      folderMap: {}
    })
  ).rejects.toThrow('技能不存在')
  expect(() => a.skills.experiences([experience.id])).toThrow('经验不存在')
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
it('协议不兼容或非局域网的发现记录不能发起配对，默认值与不匹配哈希不可进入导入草稿', async () => {
  const a = await make()
  const b = await make()
  await start(a, 'A')
  await start(b, 'B')
  announce(b, a, { address: '8.8.8.8' })
  await expect(b.lan.requestPair(a.lan.device().id)).rejects.toThrow('附近没有这台设备')
  announce(b, a, { protocol: 2 })
  await expect(b.lan.requestPair(a.lan.device().id)).rejects.toThrow('协议版本不兼容')
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
  await pair(b, c)
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
  const a = await make()
  const b = await make()
  const c = await make()
  await pair(a, b)
  await start(c, 'untrusted')
  const browser = browsers.get(b.lan)!
  const originalAddress = b.lan.view().peers[0].address
  const announcePort = (port: number) =>
    browser.emit('srv-update', { txt: a.lan.device(), addresses: ['127.0.0.1'], port })
  announcePort(c.lan.view().port!)
  await b.lan.poll()
  expect(b.lan.view().peers[0]).toMatchObject({ address: originalAddress, online: true })
  await a.lan.resume()
  const nextAddress = `127.0.0.1:${a.lan.view().port}`
  announcePort(a.lan.view().port!)
  await b.lan.poll()
  expect(b.lan.view().peers[0]).toMatchObject({ address: nextAddress, online: true })
})

it('Agent 对话：写入立即推送到对端，双向回复，对端可按名称加入频道', async () => {
  const a = await make()
  const b = await make()
  await pair(a, b)
  const channel = a.lan.chat.createChannel({
    id: 'bug/STRATEGY-1',
    devices: ['Computer B'],
    members: ['a/claude']
  })
  expect(channel.devices).toEqual([a.lan.device().id, b.lan.device().id])
  await until(() => !!b.lan.chat.channel('bug/STRATEGY-1'))
  const waiting = b.lan.chat.wait({ member: 'b/qoder', channels: ['bug/STRATEGY-1'], timeout: 5 })
  a.lan.chat.post({ channel: 'bug/STRATEGY-1', from: 'a/claude', body: '请修复' })
  expect((await waiting).map((m) => m.body)).toEqual(['请修复'])
  b.lan.chat.post({ channel: 'bug/STRATEGY-1', from: 'b/qoder', body: '已修复' })
  expect(
    (await a.lan.chat.wait({ member: 'a/claude', channels: ['*'], timeout: 5 })).map((m) => m.body)
  ).toEqual(['已修复'])
  // 两端历史一致，频道摘要进入 LAN 视图
  expect(b.lan.chat.history('bug/STRATEGY-1').map((m) => m.id)).toEqual(
    a.lan.chat.history('bug/STRATEGY-1').map((m) => m.id)
  )
  expect(a.lan.view().chats[0]).toMatchObject({ id: 'bug/STRATEGY-1', count: 2 })
})

it('Agent 对话：推送失败时由轮询同步补齐，并经中间设备转发给未直接配对的设备', async () => {
  const a = await make()
  const b = await make()
  const c = await make()
  await pair(a, b)
  // c 只与 b 配对
  await start(c, 'Computer C')
  announce(c, b)
  const pending = c.lan.requestPair(b.lan.device().id)
  await until(() => b.lan.view().requests.length > 0)
  await b.lan.respondPair(b.lan.view().requests[0].id, true)
  await c.lan.poll()
  expect(await pending).toBe('paired')
  await b.lan.poll()
  // 频道包含三台设备：c 由 b 创建时加入，a 再通过并集合并得到 c
  b.lan.chat.createChannel({ id: 'control', devices: [a.lan.device().id, c.lan.device().id] })
  await until(() => !!a.lan.chat.channel('control') && !!c.lan.chat.channel('control'))
  expect(a.lan.chat.channel('control')!.devices).toHaveLength(3)
  // 关闭 a 的即时推送，验证版本向量同步
  ;(a.lan as unknown as { pushChat: () => void }).pushChat = () => {}
  for (let i = 1; i <= 3; i++)
    a.lan.chat.post({ channel: 'control', from: 'a/main', body: `m${i}` })
  expect(b.lan.chat.history('control')).toHaveLength(0)
  await b.lan.poll()
  expect(b.lan.chat.history('control').map((m) => m.body)).toEqual(['m1', 'm2', 'm3'])
  // c 与 a 未配对，经 b 同步获得 a 的消息
  await c.lan.poll()
  expect(c.lan.chat.history('control').map((m) => m.body)).toEqual(['m1', 'm2', 'm3'])
  expect(c.lan.chat.history('control')[0].origin).toBe(a.lan.device().id)
  // 重复同步不会产生重复消息
  await b.lan.poll()
  await c.lan.poll()
  expect(c.lan.chat.history('control')).toHaveLength(3)
})

it('Agent 对话图片：对端同步后拉取文件且哈希一致，非频道设备被拒，删除频道后对端图片删除', async () => {
  const a = await make()
  const b = await make()
  const c = await make()
  await pair(a, b)
  // c 与 a 配对但不在频道内
  await start(c, 'Computer C')
  announce(c, a)
  const pending = c.lan.requestPair(a.lan.device().id)
  await until(() => a.lan.view().requests.length > 0)
  await a.lan.respondPair(a.lan.view().requests[0].id, true)
  await c.lan.poll()
  expect(await pending).toBe('paired')
  await a.lan.poll()
  a.lan.chat.createChannel({ id: 'bug/IMG-1', devices: [b.lan.device().id] })
  await until(() => !!b.lan.chat.channel('bug/IMG-1'))
  const image = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('lan image payload')
  ])
  const hash = createHash('sha256').update(image).digest('hex')
  const uploaded = a.lan.chat.uploadFile({
    channel: 'bug/IMG-1',
    name: 'screen.png',
    data: image.toString('base64')
  })
  expect(uploaded.path).toBe(path.join(a.directory, 'chat-files', `${hash}.png`))
  a.lan.chat.post({
    channel: 'bug/IMG-1',
    from: 'a/claude',
    body: '看截图',
    attachments: [{ hash }]
  })
  // 推送到达后 B 后台拉取图片；轮询同样会补拉
  await until(() => !!b.lan.chat.history('bug/IMG-1')[0]?.attachments?.[0]?.path)
  const local = b.lan.chat.history('bug/IMG-1')[0].attachments![0]
  expect(local).toMatchObject({ hash, name: 'screen.png', mime: 'image/png', size: image.length })
  expect(local.path).toBe(path.join(b.directory, 'chat-files', `${hash}.png`))
  expect(createHash('sha256').update(readFileSync(local.path!)).digest('hex')).toBe(hash)
  expect(b.lan.chat.summaries()[0].pendingFiles).toBe(0)
  // 频道 ID 含 /，路径中需编码；成员可读取，非成员与未配对设备被拒
  const route = `/lan/v1/chat/files/${encodeURIComponent('bug/IMG-1')}/${hash}`
  expect((await raw(b, a.lan.view().port!, route)).status).toBe(200)
  expect((await raw(c, a.lan.view().port!, route)).status).toBe(403)
  // A 删除频道：删除标记推送到 B，B 的图片随频道删除
  a.lan.chat.deleteChannel('bug/IMG-1')
  expect(existsSync(uploaded.path!)).toBe(false)
  await until(() => !b.lan.chat.channel('bug/IMG-1'))
  expect(existsSync(local.path!)).toBe(false)
})

it('Agent 对话：未配对证书无法访问对话接口', async () => {
  const a = await make()
  const stranger = await make()
  await start(a, 'Computer A')
  await start(stranger, 'Stranger')
  const response = await raw(stranger, a.lan.view().port!, '/lan/v1/chat/sync')
  expect(response.status).toBe(401)
})

/** 以指定设备证书直接 POST JSON，用于验证未配对证书无法写入。 */
function postJson(client: Device, port: number, route: string, body: unknown) {
  const identity = JSON.parse(
    readFileSync(path.join(client.directory, 'lan-identity.json'), 'utf8')
  )
  const encoded = JSON.stringify(body)
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        key: identity.private,
        cert: identity.cert,
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(encoded)
        },
        timeout: 5000
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode!, body: text }))
      }
    )
    req.once('error', reject)
    req.end(encoded)
  })
}
it('经验复制到已配对设备：项目映射到对端项目、重复跳过、未配对拒绝、项目不存在整批不写', async () => {
  const a = await make()
  const b = await make()
  const stranger = await make()
  for (const device of [a, b]) mkdirSync(path.join(device.directory, 'shared-project'))
  const sourceFolder = a.store.addFolder(path.join(a.directory, 'shared-project'))
  const targetFolder = b.store.addFolder(path.join(b.directory, 'shared-project'))
  const source = a.skills.create(pkg(), 'source')
  const target = b.skills.create(pkg('target-tool'), 'target')
  const general = a.skills.addExperience({
    skillId: source.id,
    content: '远程通用经验',
    evidence: '已验证'
  })
  const scoped = a.skills.addExperience({
    skillId: source.id,
    folderId: sourceFolder.id,
    content: '远程项目经验',
    evidence: '项目内验证'
  })
  await pair(a, b)
  await start(stranger, 'Stranger')
  const request = {
    ids: [general.id, scoped.id],
    targetDeviceId: b.lan.device().id,
    targetSkillId: target.id,
    folderMap: { [sourceFolder.id]: targetFolder.id }
  }
  expect(await a.lan.copyExperiences(request)).toEqual({ added: 2, skipped: 0 })
  const copied = b.skills.detail(target.id).experiences
  expect(copied.map((item) => [item.content, item.folderId]).sort()).toEqual([
    ['远程通用经验', null],
    ['远程项目经验', targetFolder.id]
  ])
  expect(copied.find((item) => item.folderId === null)!.evidence).toBe(
    `已验证\n（复制自 Computer A/remote-tool 经验 ${general.id}）`
  )
  // 重复复制幂等。
  expect(await a.lan.copyExperiences(request)).toEqual({ added: 0, skipped: 2 })
  // 目标项目在接收端不存在：整批 404，不写入任何条目。
  await expect(
    a.lan.copyExperiences({
      ...request,
      ids: [general.id, scoped.id],
      folderMap: { [sourceFolder.id]: '00000000-0000-4000-8000-000000000000' }
    })
  ).rejects.toThrow('项目不存在')
  await expect(
    a.lan.copyExperiences({
      ...request,
      targetSkillId: '00000000-0000-4000-8000-000000000000'
    })
  ).rejects.toThrow('技能不存在')
  expect(b.skills.detail(target.id).experiences).toHaveLength(2)
  // 未配对证书无法写入；已配对但请求体非法时整批 400。
  const route = `/lan/v1/skills/${target.id}/experiences`
  const body = { experiences: [{ content: '陌生人', evidence: '伪造', folderId: null }] }
  expect((await postJson(stranger, b.lan.view().port!, route, body)).status).toBe(401)
  expect(
    (
      await postJson(a, b.lan.view().port!, route, {
        experiences: [{ content: 'x', evidence: 'y', folderId: null, extra: 1 }]
      })
    ).status
  ).toBe(400)
  expect(
    (
      await postJson(a, b.lan.view().port!, route, {
        experiences: Array.from({ length: 101 }, (_, i) => ({
          content: `c${i}`,
          evidence: 'e',
          folderId: null
        }))
      })
    ).status
  ).toBe(400)
  expect(b.skills.detail(target.id).experiences).toHaveLength(2)
  // 对端离线时给出明确错误。
  at += 16000
  await expect(a.lan.copyExperiences(request)).rejects.toThrow('离线')
})

it('设备负载随快照同步：新版本互相可见，旧版本对端（不发送负载）显示为 null', async () => {
  let current: DeviceMetrics = {
    at: 1,
    cpu: { cores: 8, load1: 1.5, load5: 1, load15: 0.5 },
    memory: { totalGB: 16, freePct: 56, pressure: 'normal', swapUsedMB: 0 },
    disk: { path: '/System/Volumes/Data', freeGB: 3.2, totalGB: 460, usedPct: 99.3 },
    procs: { prePush: 0, pixel: 0, vitest: 2, devServer: 0, tsc: 0, eslint: 0 }
  }
  // A 为新版本并提供负载；B 未提供负载，等价于旧版本对端不发送该字段。
  const a = await make(true, () => current)
  const b = await make()
  await pair(a, b)
  const byName = (devices: { name: string }[], name: string) =>
    devices.find((device) => device.name === name) as Record<string, unknown>
  expect(byName(b.lan.chat.devices(), 'Computer A')).toMatchObject({
    self: false,
    online: true,
    metrics: current
  })
  expect(byName(b.lan.chat.devices(), 'Computer B')).toMatchObject({ self: true, metrics: null })
  expect(byName(a.lan.chat.devices(), 'Computer A')).toMatchObject({ self: true, metrics: current })
  expect(byName(a.lan.chat.devices(), 'Computer B')).toMatchObject({ online: true, metrics: null })
  expect(b.lan.view().peers[0].snapshot?.metrics).toEqual(current)
  // 新一轮采集后 ETag 变化，对端下次轮询即拿到新负载。
  current = { ...current, at: 2, cpu: { ...current.cpu, load1: 7.25 } }
  at += 1000
  await b.lan.poll()
  expect(b.lan.chat.deviceMetrics('computer a')[0].metrics).toMatchObject({
    at: 2,
    cpu: { load1: 7.25 }
  })
  // 对端离线后保留最后一次数据，调用方按 at 判断新旧。
  at += 60_000
  expect(byName(b.lan.chat.devices(), 'Computer A')).toMatchObject({
    online: false,
    metrics: { at: 2 }
  })
})
