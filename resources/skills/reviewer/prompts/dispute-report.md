你正在为未收敛的 reviewer 工作流生成分歧报告。

## 输入

- 用户任务：`{{USER_TASK}}`
- 制品类型：`{{ARTIFACT_TYPE}}`
- topic slug：`{{TOPIC_SLUG}}`
- 当前独立盲审轮次：`{{AUDIT_ROUND}}`
- 当前内层迭代：`{{INNER_ITERATION}}`
- 最大独立盲审次数：`{{MAX_BLIND_AUDITS}}`
- 最新制品：

{{LATEST_ARTIFACT}}

- 最新 Review：

{{LATEST_REVIEW}}

- 最新主 agent 回应：

{{LATEST_AGENT_RESPONSE}}

## 目标

在某次独立盲审的内层收敛流程无法达成一致时，总结仍需人类裁决的争议点。

不要重新评判谁对谁错；只整理双方立场、未解决原因和建议的人类决策。

## 输出格式

```markdown
# 分歧报告

## 工作流摘要
- topic: <topic slug>
- artifact-type: <code | doc>
- blind-audits-started: <已启动的独立盲审次数>
- inner-iterations: <当前盲审内已运行的修订迭代数>
- latest-artifact: <最新制品文件名>

## 未解决问题
1. <问题标题>
   - severity: <blocking | important>
   - reviewer-reproduction: <reviewer 给出的当前状态复现步骤和观察结果>
   - agent-verification: <主 agent 的 verification-result 和实际复验结果>
   - codex-position: <引用或概述 Codex 当前立场>
   - agent-position: <引用或概述主 agent 当前立场>
   - why-still-unresolved: <为什么仍未收敛>
   - suggested-human-decision: <建议人类做出的判断>

## 建议下一步
- <一个具体的人类动作>
```

只输出分歧报告正文，不要附加额外说明。
