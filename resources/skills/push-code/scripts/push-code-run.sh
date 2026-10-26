#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
PROJECT_ROOT="${EBISU_PROJECT_ROOT:?请通过 Ebisu 客户端 run 执行}"
cd "${PROJECT_ROOT}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
GITLAB_HELPER="${SCRIPT_DIR}/push_code_webhook.py"

usage() {
  cat >&2 <<'EOF'
用法:
  push-code-run.sh preflight
  push-code-run.sh push [--force-with-lease]
  push-code-run.sh rebase-target
  push-code-run.sh create-mr [--title <title>] [--description-file <path>]
  push-code-run.sh status --mr-id <id>
  push-code-run.sh threads --mr-id <id>
  push-code-run.sh wait-review --mr-id <id>
  push-code-run.sh post-rebase-check --mr-id <id>
  push-code-run.sh comment --mr-id <id> --thread-id <id> (--body <text> | --body-file <path>)
  push-code-run.sh note --mr-id <id> (--body <text> | --body-file <path>)
  push-code-run.sh resolve-thread --mr-id <id> --thread-id <id>
  push-code-run.sh reopen-thread --mr-id <id> --thread-id <id>
  push-code-run.sh config
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "错误: 未找到命令: $1" >&2
    exit 1
  }
}

# 变量由 Ebisu 按项目 > 终端 > 技能解析，不读取或执行 env 配置文件。
load_config() {
  : "${PUSH_CODE_GIT_REMOTE:=origin}"
  : "${PUSH_CODE_TARGET_BRANCH:=main}"
  : "${PUSH_CODE_MR_TITLE_PREFIX:=[Ebisu]}"
  : "${PUSH_CODE_POLL_INTERVAL_SECONDS:=30}"
  : "${PUSH_CODE_REVIEW_TIMEOUT_SECONDS:=3600}"
}

require_git_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    echo "错误: 当前目录不是 git 仓库" >&2
    exit 1
  }
}

current_branch() {
  git rev-parse --abbrev-ref HEAD
}

ensure_not_detached() {
  local branch
  branch="$(current_branch)"
  [[ "${branch}" != "HEAD" ]] || {
    echo "错误: 当前处于 detached HEAD，无法执行 push-code 工作流" >&2
    exit 1
  }
}

ensure_clean_worktree() {
  git update-index -q --refresh
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "错误: 工作区存在未提交改动，push-code 工作流要求 clean working tree" >&2
    git status --short >&2 || true
    exit 1
  fi
}

ensure_not_target_branch() {
  local branch="$1"
  [[ "${branch}" != "${PUSH_CODE_TARGET_BRANCH}" ]] || {
    echo "错误: 当前分支就是目标分支 ${PUSH_CODE_TARGET_BRANCH}，拒绝为其创建 MR" >&2
    exit 1
  }
}

record_post_rebase_state() {
  local head_sha="$1"
  printf '%s\n' "${head_sha}" > "$(post_rebase_state_file)"
}

clear_post_rebase_state() {
  rm -f "$(post_rebase_state_file)"
}

post_rebase_state_file() {
  local git_path="" git_root="" project_root=""
  project_root="${PROJECT_ROOT}"
  git_root="$(git -C "${project_root}" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "${git_root}" && "${git_root}" == "${project_root}" ]] && \
    git_path="$(git -C "${project_root}" rev-parse --git-path push-code-post-rebase-required 2>/dev/null)"; then
    if [[ "${git_path}" = /* ]]; then
      printf '%s' "${git_path}"
    else
      printf '%s/%s' "${git_root}" "${git_path#./}"
    fi
    return 0
  fi
  # Non-git diagnostic invocations retain the old fallback location.
  printf '%s' "${PUSH_CODE_POST_REBASE_STATE_FILE:-${PROJECT_ROOT}/.git/push-code-post-rebase-required}"
}

print_preflight_json() {
  local branch="$1"
  printf '{\n'
  printf '  "branch": "%s",\n' "${branch}"
  printf '  "remote": "%s",\n' "${PUSH_CODE_GIT_REMOTE}"
  printf '  "target_branch": "%s",\n' "${PUSH_CODE_TARGET_BRANCH}"
  printf '  "clean": true\n'
  printf '}\n'
}

cmd_preflight() {
  require_command git
  require_git_repo
  load_config
  ensure_not_detached
  ensure_clean_worktree
  local branch
  branch="$(current_branch)"
  ensure_not_target_branch "${branch}"
  print_preflight_json "${branch}"
}

cmd_push() {
  require_command git
  require_git_repo
  load_config
  ensure_not_detached
  ensure_clean_worktree
  local branch status push_mode=""
  while [[ $# -gt 0 ]]; do
    case "${1-}" in
      --force-with-lease)
        push_mode="--force-with-lease"
        shift
        ;;
      *)
        usage
        exit 1
        ;;
    esac
  done
  branch="$(current_branch)"
  ensure_not_target_branch "${branch}"
  if git rev-parse --verify --quiet "@{upstream}" >/dev/null 2>&1; then
    if git push ${push_mode:+${push_mode}} "${PUSH_CODE_GIT_REMOTE}" "${branch}"; then
      if [[ "${push_mode}" == "--force-with-lease" ]]; then
        record_post_rebase_state "$(git rev-parse HEAD)"
        echo "提示: rebase 后远端 head 已更新；旧的 pipeline/review 结论已失效。请执行 push-code-run.sh post-rebase-check --mr-id <id>，等待当前 head 的新 pipeline 完成后再收口。" >&2
      elif [[ -f "$(post_rebase_state_file)" ]]; then
        # A follow-up fix commit after rebase also gets a fresh pipeline.
        record_post_rebase_state "$(git rev-parse HEAD)"
      fi
      return 0
    fi
    status=$?
  else
    if git push ${push_mode:+${push_mode}} --set-upstream "${PUSH_CODE_GIT_REMOTE}" "${branch}"; then
      if [[ "${push_mode}" == "--force-with-lease" ]]; then
        record_post_rebase_state "$(git rev-parse HEAD)"
        echo "提示: rebase 后远端 head 已更新；旧的 pipeline/review 结论已失效。请执行 push-code-run.sh post-rebase-check --mr-id <id>，等待当前 head 的新 pipeline 完成后再收口。" >&2
      elif [[ -f "$(post_rebase_state_file)" ]]; then
        record_post_rebase_state "$(git rev-parse HEAD)"
      fi
      return 0
    fi
    status=$?
  fi
  cat >&2 <<'EOF'
错误: git push 失败。

如果失败来自本地 pre-push 检查脚本，请先阅读报错、分析失败原因，修复代码或配置后重新：
1. `git add`
2. `git commit`
3. 再次执行 `push-code-run.sh push`

不要跳过 pre-push 检查，也不要在没有新 commit 的情况下重复空推。
EOF
  exit "${status}"
}

print_rebase_json() {
  local branch="$1"
  printf '{\n'
  printf '  "branch": "%s",\n' "${branch}"
  printf '  "target_branch": "%s",\n' "${PUSH_CODE_TARGET_BRANCH}"
  printf '  "remote": "%s",\n' "${PUSH_CODE_GIT_REMOTE}"
  printf '  "rebased_onto": "%s/%s"\n' "${PUSH_CODE_GIT_REMOTE}" "${PUSH_CODE_TARGET_BRANCH}"
  printf '}\n'
}

cmd_rebase_target() {
  require_command git
  require_git_repo
  load_config
  ensure_not_detached
  ensure_clean_worktree
  local branch upstream_ref
  branch="$(current_branch)"
  ensure_not_target_branch "${branch}"
  upstream_ref="${PUSH_CODE_GIT_REMOTE}/${PUSH_CODE_TARGET_BRANCH}"

  if ! git fetch "${PUSH_CODE_GIT_REMOTE}" "${PUSH_CODE_TARGET_BRANCH}"; then
    echo "错误: 无法获取目标分支 ${upstream_ref}" >&2
    exit 1
  fi

  if git rebase "${upstream_ref}"; then
    print_rebase_json "${branch}"
    return 0
  fi

  cat >&2 <<EOF
错误: 将当前分支 rebase 到 ${upstream_ref} 时失败。

请先解决 rebase 冲突，然后根据实际情况执行：
1. git rebase --continue
2. 运行必要验证
3. ${SCRIPT_DIR}/push-code-run.sh push --force-with-lease

如果决定放弃本次 rebase，可执行：
- git rebase --abort
EOF
  exit 1
}

require_gitlab_prereqs() {
  require_command "${PYTHON_BIN}"
  [[ -x "${GITLAB_HELPER}" ]] || {
    echo "错误: helper 不可执行: ${GITLAB_HELPER}" >&2
    exit 1
  }
  [[ -n "${PUSH_CODE_GITLAB_BASE_URL}" ]] || {
    echo "错误: 缺少 GitLab 基础地址配置 PUSH_CODE_GITLAB_BASE_URL" >&2
    exit 1
  }
  [[ -n "${PUSH_CODE_PROJECT_ID}" ]] || {
    echo "错误: 缺少项目标识配置 PUSH_CODE_PROJECT_ID" >&2
    exit 1
  }
}

default_title() {
  local branch="$1"
  printf '%s %s' "${PUSH_CODE_MR_TITLE_PREFIX}" "${branch}"
}

cmd_create_mr() {
  require_command git
  require_git_repo
  load_config
  require_gitlab_prereqs
  local branch title="" description_file="" description="" result=""

  while [[ $# -gt 0 ]]; do
    case "${1-}" in
      --title)
        title="${2-}"
        shift 2
        ;;
      --description-file)
        description_file="${2-}"
        shift 2
        ;;
      *)
        usage
        exit 1
        ;;
    esac
  done

  branch="$(current_branch)"
  [[ -n "${title}" ]] || title="$(default_title "${branch}")"
  if [[ -n "${description_file}" ]]; then
    description="$(<"${description_file}")"
  fi

  result="$("${PYTHON_BIN}" "${GITLAB_HELPER}" create-mr \
    --branch "${branch}" \
    --target-branch "${PUSH_CODE_TARGET_BRANCH}" \
    --project-id "${PUSH_CODE_PROJECT_ID}" \
    --title "${title}" \
    --description "${description}")"
  printf '%s\n' "${result}"
}

parse_mr_id_args() {
  local mr_id=""
  while [[ $# -gt 0 ]]; do
    case "${1-}" in
      --mr-id)
        mr_id="${2-}"
        shift 2
        ;;
      *)
        usage
        exit 1
        ;;
    esac
  done
  [[ -n "${mr_id}" ]] || {
    echo "错误: 缺少 --mr-id" >&2
    exit 1
  }
  printf '%s' "${mr_id}"
}

cmd_status() {
  load_config
  require_gitlab_prereqs
  local mr_id expected_head_sha=""
  mr_id="$(parse_mr_id_args "$@")"
  local helper_args=(
    "${GITLAB_HELPER}" status
    --mr-id "${mr_id}"
    --project-id "${PUSH_CODE_PROJECT_ID}"
  )
  if [[ -f "$(post_rebase_state_file)" ]]; then
    expected_head_sha="$(<"$(post_rebase_state_file)")"
    if [[ -n "${expected_head_sha}" ]]; then
      helper_args+=(--expected-head-sha "${expected_head_sha}" --require-current-head-pipeline)
      echo "提示: 检测到 rebase 后待验证 head，status 将强制应用新 head pipeline 门禁。" >&2
    fi
  fi
  "${PYTHON_BIN}" "${helper_args[@]}"
}

cmd_threads() {
  load_config
  require_gitlab_prereqs
  local mr_id
  mr_id="$(parse_mr_id_args "$@")"
  exec "${PYTHON_BIN}" "${GITLAB_HELPER}" threads \
    --mr-id "${mr_id}" \
    --project-id "${PUSH_CODE_PROJECT_ID}"
}

cmd_wait_review() {
  load_config
  require_gitlab_prereqs
  local mr_id expected_head_sha="" status
  mr_id="$(parse_mr_id_args "$@")"
  local helper_args=(
    "${GITLAB_HELPER}" wait-review
    --mr-id "${mr_id}"
    --project-id "${PUSH_CODE_PROJECT_ID}"
    --poll-interval-seconds "${PUSH_CODE_POLL_INTERVAL_SECONDS}"
    --review-timeout-seconds "${PUSH_CODE_REVIEW_TIMEOUT_SECONDS}"
  )
  if [[ -f "$(post_rebase_state_file)" ]]; then
    expected_head_sha="$(<"$(post_rebase_state_file)")"
    if [[ -n "${expected_head_sha}" ]]; then
      helper_args+=(--expected-head-sha "${expected_head_sha}" --require-current-head-pipeline)
      echo "提示: 检测到 rebase 后待验证 head，wait-review 将强制等待新 head pipeline。" >&2
    fi
  fi
  if "${PYTHON_BIN}" "${helper_args[@]}"; then
    clear_post_rebase_state
    return 0
  else
    status=$?
    return "${status}"
  fi
}

cmd_post_rebase_check() {
  require_command git
  require_git_repo
  load_config
  require_gitlab_prereqs
  local mr_id head_sha
  mr_id="$(parse_mr_id_args "$@")"
  head_sha="$(git rev-parse HEAD)"
  if "${PYTHON_BIN}" "${GITLAB_HELPER}" wait-review \
    --mr-id "${mr_id}" \
    --project-id "${PUSH_CODE_PROJECT_ID}" \
    --poll-interval-seconds "${PUSH_CODE_POLL_INTERVAL_SECONDS}" \
    --review-timeout-seconds "${PUSH_CODE_REVIEW_TIMEOUT_SECONDS}" \
    --expected-head-sha "${head_sha}" \
    --require-current-head-pipeline; then
    clear_post_rebase_state
    return 0
  else
    return $?
  fi
}

cmd_comment() {
  load_config
  require_gitlab_prereqs
  local mr_id="" thread_id="" body="" body_file=""
  while [[ $# -gt 0 ]]; do
    case "${1-}" in
      --mr-id)
        mr_id="${2-}"
        shift 2
        ;;
      --thread-id)
        thread_id="${2-}"
        shift 2
        ;;
      --body)
        body="${2-}"
        shift 2
        ;;
      --body-file)
        body_file="${2-}"
        shift 2
        ;;
      *)
        usage
        exit 1
        ;;
    esac
  done

  [[ -n "${mr_id}" ]] || {
    echo "错误: 缺少 --mr-id" >&2
    exit 1
  }
  [[ -n "${thread_id}" ]] || {
    echo "错误: 缺少 --thread-id" >&2
    exit 1
  }
  if [[ -n "${body_file}" ]]; then
    body="$(<"${body_file}")"
  fi
  [[ -n "${body}" ]] || {
    echo "错误: 缺少评论正文" >&2
    exit 1
  }

  exec "${PYTHON_BIN}" "${GITLAB_HELPER}" comment \
    --mr-id "${mr_id}" \
    --thread-id "${thread_id}" \
    --project-id "${PUSH_CODE_PROJECT_ID}" \
    --body "${body}"
}

cmd_note() {
  load_config
  require_gitlab_prereqs
  local mr_id="" body="" body_file=""
  while [[ $# -gt 0 ]]; do
    case "${1-}" in
      --mr-id)
        mr_id="${2-}"
        shift 2
        ;;
      --body)
        body="${2-}"
        shift 2
        ;;
      --body-file)
        body_file="${2-}"
        shift 2
        ;;
      *)
        usage
        exit 1
        ;;
    esac
  done

  [[ -n "${mr_id}" ]] || {
    echo "错误: 缺少 --mr-id" >&2
    exit 1
  }
  if [[ -n "${body_file}" ]]; then
    body="$(<"${body_file}")"
  fi
  [[ -n "${body}" ]] || {
    echo "错误: 缺少评论正文" >&2
    exit 1
  }

  exec "${PYTHON_BIN}" "${GITLAB_HELPER}" note \
    --mr-id "${mr_id}" \
    --project-id "${PUSH_CODE_PROJECT_ID}" \
    --body "${body}"
}

cmd_resolve_thread() {
  load_config
  require_gitlab_prereqs
  local mr_id="" thread_id=""
  while [[ $# -gt 0 ]]; do
    case "${1-}" in
      --mr-id)
        mr_id="${2-}"
        shift 2
        ;;
      --thread-id)
        thread_id="${2-}"
        shift 2
        ;;
      *)
        usage
        exit 1
        ;;
    esac
  done

  [[ -n "${mr_id}" ]] || {
    echo "错误: 缺少 --mr-id" >&2
    exit 1
  }
  [[ -n "${thread_id}" ]] || {
    echo "错误: 缺少 --thread-id" >&2
    exit 1
  }

  exec "${PYTHON_BIN}" "${GITLAB_HELPER}" resolve-thread \
    --mr-id "${mr_id}" \
    --thread-id "${thread_id}" \
    --project-id "${PUSH_CODE_PROJECT_ID}"
}

cmd_reopen_thread() {
  load_config
  require_gitlab_prereqs
  local mr_id="" thread_id=""
  while [[ $# -gt 0 ]]; do
    case "${1-}" in
      --mr-id)
        mr_id="${2-}"
        shift 2
        ;;
      --thread-id)
        thread_id="${2-}"
        shift 2
        ;;
      *)
        usage
        exit 1
        ;;
    esac
  done

  [[ -n "${mr_id}" ]] || {
    echo "错误: 缺少 --mr-id" >&2
    exit 1
  }
  [[ -n "${thread_id}" ]] || {
    echo "错误: 缺少 --thread-id" >&2
    exit 1
  }

  exec "${PYTHON_BIN}" "${GITLAB_HELPER}" reopen-thread \
    --mr-id "${mr_id}" \
    --thread-id "${thread_id}" \
    --project-id "${PUSH_CODE_PROJECT_ID}"
}

cmd_config() {
  echo '配置由 Ebisu 变量界面管理；敏感值不会打印到配置诊断输出。'
}

main() {
  local subcommand="${1-}"
  [[ $# -gt 0 ]] || {
    usage
    exit 1
  }
  shift

  case "${subcommand}" in
    preflight)
      cmd_preflight "$@"
      ;;
    push)
      cmd_push "$@"
      ;;
    rebase-target)
      cmd_rebase_target "$@"
      ;;
    create-mr)
      cmd_create_mr "$@"
      ;;
    status)
      cmd_status "$@"
      ;;
    threads)
      cmd_threads "$@"
      ;;
    wait-review)
      cmd_wait_review "$@"
      ;;
    post-rebase-check)
      cmd_post_rebase_check "$@"
      ;;
    comment)
      cmd_comment "$@"
      ;;
    note)
      cmd_note "$@"
      ;;
    resolve-thread)
      cmd_resolve_thread "$@"
      ;;
    reopen-thread)
      cmd_reopen_thread "$@"
      ;;
    config)
      cmd_config "$@"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
