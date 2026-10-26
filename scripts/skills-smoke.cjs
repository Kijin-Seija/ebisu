/* 可由主 smoke 复用，也可单独在临时 HOME 验收技能界面。 */
const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
module.exports = async function skillSmoke({
  app,
  window,
  runtime,
  home,
  data,
  repo,
  screenshots
}) {
  // 技能模块：真实 HTTP 创建经验，界面只读查看和删除；变量通过受限 IPC 编辑。
  const postSkill = async (action, body) => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/v1/skills/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'codex', ...body })
    })
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  const businessSkills = (await window.evaluate(() => window.ebisu.snapshot())).skills
  assert.equal(businessSkills.length, 9)
  const managedCreate = path.join(home, '.agents/skills/ebisu-skill-create/SKILL.md')
  assert.equal(existsSync(managedCreate), true)
  assert.match(readFileSync(managedCreate, 'utf8'), /\.ebisu\/management/)
  const debug = businessSkills.find((item) => item.name === 'debug-auto')
  const experience = await postSkill('experience-add', {
    skillId: debug.id,
    content: '已验证的共享浏览器经验',
    evidence: '隔离 fixture 已验证'
  })
  await postSkill('experience-add', {
    skillId: debug.id,
    folderId: repo.id,
    content: '此项目专属经验',
    evidence: '项目 fixture 已验证'
  })
  await postSkill('variable-add', {
    skillId: debug.id,
    variable: {
      name: 'UI_FIXTURE',
      description: '界面变量测试',
      type: 'string',
      required: false,
      sensitive: false,
      scopes: ['skill', 'terminal', 'project'],
      defaultValue: 'base'
    }
  })
  await window.locator('.navigation button').filter({ hasText: '技能列表' }).click()
  await window.locator('.skill-card').first().waitFor()
  assert.equal(await window.locator('.skill-card').count(), 9)
  assert.equal(
    await window.locator('.skill-grid').evaluate((grid) => getComputedStyle(grid).display),
    'grid'
  )
  await window.screenshot({ path: path.join(screenshots, 'skills-light.png') })
  await window.locator('[data-skill="debug-auto"]').click()
  const drawer = window.locator('[data-skill-drawer]')
  assert.deepEqual(await drawer.locator('.skill-meta-list dt').allInnerTexts(), [
    '技能 ID',
    '创建于',
    '依赖'
  ])
  const dependency = drawer.locator('.dependency-badge').first()
  assert.match(await dependency.innerText(), /python3/)
  assert.match(await dependency.innerText(), /≥3\.10/)
  // 徽章图标必须真实加载，避免 CSS mask 或资源路径失效时只剩文字。
  assert.equal(
    await dependency
      .locator('img.dependency-badge-icon')
      .evaluate((icon) => icon.complete && icon.naturalWidth > 0),
    true
  )
  assert.equal(await drawer.locator('[data-skill-terminal="codex"] .skill-install-icon').count(), 1)
  await drawer.getByRole('tab', { name: '经验', exact: true }).click()
  await drawer.getByText('已验证的共享浏览器经验', { exact: true }).waitFor()
  assert.equal(
    await drawer
      .locator('.experience-item textarea, .experience-item input:not([type="checkbox"])')
      .count(),
    0
  )
  await window.evaluate(() => {
    navigator.clipboard.writeText = async (text) => {
      window.__copiedSkillText = text
    }
  })
  await drawer.locator(`[data-experience="${experience.id}"] input[type="checkbox"]`).check()
  await drawer.getByRole('button', { name: '复制 ID 列表', exact: true }).click()
  assert.equal(
    await window.evaluate(() => window.__copiedSkillText),
    JSON.stringify([experience.id])
  )
  await drawer.getByRole('button', { name: '复制讨论指令', exact: true }).click()
  assert.match(await window.evaluate(() => window.__copiedSkillText), /ebisu-skill-discuss/)
  await drawer.getByRole('tab', { name: '脚本与文件', exact: true }).click()
  assert.equal(await drawer.locator('[data-file="scripts/cdp_browser.py"]').count(), 1)
  assert.equal(await drawer.locator('[data-file="scripts/cdp_browser.py"] .n-tag').count(), 0)
  await drawer.locator('[data-file="scripts/cdp_browser.py"]').click()
  const fileDrawer = window.locator('[data-file-drawer]')
  await fileDrawer.locator('.hljs-keyword').first().waitFor()
  assert.ok((await fileDrawer.locator('.skill-code').innerText()).includes('import'))
  assert.equal(await fileDrawer.locator('.n-code__line-numbers').count(), 0)
  const fileActions = fileDrawer.getByRole('button', { name: '文件操作', exact: true })
  await fileActions.click()
  await window.getByText('复制路径', { exact: true }).waitFor()
  assert.deepEqual(await window.locator('.n-dropdown-option-body__label').allInnerTexts(), [
    '复制路径',
    '复制内容',
    '另存为',
    '在 Finder 中显示'
  ])
  await window.screenshot({ path: path.join(screenshots, 'skill-file-menu.png') })
  await window.getByText('复制路径', { exact: true }).click()
  const sourcePath = await window.evaluate(() => window.__copiedSkillText)
  assert.match(sourcePath, new RegExp(`/skills/${debug.id}/scripts/cdp_browser\\.py$`))
  const sourceContent = await window.evaluate(
    async (id) =>
      (await window.ebisu.skillDetail(id)).package.files['scripts/cdp_browser.py'].content,
    debug.id
  )
  await fileActions.click()
  await window.getByText('复制内容', { exact: true }).click()
  assert.equal(await window.evaluate(() => window.__copiedSkillText), sourceContent)
  // 隔离系统对话框与 Finder，仍通过真实 preload/IPC 验证保存字节和定位路径。
  const exported = path.join(home, 'skill-export.py')
  await app.evaluate(({ dialog, shell }, destination) => {
    globalThis.__skillFileOriginals = {
      save: dialog.showSaveDialog,
      reveal: shell.showItemInFolder
    }
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    shell.showItemInFolder = (file) => {
      globalThis.__revealedSkillFile = file
    }
  }, exported)
  try {
    await fileActions.click()
    await window.getByText('另存为', { exact: true }).click()
    await window.getByText(`已保存到 ${exported}`, { exact: true }).waitFor()
    assert.equal(readFileSync(exported, 'utf8'), sourceContent)
    await fileActions.click()
    await window.getByText('在 Finder 中显示', { exact: true }).click()
    await window.evaluate(() => window.ebisu.snapshot())
    assert.equal(await app.evaluate(() => globalThis.__revealedSkillFile), sourcePath)
  } finally {
    await app.evaluate(({ dialog, shell }) => {
      dialog.showSaveDialog = globalThis.__skillFileOriginals.save
      shell.showItemInFolder = globalThis.__skillFileOriginals.reveal
      delete globalThis.__skillFileOriginals
      delete globalThis.__revealedSkillFile
    })
  }
  await fileDrawer.getByRole('button', { name: 'close' }).click()
  await fileDrawer.waitFor({ state: 'hidden' })
  await drawer.getByRole('tab', { name: '环境变量', exact: true }).click()
  const variableNav = drawer.locator('.skill-variable-nav')
  await variableNav.waitFor()
  assert.equal(await variableNav.evaluate((node) => getComputedStyle(node).position), 'sticky')
  assert.equal(await variableNav.getByText('UI_FIXTURE', { exact: true }).count(), 0)
  assert.equal(await variableNav.getByText('界面变量测试', { exact: true }).count(), 1)
  const variable = drawer.locator('[data-variable="UI_FIXTURE"]')
  await variable.getByRole('textbox').fill('edited from UI')
  await window.evaluate(() => window.ebisu.rescan())
  assert.equal(await variable.getByRole('textbox').inputValue(), 'edited from UI')
  await window.waitForFunction(
    async (id) =>
      (await window.ebisu.skillVariables(id, null)).find((item) => item.name === 'UI_FIXTURE')
        .global.value === 'edited from UI',
    debug.id
  )
  await variable.locator('[data-clear]').click()
  await window.waitForFunction(
    async (id) =>
      !(await window.ebisu.skillVariables(id, null)).find((item) => item.name === 'UI_FIXTURE')
        .global.hasValue,
    debug.id
  )
  await drawer.getByRole('tab', { name: '安装管理', exact: true }).click()
  await drawer
    .locator('[data-skill-terminal="codex"]')
    .getByRole('button', { name: '安装', exact: true })
    .click()
  await drawer
    .locator('[data-skill-terminal="codex"]')
    .getByRole('button', { name: '卸载', exact: true })
    .waitFor()
  const entry = readFileSync(path.join(home, '.agents/skills/debug-auto/SKILL.md'), 'utf8')
  assert.match(entry, /\.ebisu\/skills/)
  assert.equal(existsSync(path.join(home, '.agents/skills/debug-auto/scripts')), false)
  await drawer.getByRole('tab', { name: '经验', exact: true }).click()
  await drawer
    .locator(`[data-experience="${experience.id}"]`)
    .getByRole('button', { name: '删除经验', exact: true })
    .click()
  await window.getByRole('button', { name: '删除', exact: true }).click()
  await window.waitForFunction(
    async ({ skillId, experienceId }) =>
      !(await window.ebisu.skillDetail(skillId)).experiences.some(
        (item) => item.id === experienceId
      ),
    { skillId: debug.id, experienceId: experience.id }
  )
  await window.waitForFunction(() => document.querySelectorAll('.n-message').length === 0)
  await window.screenshot({ path: path.join(screenshots, 'skill-details-light.png') })
  await window.keyboard.press('Escape')
  await drawer.waitFor({ state: 'hidden' })
  await window.evaluate(() => window.ebisu.setTheme('dark'))
  await window.locator('.app-shell.dark').waitFor()
  await window.screenshot({ path: path.join(screenshots, 'skills-dark.png') })
  await window.locator('[data-skill="debug-auto"]').click()
  await window
    .locator('[data-skill-drawer]')
    .getByRole('tab', { name: '环境变量', exact: true })
    .click()
  await window.locator('[data-skill-drawer] [data-variable="CDP_BROWSER"]').waitFor()
  await window.waitForFunction(() => document.querySelectorAll('.n-message').length === 0)
  // Pane 节点会在切换动画完成前进入 DOM；截图须等待退出面板消失。
  await window.waitForFunction(
    () => !document.querySelector('[data-skill-drawer] .n-tabs-pane-wrapper > .v-leave-active')
  )
  await window.waitForTimeout(350)
  await window.screenshot({
    path: path.join(screenshots, 'skill-variables-dark.png'),
    animations: 'disabled'
  })
  await window.keyboard.press('Escape')
  await window.locator('[data-skill-drawer]').waitFor({ state: 'hidden' })
  await window.evaluate(() => window.ebisu.setTheme('light'))
  // 高亮以标题越过容器中线为准；点击则把卡片移到固定导航顶部，不能共用同一偏移。
  await window.locator('[data-skill="push-code"]').click()
  await drawer.getByRole('tab', { name: '环境变量', exact: true }).click()
  await drawer.locator('.skill-variable').first().waitFor()
  await window.waitForTimeout(400)
  const headings = drawer.locator('.skill-variable-heading')
  const secondId = await headings.nth(1).getAttribute('id')
  const firstId = await headings.first().getAttribute('id')
  const assertMidpoint = async () => {
    for (const [delta, id] of [
      [10, firstId],
      [-10, secondId]
    ]) {
      await headings.nth(1).evaluate((heading, delta) => {
        let target = heading.parentElement
        while (!['auto', 'scroll'].includes(getComputedStyle(target).overflowY))
          target = target.parentElement
        target.scrollTop +=
          heading.getBoundingClientRect().top -
          target.getBoundingClientRect().top -
          target.clientHeight / 2 -
          delta
      }, delta)
      await window.waitForFunction(
        (id) =>
          document
            .querySelector('.skill-variable-nav .n-anchor-link--active a')
            ?.getAttribute('href') === `#${id}`,
        id
      )
    }
  }
  await assertMidpoint()
  const fourth = drawer.locator('.skill-variable').nth(3)
  await drawer.locator('.skill-variable-nav a').nth(3).click()
  await window.waitForFunction(() => {
    const card = document.querySelectorAll('.skill-variable')[3]
    const nav = document.querySelector('.skill-variable-nav')
    return Math.abs(card.getBoundingClientRect().top - nav.getBoundingClientRect().top) <= 1
  })
  assert.ok(await fourth.isVisible())
  await window.screenshot({ path: path.join(screenshots, 'skill-anchor-aligned.png') })
  await drawer.locator('.skill-variable-nav a').last().click()
  await window.waitForFunction(() => {
    let target = document.querySelector('.skill-variable-content')
    while (!['auto', 'scroll'].includes(getComputedStyle(target).overflowY))
      target = target.parentElement
    return Math.abs(target.scrollHeight - target.clientHeight - target.scrollTop) <= 1
  })
  const contentBounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((item) => !item.webContents.getURL().includes('tray=1'))
      .getContentBounds()
  )
  try {
    await app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()
        .find((item) => !item.webContents.getURL().includes('tray=1'))
        .setContentSize(bounds.width, bounds.height - 120)
    }, contentBounds)
    await window.waitForTimeout(200)
    await assertMidpoint()
  } finally {
    await app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()
        .find((item) => !item.webContents.getURL().includes('tray=1'))
        .setContentBounds(bounds)
    }, contentBounds)
  }
  await window.keyboard.press('Escape')
  await drawer.waitFor({ state: 'hidden' })
  await window.locator('.navigation button').filter({ hasText: '设置' }).click()
}
if (require.main === module) {
  const { _electron: electron } = require('playwright')
  const { mkdtempSync, mkdirSync, rmSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  ;(async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'ebisu-skill-ui-'))
    const home = path.join(fixture, 'home'),
      data = path.join(fixture, 'data'),
      repository = path.join(fixture, 'repo')
    for (const directory of [home, data, repository]) mkdirSync(directory)
    const screenshots = path.resolve('.smoke')
    mkdirSync(screenshots, { recursive: true })
    const env = { ...process.env, EBISU_SMOKE: '1', EBISU_TEST_HOME: home, EBISU_DATA_DIR: data }
    delete env.ELECTRON_RUN_AS_NODE
    let app
    try {
      const packaged = process.env.EBISU_SMOKE_EXECUTABLE
      app = await electron.launch({
        executablePath: packaged || require('electron'),
        args: packaged ? [] : [path.resolve('.')],
        env
      })
      await app.firstWindow()
      const window = app.windows().find((page) => !page.url().includes('tray=1'))
      await window.locator('.empty-panel').waitFor()
      await app.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
      }, repository)
      await window.evaluate(() => window.ebisu.addFolder())
      await window.evaluate(() => window.ebisu.install('codex'))
      const repo = (await window.evaluate(() => window.ebisu.snapshot())).folders[0]
      const runtime = JSON.parse(readFileSync(path.join(data, 'runtime.json'), 'utf8'))
      const errors = []
      window.on('pageerror', (error) => errors.push(String(error)))
      await module.exports({ app, window, runtime, home, data, repo, screenshots })
      assert.deepEqual(errors, [])
      console.log('Skills smoke passed')
    } finally {
      if (app) await app.close()
      rmSync(fixture, { recursive: true, force: true })
    }
  })().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
