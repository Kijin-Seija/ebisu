# Push Code 参考

运行依赖 Git 与 Python 3。GitLab 认证、分支和项目设置统一由 Ebisu 变量管理。

## launcher 命令

### `preflight`

检查：

- 当前目录是 git 仓库
- worktree clean
- 非 detached HEAD
- 当前分支不是目标主分支

输出 JSON，例如：

```json
{
  "branch": "feature/foo",
  "remote": "origin",
  "target_branch": "main",
  "clean": true
}
```

### `push`

把当前分支推到配置的 remote。

如果当前分支没有 upstream，脚本会自动使用 `--set-upstream`。

如果当前分支刚做过 rebase，需要改用：

```bash
push-code-run.sh push --force-with-lease
```

如果 `git push` 触发了本地 pre-push 检查并失败：

- 不要跳过 hook
- 先阅读 hook 输出并判断失败类别
- 修复问题后，若当前分支是 `master`，先创建 `${HOST_KEY}/<简短描述>` 提交分支（已存在时追加递增后缀），再执行 `git add`、`git commit`
- 再次执行 `push`

### `rebase-target`

先执行：

- `git fetch <remote> <target-branch>`
- `git rebase <remote>/<target-branch>`

适用场景：

- `wait-review` 返回 `needs_rebase`
- `status` 输出里的 `raw_status` 是 `need_rebase` 或 `conflict`
- `meta.detailed_merge_status` 表示当前源分支必须先 rebase 到目标分支

如果 rebase 冲突：

- 先解决冲突
- 再执行 `git rebase --continue`
- 完成后使用 `push --force-with-lease`

rebase 成功并 force push 后，旧 head 的 pipeline / review 结论全部失效。必须执行：

```bash
push-code-run.sh post-rebase-check --mr-id <mr_id>
```

该命令会校验 GitLab 的 MR head SHA 与本地新 `HEAD` 一致，并等待当前 head 的新 pipeline 出现且结束；在此之前返回的 `approved` 不得用于收口。若手动执行，则先用 `status --mr-id` 核对 `meta.head_sha`，再用 `wait-review --mr-id` 继续轮询。

### `post-rebase-check`

这是 rebase 后的强制验证入口。它等价于带有本地新 head SHA 门禁和“必须观察到当前 head pipeline”条件的 `wait-review`：

- `post_rebase_head_sha_not_updated`：GitLab 还未看到 force push 后的新 head
- `post_rebase_pipeline_not_created`：新 head 的 pipeline 尚未创建
- `post_rebase_pipeline_not_completed` / `post_rebase_pipeline_not_success`：新 head 的 pipeline 尚未成功结束
- 只有当前 head pipeline 已结束且 review / discussions / notes / mergeability 均通过时，才返回 `approved`（退出码 `0`）

### `create-mr`

调用 GitLab REST API：

- `POST /api/v4/projects/:id/merge_requests`

默认请求体为：

```json
{
  "source_branch": "feature/foo",
  "target_branch": "main",
  "title": "[Ebisu] feature/foo",
  "description": ""
}
```

返回里会优先使用 `iid` 作为工作流里的 `mr_id`，因为后续 discussions / approvals / merge request 详情接口都使用 MR IID。

建议响应摘要示例：

```json
{
  "mr_id": 123,
  "mr_global_id": 456,
  "mr_url": "https://gitlab.example.com/group/project/-/merge_requests/123"
}
```

### `status`

查询：

- `GET /api/v4/projects/:id/merge_requests/:iid`
- `GET /api/v4/projects/:id`
- `GET /api/v4/projects/:id/merge_requests/:iid/pipelines`
- `GET /api/v4/projects/:id/merge_requests/:iid/status_checks`（如果实例支持且当前 token 有权限）
- `GET /api/v4/projects/:id/merge_requests/:iid/discussions`
- `GET /api/v4/projects/:id/merge_requests/:iid/approvals`（如果实例支持且当前 token 有权限）

状态归一化规则：

- `detailed_merge_status=need_rebase`、存在 merge conflict，或 GitLab 明确返回 rebase blocker：`needs_rebase`
- 如果项目 `merge_method` 是 `ff` / `rebase_merge`，且 `diverged_commits_count > 0`，即使 `detailed_merge_status` 还没刷新成 `need_rebase`，也按 `needs_rebase` 处理
- pipeline 列表只统计 `sha == MR 当前 head SHA` 或 `sha == head_pipeline.sha` 的记录，以兼容 merged-results pipeline；旧提交对应的 pipeline 不参与当前结论
- 任意当前 head pipeline 为 `failed|canceled|canceling|skipped`：立即按 `changes_requested` 处理；该失败优先于其他 pipeline 的 `running|pending`
- `detailed_merge_status=ci_must_pass` / `status_checks_must_pass` 且任意当前 head pipeline 失败：`changes_requested`
- `status_checks` 里只要存在 `failed` 项：立即按 `changes_requested` 处理；该失败优先于 pipeline / status check 的 running / pending 信号
- `status_checks` 里只要还存在 `pending` 项：`pending`
- 只要 `head_pipeline.status` 仍处于 `running` / `pending` / `preparing` 等未完成状态，即使 `detailed_merge_status=mergeable` 也仍然是 `pending`
- 存在未解决的可解析 discussion：`changes_requested`
- 没有未解决 discussion，且 approval 规则已满足：`approved`
- 没有未解决 discussion，且已经出现过 review discussion：`approved`
- 没有任何 discussion，且 MR 创建时间仍在 `PUSH_CODE_GITLAB_INITIAL_REVIEW_GRACE_SECONDS` 宽限内：`pending`
- 没有任何 discussion，且超过宽限：`approved`

### `threads`

查询：

- `GET /api/v4/projects/:id/merge_requests/:iid/discussions`
- `GET /api/v4/projects/:id/merge_requests/:iid/notes`

输出会被归一化成：

```json
{
  "threads": [
    {
      "id": "abc",
      "individual_note": false,
      "resolved": false,
      "resolvable": true,
      "notes": [
        {
          "id": 1,
          "body": "...",
          "author": "review-bot"
        }
      ]
    }
  ],
  "notes": [
    {
      "id": 101,
      "body": "审核不通过...",
      "author": "review-bot"
    }
  ],
  "summary": {
    "total": 1,
    "unresolved": 1,
    "notes": 1
  }
}
```

### `wait-review`

轮询 `status`，并在遇到变更请求、通过或超时时退出：

- 退出码 `0`：通过
- 退出码 `10`：review 要求修改
- 退出码 `11`：当前 MR 必须先 rebase 到目标分支
- 退出码 `124`：超时

输出 JSON 会附带当前 discussions 和 MR 摘要，便于主 agent 决策。

`status` / `wait-review` 现在无论当前是 `pending`、`changes_requested` 还是 `approved`，都会附带完整 `notes`，并在 `meta` 中补充：

- `notes_total`
- `non_system_notes_total`
- `latest_non_system_note_id`
- `latest_non_system_note_created_at`
- `latest_non_system_note_updated_at`
- `latest_non_system_note_body_sha256`
- `latest_non_system_note_revision_key`
- `latest_non_system_note_author`
- `review_notes_fingerprint`
- `review_note_revisions_total`

同时还会附带 `workflow_guidance`，至少包含：

- `review_complete`
- `workflow_complete`
- `can_announce_completion`
- `recommended_next_action`
- `user_facing_state`

推荐主 agent 直接把 `workflow_guidance.can_announce_completion` 当成硬约束：

- `true`：当前轮允许按“MR 已达到可提交状态”口径收口
- `false`：当前轮绝不能把 push-code 流程说成已完成
- `false` 且没有新的用户决策 blocker：当前轮也不允许发送 final answer；只能继续在同一 turn 内轮询并发送 commentary

另外，`workflow_guidance.recommended_next_action` 里以 `_in_current_session` 结尾的值也应被视为硬约束，表示当前会话必须自己继续轮询并处理。例如：

- `keep_waiting_for_ci_in_current_session`
- `keep_waiting_in_current_session_and_treat_note_as_pending_finding`
- `keep_waiting_for_review_signal_in_current_session`

这些值出现时，说明最新 head pipeline / review 信号仍属于当前会话必须继续跟进的范围。

对业务 agent 来说，这里还有一个更严格的收口规则：

- `pending` / `ci_still_running` / `head_pipeline:running` 本身不是 final 收口条件
- “MR 已创建、review note 看起来通过、现在只等 CI” 也不是 final 收口条件
- 只有 MR 达到可提交状态，或出现明确 blocker 需要用户立刻介入时，才允许发送 final answer

### `comment`

调用：

- `POST /api/v4/projects/:id/merge_requests/:iid/discussions/:thread_id/notes`

用于回复 discussion。

### `note`

调用：

- `POST /api/v4/projects/:id/merge_requests/:iid/notes`

用于追加普通 MR note。

### `resolve-thread`

调用：

- `PUT /api/v4/projects/:id/merge_requests/:iid/discussions/:thread_id`

请求体会把 `resolved=true`。

### `reopen-thread`

调用：

- `PUT /api/v4/projects/:id/merge_requests/:iid/discussions/:thread_id`

请求体会把 `resolved=false`。



## Ebisu 配置与运行

GitLab 地址、token、项目 ID、分支、认证及有界轮询参数由技能变量界面管理，项目覆盖终端，终端覆盖技能。凭据不写入包或项目。使用客户端 run 注入配置后运行 scripts/push-code-run.sh；项目根目录由 EBISU_PROJECT_ROOT 显式传入。保留当前会话有超时上限的 review 跟进，不创建后台进程、定时唤醒或自动通知。
