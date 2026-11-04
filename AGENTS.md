# 项目约定

- 使用 TypeScript；复杂业务函数、状态转换和关键变量使用中文注释，说明用途与边界。
- 主进程负责文件、Git、HTTP 和 SQLite，renderer 只通过受限 preload 业务 API 调用。
- 集成测试必须使用临时 HOME；不得为测试直接覆盖真实终端全局配置。
- 如存在 `.codegraph/`，理解或定位代码前先使用 CodeGraph；不要自动创建索引。
- 测试直接运行 `pnpm test [测试文件…]`（内部以 Electron Node 运行 vitest），冒烟测试用 `pnpm test:smoke`。
- `pnpm typecheck`、`pnpm build` 与 `pnpm package:mac` 不运行项目测试。
- SQLite 原生依赖使用 Electron ABI，测试启动器已统一到 Electron Node 模式。
