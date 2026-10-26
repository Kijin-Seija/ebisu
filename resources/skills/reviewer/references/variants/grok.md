---
name: reviewer
description: 当用户显式调用 /reviewer，或要求使用 reviewer skill、reviewer 工作流、让独立 subagent 审查任务结果或执行持续审查循环时使用。先完成主任务，再用上下文隔离的原生 spawn_subagent 执行独立盲审；只有当前状态下已实际复现、可由主 agent 独立复验且与任务相关的缺陷才能阻塞交付。未来风险、静态猜测和“可能导致”类 finding 进入 backlog。一次独立盲审没有交付阻塞问题后稳定收敛；非 goal 模式默认最多 10 轮，goal 模式全局最多 20 轮。
---


## Ebisu 运行方式

先读取入口返回的经验与变量。运行工具必须通过 `${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill reviewer --path "$PWD" --script scripts/脚本名 -- 参数`，不从安装目录推导项目、不直接改写中央文件。

# Reviewer 工作流

## 核心规则

执行两层循环：

- 外层 `blind audit round`：用 `spawn_subagent`（`subagent_type=explore`，`isolation="none"`）启动一个**全新上下文**的只读 reviewer subagent。`explore` 不能改文件，适合只读盲审；`isolation="none"` 让它直接检查真实工作区。
- 内层 `inner iteration`：盲审发现交付阻塞问题后，由主 agent 修复；用 `resume_from` 把 follow-up 发给**同一个** reviewer subagent 复查、裁决异议并发现新问题。

只有主 agent 可以修改代码或文档。reviewer 始终只读。不要用 shell 命令拼一个"外部审查者"来代替原生 subagent；原生 subagent 是唯一首选执行方式。

只把同时满足以下条件的 finding 视为交付阻塞问题：

- severity 为 `blocking` 或 `important`
- origin 为 `change_introduced` 或 `task_related`
- blocking 的 confidence 为 `high|medium`；important 必须为 `high`
- code 使用 `failing_check|runtime_reproduction|safe_poc`；doc 可使用 `document_observation`
- 当前代码、配置和支持范围内可达，并提供 `observed=true` 的完整 reproduction
- 不处理会使原始任务交付不正确、不完整或产生实质回归

`task_related` 只有直接违反原始任务明确要求或验收标准时才能阻塞。依赖未来代码/配置/调用方/流量、只有静态代码路径推断、无法实际复现或使用“可能、也许、may、might、could cause”等不确定结论的 finding 必须进入 backlog。只读 sandbox 或缓存权限导致的测试失败不算产品 bug。

将 `minor`、`pre_existing`、`out_of_scope`、低置信度推测、纯优化和风格偏好写入 `review-backlog.json`，不要触发修复循环。相关测试、lint、typecheck 等确定性检查必须通过；真实失败属于有证据的交付阻塞问题。

## 初始化

收集或推断原始任务、`code|doc` 制品类型、lowercase kebab-case topic slug 和最大独立盲审次数。普通会话默认 `10`；存在未完成 goal 时使用 `20 (goal-mode)`。

在 `.grok/plans/<topic-slug>/` 创建并持久化：

- `brief.md`：原始任务、制品类型、固定 git baseline、最大盲审次数和执行模式
- `consensus-exclusions.json`：初始为 `{"exclusions":[]}`
- `review-backlog.json`：初始为 `{"items":[]}`
- `workflow-state.json`：符合 `schemas/workflow-state.schema.json`，包含连续合格盲审计数

code 模式只记录一次任务开始前的 `git rev-parse HEAD`，后续不得重算 baseline。

## 完成主任务

先完成用户任务并运行与风险相称的确定性检查。检查失败时先修复，不要带着已知失败进入“通过”状态。

采集当前制品：

- code：固定 baseline 到真实工作区的完整 diff，排除 `.grok/plans/`
- doc：当前完整文档和原始目标约束

保存为 `artifact-rN.md`。

## 独立盲审

对每个外层轮次 `N`：

1. 使用 `prompts/codex-blind-review-request.md` 渲染 prompt。
2. 只传入原始任务、制品类型、固定 baseline、当前制品、active `consensus-exclusions.json` 和 `review-backlog.json`。
3. 不传入 topic、历史 review、主 agent 回应、当前轮次、最大轮次、争议记录或 plans 路径。
4. 用 `spawn_subagent` 创建全新 reviewer：`subagent_type=explore`，`isolation="none"`，`description` 用可复用名字（例如 `reviewer-rN`）。新 subagent 自带独立上下文，不要再把历史 review 塞进它的 prompt。要求它忽略工作流目录、只读检查真实工作区。
5. 等待该 subagent 完成（`get_command_or_subagent_output`），保存原样 JSON 到 `blind-review-rN.md`，按 `schemas/codex-review.schema.json` 校验。记下本次 `subagent_id`，内层复查要用。
6. 合法处理 `reopens_consensus_id` 与 `related_backlog_id`，机械更新共识账本和非阻塞 backlog。

按结果处理：

- 没有 `delivery_blocking: true`：这是一次 qualifying blind audit。即使包含非阻塞 finding，也不得进入修复循环。
- 存在 delivery blocker 且 `next_action=revise`：将连续合格计数重置为 0，进入内层收敛。
- `next_action=human_judgment`：重置连续计数，生成 `dispute-report.md` 并停止。

不要要求“零 finding”。只有 delivery blocker 影响交付判定。

## 内层主 agent 修复与 reviewer 复查

保持当前 reviewer subagent 可 resume，不得在同一外层轮次创建新 reviewer。

对每个内层迭代 `M`：

1. 只逐项分析最新 review 中 `delivery_blocking: true` 的 issue。
2. 修改前先执行 reviewer 的 reproduction；记录 `verification-result` 和实际命令/结果。
3. 只有 `reproduced|independently_verified` 才能 accepted 并修复；`not_reproduced` 时不得修改，必须 questioned/rejected。
4. 保存 `response-rN-iM.md` 和最新 `revision-rN-iM.md`。
5. 使用 `prompts/codex-review-request.md` 渲染 follow-up prompt，并通过 `spawn_subagent(..., resume_from=<该 reviewer 的 subagent_id>)` 发给同一个 reviewer。
6. reviewer 对 not_reproduced 项必须提供修正后的可执行复现；无法提供时撤回为 backlog。
7. reviewer 明确同意 questioned/rejected 项不成立或无需处理时，才允许写入 `new_consensus_exclusions`。
8. 保存 `review-rN-iM.md`，校验并机械合并共识和 backlog。

`fail + revise` 时继续内层迭代。`pass + approve` 表示当前外层轮次完成；issues 可以包含非阻塞 finding。因为该轮盲审入口曾发现 blocker，本轮不得增加连续 qualifying 计数。结束该 reviewer subagent，再启动下一次全新盲审。

主 agent 不得无条件接受 reviewer 意见，也不得自行降级或丢弃 finding；必须逐项依据证据修复或提出异议。

## 收敛与最大轮次

维护 `consecutive_qualifying_blind_audits` 作为 0/1 状态：

- 全新盲审入口没有 delivery blocker：设为 1 并立即稳定收敛
- 全新盲审发现 delivery blocker：立即重置为 0
- 经内层修复后通过：该轮完成，但计数保持 0

一次 qualifying blind audit 后，以 `stable-convergence` 完成。普通模式达到最大独立盲审次数时，以 `max-blind-audits-completed` 完成。goal 模式全局最多 20 次独立盲审；第 20 轮的内层 blocker 处理完成且确定性检查通过后，以 `review-budget-completed` 结束，不要求零 finding。

## 会话 rollover

每个会话最多完成 10 次外层盲审。仍需继续时：

1. 将 state 设为 `handoff_required`，覆盖写入 `session-handoff.md`。
2. 清理刚完成轮次的临时文件。
3. 请用户在同一 local checkout 开启一个**新会话**（不要 fork 或复制旧对话历史）。
4. 新会话只接收 topic 和 plans 路径，并读取 `brief.md`、`workflow-state.json`、`consensus-exclusions.json`、`review-backlog.json`、`session-handoff.md`。
5. resume 后从 `next_blind_audit` 继续，不重新推断 max/goal-mode。

无法开启新会话时保留 checkpoint 并停止，要求用户在同一 checkout 手动继续。不得在旧会话突破 10 轮。

## 清理与保留

每个已完成外层轮次只清理：

- `artifact-rN.md`
- `blind-review-rN.md`
- `response-rN-iM.md`
- `revision-rN-iM.md`
- `review-rN-iM.md`

始终保留 `brief.md`、`consensus-exclusions.json`、`review-backlog.json`、`workflow-state.json`、必要的 handoff/final/dispute 文件。未通过、需人工裁决、协议失败或中断时不得清理当前轮次。

## 协议校验

严格使用 `schemas/codex-review.schema.json`：

- pass 不得包含 delivery blocker，`next_action=approve`；允许非阻塞 issues
- fail 必须至少包含一个 delivery blocker，`next_action=revise|human_judgment`
- code blocker 必须是当前状态已观察到的 failing check、runtime reproduction 或 safe PoC；doc 可使用当前文本的 document observation
- 每个 issue 必须包含 `evidence_kind`、`current_state_reachable` 和结构化 `reproduction`
- 主 agent response 只覆盖 delivery blocker，并包含 `verification-result` 与 `verification-evidence`

详细契约、backlog 合并和文件布局见 `references/reference.md`。
