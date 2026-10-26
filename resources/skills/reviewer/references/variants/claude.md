---
name: reviewer
description: 当用户显式调用 /reviewer，或要求使用 reviewer skill、reviewer 工作流、让外部 Codex 审查 Claude 的任务结果或执行持续审查循环时使用。Claude 先完成主任务，再通过 launcher 执行上下文隔离的独立盲审；只有当前状态下已实际复现并可独立复验的任务相关缺陷才能阻塞交付。未来风险、静态猜测和“可能导致”类 finding 进入 backlog。一次独立盲审没有交付阻塞问题后稳定收敛；goal 模式全局最多 20 轮。
---


## Ebisu 运行方式

先读取入口返回的经验与变量。运行工具必须通过 `${EBISU_CLIENT} --terminal ${HOST_KEY} run --skill reviewer --path "$PWD" --script scripts/脚本名 -- 参数`，不从安装目录推导项目、不直接改写中央文件。

# Reviewer 工作流

## 核心规则

执行两层循环：

- 外层 `blind audit round`：通过 launcher 启动全新的外部 Codex 盲审会话。
- 内层 `inner iteration`：盲审发现交付阻塞问题后，由 Claude 修复；Codex 只读复查、裁决异议并发现新问题。

只有 Claude 可以修改代码或文档。Codex reviewer 始终只读。

code 只有当前状态已观察到的 `failing_check|runtime_reproduction|safe_poc` 才能阻塞，doc 可使用 `document_observation`；都必须包含当前可达、observed=true 的完整 reproduction。blocking 可为 high/medium confidence，important 必须 high confidence。未来风险、静态路径推断、无法复现及不确定性结论写入 `review-backlog.json`。

## 初始化

收集原始任务、`code|doc` 制品类型、lowercase kebab-case topic slug 和最大独立盲审次数，默认 `10`。

在 `.claude/plans/<topic-slug>/` 创建：

- `brief.md`
- `consensus-exclusions.json`，初始为 `{"exclusions":[]}`
- `review-backlog.json`，初始为 `{"items":[]}`
- `workflow-state.json`，符合 `schemas/workflow-state.schema.json`

code 模式只记录一次任务开始前的 git baseline，后续不得重算。

使用 `.claude/skills/reviewer/bin/reviewer-run.sh`。默认 reviewer 模型为 `gpt-5.4`，可用 `REVIEWER_CODEX_REVIEW_MODEL` 覆盖。launcher 必须在当前真实工作区使用只读 Codex。

## 完成主任务

先完成用户任务并运行与风险相称的确定性检查。保存固定 baseline 到当前工作区的完整 diff 或当前完整文档为 `artifact-rN.md`；排除 `.codex/plans/` 与 `.claude/plans/`。

## 独立盲审

调用：

```bash
.claude/skills/reviewer/bin/reviewer-run.sh blind \
  --task "<原始任务>" \
  --artifact-type <code|doc> \
  --topic <slug> \
  --audit-round <N> \
  --max-blind-audits <最大次数> \
  --baseline <固定-baseline> \
  --artifact .claude/plans/<slug>/artifact-r<N>.md
```

盲审 prompt 只包含原始任务、制品类型、固定 baseline、当前制品、active 共识排除项和非阻塞 backlog。不得包含历史 review、Claude 回应、topic、当前轮次、最大轮次或 plans 路径。

按结果处理：

- pass：没有 delivery blocker；允许非阻塞 issues。将这些 finding 合并到 backlog，完成一次 qualifying blind audit。
- fail + revise：至少有一个 delivery blocker；重置连续合格计数并进入内层收敛。
- human_judgment：生成分歧报告并停止。

不要要求 issues 为空，也不要因 backlog finding 进入修复循环。

## 内层 Claude 修复与 reviewer 复查

Claude 只逐项处理最新 review 中 `delivery_blocking: true` 的 issue。修改前必须执行 reproduction，并记录 `verification-result` 与实际验证证据。只有 reproduced/independently_verified 才能 accepted 并修复；not_reproduced 时不得修改，必须 questioned/rejected。非阻塞 finding 已进入 backlog。

保存 `response-rN-iM.md` 和 `revision-rN-iM.md` 后调用：

```bash
.claude/skills/reviewer/bin/reviewer-run.sh followup \
  --task "<原始任务>" \
  --artifact-type <code|doc> \
  --topic <slug> \
  --audit-round <N> \
  --inner-iteration <M> \
  --max-blind-audits <最大次数> \
  --baseline <固定-baseline> \
  --artifact .claude/plans/<slug>/revision-r<N>-i<M>.md \
  --latest-review <本轮最新-review> \
  --latest-response .claude/plans/<slug>/response-r<N>-i<M>.md
```

launcher 会把当前制品、最新 review、Claude 回应、共识排除项和 backlog 传给 follow-up reviewer。not_reproduced 时 reviewer 必须提供修正后的实际复现，否则撤回为 backlog。

只有 reviewer 明确同意 questioned/rejected delivery blocker 不成立或无需处理时，才能写入 `new_consensus_exclusions`。Claude 不得无条件修改，也不得自行改写或降级 reviewer finding。

follow-up pass 表示当前外层轮次完成；issues 可以包含非阻塞 finding。由于该轮入口曾有 blocker，本轮不计入连续 qualifying blind audit。完成后清理本轮临时文件并启动全新盲审。

## 收敛与最大轮次

维护连续合格盲审计数：

- 全新盲审入口没有 delivery blocker：加 1
- 全新盲审发现 delivery blocker：重置为 0
- 内层修复后通过：当前轮完成，但计数保持 0

一次 qualifying blind audit 后以 `stable-convergence` 完成。普通模式默认最多 10 次独立盲审，达到最大独立盲审次数时以 `max-blind-audits-completed` 完成。goal 模式使用 `20 (goal-mode)`，第 20 轮内层收敛后以 `review-budget-completed` 完成，不要求零 finding。

## 主会话 rollover

每个主会话最多完成 10 次外层盲审。仍需继续时，launcher 将 state 标为 `handoff_required` 并写入 `session-handoff.md`。在相同 checkout 的无历史新会话中执行：

```bash
.claude/skills/reviewer/bin/reviewer-run.sh resume --topic <slug>
```

新会话读取 brief、state、共识账本、review backlog 和 handoff，从 `next_blind_audit` 继续。不得 fork、复制旧聊天历史或在旧会话突破 10 轮。

## 清理与协议

每轮完成后删除该轮 artifact、blind-review、response、revision 和 review 文件。保留 `brief.md`、`consensus-exclusions.json`、`review-backlog.json`、`workflow-state.json` 和必要的 handoff/final/dispute 文件。未通过、需人工裁决、协议失败或中断时不得清理。

reviewer JSON 必须符合 `schemas/codex-review.schema.json`：

- pass 不得包含 delivery blocker，允许非阻塞 issues
- fail 必须至少包含一个 delivery blocker
- code blocker 必须是当前状态已观察到的 failing check、runtime reproduction 或 safe PoC；doc 可使用 document observation
- Claude response 只覆盖 delivery blocker，并包含独立 `verification-result` 和 `verification-evidence`

详细契约见 `references/reference.md`。
