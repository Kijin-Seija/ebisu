# 终端适配依据与验收边界

## 配置来源

- Codex：[Skills](https://developers.openai.com/codex/skills/)、[Hooks](https://learn.chatgpt.com/docs/hooks)、[配置参考](https://developers.openai.com/codex/config-reference/)。
- Claude Code：[Hooks](https://code.claude.com/docs/en/hooks)。
- Grok：本机 Grok 1.0.41 安装提供的 `~/.grok/docs/user-guide/08-skills.md`、`10-hooks.md`、`12-project-rules.md`。
- WorkBuddy：本机 WorkBuddy 内置 CLI 的生命周期事件、settings schema、全局 AGENTS 和 skill 加载路径，以及现有 `~/.workbuddy` 用户配置结构。未读取密钥、对话或鉴权数据库。
- Qoder：[桌面 Hooks](https://docs.qoder.com/qoder/hooks)、[CLI Hooks](https://docs.qoder.com/cli/hooks)、[Skills](https://docs.qoder.com/cli/Skills)、[Memory](https://docs.qoder.com/cli/memory)。桌面和 CLI 共用用户级 settings hook 格式。

Grok 兼容扫描 Claude 目录，因此 Claude hook 在检测到 Grok 原生环境时跳过；Grok 原生适配器负责上报。规则也要求只使用当前宿主终端的命令。各终端使用不同 skill 名称以免同名覆盖。

## 会话身份一致性

手动 skill 上报与原生 hook 必须使用同一会话 ID。桥接工具读取 Codex 的 `CODEX_THREAD_ID / CODEX_SESSION_ID`、Qoder 的 `QODER_SESSION_ID`、WorkBuddy 的 `WORKBUDDY_SESSION_ID / CODEBUDDY_SESSION_ID`、Grok 的 `GROK_SESSION_ID` 和 Claude 的 `CLAUDE_SESSION_ID`（宿主实际提供时）；`--new-session` 优先返回宿主真实 ID，仅在缺失时生成独立 `local-` ID。原生事件的 ID 优先于环境；显式真实 ID 可指定子会话，显式临时 ID 则让位于宿主真实 ID。

Qoder 的本机复现记录确认：skill 申请了 `local-` 临时 ID，原生 hook 使用另一个真实 ID，导致同一任务显示终端头像和模型头像两个记录。其他终端在没有向工具导出会话环境变量时也存在同一风险。现在 PreToolUse / PostToolUse 从当前上报命令中读取 `--terminal` 和 `--session local-...`，与该工具事件的真实会话 ID 绑定，通过认证的 `POST /v1/identity` 只迁移身份，不产生心跳或改变 waiting/exit。PreToolUse 先绑定，随后手动上报不会短暂产生重复头像；PostToolUse 兼容已有临时记录，且不能复活已结束任务。

缺少会话 ID 的普通上报和 hook 不创建活动，不再根据共享桌面宿主进程猜测身份。规则要求只调用一次 `--new-session` 并持续显式复用 ID。只有已知 Grok 兼容扫描 Claude 配置时才抑制重复 hook，其余终端不会因继承父 Codex 环境变量而被错误跳过。

旧规则仍传入临时 ID 时，上报桥在同一次请求中明确声明 `sessionAliases`，服务端事务迁移该身份在所有目录的记录、已知模型与退出墓碑。别名按终端隔离并持久化，不能重新绑定到其他真实会话。不按相同目录、终端或相近时间合并会话，以保留真实并发任务。未获得身份证据的旧记录仍按十分钟租约过期。

正常 Stop 释放执行状态；Interrupt、SessionEnd 和显式 session 退出释放全部目录。Stop 保留明确的 waiting；StopFailure 进入 error，error 不随退出、重启或十分钟租约消失，直到同项目收到新的 executing 上报。若宿主强制取消没有发出任何事件、且 agent 无法再执行退出命令，则依旧由十分钟租约兜底（error 不参与过期），不声称能立即感知所有强制停止。

## 安装与卸载

安装记录与文件 hash 保存在 SQLite。变更前的文件副本保存在应用数据目录 `backups/<terminal>-<timestamp>-<id>/`，权限限制为当前用户。安装失败按反向顺序恢复原文。

全局 Markdown 使用 Ebisu 标记块，保留前后原文；JSON 使用解析后增量合并，保留原键与其他 hook 的语义，缩进可能被规范化。Codex TOML 通过标记行添加 hook 功能开关，保留注释与其他配置。显式禁用 hook 时不覆盖设置。

Codex 的 `features` 若使用行内表或特殊 dotted-key 写法，会保留原文并显示能力受限；请在原有 `features` 中手动启用 `hooks`，避免重复定义 TOML 表。

卸载不恢复整份旧配置，以免覆盖安装后用户的新改动；仅移除拥有标记的 handler、规则块、未被手动修改的 skill 和自己添加的开关。备份保留供人工恢复。

终端集成从不在应用启动时自动安装。共享上报桥由应用维护，并在每次启动时更新为当前应用可执行文件路径；将应用移动位置后先启动一次 Ebisu。

## 已验证与未验证

自动测试在临时 HOME 安装五种终端的配置，以对应形状的原生事件 JSON 回放到真实上报进程、HTTP 服务和 SQLite；覆盖等待、软结束、恢复、故障保留与清除、退出与兼容扫描，以及五种终端在无身份环境变量时的 skill/hook 身份绑定、多目录释放、真实并发隔离和迟到 hook 不复活任务。
Electron 端到端测试使用当前真实文件系统探测安装位置，并在临时 HOME 通过界面安装和检查。开发时最初没有发现 Qoder，后续实机探测已发现 Qoder.app 0.4.8；缺失终端分支由隔离 fixture 固定验证。

没有在各第三方终端实际启动模型任务，所以不把事件回放视为“第三方运行时已经加载 hook”的证据。设置页显示安装状态，完成配置写入即显示“已安装”；这不代表第三方运行时已经加载 hook。服务端仍单独记录真实上报与健康状态；策略阻止加载、旧版本不支持事件或沙箱无法访问服务时，可通过“检查”和实际项目活动继续排查。

应用不扫描会话内容、不从默认模型配置推测当前模型、不通过无限后台定时器延长已停止的任务。全局规则按两分钟要求主动刷新，工具事件可补充心跳，executing 与 waiting 超过十分钟没有新请求则释放；error 保留到同项目下一次执行中上报。
