你正在处理一轮来自外部 Codex reviewer 的审查结果。

## 输入

- 用户任务：`{{USER_TASK}}`
- 制品类型：`{{ARTIFACT_TYPE}}`
- 独立盲审轮次：`{{AUDIT_ROUND}}`
- 当前内层迭代：`{{INNER_ITERATION}}`
- 最大独立盲审次数：`{{MAX_BLIND_AUDITS}}`

## 当前制品

{{CURRENT_ARTIFACT}}

## 最新 Review

{{LATEST_REVIEW}}

## 你的职责

只处理最新 review 中 `delivery_blocking: true` 的 issue。非阻塞 finding 已由控制器写入 backlog，不要求本轮修改或回应。

修改前先逐项执行 reviewer 提供的 reproduction。只有确实复现，或对 failing check / safe PoC 完成独立验证后，才能接受并修改：

- 如果复现成功或已独立验证：问题属实才修改，并标记为 `accepted`
- 如果无法复现：不要修改，标记为 `questioned`，附实际执行命令和结果
- 如果问题不成立：给出理由，并标记为 `rejected`

不要静默跳过任何 delivery blocker。每个 delivery blocker 都必须逐条回应；不要为非阻塞 issue 创建响应条目。

如果你接受某个问题，就必须真正落实对应修改，而不是只说会改。

## 输出格式

只输出以下 Markdown 结构，供控制器直接保存为 `response-rN-iM.md`：

```markdown
# 独立盲审第 {{AUDIT_ROUND}} 轮 · 内层迭代 {{INNER_ITERATION}} 修订响应

## Review Response
1. <issue-id>
   - decision: accepted | questioned | rejected
   - verification-result: reproduced | independently_verified | not_reproduced
   - verification-evidence: <实际执行的命令/步骤和结果；安全 PoC 或 failing check 写独立验证依据>
   - action: <做了什么修改；如果未修改则写 none>
   - rationale: <为什么这样处理>
   - open-question: <如有疑问写在这里，否则写 none>
```

## 额外要求

- 回应应与 review 中的 delivery blocker 一一对应，不多不少
- `accepted` 必须使用 `reproduced` 或 `independently_verified`；`not_reproduced` 不得 accepted
- verification-evidence 不能为空，也不能只复述 reviewer 的结论
- 不要重写或复述全部主制品，只聚焦对 findings 的回应
- 如果是 `code` 模式，代码修改在工作区文件中完成
- 如果是 `doc` 模式，文档修订在当前主制品中完成
- 如果某个问题建议不合理，也必须给出清晰理由，便于下一轮 reviewer 或人类判断
- `questioned` 或 `rejected` 只是主 agent 的立场，不会自动进入共识排除项；必须由 reviewer 在下一次复查中明确确认
- 这次响应只处理当前独立盲审轮次；内层 reviewer 通过后，控制器仍可能启动下一次全新独立盲审
