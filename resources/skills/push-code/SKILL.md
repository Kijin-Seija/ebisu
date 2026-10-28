---
name: push-code
description: 当用户显式调用 ${INVOKE}，或要求使用 "push-code skill"、"push code workflow"、"推当前分支并创建 MR"、"跟进 GitLab code review 到可提交状态" 时使用。适用于需要把当前分支推送到 GitLab、直接调用 GitLab REST API 创建合到主分支的 MR、轮询 online review discussions / 普通 MR notes / mergeability 状态，并根据 review 评论继续修复或发起异议回复的场景。
---

## Ebisu 运行方式

先读取入口返回的经验与变量。运行工具必须通过 `${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/脚本名 -- 参数`，不从安装目录推导项目、不直接改写中央文件。

## 经验沉淀

经验是持久化数据，不是对话中的口头记忆。当用户说“记住”“以后都这样”“默认遵循”，或明确提出长期规范/偏好时，必须先执行 `experience-add`，成功后才能回复“已记住”。默认使用当前项目作用域：传入当前路径（`experience-add --path "$PWD"`，客户端默认使用当前工作目录）；只有用户明确要求所有项目通用时才使用 `experience-add --scope skill`。当前路径未注册为项目时必须报告失败，不能静默写成全局经验。写入失败时必须报告失败，不能只口头承诺。用户明确指定的规范可以用该用户指令作为 `evidence`；模型自行总结的规则必须有实际验证依据。两类经验都不得记录推测、凭据或任务流水账。

# Push Code 工作流

## 触发条件

只在用户明确要求时启用，例如：

- `使用 push-code skill`
- `${INVOKE}`
- `请走 push code workflow`
- `把当前分支推上去并创建 MR`
- `跟进这次 GitLab code review 到可提交状态`

如果用户没有显式要求，不要默认启用。

## 目标

该 skill 用于驱动一个可重复的 push / MR / review 闭环：

1. 先验证当前工作区能否安全 push
2. 把当前分支 push 到远端
3. 直接调用 GitLab REST API 创建一个当前分支合到目标主分支的 MR，并拿到 `mr_id`
4. 轮询 review 状态、discussions、普通 MR notes 与 mergeability blockers
5. 如果 GitLab 判定源分支必须先 rebase 到目标分支，则先处理 rebase
6. 对 review 结果做两类处理：
   - 有异议：通过 GitLab discussions 回复评论
   - 无异议：修复代码后重新 `git add`、`git commit`、`git push`
7. 循环以上步骤，直到 MR 达到可提交状态，或出现明确 blocker 需要暂停

## 必要前提

开始前必须检查：Git/Python 依赖可用，当前目录为已有项目，Git 工作树干净且不在目标分支，GitLab 必填变量已配置。

如果当前分支不是 clean working tree，必须立即终止流程，不要替用户自动提交，也不要带着未提交改动去 push。

## 必须使用的资源

进入该 workflow 后，使用 scripts/push-code-run.sh 和 scripts/push_code_webhook.py；详细参数参见 references/reference.md。不要在对话里重写 GitLab 客户端。

## 标准执行顺序

### 1. Preflight

先执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- preflight
```

如果失败：

- 直接向用户说明 blocker
- 不要继续创建 MR
- 不要替用户生成兜底 commit

### 2. Push 当前分支

预检通过后执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- push
```

要求：

### 3. 创建 MR

push 成功后执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- create-mr
```

要求：

### 4. 等待在线 review

拿到 `mr_id` 后执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- wait-review --mr-id <mr_id>
```

处理规则：

- 如果返回通过态，仍要先检查本轮 `review_notes_fingerprint` 和所有 note `revision_key`；只有不存在尚未阅读的新 revision 时，才能说明 MR 已达到可提交状态
- 如果返回 `needs_rebase`，先处理本地 rebase，再继续等待 review
- 如果返回变更请求态，继续拉取 discussions
- `pending`、`ci_still_running`、`head_pipeline:running`、`external_status_checks_pending:*`、`awaiting_first_review_signal` 都不是完成态；只要还处于这些状态，就不能把 push-code 流程表述成“已完成 / 已通过 / 可以收口”
- 在提交 MR 之后，当前会话必须自己继续定时轮询并跟进，直到 MR 达到可提交状态、超时或遇到明确 blocker
- 即使返回 `pending`，也要读取这次返回里的全部非 system `notes`，与上一轮已处理 note revision 集合按 `id` / `updated_at` / `body_sha256` 做差；新增 note 或已有 note 内容被编辑都必须视为待处理 finding，而不是直接口径收敛成“仅等待 CI”
- 如果超时或 GitLab API 返回无法识别的状态，向用户说明并暂停自动循环
- `status` / `wait-review` 的 JSON 里如果带有 `workflow_guidance.can_announce_completion=false`，就绝不能向用户发送“本次 push-code 已完成”的 final answer
- `workflow_guidance.can_announce_completion=true` 只是结构化检查通过的必要信号，不会替代 note revision 检查；存在尚未阅读的新建或被编辑 note 时仍禁止收口
- 当 `workflow_guidance.recommended_next_action` 是 `keep_waiting_for_ci_in_current_session`、`keep_waiting_in_current_session_and_treat_note_as_pending_finding` 或 `keep_waiting_for_review_signal_in_current_session` 时，按字面执行：继续由当前会话轮询
- 只要当前状态仍是 `pending` / `ci_still_running` / `head_pipeline:running`，且没有出现“需要用户现在介入”的新 blocker，就必须继续停留在当前 turn 内轮询；可以发 commentary 进度，但不能发送 final answer 结束本轮
- 即使你想表达“目前只是等 CI”，也只能用 commentary 同步阶段性状态，不能用 final answer 把线程收口

### 5. 处理 need rebase 分支

如果 `wait-review` 返回 `needs_rebase`，或者 `status` 输出中的 `raw_status` / `meta.detailed_merge_status` 表示当前源分支必须先 rebase 到目标分支，则应先执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- rebase-target
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- push --force-with-lease
```

处理规则：

- launcher 会先 `git fetch <remote> <target-branch>`，再把当前分支 rebase 到 `<remote>/<target-branch>`
- 如果 rebase 出现冲突，先解决冲突并完成 `git rebase --continue`
- rebase 完成后必须使用 `push --force-with-lease` 更新远端分支，不能使用裸 `--force`
- 如果 rebase 后的 push 仍然命中本地 pre-push 检查失败，依然要先修复检查问题，再继续 MR / review 闭环

#### Rebase 后的强制验证门禁

rebase 会改变 MR 的 head SHA，并触发一轮全新的 pipeline。rebase 前拿到的 `approved`、旧 head 的 pipeline 成功，或“没有 unresolved thread”都不能沿用到新 head；这正是最容易误报完成的分支。

完成 rebase 并 `push --force-with-lease` 后，必须立即执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- post-rebase-check --mr-id <mr_id>
```

该命令会把本地新 `HEAD` 作为期望 head SHA，持续等待 GitLab 看到同一 SHA 的新 pipeline，并重新执行完整的 review / discussion / note / mergeability 检查。只有该命令最终返回 `approved`，且 `workflow_guidance.can_announce_completion=true`，才允许收口。

以下情况都必须继续等待，不能引用 rebase 前结论：

- `post_rebase_head_sha_not_updated`
- `post_rebase_pipeline_not_created`
- `post_rebase_pipeline_not_completed`、`post_rebase_pipeline_not_success`
- `pending`、`ci_still_running`、`head_pipeline:running`
- 新 head pipeline 失败，或出现新的 reviewer note / discussion finding

如果不使用 `post-rebase-check`，则至少要手动先执行 `status --mr-id <mr_id>` 核对 `meta.head_sha == git rev-parse HEAD`，再执行 `wait-review --mr-id <mr_id>`；仅看到 force push 成功绝不代表 pipeline 通过。

### 6. 读取 discussions / 普通 MR notes 并分类处理

当 review 未通过时，执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- threads --mr-id <mr_id>
```

读取 discussions 和普通 MR notes 后，对每条问题做判断：

- `accepted`：意见成立，应修改代码
- `questioned`：意见可能不完整或存在误判，应先回复 discussion
- `rejected`：意见明显不成立，应在 discussion 中说明依据

如果需要回复 discussion，优先把回复内容写到临时文件，再执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- comment \
  --mr-id <mr_id> \
  --thread-id <thread_id> \
  --body-file <reply-file>
```

不要在没有阅读 discussion 内容的情况下直接回复“已修复”或“已知悉”。

如果某条 discussion 的意见你已经接受、代码也已经修复并 push 完成，还需要显式把对应 thread 标记为 resolved：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- resolve-thread \
  --mr-id <mr_id> \
  --thread-id <thread_id>
```

如果后续发现该 thread 其实不该关闭，也可以重新打开：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- reopen-thread \
  --mr-id <mr_id> \
  --thread-id <thread_id>
```

如果问题是普通 MR note，而不是 thread/discussion，可直接在 MR 下追加一条普通评论：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- note \
  --mr-id <mr_id> \
  --body-file <reply-file>
```

如果 `wait-review` 返回的阻塞来自 mergeability / pipeline / external review stage，而不是 discussion，则先读取 `status` / `threads` 输出里的 `meta`、`notes` 和 `raw.merge_request`，再判断是需要修代码、回复普通 note，还是仅等待检查继续运行。

每次 push 之后重新进入 `wait-review` 时，都要把全部非 system MR notes 重新过一遍，不能因为 `unresolved_threads = 0` 就跳过。推荐至少维护一份“已处理 note revision 集合”，按 note 的 `revision_key` 去重；若没有该字段，则使用 `id` / `updated_at` / `body_sha256` 组合。只要发现新增 reviewer note，或已有 note 的 revision 发生变化，就要明确标成“待处理 review finding / 待确认 finding”。

### 7. 修复并再次 push

如果你接受 review 意见，则：

1. 修改代码
2. 运行必要验证
3. 提交前检查当前分支：如果当前分支是 `master`，先执行 `git switch -c ${HOST_KEY}/<简短描述>` 创建提交分支，再继续后续提交；分支名已存在时追加递增后缀（例如 `-2`），不要直接在 `master` 上提交。
4. `git add`
5. `git commit`
6. `push`
7. 对已确认修复完成的 unresolved threads 执行 `resolve-thread`
8. 再次执行：

```bash
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- push
${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill push-code --path "$PWD" --script scripts/push-code-run.sh -- wait-review --mr-id <mr_id>
```

不要在没有新 commit 的情况下空转轮询 review。

如果在第 5 步 push 时触发本地 pre-push 检查失败：

1. 先读取 pre-push 脚本输出
2. 区分是测试失败、lint 失败、构建失败还是环境配置问题
3. 基于失败原因继续修复
4. 修复后重新 `git add`、`git commit`
5. 再次执行 `push`

不要为了“尽快过掉检查”而跳过 hook、强推、或忽略检查结果继续创建 MR。

## 终态约束

push-code 工作流只有两类允许收口的终态：

- `approved`，或 `workflow_guidance.review_complete=true`，并且当前不存在尚未阅读的 reviewer note revision
- 明确超时 / API 失败 / 需要用户介入，且你已经把 blocker 讲清楚

以下状态一律不是完成态：

- `pending`
- `needs_rebase`
- `changes_requested`
- `ci_still_running`
- `head_pipeline.status` 仍是 `running` / `pending` / `preparing`
- 任何 `workflow_guidance.can_announce_completion=false` 的返回

因此：

- 只要 MR 还没进入完成态，就不能在 final answer 里写“流程完成”“MR 已通过”“现在只差人工 merge”
- 只要 MR 还没进入完成态，而且也没有新的明确 blocker 需要用户当下决策，就根本不能发送 final answer；此时只允许继续轮询并发送 commentary 更新
- 只有在最新 head pipeline 已经结束、且 review 通过或 `workflow_guidance.review_complete=true` 时，才能把状态表述成“MR 已达到可提交状态”
- 如果还在 `pending` 但同时已经出现 reviewer finding，要明确说明“CI 仍在运行，同时已有待处理 review finding”

## 决策原则

### 证据优先

面对 review finding 时：

- 先读 discussion 原文
- 再读对应代码与 diff
- 最后决定接受、质疑还是拒绝

不要仅凭“看起来像误报”就直接回复 reviewer。

### 最小动作面

进入修订轮后，只修改与当前 findings 直接相关的内容。

不要顺手做无关重构，否则会让 MR 在下一轮 review 中引入新的噪音。

### 明确区分两种动作

- `回复 discussion / note`：用于解释、追问、反驳、同步修复计划
- `resolve thread`：用于在修复代码并 push 完成后，显式关闭已经处理完的 review thread
- `修改代码并 push`：用于实际消除 review 问题

二者不要混淆；如果只是有疑问，不应直接修改大量代码来“碰碰运气”。

## 推荐输出骨架

在向用户同步进度时，尽量按这个顺序：

1. 当前 preflight / push / MR / review 所处阶段
2. 已拿到的 `mr_id`
3. 当前 review 结论：达到可提交状态 / 待处理 / 超时
   - 如果是 `pending`，要区分“纯等待检查”还是“等待检查 + 已出现待处理 reviewer note”
4. 如果当前存在 mergeability blocker：
   - 是否需要 rebase
   - 是否有冲突需要先解决
5. 如果有 findings：
   - 哪些准备接受并修复
   - 哪些准备通过 discussion 提问或反驳
6. 下一步动作

## 失败处理

- preflight 失败：终止流程并说明是 dirty working tree、detached HEAD 还是缺配置
- push 失败：不要擅自改 remote 或强推；如果是本地 pre-push 检查失败，先分析并修复，再重新 commit + push
- need rebase：先执行 `rebase-target`，完成后用 `push --force-with-lease` 更新远端分支
- 外部 review / pipeline blocker：不要因为没有 thread 就判通过；先看当前 head SHA 的全部 `pipelines`、`detailed_merge_status`、`head_pipeline.status`、`status_checks` 和普通 MR notes。任意当前 head pipeline / status check 失败都优先于其他 running / pending 信号
- unresolved threads 未关闭：即使 reviewer 已口头通过，MR 仍可能因为 `discussions_not_resolved` 无法合并；修复并 push 后记得 `resolve-thread`
- create MR 失败：不要伪造 `mr_id`
- wait review 超时：向用户报告当前 `mr_id`、最后一次状态和已知 discussions
- discussion 回复失败：保留准备回复的文本，并向用户说明 GitLab API 调用失败

## Final Answer 约束

- `final answer` 只允许出现在两类场景：
  1. MR 已达到可提交状态
  2. 出现明确 blocker，需要用户介入、授权或后续人工接手
- 如果只是 “MR 已创建成功，但 CI 还在 running / pending”，这不是 `final answer` 场景
- 如果只是 “review note 看起来通过，但 pipeline 还没结束”，这也不是 `final answer` 场景
- 如果 helper 返回的 `workflow_guidance` 明确要求 `keep_waiting_*_in_current_session`，那就把它当成禁止 final 收口的硬门禁

## 明确禁止

- 不要自动 merge MR
- 不要调用任何自动合并、squash merge、rebase merge、merge when pipeline succeeds 之类动作
- MR 是否最终合并，必须交由人工确认和执行

${#IF workbuddy#}
## 本宿主强制规则（内嵌）

WorkBuddy 是否读取全局 `AGENTS.md` 尚未实测确认，因此以下强制规则直接写进本 skill，不依赖全局指令文件：

- 只在用户显式要求时启用本工作流（例如通过 `${INVOKE}`，或明确要求使用 push-code）。
- 进入工作流后，必须通过安装后的 launcher 执行机械动作（`${SKILL_DIR}/scripts/push-code-run.sh` 等），不要手写 `curl`。
- 关键强制门禁（轮询等待 review、rebase 后必须 `post-rebase-check`、不得自动 merge MR、final answer 约束）与本 skill 其他宿主完全一致，必须同样遵守。
${#END#}
## 配置说明

安装后配置分两层：

字段说明见：

- `${SKILL_DIR}/references/reference.md`

如果 GitLab 实例有额外认证或代理要求，优先调整配置或 helper，不要在主流程里内联一套新的手写请求逻辑。


## Ebisu 配置与运行

GitLab 地址、token、项目 ID、分支、认证及有界轮询参数由技能变量界面管理，项目覆盖终端，终端覆盖技能。凭据不写入包或项目。使用客户端 run 注入配置后运行 scripts/push-code-run.sh；项目根目录由 EBISU_PROJECT_ROOT 显式传入。保留当前会话有超时上限的 review 跟进，不创建后台进程、定时唤醒或自动通知。
