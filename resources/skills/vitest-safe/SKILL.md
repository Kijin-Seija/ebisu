---
name: vitest-safe
description: 当任务需要执行项目测试，尤其是 Vitest、由 Vitest 驱动的 package test 脚本或完整测试套件时使用；也可通过 ${INVOKE} 显式调用。通过全局 vitest-safe 队列运行命令，避免多个测试进程同时耗尽内存。
---


## Ebisu 运行方式

先读取入口返回的经验与变量。运行工具必须通过 `${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill vitest-safe --path "$PWD" --script scripts/脚本名 -- 参数`，不从安装目录推导项目、不直接改写中央文件。

# Vitest 安全执行

## 适用范围

只要命令会执行项目测试，就必须使用这个 skill。包括直接调用 `vitest`、`pnpm exec vitest`、`npm exec vitest`，以及经过 `package.json` 脚本间接启动 Vitest 的命令（例如 `pnpm test`、`pnpm --filter <package> test`）；其他测试框架的测试命令也走同一个队列。

先查看项目脚本，确认一个看起来普通的 `test` 命令是否实际调用了 Vitest；确认后也必须走队列。

## 强制执行方式

所有项目测试均通过客户端运行中央队列包装器：

```sh
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill vitest-safe --path "$PWD" --script scripts/vitest-safe -- -- pnpm test
```

不要直接执行测试命令，不要为绕过队列额外启动完整套件。等待 slot 时继续等待已有进程。包装器采用内核文件锁，进程结束或崩溃时自动释放。

共享队列兼容已有 chimata-vitest-safe 配置与锁目录；没有配置时最大并发为 2。全局并发上限与锁目录通过技能层变量设置，不允许终端或项目覆盖。若依赖或配置不可用，明确报告，不退回直接测试。
