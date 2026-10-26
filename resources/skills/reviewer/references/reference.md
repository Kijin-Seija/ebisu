# Reviewer 参考规范

## 目录

1. 角色与循环
2. Finding 分类
3. 盲审隔离
4. 共识排除与非阻塞 backlog
5. 状态与收敛
6. JSON 契约
7. 文件生命周期
8. 分歧与协议失败

## 角色与循环

主 agent 独占写权限；reviewer 始终只读。

- `blind audit round`：每启动一个全新上下文隔离 reviewer 才加一。
- `inner iteration`：主 agent 修复当前轮 delivery blocker，同一个 reviewer 复查。内层迭代不消耗 blind audit 次数。

${#IF claude#}
通过 `bin/reviewer-run.sh` launcher 启动外部 Codex 盲审会话（本宿主没有原生 reviewer subagent）。
${#ELSE#}
优先用原生 subagent 启动上下文隔离的只读 reviewer；兼容 launcher 仅用于回归测试或无法使用原生 subagent 的受限环境。
${#END#}

标准流程：

1. 主 agent 完成任务并通过适用的测试、lint、typecheck 等确定性检查。
2. 启动全新盲审。
3. 没有 delivery blocker 时完成一次 qualifying blind audit。
4. 有 blocker 时，连续合格计数清零；主 agent 逐项修复或提出异议，同一 reviewer 复查直到 pass。
5. 内层 pass 只完成本轮，不计为 qualifying。
6. 启动下一只全新 reviewer。
7. 一次 qualifying blind audit 后稳定收敛；普通模式默认最多 10 轮，goal 模式最多 20 轮。

## Finding 分类

每个 issue 必须包含：

- `severity`: `blocking | important | minor`
- `origin`: `change_introduced | task_related | pre_existing | out_of_scope`
- `confidence`: `high | medium | low`
- `evidence_kind`: `failing_check | runtime_reproduction | safe_poc | document_observation | deterministic_current_path | static_suspicion | future_risk | best_practice | insufficient_evidence`
- `evidence`: reviewer 实际观察到的证据或非阻塞 finding 的证据缺口
- `current_state_reachable`: 是否由当前代码、配置和受支持输入触发
- `reproduction`: 前置条件、步骤/命令、预期结果、实际结果和 observed 标记
- `delivery_blocking`: boolean
- `non_blocking_reason`: blocker 为 null；非 blocker 必须说明原因

只有同时满足以下条件才能 `delivery_blocking=true`：

1. severity 为 blocking/important
2. origin 为 change_introduced，或直接违反明确任务要求/验收标准的 task_related
3. blocking 的 confidence 为 high/medium；important 必须为 high
4. code 的 evidence_kind 为 failing_check/runtime_reproduction/safe_poc；doc 可用 document_observation
5. current_state_reachable=true，且 reproduction 完整、observed=true
6. reviewer 已实际执行安全复现；只读 sandbox/缓存权限失败不算产品失败
7. 不处理会破坏原始任务的当前正确交付

以下 finding 必须非阻塞：

- minor
- pre-existing 或 out-of-scope
- low confidence
- medium-confidence important
- 纯优化、风格偏好、防御性增强
- 没有具体失败证据的推测
- 仅从通用最佳实践推断、未违反明确任务要求的改进
- deterministic current path、静态猜测和未来风险
- 依赖未来代码、配置、调用方、流量或当前不受支持输入
- reproduction 未执行、未观察到或不能由主 agent 重复

blocker 的核心 description/evidence 不得使用“可能、也许、或许、may、might、could cause”等不确定措辞。应明确写出当前前置条件、执行步骤、预期值和实际观察值。

上下文不足默认是低置信度非阻塞 finding。只有“缺少必需输入”本身明确违反任务要求时才可阻塞。

## 盲审隔离

全新盲审只接收：

- 原始任务
- 制品类型
- 固定 baseline
- 当前 baseline diff 或完整文档
- active `consensus-exclusions.json`
- active `review-backlog.json`
- 当前真实工作区

不得提供历史 review、主 agent 回应、当前轮次、最大轮次、topic、争议记录或旧聊天历史。盲审 prompt 不得泄露这些控制字段。

reviewer 必须忽略各宿主的 plans 目录（`.codex/plans/`、`.claude/plans/`、`.workbuddy/plans/`）和其他工作流产物。允许读取调用方、测试和配置，但只用于验证本次任务变更，不得扩张成无边界项目审计。

follow-up 不属于全新盲审，必须带当前轮次的最新 review、主 agent 回应、当前制品、共识账本和 backlog，并继续使用同一个 reviewer。

## 共识排除与非阻塞 backlog

### consensus-exclusions.json

保存双方明确确认的不成立或无需处理事项。完整结构见 `schemas/consensus-exclusions.schema.json`。

只有 follow-up reviewer 明确同意主 agent 对某个 delivery blocker 的 `questioned|rejected` 立场时，才能创建 exclusion。accepted、已修复、未达成一致或真实但容忍的风险不得写入。

新盲审不得重复 active exclusion。事实变化满足 `reopen_if` 时，可通过 `reopens_consensus_id` 重新打开；控制器机械移除该 active 条目。

### review-backlog.json

保存不阻塞当前任务交付的 finding。完整结构见 `schemas/review-backlog.schema.json`。

```json
{
  "items": [
    {
      "backlog_id": "backlog-0123456789ab",
      "severity": "minor",
      "origin": "task_related",
      "confidence": "high",
      "evidence_kind": "best_practice",
      "description": "可选的错误提示可以更清晰",
      "evidence": "src/form.ts:42 使用通用提示",
      "current_state_reachable": true,
      "reproduction": null,
      "location": "src/form.ts:42",
      "reason_non_blocking": "不影响本次校验正确性"
    }
  ]
}
```

控制器从规范化 origin/location/description 生成稳定 hash id，精确重复时更新而不追加。reviewer 对实质相同条目应省略；新证据改变交付影响时，通过 `related_backlog_id` 引用。若升级为 delivery blocker，控制器从 backlog 移除原条目。

backlog 不是“已确认真实且必须修复”的清单，只是避免后续盲审反复提出非阻塞事项的最小记忆。

## 状态与收敛

`workflow-state.json` 使用 `schemas/workflow-state.schema.json`，当前 version 为 3。launcher 自动把 version 1/2 state 迁移到 version 3，并将旧 `unlimited (goal-mode)` 改为 `20 (goal-mode)`。

关键字段：

```json
{
  "version": 3,
  "max_blind_audits": "20 (goal-mode)",
  "rollover_every": 10,
  "required_qualifying_blind_audits": 1,
  "consecutive_qualifying_blind_audits": 0,
  "completed_blind_audits": 10,
  "next_blind_audit": 11,
  "session_segment": 1,
  "completed_in_current_session": 10,
  "status": "handoff_required"
}
```

计数规则：

- 全新盲审没有 blocker：计数设为 1，并立即 `stable-convergence`
- 全新盲审有 blocker：立即设为 0
- 内层修复后 pass：完成本轮，但保持 0
- 连续计数达到 1：`stable-convergence`
- 普通模式达到 max：`max-blind-audits-completed`
- goal 模式完成第 20 轮内层收敛：`review-budget-completed`

goal 模式全局最多 20 次独立盲审，但不是“零 finding”模式；任意一次全新盲审没有 delivery blocker 即可稳定收敛。

每个主会话最多完成 10 次盲审。仍需继续时设置 `handoff_required`，写入 `session-handoff.md`。新会话必须使用相同 local checkout，不 fork、不创建 worktree，只读取 brief/state/exclusions/backlog/handoff，然后 resume。每个新会话段重复相同 10 轮限制。

## JSON 契约

所有 `blind-review-rN.md` 与 `review-rN-iM.md` 使用 `schemas/codex-review.schema.json`：

```json
{
  "status": "pass",
  "summary": "没有交付阻塞问题；记录一个非阻塞建议",
  "issues": [
    {
      "id": "issue-1",
      "severity": "minor",
      "origin": "task_related",
      "confidence": "high",
      "evidence_kind": "best_practice",
      "evidence": "src/form.ts:42 使用通用提示",
      "current_state_reachable": true,
      "reproduction": null,
      "description": "提示文案可以更具体",
      "fix_suggestion": "后续优化提示文案",
      "location": "src/form.ts:42",
      "delivery_blocking": false,
      "non_blocking_reason": "不影响本次任务正确交付",
      "reopens_consensus_id": null,
      "related_backlog_id": null
    }
  ],
  "new_consensus_exclusions": [],
  "next_action": "approve"
}
```

语义约束：

- pass：没有 delivery blocker；issues 可空或只含非阻塞 finding；next_action=approve
- fail：至少一个 delivery blocker；next_action=revise|human_judgment
- 独立盲审不得创建 `new_consensus_exclusions`
- follow-up 的 exclusion 只能引用最新 review 中被 questioned/rejected 的 delivery blocker
- `related_backlog_id` 与 `reopens_consensus_id` 必须引用当前 active 条目
- code blocker 只能使用 failing_check/runtime_reproduction/safe_poc；doc 可使用 document_observation；都必须当前可达、observed=true

主 agent response 只覆盖最新 review 的 delivery blocker。修改前必须独立执行 reproduction，并填写：

- `verification-result`: `reproduced | independently_verified | not_reproduced`
- `verification-evidence`: 实际命令/步骤和结果

accepted 只能与 reproduced/independently_verified 同时出现。not_reproduced 时不得修改，必须 questioned/rejected；reviewer 后续必须给出修正复现，无法给出则撤回到 backlog。控制器不得补写、合并或自行降级 reviewer finding。

## 文件生命周期

持久文件：

```text
brief.md
consensus-exclusions.json
review-backlog.json
workflow-state.json
session-handoff.md
final.md
dispute-report.md
```

当前未完成轮次临时文件：

```text
artifact-rN.md
blind-review-rN.md
response-rN-iM.md
revision-rN-iM.md
review-rN-iM.md
```

每轮完成并写好账本/state/final 后，单次清理该轮所有临时文件。未通过、human judgment、协议失败或中断时不得清理。

## 分歧与协议失败

`human_judgment` 时生成 `dispute-report.md`，保留双方证据、未决 delivery blocker 和风险，不要伪造共识。

schema 或语义校验失败时要求 reviewer 仅重发合法 JSON。重复失败时停止并保留当前产物。控制器不能替 reviewer 改写 finding，也不能把缺失 evidence 的 issue 擅自升级为 blocker。
