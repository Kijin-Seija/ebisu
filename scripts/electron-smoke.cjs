/* Electron 端到端验收：所有目录选择与集成安装都落在临时 HOME。
 * 必须通过 vitest-safe 队列运行。截图保存在 .smoke/，不进入版本控制。
 */
const { _electron: electron } = require('playwright')
const { execFileSync } = require('node:child_process')
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  copyFileSync,
  appendFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

async function main() {
  const fixture = mkdtempSync(path.join(tmpdir(), 'ebisu-ui-'))
  const data = path.join(fixture, 'data')
  const home = path.join(fixture, 'home')
  const repository = path.join(fixture, 'ebisu-workspace')
  const ordinary = path.join(fixture, 'design-notes')
  for (const directory of [data, home, repository, ordinary]) mkdirSync(directory)
  mkdirSync(path.join(home, '.codex'))
  const titleIndex = path.join(home, '.codex/session_index.jsonl')
  writeFileSync(
    titleIndex,
    JSON.stringify({
      id: '0199d205-691a-74cf-9b7e-cd307e3188d7',
      thread_name: '开发 Agent 文件夹监控应用'
    }) + '\n'
  )
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' })
  git('init', '-b', 'feature/strategy-3880-date-time-picker')
  git('config', 'user.name', 'Ebisu')
  git('config', 'user.email', 'test@ebisu.local')
  writeFileSync(path.join(repository, 'existing.ts'), 'original\n')
  writeFileSync(path.join(repository, 'removed.ts'), 'original\n')
  git('add', '.')
  git('commit', '-m', 'fixture')
  writeFileSync(path.join(repository, 'existing.ts'), 'modified\n')
  writeFileSync(path.join(repository, 'new.ts'), 'added\n')
  rmSync(path.join(repository, 'removed.ts'))
  const screenshots = path.resolve('.smoke')
  mkdirSync(screenshots, { recursive: true })
  const env = { ...process.env, EBISU_SMOKE: '1', EBISU_DATA_DIR: data, EBISU_TEST_HOME: home }
  delete env.ELECTRON_RUN_AS_NODE
  const packaged = process.env.EBISU_SMOKE_EXECUTABLE
  let app
  let fullscreenApp
  const errors = []
  try {
    app = await electron.launch({
      executablePath: packaged || require('electron'),
      args: packaged ? [] : [path.resolve('.')],
      env,
      timeout: 30000
    })
    await app.firstWindow()
    // 两个 renderer 可以同时完成加载；不能假定 firstWindow 一定是主窗口。
    let window
    for (let attempt = 0; attempt < 100; attempt++) {
      window = app
        .windows()
        .find((page) => page.url().includes('index.html') && !page.url().includes('tray=1'))
      if (window) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(window, 'main window should be loaded')
    window.on('pageerror', (error) => errors.push(String(error)))
    window.on('console', (event) => {
      if (event.type() === 'error') errors.push(event.text())
    })
    await window.locator('.empty-panel').waitFor()
    await window.screenshot({
      path: path.join(screenshots, packaged ? 'packaged-empty.png' : 'empty.png')
    })
    // 分开注册，确保两个 createdAt 不在同一毫秒；同毫秒时数据库会按随机 UUID 排序。
    for (const directory of [ordinary, repository]) {
      await app.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
      }, directory)
      await window.evaluate(() => window.ebisu.addFolder())
    }
    await window.locator('.project-card').first().waitFor()
    const initial = await window.evaluate(() => window.ebisu.snapshot())
    assert.equal(initial.folders.length, 2)
    const repo = initial.folders.find((folder) => folder.name === 'ebisu-workspace')
    assert.equal(
      await window.locator('.project-card').first().getAttribute('data-folder'),
      'design-notes'
    )
    const idleHeight = await window
      .locator('[data-folder="ebisu-workspace"]')
      .evaluate((card) => card.getBoundingClientRect().height)
    assert.deepEqual([repo.git.added, repo.git.deleted, repo.git.modified], [1, 1, 1])
    assert.equal(initial.folders.find((folder) => folder.name === 'design-notes').git, null)
    const runtime = JSON.parse(readFileSync(path.join(data, 'runtime.json'), 'utf8'))
    async function activity(directory, terminal, sessionId, patch = {}) {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/v1/activity`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: directory, terminal, sessionId, action: 'enter', ...patch })
      })
      assert.equal(response.status, 200)
    }
    /** 用实际 badge 的计算颜色验收，覆盖主题切换及 hover，避免只检查写入的 CSS 变量。 */
    async function assertCardState(page, state, expectedHeight) {
      const tray = page.url().includes('tray=1')
      await page.waitForFunction(
        ({ state, tray }) => {
          const card = document.querySelector('[data-folder="ebisu-workspace"]')
          if (card?.getAttribute('data-activity-state') !== state) return false
          if (state === 'idle') return true
          const badge = card.querySelector(
            state === 'waiting'
              ? '.session-status-badge[data-status="waiting"] .n-badge-sup, .session-group-badge .n-badge-sup'
              : state === 'error'
                ? '.session-status-badge[data-status="error"] .n-badge-sup, .session-group-badge .n-badge-sup'
                : '.session-status-badge[data-status="executing"] .n-badge-sup'
          )
          if (!badge) return false
          const color = getComputedStyle(badge).backgroundColor
          const borderMatches = getComputedStyle(card).borderTopColor === color
          if (tray) return borderMatches
          const dot = card.querySelector('.occupancy .status-dot')
          return borderMatches && dot !== null && getComputedStyle(dot).backgroundColor === color
        },
        { state, tray }
      )
      const card = page.locator('[data-folder="ebisu-workspace"]')
      assert.equal(await card.locator('.occupancy').count(), tray ? 0 : 1)
      if (!tray) {
        assert.equal(
          await card.locator('.occupancy').innerText(),
          {
            idle: '空闲可用',
            executing: '正在协作',
            waiting: '需要处理',
            error: '出现故障'
          }[state]
        )
      }
      const layout = await card.evaluate((card) => ({
        height: card.getBoundingClientRect().height,
        border: getComputedStyle(card).borderTopWidth,
        padding: getComputedStyle(card).paddingTop,
        sideWidths: ['borderLeftWidth', 'borderRightWidth', 'borderBottomWidth'].map(
          (key) => getComputedStyle(card)[key]
        )
      }))
      assert.equal(layout.border, state === 'idle' ? '1px' : '4px')
      assert.equal(layout.padding, state === 'idle' ? '16px' : '13px')
      assert.deepEqual(layout.sideWidths, ['1px', '1px', '1px'])
      if (expectedHeight !== undefined) assert.equal(layout.height, expectedHeight)
    }
    // 内置大头像必须含真实透明通道；不能只用 CSS 透明度伪装掉 RGB 截帧的白色底。
    const silhouettes = await app.evaluate(({ app, nativeImage }) => {
      const path = process.getBuiltinModule('path')
      const root = app.isPackaged
        ? path.join(process.resourcesPath, 'ebisu')
        : path.join(app.getAppPath(), 'resources')
      return ['backgrounds', 'tray'].flatMap((folder) =>
        ['gpt', 'claude', 'deepseek', 'kimi', 'qwen', 'gemini', 'grok'].map((family) => {
          const image = nativeImage.createFromPath(
            path.join(root, 'avatars', folder, `model-${family}.png`)
          )
          const { width, height } = image.getSize()
          const pixels = image.toBitmap()
          let transparent = 0
          let opaque = 0
          for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i] === 0) transparent++
            if (pixels[i] === 255) opaque++
          }
          // 托盘素材的水平线以下桌面应被抠成透明，仅保留手与装饰。
          const bottomStart = Math.max(0, height - Math.max(1, Math.round(height * 0.02)))
          let bottomTransparent = 0
          for (let y = bottomStart; y < height; y++) {
            for (let x = 0; x < width; x++) {
              if (pixels[(y * width + x) * 4 + 3] === 0) bottomTransparent++
            }
          }
          return {
            folder,
            family,
            transparent,
            opaque,
            total: pixels.length / 4,
            bottomTransparent,
            bottomTotal: width * (height - bottomStart)
          }
        })
      )
    })
    for (const image of silhouettes) {
      const label = `${image.folder}/${image.family}`
      assert.ok(image.total > 0, `${label} background asset should exist`)
      assert.ok(image.transparent > image.total * 0.1, `${label} should have no solid backdrop`)
      assert.ok(image.opaque > image.total * 0.2, `${label} silhouette should remain opaque`)
      if (image.folder === 'tray') {
        assert.ok(
          image.bottomTransparent > image.bottomTotal * 0.8,
          `${label} desk below the plane should be transparent`
        )
      }
    }
    /** 验收轮廓遮挡：人物内部覆盖旧图，轮廓外显示旧图，整组合成后再统一淡化。 */
    const trayLineDrops = {
      gpt: 0.078125,
      claude: 0.078125,
      deepseek: 0.06640625,
      kimi: 0.076171875,
      qwen: 0.134765625,
      gemini: 0.06640625,
      grok: 0.07421875
    }
    async function assertAvatarBackground(page, count, size, step) {
      const tray = page.url().includes('tray=1')
      const card = page.locator('[data-folder="ebisu-workspace"]')
      await page.waitForFunction(
        (count) =>
          document.querySelectorAll('[data-folder="ebisu-workspace"] .card-avatar-background-image')
            .length === count,
        count
      )
      if (!count) {
        assert.equal(await card.locator('.card-avatar-background').count(), 0)
        return
      }
      await card.locator('.card-avatar-background').evaluate(async (layer) => {
        await Promise.all([...layer.querySelectorAll('img')].map((image) => image.decode()))
      })
      const layout = await card.evaluate((card) => {
        const layer = card.querySelector('.card-avatar-background')
        const bounds = layer.getBoundingClientRect()
        return {
          hidden: layer.getAttribute('aria-hidden'),
          overflow: getComputedStyle(layer).overflow,
          pointerEvents: getComputedStyle(layer).pointerEvents,
          opacity: getComputedStyle(layer).opacity,
          foregroundAbove:
            Number(getComputedStyle(card.querySelector('.card-top')).zIndex) >
            Number(getComputedStyle(layer).zIndex),
          noOverflow: card.scrollWidth === card.clientWidth,
          right: bounds.right,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
          images: [...layer.querySelectorAll('img')].map((image) => ({
            left: image.getBoundingClientRect().left,
            right: image.getBoundingClientRect().right,
            top: image.getBoundingClientRect().top,
            bottom: image.getBoundingClientRect().bottom,
            width: image.getBoundingClientRect().width,
            height: image.getBoundingClientRect().height,
            opacity: getComputedStyle(image).opacity,
            backgroundColor: getComputedStyle(image).backgroundColor,
            src: image.src
          }))
        }
      })
      assert.equal(layout.hidden, 'true')
      assert.equal(layout.overflow, tray ? 'visible' : 'hidden')
      assert.equal(layout.pointerEvents, 'none')
      assert.equal(layout.opacity, '0.3')
      assert.equal(layout.foregroundAbove, true)
      assert.equal(layout.noOverflow, true)
      assert.equal(layout.images.at(-1).right, tray ? layout.right - 12 : layout.right + 20)
      for (const [index, image] of layout.images.entries()) {
        assert.equal(image.opacity, '1')
        assert.equal(image.backgroundColor, 'rgba(0, 0, 0, 0)')
        if (tray) {
          const family = new URL(image.src).pathname.split('/').pop()
          const lineDrop = trayLineDrops[family]
          assert.ok(lineDrop, `unknown tray background model: ${family}`)
          // 托盘角色完整显示，高度略高于卡片一半并缩小 4px。
          assert.ok(
            Math.abs(image.height - (layout.height * 0.58 - 4)) < 1.5,
            'tray background height should be 4px under 58% of the card'
          )
          assert.ok(
            Math.abs(image.width - image.height) < 0.5,
            'tray background should keep its square ratio'
          )
          assert.ok(
            image.top >= layout.bottom - layout.height,
            'tray background should fit at the top'
          )
          assert.ok(
            image.left >= layout.right - layout.width,
            'tray background should fit horizontally'
          )
          assert.ok(image.right <= layout.right, 'tray background should fit horizontally')
          assert.ok(
            image.bottom > layout.bottom,
            'contents below the plane should overflow the card'
          )
          const overhang = image.bottom - layout.bottom
          assert.ok(
            Math.abs(overhang - image.height * lineDrop) <= 1.5,
            'each character plane should sit on the card bottom'
          )
          if (index) {
            assert.ok(Math.abs(image.left - layout.images[index - 1].left - 20) < 1)
            assert.ok(layout.images[index - 1].right > image.left)
          }
        } else {
          assert.equal(image.width, size)
          assert.equal(image.height, size)
          assert.ok(image.bottom > layout.bottom, 'oversized image should be clipped at the bottom')
          if (index) {
            assert.equal(image.left - layout.images[index - 1].left, step)
            assert.ok(
              layout.images[index - 1].right > image.left,
              'background images should overlap'
            )
          }
        }
      }
      // 背景固定使用模型角色的透明轮廓，会话头像则固定使用终端商标。
      for (const image of layout.images) {
        const backgroundUrl = new URL(image.src)
        assert.equal(backgroundUrl.searchParams.get('background'), '1')
        assert.equal(backgroundUrl.searchParams.get('tray'), tray ? '1' : null)
        assert.match(backgroundUrl.pathname, /^\/model\//)
      }
      const avatarPaths = await card
        .locator('.session-avatar')
        .evaluateAll((images) => images.map((image) => new URL(image.src).pathname))
      assert.ok(avatarPaths.length > 0)
      assert.ok(avatarPaths.every((path) => path.startsWith('/terminal/')))
      if (count === 3 && !tray) {
        // 在真实卡片上临时使用透明圆形与红色底层，分别采样轮廓内外，避免把矩形遮挡当作成功。
        const images = card.locator('.card-avatar-background-image')
        const saved = await images.evaluateAll(async (images) => {
          const saved = images.map((image) => ({
            src: image.src,
            visibility: image.style.visibility
          }))
          for (const image of images) image.style.visibility = 'hidden'
          const svg = (body) =>
            `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">${body}</svg>`)}`
          images.at(-2).src = svg('<rect width="256" height="256" fill="red"/>')
          images.at(-1).src = svg('<circle cx="128" cy="128" r="100" fill="blue"/>')
          images.at(-2).style.visibility = 'visible'
          images.at(-1).style.visibility = 'visible'
          await Promise.all(images.map((image) => image.decode()))
          return saved
        })
        const clip = {
          x: Math.ceil(layout.images.at(-1).left),
          y: Math.floor(layout.bottom - 12),
          width: Math.ceil(size * 0.5),
          height: 4
        }
        try {
          const before = await page.screenshot({ clip })
          await images.nth(count - 2).evaluate((image) => {
            image.style.visibility = 'hidden'
          })
          const withoutOldImages = await page.screenshot({ clip })
          const difference = await app.evaluate(
            ({ nativeImage }, { before, after, size }) => {
              const a = nativeImage.createFromBuffer(Buffer.from(before, 'base64'))
              const b = nativeImage.createFromBuffer(Buffer.from(after, 'base64'))
              const differenceAt = (x) => {
                const bounds = { x: Math.floor(x), y: 1, width: 1, height: 1 }
                const first = a.crop(bounds).toBitmap()
                const second = b.crop(bounds).toBitmap()
                return first.reduce(
                  (max, value, index) => Math.max(max, Math.abs(value - second[index])),
                  0
                )
              }
              return { inside: differenceAt(size * 0.35), outside: differenceAt(size * 0.02) }
            },
            { before: before.toString('base64'), after: withoutOldImages.toString('base64'), size }
          )
          // 合成组允许 1 级 GPU 取整差异，轮廓内部不能透底，轮廓外必须保留旧图。
          assert.ok(
            difference.inside <= 1,
            `silhouette should hide underlying artwork: ${JSON.stringify(difference)}`
          )
          assert.ok(
            difference.outside >= 20,
            `transparent space should reveal underlying artwork: ${JSON.stringify(difference)}`
          )
        } finally {
          await images.evaluateAll(async (images, saved) => {
            for (const [index, image] of images.entries()) {
              image.src = saved[index].src
              image.style.visibility = saved[index].visibility
            }
            await Promise.all(images.map((image) => image.decode()))
          }, saved)
        }
      }
    }
    await assertCardState(window, 'idle', idleHeight)
    await assertAvatarBackground(window, 0)
    const trayPage = app.windows().find((page) => page.url().includes('tray=1'))
    await trayPage.locator('[data-folder="ebisu-workspace"]').waitFor()
    const trayIdleHeight = await trayPage
      .locator('[data-folder="ebisu-workspace"]')
      .evaluate((card) => card.getBoundingClientRect().height)
    await activity(repository, 'codex', '0199d205-691a-74cf-9b7e-cd307e3188d7', { model: 'gpt-6' })
    await assertCardState(window, 'executing', idleHeight)
    await assertCardState(trayPage, 'executing')
    await assertAvatarBackground(window, 1, 180, 90)
    await assertAvatarBackground(trayPage, 1)
    // 托盘的有头像/无头像布局原本略有高度差；分别记录基线，验证状态和边框切换不再增高。
    const trayBusyHeight = await trayPage
      .locator('[data-folder="ebisu-workspace"]')
      .evaluate((card) => card.getBoundingClientRect().height)
    await window.screenshot({ path: path.join(screenshots, 'executing-light.png') })
    await window.locator('[data-folder="ebisu-workspace"] .session').hover()
    await window.locator('.session-task-title').waitFor()
    assert.equal(
      await window.locator('.session-task-title').innerText(),
      '开发 Agent 文件夹监控应用'
    )
    appendFileSync(
      titleIndex,
      JSON.stringify({
        id: '0199d205-691a-74cf-9b7e-cd307e3188d7',
        thread_name: '开发 Agent 文件夹监控应用（已更新）'
      }) + '\n'
    )
    await window.evaluate(() => window.ebisu.rescan())
    await window.waitForFunction(
      () =>
        document.querySelector('.session-task-title')?.textContent ===
        '开发 Agent 文件夹监控应用（已更新）'
    )
    await window.screenshot({ path: path.join(screenshots, 'task-title.png') })
    await window.locator('h1').hover()
    await window.locator('.session-details').waitFor({ state: 'hidden' })
    await activity(repository, 'claude', 'session-claude-7a12f05c', {
      phase: 'waiting',
      model: 'claude-opus-4-6',
      taskTitle: '修复登录自动更新 500'
    })
    await activity(repository, 'grok', 'grok-96bd44c0', { model: 'grok-4' })
    await window.locator('.session').nth(2).waitFor()
    await window.waitForFunction(() =>
      [...document.images].every((image) => image.complete && image.naturalWidth > 0)
    )
    assert.equal(await window.locator('.session.waiting').count(), 1)
    await window.waitForFunction(
      () => document.querySelectorAll('.session-status-badge .n-base-wave').length === 3
    )
    assert.equal(
      await window.locator('.session-status-badge[data-status="waiting"] .n-badge-sup').innerText(),
      '?'
    )
    assert.equal(await window.locator('.session-executing-dots').count(), 2)
    // 采样一轮动画中的三个时刻，验证点数确实分三步变化，同时保留所有 badge 的 processing 波纹。
    const badgeAnimation = await window
      .locator('.session-executing-dots')
      .first()
      .evaluate((dots) => {
        const animation = dots.getAnimations()[0]
        animation.pause()
        const clips = [0, 500, 1000].map((time) => {
          animation.currentTime = time
          return getComputedStyle(dots).clipPath
        })
        animation.play()
        return {
          clips,
          iterations: String(animation.effect.getTiming().iterations),
          waves: [...document.querySelectorAll('.session-status-badge .n-base-wave')].map(
            (wave) => ({
              name: getComputedStyle(wave).animationName,
              iterations: getComputedStyle(wave).animationIterationCount
            })
          )
        }
      })
    assert.equal(new Set(badgeAnimation.clips).size, 3)
    assert.equal(badgeAnimation.iterations, 'Infinity')
    assert.ok(
      badgeAnimation.waves.every(
        (wave) => wave.name === 'badge-wave-spread' && wave.iterations === 'infinite'
      )
    )
    const repoCard = window.locator('[data-folder="ebisu-workspace"]')
    // 注册顺序中排在后面的协作项目自动置顶，边框加粗不会导致卡片变高。
    assert.equal(
      await window.locator('.project-card').first().getAttribute('data-folder'),
      'ebisu-workspace'
    )
    assert.deepEqual(
      await repoCard.evaluate((card) => ({
        height: card.getBoundingClientRect().height,
        border: getComputedStyle(card).borderTopWidth
      })),
      { height: idleHeight, border: '4px' }
    )
    await assertCardState(window, 'waiting', idleHeight)
    await assertAvatarBackground(window, 3, 180, 90)
    await repoCard.hover()
    await assertCardState(window, 'waiting', idleHeight)
    assert.equal(
      await window
        .getByRole('button', { name: '关联文件夹', exact: true })
        .evaluate((button) => getComputedStyle(button).fontSize),
      '14px'
    )
    assert.equal(
      await repoCard
        .locator('.session-status-badge .n-badge-sup')
        .first()
        .evaluate((badge) => getComputedStyle(badge).fontSize),
      '12px'
    )
    await repoCard.locator('.icon-button').click()
    await window.locator('.n-dropdown-option-body').first().waitFor()
    assert.equal(
      await window
        .locator('.n-dropdown-option-body')
        .first()
        .evaluate((option) => getComputedStyle(option).fontSize),
      '14px'
    )
    await window.getByText('修改显示名称', { exact: true }).click()
    await window.locator('.n-input__input-el').waitFor()
    assert.equal(
      await window
        .locator('.n-input__input-el')
        .evaluate((input) => getComputedStyle(input).fontSize),
      '14px'
    )
    await window.getByRole('button', { name: '取消', exact: true }).click()
    await window.locator('.n-input__input-el').waitFor({ state: 'hidden' })
    await window.waitForFunction(
      () => document.querySelector('.toolbar-sessions strong')?.textContent === '3'
    )
    assert.equal(await window.locator('.project-stats, .page-footer').count(), 0)
    assert.equal(await window.locator('[data-filter="all"] .tab-count').innerText(), '2')
    assert.equal(await window.locator('[data-filter="busy"] .tab-count').innerText(), '1')
    assert.equal(await window.locator('[data-filter="idle"] .tab-count').innerText(), '1')
    assert.equal(
      await repoCard
        .locator('.session-avatar')
        .first()
        .evaluate((image) => image.getBoundingClientRect().width),
      34
    )
    await window.locator('[data-filter="busy"]').click()
    assert.equal(await window.locator('.project-card').count(), 1)
    await window.locator('[data-filter="idle"]').click()
    assert.equal(await window.locator('[data-folder="design-notes"]').count(), 1)
    assert.equal(await window.locator('.toolbar-sessions strong').innerText(), '3')
    assert.equal(
      await window.locator('.project-card').first().getAttribute('data-folder'),
      'design-notes'
    )
    await window.locator('[data-filter="all"]').click()
    // 同一会话占用第二个项目时只增加忙碌项目数，不重复增加会话总数。
    await activity(ordinary, 'codex', '0199d205-691a-74cf-9b7e-cd307e3188d7')
    await window.waitForFunction(
      () => document.querySelector('[data-filter="busy"] .tab-count')?.textContent === '2'
    )
    assert.equal(
      await window.locator('.project-card').first().getAttribute('data-folder'),
      'design-notes'
    )
    assert.equal(await window.locator('.toolbar-sessions strong').innerText(), '3')
    await activity(ordinary, 'codex', '0199d205-691a-74cf-9b7e-cd307e3188d7', { action: 'exit' })
    await window.waitForFunction(
      () => document.querySelector('[data-filter="idle"] .tab-count')?.textContent === '1'
    )
    assert.equal(
      await window.locator('.project-card').first().getAttribute('data-folder'),
      'ebisu-workspace'
    )
    assert.equal(
      await repoCard.locator('.folder-path, .git-counts, .open-folder, .clear-session').count(),
      0
    )
    assert.equal(await repoCard.getByText('准备好开始下一次协作').count(), 0)
    await repoCard.locator('.folder-symbol').hover()
    await window.locator('.folder-details').waitFor()
    const folderDetails = await window.locator('.folder-details').innerText()
    for (const value of [
      'ebisu-workspace',
      repo.path,
      'feature/strategy-3880-date-time-picker',
      'dirty',
      '新增 1',
      '修改 1',
      '删除 1'
    ])
      assert.ok(folderDetails.includes(value), `folder popover should include ${value}`)
    await window.screenshot({ path: path.join(screenshots, 'folder-details.png') })
    await window.locator('h1').hover()
    await window.locator('.folder-details').waitFor({ state: 'hidden' })
    await repoCard.locator('.session.waiting').hover()
    await window.locator('.session-details').waitFor()
    assert.ok((await window.locator('.session-details').innerText()).includes('问题待确认'))
    assert.equal(await window.locator('.session-task-title').innerText(), '修复登录自动更新 500')
    const copyButton = window.locator('.session-id-heading .copy-session-id')
    assert.equal(await copyButton.innerText(), '')
    assert.equal(await copyButton.locator('svg').count(), 1)
    // 在隔离 renderer 内替换剪贴板写入，验证气泡按钮，不覆盖用户系统剪贴板。
    await window.evaluate(() => {
      navigator.clipboard.writeText = async (text) => {
        window.__copiedSessionId = text
      }
    })
    await window.screenshot({ path: path.join(screenshots, 'session-details.png') })
    await window
      .locator('.session-details')
      .getByRole('button', { name: '复制 ID', exact: true })
      .click()
    assert.equal(await window.evaluate(() => window.__copiedSessionId), 'session-claude-7a12f05c')
    await window.locator('h1').hover()
    await window.locator('.session-details').waitFor({ state: 'hidden' })
    await window.waitForFunction(() => document.querySelectorAll('.n-message').length === 0)
    await window.screenshot({ path: path.join(screenshots, 'dashboard-light.png') })
    // 故障会话使用 error badge 与感叹号，项目状态优先于等待和执行。
    await activity(repository, 'grok', 'grok-fault', { phase: 'error', model: 'grok-4' })
    await window.locator('.session-status-badge[data-status="error"] .n-badge-sup').waitFor()
    await assertCardState(window, 'error', idleHeight)
    await assertAvatarBackground(window, 4, 180, 90)
    assert.equal(
      await window.locator('.session-status-badge[data-status="error"] .n-badge-sup').innerText(),
      '!'
    )
    await repoCard.locator('.session.error').hover()
    await window.locator('.session-details').waitFor()
    assert.ok((await window.locator('.session-details').innerText()).includes('出现故障'))
    await window.screenshot({ path: path.join(screenshots, 'error-light.png') })
    await window.locator('h1').hover()
    await window.locator('.session-details').waitFor({ state: 'hidden' })
    // 同项目的下一条执行中请求清除全部故障，故障会话随之释放。
    await activity(repository, 'claude', 'session-claude-7a12f05c', { phase: 'executing' })
    await window
      .locator('.session-status-badge[data-status="error"]')
      .waitFor({ state: 'detached' })
    await assertCardState(window, 'executing', idleHeight)
    // 多于一行容量时显示 +x；气泡横排头像，继续悬停可查看详情并复制 ID。
    for (let i = 0; i < 8; i++)
      await activity(repository, 'codex', `overflow-session-${i}`, { taskTitle: `并发任务 ${i}` })
    await repoCard.locator('.session-overflow').waitFor()
    const avatarLayout = await repoCard.locator('.session-avatar-row').evaluate((row) => ({
      count: row.querySelectorAll('.session').length,
      hidden: Number(row.querySelector('.session-overflow').textContent.slice(1)),
      tops: [...row.children].map((element) => element.getBoundingClientRect().top),
      overflow: row.scrollWidth > row.clientWidth
    }))
    assert.equal(avatarLayout.count + avatarLayout.hidden, 11)
    assert.equal(new Set(avatarLayout.tops).size, 1)
    assert.equal(avatarLayout.overflow, false)
    // 8 个未提供模型名的并发会话没有角色背景，背景层只保留三个已识别模型。
    await assertAvatarBackground(window, 3, 180, 90)
    assert.equal(await repoCard.locator('.session-group-badge .n-badge-sup').count(), 0)
    await activity(repository, 'codex', 'overflow-session-7', { phase: 'waiting' })
    await repoCard.locator('.session-group-badge .n-badge-sup').waitFor()
    // 此时直接展示的会话全在执行，只有 +x 内的会话在等待，卡片也必须显示需要处理。
    await assertCardState(window, 'waiting', idleHeight)
    assert.equal(await repoCard.locator('.session-group-badge .n-badge-sup').innerText(), '?')
    assert.equal(await repoCard.locator('.session-group-badge .n-base-wave').count(), 1)
    await repoCard.locator('.session-overflow').hover()
    await window.locator('.overflow-session-avatars').waitFor()
    assert.equal(
      await window.locator('.overflow-session-avatars .session').count(),
      avatarLayout.hidden
    )
    assert.equal(await window.locator('.overflow-session-avatars .session.waiting').count(), 1)
    const hiddenTops = await window
      .locator('.overflow-session-avatars .session')
      .evaluateAll((avatars) => avatars.map((avatar) => avatar.getBoundingClientRect().top))
    assert.equal(new Set(hiddenTops).size, 1)
    await window.locator('.overflow-session-avatars .session').last().hover()
    const lastDetails = window.locator('.session-details')
    await lastDetails.waitFor()
    const lastId = await lastDetails.locator('.session-full-id').innerText()
    assert.equal(await lastDetails.locator('.session-task-title').innerText(), '并发任务 7')
    await lastDetails.getByRole('button', { name: '复制 ID', exact: true }).click()
    assert.equal(await window.evaluate(() => window.__copiedSessionId), lastId)
    await window.screenshot({ path: path.join(screenshots, 'overflow-details.png') })
    await window.locator('h1').hover()
    await window.locator('.overflow-session-avatars').waitFor({ state: 'hidden' })
    await window.locator('.session-details').waitFor({ state: 'hidden' })
    await activity(repository, 'codex', 'overflow-session-7', { phase: 'executing' })
    await repoCard.locator('.session-group-badge .n-badge-sup').waitFor({ state: 'detached' })
    await assertCardState(window, 'executing', idleHeight)
    // 折叠的会话故障时，+x 使用 error 色的感叹号并让项目显示故障。
    await activity(repository, 'codex', 'overflow-session-7', { phase: 'error' })
    await repoCard.locator('.session-group-badge .n-badge-sup').waitFor()
    await assertCardState(window, 'error', idleHeight)
    assert.equal(await repoCard.locator('.session-group-badge .n-badge-sup').innerText(), '!')
    // 同项目任一执行中请求清除全部故障；故障会话被释放，+x 回到无状态。
    await activity(repository, 'codex', 'overflow-session-6', { phase: 'executing' })
    await repoCard.locator('.session-group-badge .n-badge-sup').waitFor({ state: 'detached' })
    await assertCardState(window, 'executing', idleHeight)
    // 窗口缩放触发真实 ResizeObserver，主面板头像容量随卡片宽度变化。
    const originalBounds = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (window) => !window.webContents.getURL().includes('tray=1')
      )
      const bounds = main.getBounds()
      // 1000px 时 grid 从三列变成两列，每张卡片更宽；避开扩宽后新增列、容量恰好相同的断点。
      main.setSize(1000, bounds.height)
      return bounds
    })
    await window.waitForFunction(
      (previous) =>
        document
          .querySelector('[data-folder="ebisu-workspace"] .session-avatar-row')
          .querySelectorAll('.session').length !== previous,
      avatarLayout.count
    )
    await app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.getURL().includes('tray=1'))
        .setBounds(bounds)
    }, originalBounds)
    for (let i = 0; i < 8; i++)
      await activity(repository, 'codex', `overflow-session-${i}`, { action: 'exit' })
    await repoCard.locator('.session-overflow').waitFor({ state: 'detached' })
    await activity(repository, 'claude', 'session-claude-7a12f05c', { phase: 'waiting' })
    // 验证真实安装探测；只在临时 HOME 写通知配置。
    await window.getByRole('button', { name: '设置', exact: true }).click()
    await window.locator('[data-terminal="qoder"]').waitFor()
    assert.equal(
      await window
        .locator('.n-base-selection-label')
        .evaluate((label) => getComputedStyle(label).fontSize),
      '14px'
    )
    await window.locator('.n-select').click()
    await window.locator('.n-base-select-option').first().waitFor()
    assert.equal(
      await window
        .locator('.n-base-select-option')
        .first()
        .evaluate((option) => getComputedStyle(option).fontSize),
      '14px'
    )
    await window.locator('.preference-heading').click()
    assert.equal(await window.locator('.integration-row').count(), 5)
    const detection = await window.evaluate(async () =>
      (await window.ebisu.snapshot()).integrations.map(({ id, detected, evidence }) => ({
        id,
        detected,
        evidence
      }))
    )
    console.log('Actual machine detection:', JSON.stringify(detection))
    for (const id of ['codex', 'workbuddy', 'claude', 'grok'])
      assert.equal(
        detection.find((item) => item.id === id).detected,
        true,
        `${id} should be detected`
      )
    // 用户可在开发期间安装终端；实机结果跟随实际状态，未安装分支另有隔离测试。
    assert.equal(
      await window
        .locator('[data-terminal="qoder"]')
        .getByRole('button', { name: '安装集成' })
        .isDisabled(),
      !detection.find((item) => item.id === 'qoder').detected
    )
    await window
      .locator('[data-terminal="codex"]')
      .getByRole('button', { name: '安装集成' })
      .click()
    await window
      .locator('[data-terminal="codex"]')
      .getByRole('button', { name: '检查', exact: true })
      .waitFor()
    assert.equal(existsSync(path.join(home, '.codex/hooks.json')), true)
    await window
      .locator('[data-terminal="codex"] .installation-badge')
      .getByText('已安装', { exact: true })
      .waitFor()
    assert.equal(
      await window
        .locator('.integration-heading')
        .getByRole('button', { name: '重新探测', exact: true })
        .count(),
      1
    )
    assert.equal(await window.locator('.settings-heading h1').innerText(), '设置.')
    assert.equal(await window.locator('.integration-info p, .settings-footer').count(), 0)
    assert.equal(await window.getByText('等待会话验证', { exact: true }).count(), 0)
    const skillReview = path.join(screenshots, 'skills', 'ebisu-codex')
    mkdirSync(skillReview, { recursive: true })
    copyFileSync(
      path.join(home, '.agents/skills/ebisu-codex/SKILL.md'),
      path.join(skillReview, 'SKILL.md')
    )
    const connectivity = await window.evaluate(() => window.ebisu.check('codex'))
    assert.match(connectivity, /本机通知链路正常/)
    await window.waitForFunction(() =>
      [...document.images].every((image) => image.complete && image.naturalWidth > 0)
    )
    await window.waitForFunction(() => document.querySelectorAll('.n-message').length === 0)
    await window.screenshot({ path: path.join(screenshots, 'settings.png'), fullPage: true })
    await require('./skills-smoke.cjs')({ app, window, runtime, home, data, repo, screenshots })
    await app.evaluate(({ dialog }, image) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] })
    }, path.resolve('resources/avatars/terminal-workbuddy.png'))
    await window.evaluate(() => window.ebisu.chooseAvatar('model:gpt'))
    const customized = await window.evaluate(() => window.ebisu.snapshot())
    assert.ok(customized.settings.avatars['model:gpt'].startsWith(data))
    // 托盘设置展示七种独立形象；预览地址和卡片背景地址必须读取同一自定义副本。
    assert.equal(await window.locator('[data-avatar^="tray:"]').count(), 7)
    const readAsset = (url) =>
      app.evaluate(async ({ net }, url) => {
        const response = await net.fetch(url)
        return Buffer.from(await response.arrayBuffer()).toString('base64')
      }, url)
    const trayUrl = 'ebisu-asset://avatar/model/gpt?background=1&tray=1'
    assert.equal(
      await readAsset(trayUrl),
      readFileSync(path.resolve('resources/avatars/tray/model-gpt.png')).toString('base64')
    )
    const trayImage = path.resolve('resources/avatars/tray/model-claude.png')
    await app.evaluate(({ dialog }, image) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] })
    }, trayImage)
    await window.locator('[data-avatar="tray:gpt"]').click()
    await window.waitForFunction(() => !document.querySelector('[data-avatar="tray:gpt"]').disabled)
    const withTrayAvatar = (await window.evaluate(() => window.ebisu.snapshot())).settings.avatars
    assert.ok(withTrayAvatar['tray:gpt'].startsWith(data))
    assert.notEqual(withTrayAvatar['model:gpt'], withTrayAvatar['tray:gpt'])
    assert.equal(await readAsset(trayUrl), readFileSync(trayImage).toString('base64'))
    assert.equal(
      await readAsset('ebisu-asset://avatar/tray/gpt'),
      readFileSync(trayImage).toString('base64')
    )
    assert.equal(
      await readAsset('ebisu-asset://avatar/model/gpt?background=1'),
      readFileSync(customized.settings.avatars['model:gpt']).toString('base64')
    )
    await window.waitForFunction(() =>
      [...document.images].every((image) => image.complete && image.naturalWidth > 0)
    )
    await window.screenshot({
      path: path.join(screenshots, 'settings-tray-avatars.png'),
      fullPage: true
    })
    await window.evaluate(() => window.ebisu.resetAvatars())
    assert.deepEqual((await window.evaluate(() => window.ebisu.snapshot())).settings.avatars, {})
    assert.equal(
      await readAsset(trayUrl),
      readFileSync(path.resolve('resources/avatars/tray/model-gpt.png')).toString('base64')
    )
    await window.evaluate(() => window.ebisu.setTheme('dark'))
    await window.getByRole('button', { name: '项目面板', exact: false }).first().click()
    await window.locator('.app-shell.dark').waitFor()
    await assertCardState(window, 'waiting', idleHeight)
    await assertAvatarBackground(window, 3, 180, 90)
    await window.screenshot({ path: path.join(screenshots, 'dashboard-dark.png') })
    const tray = app.windows().find((page) => page.url().includes('tray=1'))
    assert.ok(tray, 'tray should have the same renderer')
    tray.on('pageerror', (error) => errors.push(String(error)))
    const trayCard = tray.locator('[data-folder="ebisu-workspace"]')
    await trayCard.locator('.session-overflow').waitFor()
    await assertCardState(tray, 'waiting', trayBusyHeight)
    await assertAvatarBackground(tray, 3)
    assert.equal(await tray.locator('.project-heading, .heading-actions').count(), 0)
    assert.equal(await tray.locator('.toolbar-sessions').count(), 1)
    assert.equal(await window.locator('.toolbar-sessions').count(), 1)
    assert.equal(await trayCard.locator('.card-divider, .idle-state').count(), 0)
    assert.equal(await trayCard.locator('.card-top .session').count(), 2)
    assert.equal(await trayCard.locator('.session-overflow').innerText(), '+1')
    const trayBranch = await trayCard.evaluate((card) => {
      const branch = card.querySelector('.branch-name')
      return {
        cardWidth: card.getBoundingClientRect().width,
        width: branch.getBoundingClientRect().width,
        scrollWidth: branch.scrollWidth,
        clientWidth: branch.clientWidth,
        textOverflow: getComputedStyle(branch).textOverflow
      }
    })
    assert.ok(trayBranch.width <= trayBranch.cardWidth / 2)
    assert.equal(trayBranch.textOverflow, 'ellipsis')
    assert.ok(trayBranch.scrollWidth > trayBranch.clientWidth)
    const trayLayout = await trayCard.evaluate((card) => {
      const title = card.querySelector('.card-project-name').getBoundingClientRect()
      const avatars = card.querySelector('.session-avatar-row').getBoundingClientRect()
      const menu = card.querySelector('.icon-button').getBoundingClientRect()
      return {
        height: card.getBoundingClientRect().height,
        title: title.right,
        avatarsLeft: avatars.left,
        avatarsRight: avatars.right,
        menu: menu.left
      }
    })
    assert.ok(trayLayout.height < 130)
    assert.ok(trayLayout.title <= trayLayout.avatarsLeft)
    assert.ok(trayLayout.avatarsRight <= trayLayout.menu)
    await tray.screenshot({ path: path.join(screenshots, 'tray.png') })
    await activity(repository, 'grok', 'grok-96bd44c0', { phase: 'waiting' })
    await activity(repository, 'claude', 'session-claude-7a12f05c', { phase: 'executing' })
    await trayCard.locator('.session-group-badge .n-badge-sup').waitFor()
    await assertCardState(tray, 'waiting', trayBusyHeight)
    await trayCard.locator('.session-overflow').hover()
    await tray.locator('.overflow-session-avatars .session.waiting').waitFor()
    await tray.locator('.overflow-session-avatars .session').hover()
    await tray.locator('.session-details').waitFor()
    assert.ok((await tray.locator('.session-details').innerText()).includes('grok-96bd44c0'))
    assert.equal(await tray.locator('.session-task-title').innerText(), '未提供')
    await tray.screenshot({ path: path.join(screenshots, 'tray-overflow.png') })
    await tray.locator('.tray-brand').hover()
    await tray.locator('.overflow-session-avatars').waitFor({ state: 'hidden' })
    await tray.locator('.session-details').waitFor({ state: 'hidden' })
    await activity(repository, 'grok', 'grok-96bd44c0', { phase: 'executing' })
    await trayCard.locator('.session-group-badge .n-badge-sup').waitFor({ state: 'detached' })
    await activity(repository, 'claude', 'session-claude-7a12f05c', { phase: 'executing' })
    await window.locator('.session.waiting').waitFor({ state: 'detached' })
    assert.equal(await window.locator('.session-status-badge[data-status="waiting"]').count(), 0)
    assert.equal(await window.locator('.session-executing-dots').count(), 3)
    await repoCard.hover()
    await assertCardState(window, 'executing', idleHeight)
    await assertCardState(tray, 'executing', trayBusyHeight)
    await window.screenshot({ path: path.join(screenshots, 'executing-dark.png') })
    await activity(repository, 'codex', '0199d205-691a-74cf-9b7e-cd307e3188d7', { action: 'exit' })
    await window.waitForFunction(() => document.querySelectorAll('.session').length === 2)
    await tray.waitForFunction(() => document.querySelectorAll('.session').length === 2)
    await window.evaluate(
      (id) =>
        window.ebisu.renameFolder(id, '用于验证项目标题过长时自动省略并保持操作菜单可见的项目名称'),
      repo.id
    )
    const longTitle = window
      .locator('.card-project-name')
      .filter({ hasText: '用于验证项目标题过长' })
    await longTitle.waitFor()
    assert.equal(
      await longTitle.evaluate(
        (element) =>
          element.scrollWidth > element.clientWidth &&
          getComputedStyle(element).textOverflow === 'ellipsis'
      ),
      true
    )
    for (const [terminal, sessionId] of [
      ['claude', 'session-claude-7a12f05c'],
      ['grok', 'grok-96bd44c0']
    ])
      await activity(repository, terminal, sessionId, { action: 'exit' })
    // 清空最后一个会话后恢复空闲，且协作项目置顶规则随之解除。
    await window.evaluate((id) => window.ebisu.renameFolder(id, 'ebisu-workspace'), repo.id)
    await assertCardState(window, 'idle', idleHeight)
    await assertCardState(tray, 'idle', trayIdleHeight)
    await assertAvatarBackground(window, 0)
    await assertAvatarBackground(tray, 0)
    assert.equal(
      await window.locator('.project-card').first().getAttribute('data-folder'),
      'design-notes'
    )
    await window.evaluate((id) => window.ebisu.renameFolder(id, 'renamed-project'), repo.id)
    await window.locator('[data-folder="renamed-project"]').waitFor()
    const plain = initial.folders.find((folder) => folder.name === 'design-notes')
    await window.evaluate((id) => window.ebisu.removeFolder(id), plain.id)
    assert.equal(existsSync(ordinary), true, 'removing registration must keep files')
    if (process.platform === 'darwin' && !packaged) {
      // 用另一个 Electron 进程模拟“其他应用”的原生全屏 Space，退出时自动恢复。
      // NSWorkspace/CoreGraphics 只读取前台 PID 与可见窗口，不依赖辅助功能权限。
      const helper = path.join(fixture, 'fullscreen-fixture.cjs')
      writeFileSync(
        helper,
        `
        const { app, BrowserWindow } = require('electron')
        app.setPath('userData', process.env.EBISU_SPACE_DATA)
        app.whenReady().then(() => {
          const window = new BrowserWindow({ width: 900, height: 600, show: false })
          window.loadURL('data:text/html,<body style="background:%2321313f;color:white;font:24px sans-serif;padding:40px">Ebisu fullscreen Space fixture</body>')
        })
      `
      )
      fullscreenApp = await electron.launch({
        executablePath: require('electron'),
        args: [helper],
        env: { ...env, EBISU_SPACE_DATA: path.join(fixture, 'space-data') }
      })
      await fullscreenApp.firstWindow()
      await fullscreenApp.evaluate(
        ({ BrowserWindow }) =>
          new Promise((resolve) => {
            const window = BrowserWindow.getAllWindows()[0]
            window.once('enter-full-screen', () => resolve(true))
            window.show()
            window.focus()
            window.setFullScreen(true)
          })
      )
      const nativeState = () =>
        JSON.parse(
          execFileSync(
            '/usr/bin/osascript',
            [
              '-l',
              'JavaScript',
              '-e',
              `
        ObjC.import('AppKit'); ObjC.import('CoreGraphics');
        var windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)));
        JSON.stringify({ pid: Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),
          windows: windows.map(function(w) { return { id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID }; }) });
      `
            ],
            { encoding: 'utf8', timeout: 3000 }
          )
        )
      const foreignPid = fullscreenApp.process().pid
      const foreignWindowId = await fullscreenApp.evaluate(({ BrowserWindow }) =>
        Number(BrowserWindow.getAllWindows()[0].getMediaSourceId().split(':')[1])
      )
      async function waitNative(predicate) {
        for (let i = 0; i < 40; i++) {
          const state = nativeState()
          if (predicate(state)) return state
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw new Error(`Unexpected native Space state: ${JSON.stringify(nativeState())}`)
      }
      await waitNative(
        (state) => state.pid === foreignPid && state.windows.some((w) => w.id === foreignWindowId)
      )
      const popup = await app.evaluate(({ app, BrowserWindow }) => {
        // 调用实际托盘点击使用的同一入口，不在测试中复制显示逻辑。
        const require = process
          .getBuiltinModule('module')
          .createRequire(app.getAppPath() + '/package.json')
        require(app.getAppPath() + '/out/main/index.js').toggleTray()
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('tray=1')
        )
        return {
          id: Number(window.getMediaSourceId().split(':')[1]),
          allSpaces: window.isVisibleOnAllWorkspaces(),
          top: window.isAlwaysOnTop(),
          fullscreenable: window.isFullScreenable()
        }
      })
      assert.equal(popup.allSpaces, true)
      assert.equal(popup.top, true)
      assert.equal(popup.fullscreenable, false)
      await waitNative(
        (state) =>
          state.pid === foreignPid &&
          [foreignWindowId, popup.id].every((id) => state.windows.some((w) => w.id === id))
      )
      assert.equal(
        await fullscreenApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isFullScreen()
        ),
        true
      )
      await app.evaluate(({ app }) => {
        const require = process
          .getBuiltinModule('module')
          .createRequire(app.getAppPath() + '/package.json')
        require(app.getAppPath() + '/out/main/index.js').toggleTray()
      })
      await waitNative(
        (state) => state.pid === foreignPid && !state.windows.some((w) => w.id === popup.id)
      )
      console.log(
        'Native macOS fullscreen Space passed: foreign app stays active; its fullscreen window and Ebisu tray panel remain on screen together.'
      )
      await fullscreenApp.close()
      fullscreenApp = undefined
    }
    // 关闭主窗仅隐藏；托盘窗、服务与进程仍在运行。
    const resident = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (window) => !window.webContents.getURL().includes('tray=1')
      )
      main.close()
      return {
        destroyed: main.isDestroyed(),
        visible: main.isVisible(),
        windows: BrowserWindow.getAllWindows().length
      }
    })
    assert.deepEqual(resident, { destroyed: false, visible: false, windows: 2 })
    assert.deepEqual(errors, [], 'renderer errors')
    /** 使用真实 app.quit 路径验收释放锁，不用 Playwright 的强制关闭掩盖退出挂起。 */
    async function quitAndWait(application, blockHttpClose = false) {
      const process = application.process()
      const exited = application.waitForEvent('close', { timeout: 7000 })
      await application.evaluate(({ app }, blockHttpClose) => {
        if (blockHttpClose) {
          // 故意模拟一个永不完成的清理回调，验证退出超时仍能释放进程和单实例锁。
          process.getBuiltinModule('http').Server.prototype.close = function () {
            return this
          }
        }
        setTimeout(() => app.quit(), 20)
      }, blockHttpClose)
      await exited
      assert.equal(process.exitCode, 0)
      assert.equal(existsSync(path.join(data, 'runtime.json')), false)
    }
    await quitAndWait(app)
    app = undefined
    // 同一数据目录可再次正常启动；退出清理卡住时也必须在有界时间内结束。
    app = await electron.launch({
      executablePath: packaged || require('electron'),
      args: packaged ? [] : [path.resolve('.')],
      env,
      timeout: 30000
    })
    await app.firstWindow()
    await quitAndWait(app, true)
    app = undefined
    console.log(
      'Electron smoke passed: compact cards, folder/session popovers, ID copy, avatar overflow, long title ellipsis, Git, avatars/customization, waiting/error/resume, real detection, isolated install, themes, tray synchronization, rename/removal, resident close, graceful quit/restart and bounded shutdown.'
    )
  } finally {
    if (fullscreenApp) await fullscreenApp.close()
    if (app) await app.close()
    rmSync(fixture, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
