/* 双 Electron 实例验收；所有 HOME、数据库和终端入口只落在临时目录。 */
const { _electron: electron } = require('playwright')
const { mkdtempSync, mkdirSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

module.exports = async function lanSmoke() {
  const root = mkdtempSync(path.join(tmpdir(), 'ebisu-lan-ui-'))
  const apps = []
  const errors = []
  const screenshots = path.resolve('.smoke')
  mkdirSync(screenshots, { recursive: true })
  async function launch(label) {
    const home = path.join(root, label, 'home')
    const data = path.join(root, label, 'data')
    const project = path.join(root, label, 'project')
    for (const directory of [home, data, project, path.join(home, '.codex')])
      mkdirSync(directory, { recursive: true })
    const env = {
      ...process.env,
      HOME: home,
      EBISU_SMOKE: '1',
      EBISU_TEST_HOME: home,
      EBISU_DATA_DIR: data
    }
    delete env.ELECTRON_RUN_AS_NODE
    const executable = process.env.EBISU_SMOKE_EXECUTABLE
    const app = await electron.launch({
      executablePath: executable || require('electron'),
      args: executable ? [] : [path.resolve('.')],
      env,
      timeout: 30000
    })
    apps.push(app)
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!window.ebisu)
    const main = app.windows().find((window) => !window.url().includes('tray=1')) || page
    main.on('pageerror', (error) => errors.push(String(error)))
    await main.locator('.empty-panel').waitFor()
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, project)
    await main.evaluate(() => window.ebisu.addFolder())
    await main.evaluate(() => window.ebisu.install('codex'))
    const runtime = JSON.parse(readFileSync(path.join(data, 'runtime.json'), 'utf8'))
    async function post(route, payload) {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/v1/${route}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      return body
    }
    const pkg = {
      version: 1,
      name: 'lan-example',
      description: label,
      files: {
        'SKILL.md': {
          content: `---\nname: lan-example\ndescription: ${label}\n---\nrun --skill lan-example --path "$PWD"\n`
        }
      },
      variables: [
        {
          name: 'MODE',
          description: 'mode',
          type: 'string',
          required: true,
          sensitive: false,
          scopes: ['skill']
        }
      ]
    }
    await post('skills/create', { terminal: 'codex', requestId: label, package: pkg })
    return { app, page: main, project, post }
  }
  async function filter(page, text) {
    await page.locator('.device-filter').click()
    await page.locator('.n-base-select-option').filter({ hasText: text }).click()
  }
  try {
    const a = await launch('source')
    const b = await launch('target')
    await a.page.evaluate(() => window.ebisu.configureLan(true, 'LAN source'))
    await b.page.getByRole('button', { name: '设置', exact: true }).click()
    await b.page.getByLabel('本机名称', { exact: true }).fill('LAN target')
    await b.page.getByRole('switch', { name: '局域网共享' }).click()
    await b.page.waitForFunction(async () => (await window.ebisu.snapshot()).lan?.enabled)
    // 配对只依赖 mDNS 发现：附近设备出现后直接请求，不填写地址或邀请串。
    await b.page.waitForFunction(
      async () => (await window.ebisu.snapshot()).lan?.discovered.length > 0,
      undefined,
      { timeout: 30000 }
    )
    const sourceCard = b.page.locator('.lan-device-card').filter({ hasText: 'LAN source' })
    await sourceCard.getByRole('button', { name: '请求配对', exact: true }).click()
    // 确认弹窗出现在另一台设备，接受后双方自动建立配对。
    await a.page
      .locator('.n-dialog')
      .getByText('是否接受来自「LAN target」的邀请？', { exact: true })
      .waitFor({ timeout: 30000 })
    await a.page.screenshot({ path: path.join(screenshots, 'lan-pair-request.png') })
    await a.page.locator('.n-dialog').getByRole('button', { name: '接受', exact: true }).click()
    await b.page.waitForFunction(
      async () => (await window.ebisu.snapshot()).lan?.peers.some((peer) => peer.online),
      undefined,
      { timeout: 30000 }
    )
    // 已配对设备使用两列卡片，并立即从附近设备里移除。
    await b.page.locator('.lan-device-card.is-paired').filter({ hasText: 'LAN source' }).waitFor()
    // 真实局域网里可能还有其他 Ebisu 设备，只检查本次配对的来源设备。
    assert.equal(
      await b.page
        .locator('.lan-device-card:not(.is-paired)')
        .filter({ hasText: 'LAN source' })
        .count(),
      0
    )
    await b.page.screenshot({ path: path.join(screenshots, 'lan-settings.png') })
    await a.post('activity', {
      path: a.project,
      terminal: 'codex',
      sessionId: 'remote-session',
      taskTitle: '远端只读会话',
      phase: 'waiting',
      action: 'enter'
    })
    await b.page.getByRole('button', { name: /^项目面板/ }).click()
    await filter(b.page, 'LAN source')
    await b.page.waitForFunction(
      () =>
        document.querySelector('.project-card')?.getAttribute('data-activity-state') === 'waiting'
    )
    assert.equal(await b.page.locator('.project-card .icon-button').count(), 0)
    await b.page.locator('.project-card .session').hover()
    await b.page.getByText('远端只读会话', { exact: true }).waitFor()
    assert.equal(await b.page.locator('.open-session-button').count(), 0)
    await b.page.mouse.move(10, 10)
    await b.page.waitForFunction(() => !document.querySelector('.n-message'))
    await b.page.screenshot({ path: path.join(screenshots, 'lan-projects-light.png') })
    await b.page.getByRole('button', { name: /^技能列表/ }).click()
    await b.page.locator('[data-skill="lan-example"]').click()
    await b.page.getByRole('button', { name: '导入本机', exact: true }).click()
    await b.page.getByLabel('导入技能名称').fill('lan-example-copy')
    const text = b.page.getByLabel('导入文件内容')
    await text.fill((await text.inputValue()) + '\nmanual preview correction\n')
    assert.match(await text.inputValue(), /--skill lan-example-copy/)
    await b.page.waitForFunction(() => !document.querySelector('.n-message'))
    await b.page.screenshot({ path: path.join(screenshots, 'lan-import-preview.png') })
    await b.page.getByRole('button', { name: '确认导入', exact: true }).click()
    await b.page.getByLabel('导入技能名称').waitFor({ state: 'hidden' })
    const local = await b.page.evaluate(async () => {
      const state = await window.ebisu.snapshot()
      return window.ebisu.skillDetail(
        state.skills.find((skill) => skill.name === 'lan-example-copy')?.id
      )
    })
    assert.match(local.package.files['SKILL.md'].content, /manual preview correction/)
    assert.equal(local.installations.length, 0)
    assert.equal(local.experiences.length, 0)
    await b.page.evaluate(() => window.ebisu.setTheme('dark'))
    await b.page.getByRole('button', { name: /^项目面板/ }).click()
    await b.page.waitForFunction(() => !document.querySelector('.n-message'))
    await b.page.screenshot({ path: path.join(screenshots, 'lan-projects-dark.png') })
    // 关闭共享立即使缓存离线，不需要为了验收等待十五秒。
    await b.page.evaluate(() => window.ebisu.configureLan(false, 'LAN target'))
    await b.page.locator('.project-card.is-offline').waitFor()
    assert.match(await b.page.locator('.toolbar-sessions').innerText(), /0/)
    const tray = b.app.windows().find((page) => page.url().includes('tray=1'))
    await tray.waitForFunction(async () => !(await window.ebisu.snapshot()).lan.enabled)
    await b.page.getByRole('button', { name: '设置', exact: true }).click()
    await b.page.getByRole('button', { name: '解除配对', exact: true }).click()
    await b.page.locator('.n-dialog').getByRole('button', { name: '解除配对', exact: true }).click()
    await b.page.waitForFunction(async () => !(await window.ebisu.snapshot()).lan.peers.length)
    assert.deepEqual(errors, [])
    console.log(
      'LAN smoke passed: two isolated Electron devices, settings, pairing, remote projects/session restrictions, rename preview editing, import, themes, offline statistics, tray state and revocation.'
    )
  } catch (error) {
    for (const [index, app] of apps.entries()) {
      const page = app.windows().find((page) => !page.url().includes('tray=1'))
      if (page) {
        await page
          .screenshot({ path: path.join(screenshots, `lan-failure-${index}.png`) })
          .catch(() => {})
        console.error('LAN UI messages:', await page.locator('.n-message').allTextContents())
      }
    }
    throw error
  } finally {
    for (const app of apps.reverse()) await app.close()
    rmSync(root, { recursive: true, force: true })
  }
}
if (require.main === module)
  module.exports().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
