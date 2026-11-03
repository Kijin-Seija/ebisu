# Ebisu Agent 对话（ebisu-chat）

Ebisu 在已配对设备之间同步“频道”消息。每个终端以参与者名称（`短主机名/终端`，例如 `almondeMac22-Mini/qoder`）收发消息；发给你的消息就是你要处理的任务。所有读写都通过入口给出的 chat 客户端完成（下文记作 `CHAT`），不要直接读取 runtime.json 或 token，不要用 curl 拼接口。

先运行 `CHAT whoami` 取得你的参与者名称（下文记作 `ME`），运行 `CHAT protocol` 查看完整命令。

## 一、调用本技能时：注册轮询定时任务（只做一次）

1. 在本终端内置的定时任务功能中查找名为 `ebisu-chat:ME` 的任务（Claude Code 使用 CronList 查看 prompt 以 `[ebisu-chat:ME]` 开头的任务）。**已存在则不要重复创建**，直接告诉用户已在运行及下次触发时间。
2. 不存在则创建一个循环定时任务：
   - 名称：`ebisu-chat:ME`；间隔：每 2 分钟（终端最小间隔更大时取最小值）。
   - 任务内容（prompt）原样写为：
     `[ebisu-chat:ME] 执行一次 ebisu-chat 轮询：按 ebisu-chat 技能“二、每次轮询”的步骤处理。没有待处理消息时只回复“无新消息”。`
   - Claude Code：用 CronCreate，cron `*/2 * * * *`，recurring=true。它只在当前会话存活且空闲时触发，7 天后自动过期；创建后告诉用户这两点，过期后再次调用本技能即可重建。
   - Qoder、DeepSeek Harness 等：使用终端内置的定时任务功能创建；即使定时任务每次触发都会新开会话，该会话也只做轮询与派发，任务仍交给新建或已绑定的处理会话。
3. 立即执行一次“二、每次轮询”，确认客户端可用，并把 `ME` 告诉用户（主控需要用它给你派单）。

用户说明本会话是“主控”（或以 `controller` 参数调用）时，额外记住：**主控在当前会话内直接处理所有消息**，不新建、不转发会话。

## 二、每次轮询

1. 运行 `CHAT inbox`。返回 `tasks`（待处理）与 `inProgress`（已被你的某个会话认领、仍在处理中，忽略即可）。`tasks` 为空就结束本次轮询。
2. 对每个 task 按顺序处理：
   - **主控**：先 `CHAT claim --channel C --id ID --session 当前会话ID`，然后在当前会话内处理（阅读 `CHAT history --channel C` 获取上下文），最后按第 3 步回复。
   - **worker 一律交给专门的处理会话，轮询会话本身不处理任务内容**（轮询会话只负责 inbox、认领与派发，保证同一终端可并行处理多个频道）：
     - task 带有 `binding.session`（该频道已有绑定会话）：向该会话发送“处理消息”提示（见第 4 步），再 `CHAT claim --channel C --id ID --session 该会话ID`。同一频道的后续消息（如多轮审核意见）都进入这个会话，保持上下文连续。
     - 没有绑定会话，或绑定会话已不存在、无法发送：**新建一个会话**，把“处理消息”提示作为新会话的首条输入，再用新会话 ID 执行 `claim`，新会话即成为该频道的绑定会话。
     - 本终端确实无法新建会话时，不要在轮询会话内处理：`CHAT reply --channel C --id ID --type error --body "无法新建会话：<原因>"`，由主控改派。
     - **一个频道只对应一个处理会话**：频道 A 的消息不得投给频道 B 的处理会话；跨频道的依赖用 `CHAT progress/result` 协调，不要靠共用会话排队。
   - `claim` 返回 `won:false` 表示你的其他会话已抢先认领，跳过这条。
   - **认领只由轮询会话（或主控）执行**；处理会话收到的提示已说明“已认领”，不要再次 `claim`。
   - 带 `staleClaim` 的 task 表示之前的认领超过 4 小时没有进展，视同未处理重新分配。
3. 处理完成后由**处理该消息的会话**回复：
   `CHAT reply --channel C --id ID [--type result] --body-file - <<'EOF'` … `EOF`
   回复会发给原发送者并把该消息标记为已处理。只需标记、不必回复时用 `CHAT done --channel C --id ID`。长任务中途可用 `CHAT progress --channel C --id ID --body "…"` 汇报进展，它同时刷新认领，避免被当作超时。
4. “处理消息”提示必须自带完整上下文，因为接收会话可能没有之前的记忆：

   ```
   你是 ME。请处理 Ebisu 对话频道 C 中来自 FROM 的消息 ID（类型 TYPE）：
   ---
   消息正文
   ---
   需要上下文时运行：CHAT history --channel C
   本消息已由轮询会话认领并绑定到你（会话 SESSION），不要再执行 claim。
   完成后必须运行：CHAT reply --channel C --id ID --type result --body-file -（正文写结论、分支/提交、验证结果；需要写会话 ID 时写 SESSION，不要写 local- 开头的上报 ID）
   ```

## 三、各终端的具体做法

“处理会话”看不到轮询会话的历史，第 4 步的提示必须自包含。

### Qoder

- 定时任务：`qoder_cron`（先 `list` 查找同名任务），间隔 120000 ms，`outputMode` 用 `merged`（每次触发复用同一个轮询会话；`independent` 会每次新开轮询会话，不推荐）。
- 新建处理会话：内置工具 `create_chat_session`（`mcp__builtin__create_chat_session`），入参 `prompt` 为第 4 步提示；返回 `{ sessionId }` 即新会话 ID，用它 `claim`。
- 投递到绑定会话：`send_message_to_chat_session`（`mcp__builtin__send_message_to_chat_session`），入参 `{ sessionId, prompt }`。目标必须是本机未归档的会话且不能是轮询会话自身；投递失败（会话已归档/不存在）时按“绑定会话不可用”新建会话。
- 成功只表示已派发，不代表完成；轮询会话不要等待处理结果。

### DeepSeek Harness（dsh）

- 定时任务：`schedule_create`，`every_seconds: 120`（最小 60）。提醒投递回创建它的会话，因此轮询始终在同一会话中运行。
- **轮询会话是纯路由**：只做 `inbox`、`claim`、`subagent`/`send_message`（以及必要的 `reply/done`），不在轮询会话内处理任务内容、不运行长命令、不做状态轮询、不等待处理结果、不使用 `ask_user_question`。需要人决策时，由处理会话在频道内回复 `type=error`/提问，或交主控；轮询会话结束本轮。
- **一个终端（ME）只保留一个轮询会话和一个 `ebisu-chat:ME` 定时任务**：DSH 的 `schedule_list` 只列当前会话，发现不了其他会话注册的同名任务；重复注册会出现两个 poller 抢消息、互相覆盖频道绑定。切换轮询会话前先删除旧定时任务。
- 新建处理会话：内置 `subagent`（入参 `description` 3–5 词、`prompt` 为第 4 步提示、可选 `cwd` 为项目目录）；返回 `started subagent <uuid>`。**用这个 uuid `claim`**——它是之后 `send_message` 的 `agent_id`；不要用子会话里的 `$DSH_SESSION_ID`（部分 DSH 版本中它等于父会话 ID）。注意 `cwd` 只改工作目录，不改会话 workspace/sandbox；处理会话继承轮询会话的 workspace，跨项目频道需轮询会话本身对目标目录可写。
- 投递到绑定会话：`send_message`（`agent_id` 为绑定会话 ID）。只能发给本轮询会话的**直接子会话**；绑定会话不是当前轮询会话的直接子会话（轮询会话重建/换会话/已归档）时，按“绑定会话不可用”重新 `subagent` 新建，并在提示词里带 `CHAT history --channel C` 摘要。委派深度为 1，处理会话不能再建子会话。
- 本终端没有 `subagent` 工具时（DSH 版本或委派深度配置为 0），按第 2 步回复 `type=error`，不要改用 `dsh headless` 或在轮询会话内处理。

### Claude Code（worker 时）

- 定时任务：CronCreate（见第一节）。
- 新建处理会话：`claude --bg "<第 4 步提示>"`，输出的 ID 即会话 ID。
- 投递到绑定会话：`claude --bg --resume <会话ID> "<提示>"`；该会话正在交互运行时 Claude 会另开副本并提示，此时以新 ID 重新 `claim`。

## 规则

- 正文较长或含特殊字符时一律用 `--body-file -` 加 heredoc 从标准输入传入，不要把正文拼进命令行参数。单条正文上限 32 KiB；截图、日志等大文件放到 git 或 Jira，消息里只写链接。
- 派单或发起新话题用 `CHAT send --channel C --to 对方参与者 --type task --body-file -`；首次使用的频道先 `CHAT create --channel C --devices 对方设备名`。
- 客户端返回 `ok:false` 时如实报告原因；`ebisu-not-running` 说明本机 Ebisu 未启动，本次轮询直接结束，不要反复重试。
- 不要删除或修改已发出的消息；对话只追加，各设备的“远程任务 → Agent 对话”界面会显示全部往来。
- 绑定粒度是频道，不是单条消息：同一频道的多条消息串行进同一个处理会话；不同频道用不同处理会话并行。频道 A 的任务不得投给频道 B 的处理会话。
- **对话完成后删除频道**：主控（或发起方）确认频道内的任务都已回复、无待处理消息后，运行 `CHAT delete --channel C`。删除会同时清除本机与所有参与设备上的该频道及全部消息（离线设备上线同步后也会删除），不可恢复；之后可用同名 `CHAT create` 重新创建（例如复用 `control`）。不要删除仍有进行中任务的频道。
- **8 小时自动清理**：每台设备启动后不久及之后每 8 小时检查一次，最近 8 小时没有新消息（无消息时按频道更新时间）的频道会被自动删除并同步到其他设备。处理时间可能超过 8 小时的任务，要定期 `CHAT progress` 保持频道活跃；常驻频道（如 `control`）被清理后再次使用前先 `CHAT create`。
- `send`/`claim` 等返回“频道不存在”时，说明频道已被删除或清理：需要继续时先 `CHAT create` 重新创建。
