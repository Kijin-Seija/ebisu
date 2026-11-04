// electron-builder 的 afterPack 钩子：在签名之前把 Electron 的 framework 还原成标准的
// “版本化 bundle”结构。
//
// 背景：Electron 发行包里的 *.framework 依赖符号链接：
//   Foo.framework/Foo              -> Versions/Current/Foo
//   Foo.framework/Resources        -> Versions/Current/Resources
//   Foo.framework/Versions/Current -> A
// 某些安装/解压方式（例如 pnpm 的 store 导入）会把符号链接展开成实体文件，导致同一个
// 二进制在 framework 里出现两份（本次实测体积翻倍）。这种结构下 codesign 无法判断它是
// app 还是 framework，报 "bundle format is ambiguous (could be app or framework)" 并拒绝签名。
// 结果是打出来的包连 codesign --verify 都过不了，被 macOS 隔离后用户看到的是“已损坏”
// （没有“仍要打开”按钮），而不是可以手动放行的“未验证的开发者”。
//
// 该钩子在 electron-builder 调用 codesign 之前运行（emitAfterPack 早于 doSignAfterPack），
// 因此修好结构后 ad-hoc 签名可以正常完成。已经正常的 framework 不会被改动。
const { existsSync, lstatSync, readdirSync, rmSync, symlinkSync } = require('node:fs')
const path = require('node:path')

/** 读取 lstat；路径不存在时返回 null，避免在遍历和修改之间抛错 */
function lstatOrNull(target) {
  try {
    return lstatSync(target)
  } catch {
    return null
  }
}

/**
 * 把一个 framework 还原成版本化 bundle。
 * @returns {boolean} 是否发生了修改（用于日志统计）
 */
function normalizeFramework(framework) {
  const versions = path.join(framework, 'Versions')
  const versionsStat = lstatOrNull(versions)
  if (!versionsStat?.isDirectory()) return false

  // 版本目录名通常只有 "A"；出现多个说明不是标准结构，交给 codesign 自己处理
  const versionNames = readdirSync(versions).filter((name) => name !== 'Current')
  if (versionNames.length !== 1) return false
  const versionName = versionNames[0]
  const versionDir = path.join(versions, versionName)
  if (!lstatOrNull(versionDir)?.isDirectory()) return false

  let changed = false

  // 第一步：Versions/Current 必须是指向版本目录的符号链接
  const current = path.join(versions, 'Current')
  if (!lstatOrNull(current)?.isSymbolicLink()) {
    rmSync(current, { recursive: true, force: true })
    symlinkSync(versionName, current)
    changed = true
  }

  // 第二步：framework 顶层的可执行文件和资源目录都应指向 Versions/Current/<名称>
  for (const entry of readdirSync(framework)) {
    if (entry === 'Versions') continue
    const entryPath = path.join(framework, entry)
    const versionEntry = path.join(versionDir, entry)
    // 版本目录里没有同名条目，说明是额外文件，保持原样
    if (!existsSync(versionEntry)) continue
    if (lstatOrNull(entryPath)?.isSymbolicLink()) continue
    rmSync(entryPath, { recursive: true, force: true })
    symlinkSync(path.join('Versions', 'Current', entry), entryPath)
    changed = true
  }

  return changed
}

/** 收集 app 内所有 *.framework 目录；不跟随符号链接，避免重复进入版本目录 */
function collectFrameworks(root) {
  const found = []
  const visit = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = path.join(directory, entry.name)
      if (entry.name.endsWith('.framework')) {
        found.push(child)
        continue
      }
      visit(child)
    }
  }
  visit(root)
  return found
}

exports.default = async function afterPack(context) {
  const productName = context.packager?.appInfo?.productFilename
  if (!productName) return
  const appPath = path.join(context.appOutDir, `${productName}.app`)
  if (!existsSync(appPath)) return

  let fixed = 0
  for (const framework of collectFrameworks(appPath)) {
    try {
      if (normalizeFramework(framework)) fixed += 1
    } catch (error) {
      // 单个 framework 还原失败不阻断打包，但要让日志能定位问题
      console.warn(`  • failed to normalize ${path.relative(appPath, framework)}: ${error.message}`)
    }
  }
  if (fixed > 0) {
    console.log(`  • normalized ${fixed} framework bundle(s) before codesign`)
  }
}

// 仅用于本地调试：node scripts/after-pack.cjs <path/to/App.app>
if (require.main === module) {
  const target = process.argv[2]
  if (target) {
    let fixed = 0
    for (const framework of collectFrameworks(target)) {
      if (normalizeFramework(framework)) fixed += 1
    }
    console.log(`normalized ${fixed} framework bundle(s)`)
  }
}
