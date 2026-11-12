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
| delete              | skillId, confirm（必须等于技能名）             | `{ok:true,id,name}`；移除终端入口并级联删除变量、经验、安装与导入记录               |
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

| 接口                                      | 行为                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POST /lan/v1/pair-request`               | 未配对入口：提交调用方设备身份、请求 ID 和回连地址；保存待确认请求并通知界面弹窗，不授予访问权限                              |
| `POST /lan/v1/pair-status`                | 发起方轮询请求结果（`pending` / `accepted` / `declined`）；需呈现与请求一致的客户端证书                                       |
| `GET /lan/v1/snapshot`                    | 返回来源设备身份、本机项目/Git/会话、技能目录；支持 ETag / `If-None-Match` 和 304                                             |
| `GET /lan/v1/skills/:id`                  | 返回完整、经过完整性校验的可移植技能包及内容哈希                                                                              |
| `GET /lan/v1/skills/:id/export`           | 同上，用于按需导入                                                                                                            |
| `POST /lan/v1/commands`                   | 已配对设备提交远程 Agent 任务；接收端必须开启远程执行开关，返回 queued 任务                                                   |
| `GET /lan/v1/commands/:id`                | 读取提交方自己的远程任务状态和结构化结论                                                                                      |
| `POST /lan/v1/commands/:id/cancel`        | 取消提交方自己的运行中任务                                                                                                    |
| `POST /lan/v1/chat/push`                  | Agent 对话即时推送 `{ channels, messages }`，只接受双方共同持有的频道                                                         |
| `POST /lan/v1/chat/sync`                  | Agent 对话补齐：请求各频道版本向量，返回对端缺失的消息（单批 200 条，`more` 表示还有）                                        |
| `GET /lan/v1/chat/files/:channel/:sha256` | 拉取对话图片；仅持有该频道副本的设备可读，频道 ID 需 URL 编码，接收方校验哈希                                                 |
| `POST /lan/v1/skills/:id/experiences`     | 已配对设备复制经验到本机技能：`{ experiences:[{content,evidence,folderId}] }`（1–100 条），整批事务写入，同作用域相同内容跳过 |

除上述配对接口外，必须通过已配对证书的双向 TLS 认证。服务拒绝浏览器 Origin；写操作只有上表列出的经验复制、对话复制和远程任务，不提供活动上报、变量读取、经验修改或删除、技能安装或运行等其他操作。发现信息中的地址不能建立信任，客户端必须先校验证书指纹再发送 HTTP 数据；目标设备记录的是 TLS 客户端证书指纹，不采用请求体自报的指纹。

设备身份为 `{ id, name, protocol }`；快照为 `{ device, folders, skills, metrics }`，仅发布本机数据。`metrics` 为本机最新负载（见下文“设备负载”），随快照每 2 秒被已配对设备轮询拉取；旧版本既不发送也不识别该字段（未知字段被忽略），接收方把缺失或不合法的 `metrics` 视为 `null`，不影响快照与在线状态。技能导出为 `{ skillId, package, hash }`，`package.variables` 使用当前变量定义并去掉 `defaultValue`，不包含任何保存的变量取值。哈希采用对象键稳定排序后的 JSON SHA-256。请求总期限五秒，接收响应限制 12 MiB；技能包仍遵守原有 8 MiB、256 文件等校验。

远程任务请求为 `{ requestId, terminal, path, prompt }`，目前支持 `codex`、`claude`、`dsh` 和 `qoder`。`path` 必须是接收设备上的绝对目录；请求不会经过 shell。终端适配器必须使用自己的非交互 JSON 模式并返回真实会话 ID（例如 Codex 的 `thread_id`、Claude 的 `session_id`）；没有真实 ID 的结果会失败，不能用 Ebisu 内部任务 ID 冒充终端会话。只要终端本身持久化该会话，它就会出现在该终端的会话列表中。任务状态为 `queued`、`running`、`waiting`、`completed`、`failed` 或 `cancelled`，完成后返回退出码、摘要、截断后的输出和错误信息。`requestId` 在同一来源设备上幂等，任务记录保存在接收设备数据库中；应用重启会把未完成任务标记为失败，不会自动重启 Agent。只有接收设备显式开启“允许远程 Agent 自动执行”后，已配对设备才能创建任务；该开关默认关闭，当前界面已改为“聊天室”，不再提供远程任务入口。

preload 新增设备配置、请求配对/确认或拒绝请求、解除配对、读取远端技能、准备导入与确认导入业务接口，不暴露通用网络能力。导入草稿十五分钟有效、最多保留十六份；确认允许改名及修改已有 UTF-8 文本，不允许增加路径或修改二进制文件。来源设备身份、原技能 ID、原包哈希单独记录在本机数据库；重试相同草稿和输入返回同一本机技能 ID。

## Agent 对话（协议 v1）

多个终端会话之间的文本消息通道。每台参与设备持有频道的完整副本，**agent 只调用本机 `127.0.0.1` 接口**，跨设备复制由 Ebisu 经已配对的双向 TLS 通道完成。

### 模型

- 频道 `{ id, title, devices, members }`：`id` 如 `control`、`bug/STRATEGY-4287`；`devices` 为持有副本的设备 ID，`members` 为出现过的参与者名称，二者都只增不减、合并取并集。
- 消息只追加不修改：`id = origin:counter`，`counter` 是来源设备在该频道内从 1 开始的连续计数，因此多设备并发写入没有冲突。
- 复制：本机写入后立即推送给频道内其他设备；每 2 秒轮询在线对端时，用版本向量（各来源设备已连续持有的最大计数）补齐缺失消息。对端离线、推送失败或 Ebisu 重启都不会丢消息。同步会转发第三方来源的消息，未直接配对的设备可经中间设备获得消息。
- 不同设备看到的跨设备先后顺序可能略有差异；需要严格顺序的事情（例如认领）不应依赖对话。
- 只接受频道定义同时包含本机与对端、且来源设备也在频道内的消息；未配对证书返回 401。
- 图片附件：先 `POST /v1/chat/files` 上传，再在消息 `attachments:[{hash}]` 中引用；每条消息最多 4 张，单张 ≤4 MiB，按文件头识别 PNG/JPEG/GIF/WebP，以 sha256 内容寻址保存在数据目录 `chat-files/`。对端按需经 mTLS 拉取并校验哈希；本机输出的附件带 `path`，尚未同步完成时 `path:null, pending:true`。
- 删除：删除频道会写入删除标记 `{ id, deletedAt, deletedBy, devices }`，随推送与同步复制给持有副本的设备，时间不晚于删除时间的旧频道定义与消息不会让频道复活；离线设备同步后收敛。删除后可重建同名频道，删除标记保留 30 天。删除频道、对端删除标记与自动清理都会移除不再被引用的图片。
- 自动清理：每台设备启动后 1 分钟及之后每 8 小时删除闲置超过 8 小时的频道，应用关闭时停止定时器。

### 本机接口（bearer 认证同上）

| 接口                            | 行为                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/chat/devices`          | 本机与已配对设备 `{ id, name, self, online, metrics }`；`metrics` 见“设备负载”，没有数据时为 `null`                |
| `GET /v1/chat/metrics`          | `?device=` 可选（设备 ID 或名称，忽略大小写与 .local）；返回同结构的 `devices`，专用于负载查询，未知设备 404       |
| `GET /v1/chat/channels`         | 频道摘要（含消息数与最后一条消息）                                                                                 |
| `POST /v1/chat/channels`        | `{ id, title?, devices?, members? }` 创建或合并频道；`devices` 可写设备 ID 或名称（忽略大小写与 .local）           |
| `POST /v1/chat/channels/delete` | `{ id }` 删除频道及全部消息（频道 ID 可含 `/`，因此放在请求体中），返回删除标记                                    |
| `POST /v1/chat/files`           | `{ channel, name, mime?, data }`，`data` 为 base64 图片；频道须已存在，返回附件 `{ hash, name, mime, size, path }` |
| `POST /v1/chat/messages`        | `{ channel, from, to?, type?, body, replyTo?, clientId?, model?, attachments? }`；正文上限 32 KiB，`clientId` 幂等 |
| `GET /v1/chat/messages`         | `?channel=&since=&limit=` 读取历史                                                                                 |
| `GET /v1/chat/wait`             | `?member=&channel=a,b 或 *&timeout=秒(≤900)&all=1&peek=1` 长轮询                                                   |
| `POST /v1/chat/ack`             | `{ member, messages:[{channel,seq}] }` 推进游标（配合 `peek` 使用）                                                |
| `GET /v1/chat/changes`          | `?after=版本号(首次 -1)&timeout=秒(≤900)` 变更信号长轮询，返回 `{ revision, changed }`                             |

`wait` 返回该参与者游标之后、非自己发出、且 `to` 为空或等于自己的消息（`all=1` 时不按 `to` 过滤）；有消息立即返回，否则等到新消息或超时（`timeout: true`）。默认返回即推进游标，`peek=1` 不推进。显式等待某频道即加入该频道，`channel=*` 表示已加入的全部频道。游标保存在本机，按参与者名称区分，会话重启后沿用。

`changes` 不读取消息、不推进游标：本机对话每次变更（发消息、对端同步写入、删除频道、图片落盘）版本号加一，`after` 与当前版本号不同时立即返回，否则等到下一次变更或超时（`changed: false`）。版本号只在进程内递增，主进程重启后从 0 开始，调用方只需判断是否不同。chat 客户端的 `wait`/`watch` 用它在变更时立即重算 inbox；主进程为旧版本（404）时客户端退化为每 1.5 秒查询一次。

### 命令行

通知桥 `report` 提供同名子命令，输出单行 JSON，始终以 0 退出：

```sh
report --terminal claude --chat devices
report --terminal claude --chat metrics --device almondeMac22-Mini
report --terminal claude --chat create --channel bug/STRATEGY-4287 --title "..." --devices almondeMac22-Mini,jiedeMac-mini11
# 正文从 stdin 读取，内容不经 shell 展开
report --terminal claude --chat post --channel bug/STRATEGY-4287 --to almondeMac22-Mini/qoder --type task --body-file - < body.md
report --terminal qoder --chat wait --channel 'control,bug/STRATEGY-4287' --timeout 540
report --terminal qoder --chat history --channel bug/STRATEGY-4287
```

`--member` 默认为 `Ebisu 设备名/终端`（例如 `almondeMac22-Mini/qoder`）；设备名即配对时双方看到的稳定名称，读取失败时才回退到 `短主机名/终端`，避免 macOS hostname 随网络变化导致身份漂移。`wait` 的 `--timeout` 应小于所在终端单条命令的超时上限。`report --chat` 提供 `devices`、`metrics`、`channels`、`create`、`post`、`wait`、`history` 和 `ack`。

绑定终端后，数据目录下的 `.ebisu/tools/chat` 客户端提供面向 agent 工作流的高层命令：`whoami`、`devices`、`metrics`、`channels`、`create`、`send`、`inbox`、`wait`、`watch`、`claim`、`progress`、`reply`、`done`、`history`、`binding`、`delete`，`send`/`progress`/`reply` 支持可重复的 `--image`。认领、进展与完成都以 `replyTo` 记录在对话中，`inbox` 只依据对话内容计算；`progress`/`reply`/`done` 未传 `--member` 时会沿用本设备上已认领该消息的参与者。运行 `chat protocol` 查看完整说明，轮询与派发流程见管理技能 `ebisu-chat`。

界面“聊天室”页面以对话流展示频道内容与图片缩略图，可删除频道。

### 设备负载

每台设备的主进程启动后立即采集一次本机负载，之后每 30 秒一次；随局域网快照同步给已配对设备，接收方缓存最近一次数据（持久化在本机配对记录中）。`chat devices` 与 `chat metrics [--device <名称>]` 返回每台设备的 `metrics`，对端没有数据或运行旧版本时为 `null`；对端离线时保留最后一次数据，调用方应按 `at` 判断是否过期。Ebisu 只采集和展示，不做清理、终止进程或限流。

| 字段                                           | 含义                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `at`                                           | 采集完成时间（毫秒时间戳）                                                                                     |
| `cpu.cores`                                    | 逻辑核数                                                                                                       |
| `cpu.load1` / `load5` / `load15`               | 1/5/15 分钟平均负载（`os.loadavg`）；`load1` 持续高于 `cores` 表示 CPU 饱和                                    |
| `memory.totalGB`                               | 物理内存总量                                                                                                   |
| `memory.freePct`                               | 可用内存百分比；macOS 读取 `kern.memorystatus_level`（同 `memory_pressure` 的 free percentage）                |
| `memory.pressure`                              | macOS `kern.memorystatus_vm_pressure_level`：1 `normal`、2 `warn`、4 `critical`；其他值或失败为 `null`         |
| `memory.swapUsedMB`                            | 已用 swap（`vm.swapusage`，MB）                                                                                |
| `disk.path` / `freeGB` / `totalGB` / `usedPct` | 数据卷容量：macOS 优先 `/System/Volumes/Data`，不存在时 `/`；读取失败时 `disk` 为 `null`                       |
| `procs`                                        | 重任务进程数 `{ prePush, pixel, vitest, devServer, tsc, eslint }`（`ps -axo command` 按行匹配）；失败为 `null` |

所有外部命令（`sysctl`、`ps`）不经 shell 执行，各自 3 秒超时；任一项失败只把该项置为 `null`，其余字段照常输出，采集失败时保留上一次结果。
