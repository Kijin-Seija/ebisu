# 本机通知协议 v1

## 服务发现与认证

读取应用数据目录 `runtime.json` 中的 `port` 与 `token`，连接 `http://127.0.0.1:<port>`。
端口和令牌在应用每次启动时更新；调用方每次调用都重新读取运行信息，不能硬编码端口。
`runtime.json` 仅用户可读写；正常退出时删除，崩溃后可能残留，调用方须处理连接失败。

`GET /v1/health` 与 `POST /v1/activity` 都需要 bearer token，不接受 Origin 请求头。
健康检查返回 `{"ok":true,"name":"ebisu","version":1}`，不会创建活动或将某个终端标记健康。

## 活动请求

| 字段            | 类型                        | 语义                                                                           |
| --------------- | --------------------------- | ------------------------------------------------------------------------------ |
| path            | string，必填                | 现存文件夹绝对路径；显示名称不参与匹配                                         |
| terminal        | string，必填                | codex / workbuddy / claude / grok / qoder / qodercn / dsh                      |
| sessionId       | string，必填                | 同一宿主终端中的稳定会话标识，最长 512 字符                                    |
| action          | enter / exit，必填          | 进入或刷新 / 退出                                                              |
| phase           | executing / waiting / error | enter 时生效，默认 executing；error 表示网络、额度等无法继续的故障             |
| model           | string                      | 已确认的当前模型，最长 256 字符；省略时保留已有模型信息                        |
| taskTitle       | string                      | 终端已生成的真实任务/会话标题，去除首尾空白后为 1–512 字符；省略时保留已有标题 |
| scope           | folder / session            | 默认 folder；session 对该终端、会话的关联活动统一更新或退出                    |
| preserveWaiting | boolean                     | 仅软退出使用：保留未过期 waiting，不延长其心跳                                 |
| sequence        | 非负整数                    | 可选递增序号，抵御迟到或重复的旧事件；不用于服务端租约计时                     |

每个 `(目录, 终端, 会话 ID)` 最多一条活跃记录。目录先 realpath，再按路径边界匹配最深注册目录；不同 Git worktree 不合并。

成功返回 `{"ok":true,"ignored":false,"folderId":"…","leaseSeconds":600}`。
未注册目录、不存在的目录、旧序号或无可释放活动返回 `ignored:true`，不自动注册。
`scope:session` 的退出不依赖当前目录仍存在，因此会话目录删除或工作位置变化后也可释放。

无序号调用按接收顺序处理；需要乱序保护的调用方必须在整个会话持续使用可比较的递增序号。
通知桥以进程启动时间生成微秒序号。服务保存已退出活动及会话结束序号的边界，阻止较旧事件重新激活。

## 生命周期

- UserPromptSubmit、PreToolUse、PostToolUse：进入或刷新 executing，继续工作时清除 waiting 和该项目的 error。
- PermissionRequest、Elicitation，以及询问工具的 PreToolUse：进入 waiting；waiting 不会覆盖已有 error。
- 受支持的权限或询问 Notification：进入 waiting；不把普通 idle 通知当作问题。
- ElicitationResult：恢复 executing。
- Stop：`exit + scope:session + preserveWaiting:true`；普通完成释放，已标为等待的会话保留。
- SessionEnd、Interrupt、StopCancelled：强制退出本会话，但不清除 error。
- StopFailure：进入 error；故障状态不随 exit、重启或租约过期消失。
- 同一目录收到任意新的 executing enter 时，清除该目录下所有会话的 error；其他目录不受影响。
- 普通文本提问、跨目录工作及模型接口故障：由全局规则及 skill 主动补报。任务结果为失败、阻塞、未合并、检查未通过或需要后续处理时仍属于正常结束，必须使用 `exit`，不得写入 `error`。

通知桥跳过“执行自身通知命令”对应的工具前后事件，避免主动上报 waiting、error 或 exit 后被该命令的 PostToolUse 立刻覆盖。

手动桥接故障通知必须同时提供 `--phase error --model-error '宿主返回的接口错误原文'`。缺少接口错误原文的手动 `enter + error` 被忽略，避免旧规则把“阻塞/未合并”等结果上报为故障；不扫描最终回答或工具结果来推断故障。原生 `StopFailure` 本身作为宿主接口失败事件处理。

工具事件只覆盖实际提供的 cwd 与结构化文件/目录参数。不解析任意 shell 命令来猜测目录；涉及其他目录的工具或任务由 skill 显式上报。
长时间没有事件的命令或思考期间仍依赖会话按规则刷新；executing 与 waiting 超过十分钟没有请求即过期，error 不参与租约过期，只能由同项目的 executing 请求清除。因此仍不能保证捕获不遵守规则的执行。

原生事件存在真实 session ID 时优先使用；没有 ID 的显式 skill 通知应先用 `--new-session` 生成并保留 ID。
任务标题可用 `--task-title '真实标题'` 上报；hook 读取 `task_title/taskTitle/session_title/sessionTitle`，不将工具标题或提示词当作会话名称。
Codex 还会按真实会话 ID 读取 `$CODEX_HOME/session_index.jsonl`（默认 `~/.codex/`）中的 `thread_name`，优先显示该索引中的最新名称。该元数据属于本地兼容适配；索引不存在或格式变化时回退到上报标题，无标题显示“未提供”。不读取 Codex 对话正文或数据库中的原始提示词。标题变化在下一次快照刷新时生效（正常运行约 15 秒），不延长活动租约。
手工调用完全省略 session ID 时，通知桥还会尝试基于宿主进程和启动时间派生 ID；共享 GUI 进程无法保证区分并行聊天，因此不应把这一兜底当作真实会话标识。

## 错误与失败处理

HTTP 400 为 JSON 或参数错误，401 为认证或 Origin 被拒绝，404 为未知接口，413 为请求体超过 32 KiB，415 为非 JSON，500 为持久化更新失败。
收到请求的时间由主进程记录。定时清理间隔一秒；重启、快照读取及系统唤醒也检查过期。

默认通知桥静默失败，不影响原任务，不自动启动应用，不输出令牌。单次 HTTP 空闲超时为 700ms，hook 配置超时为两秒。
`--check` 输出健康检查 JSON，`--new-session` 输出新 ID；其他上报不会向 agent 注入提示、阻止工具或自动授权。

## 技能协议 v1

技能接口复用相同服务发现、bearer 认证与 Origin 拒绝规则。所有请求为 `POST /v1/skills/<action>`，JSON 顶层必须有已绑定的 `terminal`（八种终端 ID 之一）。模型名称不参与数据隔离。活动接口仍限 32 KiB，技能接口限 12 MiB；技能包内容另限 8 MiB。

| action              | 除 terminal 之外的请求字段                     | 成功结果                                                                            |
| ------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| targets             | 无                                             | 已绑定终端及已有项目的 ID、名称和路径                                               |
| list                | 无                                             | SkillSummary[]                                                                      |
| create              | package, requestId                             | SkillDetail                                                                         |
| detail              | skillId（UUID 或名称）                         | SkillDetail                                                                         |
| install / uninstall | skillId                                        | `{ok:true}`                                                                         |
| context             | skillId, path                                  | 初始说明、适用经验、非敏感变量、遮罩配置、中央目录和脚本列表                        |
| run-context         | skillId, path                                  | 客户端执行器专用；包含敏感变量，不打印                                              |
| file                | skillId, file（包内文本路径）                  | `{content:string}`，宿主占位符已渲染                                                |
| experiences         | ids（1–100 个 UUID）                           | SkillExperience[]，缺失 ID 返回 404                                                 |
| experience-add      | skillId, content, evidence, folderId?, path?   | 新经验，含 UUID、revision、时间；提供 path 时由路径解析当前项目，未匹配项目返回 404 |
| experience-update   | id, revision, content, evidence                | 同 ID 的更新经验                                                                    |
| experience-delete   | id, revision                                   | `{ok:true}`                                                                         |
| variables           | skillId, folderId?                             | 按全局、已安装终端、当前项目分层的 VariableView[]，敏感值只返回是否已设置           |
| variable-reveal     | skillId, name, target                          | `{value:string \| null}`，显式读取指定层已保存值                                    |
| variable-add        | skillId, variable                              | `{ok:true}`                                                                         |
| variable-delete     | skillId, name                                  | `{ok:true}`，同时删除各层值                                                         |
| variable-set        | skillId, name, target, value（string 或 null） | `{ok:true}`；null 只清除 target 对应层                                              |

`target` 为 `{scope:"skill"}`（全局层）、`{scope:"terminal",terminal:"codex"}` 或 `{scope:"project",folderId:"UUID"}`。终端层和项目层互相独立；顶层 terminal 是调用宿主，target.terminal 只在终端层使用，两者都要求已绑定。

HTTP 创建载荷中的 `package.files` 为 `{相对路径:{content,encoding?:"utf8"|"base64",executable?:boolean}}`；磁盘包清单省略 content，由客户端读取并上传。类型定义见 `src/shared/skills.ts`，完整规范见 [SKILLS.md](SKILLS.md)。

参数无效返回 400，未知技能/经验/项目返回 404，未安装、未绑定、名称或重试标识冲突、修订号过期和受管文件冲突返回 409，密钥服务不可用返回 503。其他文件/数据库故障返回 500。成功变更通知所有窗口重新读取快照。

接口不提供初始文件或脚本修改操作。Renderer 的 preload 不暴露创建、变量定义新增/删除、运行配置或脚本执行能力，只公开查看、安装/卸载、经验删除、变量值编辑及显式显示敏感值。

## 局域网接口（协议 v1）

此服务独立于上述 `127.0.0.1` 通知服务，仅用户开启共享后监听局域网随机端口。不复用 `runtime.json` 的 bearer token。

配对通过“附近设备”发起，不再使用邀请串或手动地址：mDNS TXT 记录携带设备身份和 SHA-256 证书指纹，发起方先固定指纹再发送请求；目标设备只在内存中保存待确认请求（五分钟有效），由本机用户点击“接受”后才保存对方身份与证书指纹。请求与结果不写入数据库，关闭共享或重启即失效。

| 接口                            | 行为                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /lan/v1/pair-request`     | 未配对入口：提交调用方设备身份、请求 ID 和回连地址；保存待确认请求并通知界面弹窗，不授予访问权限 |
| `POST /lan/v1/pair-status`      | 发起方轮询请求结果（`pending` / `accepted` / `declined`）；需呈现与请求一致的客户端证书          |
| `GET /lan/v1/snapshot`          | 返回来源设备身份、本机项目/Git/会话、技能目录；支持 ETag / `If-None-Match` 和 304                |
| `GET /lan/v1/skills/:id`        | 返回完整、经过完整性校验的可移植技能包及内容哈希                                                 |
| `GET /lan/v1/skills/:id/export` | 同上，用于按需导入                                                                               |

除上述配对接口外，必须通过已配对证书的双向 TLS 认证。服务拒绝浏览器 Origin，不提供活动上报、变量读取、经验、安装、运行或其他写操作。发现信息中的地址不能建立信任，客户端必须先校验证书指纹再发送 HTTP 数据；目标设备记录的是 TLS 客户端证书指纹，不采用请求体自报的指纹。

设备身份为 `{ id, name, protocol }`；快照为 `{ device, folders, skills }`，仅发布本机数据。技能导出为 `{ skillId, package, hash }`，`package.variables` 使用当前变量定义并去掉 `defaultValue`，不包含任何保存的变量取值。哈希采用对象键稳定排序后的 JSON SHA-256。请求总期限五秒，接收响应限制 12 MiB；技能包仍遵守原有 8 MiB、256 文件等校验。

preload 新增设备配置、请求配对/确认或拒绝请求、解除配对、读取远端技能、准备导入与确认导入业务接口，不暴露通用网络能力。导入草稿十五分钟有效、最多保留十六份；确认允许改名及修改已有 UTF-8 文本，不允许增加路径或修改二进制文件。来源设备身份、原技能 ID、原包哈希单独记录在本机数据库；重试相同草稿和输入返回同一本机技能 ID。
