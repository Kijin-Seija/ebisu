# 本机通知协议 v1

## 服务发现与认证

读取应用数据目录 `runtime.json` 中的 `port` 与 `token`，连接 `http://127.0.0.1:<port>`。
端口和令牌在应用每次启动时更新；调用方每次调用都重新读取运行信息，不能硬编码端口。
`runtime.json` 仅用户可读写；正常退出时删除，崩溃后可能残留，调用方须处理连接失败。

`GET /v1/health` 与 `POST /v1/activity` 都需要 bearer token，不接受 Origin 请求头。
健康检查返回 `{"ok":true,"name":"ebisu","version":1}`，不会创建活动或将某个终端标记健康。

## 活动请求

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| path | string，必填 | 现存文件夹绝对路径；显示名称不参与匹配 |
| terminal | string，必填 | codex / workbuddy / claude / grok / qoder |
| sessionId | string，必填 | 同一宿主终端中的稳定会话标识，最长 512 字符 |
| action | enter / exit，必填 | 进入或刷新 / 退出 |
| phase | executing / waiting | enter 时生效，默认 executing |
| model | string | 已确认的当前模型，最长 256 字符；省略时保留已有模型信息 |
| taskTitle | string | 终端已生成的真实任务/会话标题，去除首尾空白后为 1–512 字符；省略时保留已有标题 |
| scope | folder / session | 默认 folder；session 对该终端、会话的关联活动统一更新或退出 |
| preserveWaiting | boolean | 仅软退出使用：保留未过期 waiting，不延长其心跳 |
| sequence | 非负整数 | 可选递增序号，抵御迟到或重复的旧事件；不用于服务端租约计时 |

每个 `(目录, 终端, 会话 ID)` 最多一条活跃记录。目录先 realpath，再按路径边界匹配最深注册目录；不同 Git worktree 不合并。

成功返回 `{"ok":true,"ignored":false,"folderId":"…","leaseSeconds":600}`。
未注册目录、不存在的目录、旧序号或无可释放活动返回 `ignored:true`，不自动注册。
`scope:session` 的退出不依赖当前目录仍存在，因此会话目录删除或工作位置变化后也可释放。

无序号调用按接收顺序处理；需要乱序保护的调用方必须在整个会话持续使用可比较的递增序号。
通知桥以进程启动时间生成微秒序号。服务保存已退出活动及会话结束序号的边界，阻止较旧事件重新激活。

## 生命周期

- UserPromptSubmit、PreToolUse、PostToolUse：进入或刷新 executing，继续工作时清除 waiting。
- PermissionRequest、Elicitation，以及询问工具的 PreToolUse：进入 waiting。
- 受支持的权限或询问 Notification：进入 waiting；不把普通 idle 通知当作问题。
- ElicitationResult：恢复 executing。
- Stop：`exit + scope:session + preserveWaiting:true`；普通完成释放，已标为等待的会话保留。
- SessionEnd、Interrupt、StopCancelled、StopFailure：强制退出本会话。
- 普通文本提问和跨目录工作：由全局规则及 skill 主动补报。

通知桥跳过“执行自身通知命令”对应的工具前后事件，避免主动上报 waiting 或 exit 后被该命令的 PostToolUse 立刻覆盖。

工具事件只覆盖实际提供的 cwd 与结构化文件/目录参数。不解析任意 shell 命令来猜测目录；涉及其他目录的工具或任务由 skill 显式上报。
长时间没有事件的命令或思考期间仍依赖会话按规则刷新；超过十分钟没有请求即过期，不能保证捕获不遵守规则的执行。

原生事件存在真实 session ID 时优先使用；没有 ID 的显式 skill 通知应先用 `--new-session` 生成并保留 ID。
任务标题可用 `--task-title '真实标题'` 上报；hook 读取 `task_title/taskTitle/session_title/sessionTitle`，不将工具标题或提示词当作会话名称。
Codex 还会按真实会话 ID 读取 `$CODEX_HOME/session_index.jsonl`（默认 `~/.codex/`）中的 `thread_name`，优先显示该索引中的最新名称。该元数据属于本地兼容适配；索引不存在或格式变化时回退到上报标题，无标题显示“未提供”。不读取 Codex 对话正文或数据库中的原始提示词。标题变化在下一次快照刷新时生效（正常运行约 15 秒），不延长活动租约。
手工调用完全省略 session ID 时，通知桥还会尝试基于宿主进程和启动时间派生 ID；共享 GUI 进程无法保证区分并行聊天，因此不应把这一兜底当作真实会话标识。

## 错误与失败处理

HTTP 400 为 JSON 或参数错误，401 为认证或 Origin 被拒绝，404 为未知接口，413 为请求体超过 32 KiB，415 为非 JSON，500 为持久化更新失败。
收到请求的时间由主进程记录。定时清理间隔一秒；重启、快照读取及系统唤醒也检查过期。

默认通知桥静默失败，不影响原任务，不自动启动应用，不输出令牌。单次 HTTP 空闲超时为 700ms，hook 配置超时为两秒。
`--check` 输出健康检查 JSON，`--new-session` 输出新 ID；其他上报不会向 agent 注入提示、阻止工具或自动授权。
