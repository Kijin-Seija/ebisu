#!/usr/bin/env bash

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SELF_DIR}/.." && pwd)"
PLANS_ROOT_NAME=".${EBISU_TERMINAL:?请通过 Ebisu 客户端 run 执行}"
PROMPTS_DIR="${SKILL_DIR}/prompts"
SCHEMAS_DIR="${SKILL_DIR}/schemas"

CODEX_BIN="${REVIEWER_CODEX_BIN:-${IMPLEMENTATION_LOOP_CODEX_BIN:-codex}}"
CODEX_REVIEW_MODEL="${REVIEWER_CODEX_REVIEW_MODEL:-${REVIEWER_CODEX_MODEL:-${IMPLEMENTATION_LOOP_CODEX_MODEL:-}}}"
SESSION_ROLLOVER_ROUNDS=10
GOAL_MODE_MAX_BLIND_AUDITS=20
GOAL_MODE_MAX_LABEL="${GOAL_MODE_MAX_BLIND_AUDITS} (goal-mode)"

usage() {
  cat >&2 <<'EOF'
用法:
  reviewer-run.sh blind --task <task> --artifact-type <code|doc> --topic <slug> --audit-round <n> --max-blind-audits <n|20 (goal-mode)> --baseline <sha|n/a> --artifact <path> [--consensus-exclusions <path>] [--review-backlog <path>] [--plans-dir <dir>] [--workdir <dir>]
  reviewer-run.sh followup --task <task> --artifact-type <code|doc> --topic <slug> --audit-round <n> --inner-iteration <n> --max-blind-audits <n|20 (goal-mode)> --baseline <sha|n/a> --artifact <path> --latest-review <path> --latest-response <path> [--consensus-exclusions <path>] [--review-backlog <path>] [--plans-dir <dir>] [--workdir <dir>]
  reviewer-run.sh dispute --task <task> --artifact-type <code|doc> --topic <slug> --audit-round <n> --inner-iteration <n> --max-blind-audits <n|20 (goal-mode)> --latest-artifact <path> --latest-review <path> [--latest-response <path>] [--plans-dir <dir>] [--workdir <dir>]
  reviewer-run.sh resume --topic <slug> [--plans-dir <dir>] [--workdir <dir>]
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

max_blind_audit_limit() {
  local value="$1"

  if [[ "${value}" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "${value}"
  elif [[ "${value}" == "${GOAL_MODE_MAX_LABEL}" ]]; then
    printf '%s\n' "${GOAL_MODE_MAX_BLIND_AUDITS}"
  elif [[ "${value}" == "unlimited (goal-mode)" ]]; then
    printf '%s\n' ""
  else
    return 1
  fi
}

is_goal_mode_max() {
  local value="$1"
  [[ "${value}" == "${GOAL_MODE_MAX_LABEL}" || "${value}" == "unlimited (goal-mode)" ]]
}

require_cmd() {
  local cmd="$1"
  command -v "${cmd}" >/dev/null 2>&1 || fail "缺少命令: ${cmd}"
}

json_get() {
  local path="$1"
  local expr="$2"

  python3 - "$path" "$expr" <<'PY'
import json
import sys

path, expr = sys.argv[1:3]
with open(path, "r", encoding="utf-8") as fh:
    value = json.load(fh)

for part in expr.split("."):
    value = value[int(part)] if part.isdigit() else value[part]

if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print("null")
elif isinstance(value, (dict, list)):
    print(json.dumps(value, ensure_ascii=False))
else:
    print(value)
PY
}

validate_response_coverage() {
  local review_json="$1"
  local response_path="$2"

  [[ -f "${review_json}" ]] || fail "review 文件不存在: ${review_json}"
  [[ -f "${response_path}" ]] || fail "response 文件不存在: ${response_path}"

  python3 - "$review_json" "$response_path" <<'PY'
import json
import re
import sys

review_path, response_path = sys.argv[1:3]
with open(review_path, "r", encoding="utf-8") as fh:
    review = json.load(fh)
with open(response_path, "r", encoding="utf-8") as fh:
    response = fh.read()

block_pattern = re.compile(
    r"^\s*\d+\.\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s*$"
    r"(.*?)(?=^\s*\d+\.\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s*$|\Z)",
    re.MULTILINE | re.DOTALL,
)
field_pattern = re.compile(
    r"^\s*-\s+(decision|verification-result|verification-evidence|action|rationale|open-question):\s*(.*?)\s*$",
    re.MULTILINE,
)

parsed = {}
for match in block_pattern.finditer(response):
    issue_id = match.group(1)
    if issue_id in parsed:
        raise SystemExit(f"response issue 重复: {issue_id}")
    fields = {}
    for key, value in field_pattern.findall(match.group(2)):
        if key in fields:
            raise SystemExit(f"response 字段重复: {issue_id}.{key}")
        fields[key] = value.strip()
    parsed[issue_id] = fields

expected = {
    issue["id"]
    for issue in review.get("issues", [])
    if issue.get("delivery_blocking") is True
}
if set(parsed) != expected:
    missing = sorted(expected - set(parsed))
    extra = sorted(set(parsed) - expected)
    raise SystemExit(f"response issue 覆盖不完整: missing={missing}, extra={extra}")

for issue_id, fields in parsed.items():
    required_fields = {
        "decision",
        "verification-result",
        "verification-evidence",
        "action",
        "rationale",
        "open-question",
    }
    if set(fields) != required_fields:
        raise SystemExit(f"response 字段不完整: {issue_id}")
    decision = fields["decision"]
    if decision not in {"accepted", "questioned", "rejected"}:
        raise SystemExit(f"response decision 非法: {issue_id}")
    verification_result = fields["verification-result"]
    if verification_result not in {"reproduced", "independently_verified", "not_reproduced"}:
        raise SystemExit(f"response verification-result 非法: {issue_id}")
    if not fields["verification-evidence"]:
        raise SystemExit(f"response verification-evidence 不能为空: {issue_id}")
    if not fields["rationale"]:
        raise SystemExit(f"response rationale 不能为空: {issue_id}")
    if decision == "accepted" and verification_result not in {"reproduced", "independently_verified"}:
        raise SystemExit(f"accepted blocker 必须先被主 agent 独立复验: {issue_id}")
    if decision == "accepted" and fields["action"].lower() == "none":
        raise SystemExit(f"accepted 必须包含实际 action: {issue_id}")
    if decision == "questioned" and fields["open-question"].lower() == "none":
        raise SystemExit(f"questioned 必须包含 open-question: {issue_id}")
PY
}

validate_review_contract() {
  local review_json="$1"
  local artifact_type="$2"

  python3 - "${review_json}" "${artifact_type}" <<'PY'
import json
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    review = json.load(fh)
artifact_type = sys.argv[2]

required = {"status", "summary", "issues", "new_consensus_exclusions", "next_action"}
if set(review) != required:
    raise SystemExit("review JSON 顶层字段不符合契约")

status = review["status"]
issues = review["issues"]
new_exclusions = review["new_consensus_exclusions"]
next_action = review["next_action"]
ids = [issue.get("id") for issue in issues]
if len(ids) != len(set(ids)):
    raise SystemExit("review issue id 必须唯一")
if any(not isinstance(issue_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", issue_id) for issue_id in ids):
    raise SystemExit("review issue id 格式非法")
for issue in issues:
    issue_required = {
        "id",
        "severity",
        "origin",
        "confidence",
        "evidence_kind",
        "evidence",
        "current_state_reachable",
        "reproduction",
        "description",
        "fix_suggestion",
        "location",
        "delivery_blocking",
        "non_blocking_reason",
        "reopens_consensus_id",
        "related_backlog_id",
    }
    if set(issue) != issue_required:
        raise SystemExit(f"review issue 字段不符合契约: {issue.get('id')}")
    if issue["severity"] not in {"blocking", "important", "minor"}:
        raise SystemExit("review issue severity 非法")
    if issue["origin"] not in {"change_introduced", "task_related", "pre_existing", "out_of_scope"}:
        raise SystemExit("review issue origin 非法")
    if issue["confidence"] not in {"high", "medium", "low"}:
        raise SystemExit("review issue confidence 非法")
    evidence_kinds = {
        "failing_check",
        "runtime_reproduction",
        "safe_poc",
        "document_observation",
        "deterministic_current_path",
        "static_suspicion",
        "future_risk",
        "best_practice",
        "insufficient_evidence",
    }
    if issue["evidence_kind"] not in evidence_kinds:
        raise SystemExit("review issue evidence_kind 非法")
    for key in ("evidence", "description", "fix_suggestion", "location"):
        if not isinstance(issue[key], str) or not issue[key].strip():
            raise SystemExit(f"review issue {key} 不能为空")
    if not isinstance(issue["delivery_blocking"], bool):
        raise SystemExit("delivery_blocking 必须是布尔值")
    if not isinstance(issue["current_state_reachable"], bool):
        raise SystemExit("current_state_reachable 必须是布尔值")
    reproduction = issue["reproduction"]
    reproduction_required = {"preconditions", "steps_or_command", "expected", "actual", "observed"}
    if reproduction is not None:
        if not isinstance(reproduction, dict) or set(reproduction) != reproduction_required:
            raise SystemExit("reproduction 字段不符合契约")
        for key in ("preconditions", "steps_or_command", "expected", "actual"):
            if not isinstance(reproduction[key], str) or not reproduction[key].strip():
                raise SystemExit(f"reproduction {key} 不能为空")
        if not isinstance(reproduction["observed"], bool):
            raise SystemExit("reproduction observed 必须是布尔值")
    if issue["delivery_blocking"]:
        if issue["severity"] not in {"blocking", "important"}:
            raise SystemExit("minor 不能阻塞交付")
        if issue["origin"] not in {"change_introduced", "task_related"}:
            raise SystemExit("历史或范围外问题不能阻塞交付")
        if issue["severity"] == "important" and issue["confidence"] != "high":
            raise SystemExit("important 只有 high confidence 才能阻塞交付")
        if issue["severity"] == "blocking" and issue["confidence"] not in {"high", "medium"}:
            raise SystemExit("blocking 的低置信度问题不能阻塞交付")
        allowed_blocking_evidence = {"failing_check", "runtime_reproduction", "safe_poc"}
        if artifact_type == "doc":
            allowed_blocking_evidence.add("document_observation")
        if issue["evidence_kind"] not in allowed_blocking_evidence:
            raise SystemExit("只有当前已观察到的失败、运行时复现、安全 PoC 或文档现状冲突才能阻塞交付")
        if issue["evidence_kind"] == "document_observation" and artifact_type != "doc":
            raise SystemExit("document_observation 只能用于 doc 制品")
        if issue["current_state_reachable"] is not True:
            raise SystemExit("交付阻塞问题必须在当前状态下可达")
        if reproduction is None or reproduction["observed"] is not True:
            raise SystemExit("交付阻塞问题必须提供 observed=true 的完整复现包")
        uncertainty = re.compile(
            r"(?:可能|也许|或许|理论上|潜在地|\bmay\b|\bmight\b|\bpossibly\b|\bpotentially\b|\btheoretically\b|\bcould\s+(?:cause|lead|result|allow|break|fail|be)\b)",
            re.IGNORECASE,
        )
        if uncertainty.search(issue["description"]) or uncertainty.search(issue["evidence"]):
            raise SystemExit("交付阻塞问题不能用不确定性措辞作为核心结论")
        if issue["non_blocking_reason"] is not None:
            raise SystemExit("交付阻塞问题的 non_blocking_reason 必须为 null")
    elif not isinstance(issue["non_blocking_reason"], str) or not issue["non_blocking_reason"].strip():
        raise SystemExit("非阻塞问题必须说明 non_blocking_reason")
    reopened = issue.get("reopens_consensus_id")
    if reopened is not None and (not isinstance(reopened, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", reopened)):
        raise SystemExit("reopens_consensus_id 格式非法")
    related_backlog = issue.get("related_backlog_id")
    if related_backlog is not None and (
        not isinstance(related_backlog, str)
        or not re.fullmatch(r"backlog-[a-f0-9]{12}(?:-[1-9][0-9]*)?", related_backlog)
    ):
        raise SystemExit("related_backlog_id 格式非法")

reopened_ids = [issue["reopens_consensus_id"] for issue in issues if issue["reopens_consensus_id"] is not None]
if len(reopened_ids) != len(set(reopened_ids)):
    raise SystemExit("同一个 consensus exclusion 不能在单次 review 中重复打开")
related_backlog_ids = [issue["related_backlog_id"] for issue in issues if issue["related_backlog_id"] is not None]
if len(related_backlog_ids) != len(set(related_backlog_ids)):
    raise SystemExit("同一个 backlog item 不能在单次 review 中被多个 issue 重复引用")

consensus_ids = [item.get("consensus_id") for item in new_exclusions]
if len(consensus_ids) != len(set(consensus_ids)):
    raise SystemExit("new consensus_id 必须唯一")
for item in new_exclusions:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", item.get("consensus_id", "")):
        raise SystemExit("consensus_id 格式非法")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", item.get("source_issue_id", "")):
        raise SystemExit("source_issue_id 格式非法")
    if item.get("disposition") not in {"not_a_problem", "no_action_needed"}:
        raise SystemExit("consensus disposition 非法")

delivery_blockers = [issue for issue in issues if issue["delivery_blocking"]]
if status == "pass":
    if delivery_blockers or next_action != "approve":
        raise SystemExit("pass 不能包含交付阻塞问题，且必须使用 next_action=approve")
elif status == "fail":
    if not delivery_blockers or next_action not in {"revise", "human_judgment"}:
        raise SystemExit("fail 必须包含交付阻塞问题，并使用 revise 或 human_judgment")
else:
    raise SystemExit("未知 review status")
PY
}

ensure_consensus_exclusions() {
  local path="$1"

  if [[ ! -f "${path}" ]]; then
    mkdir -p "$(dirname "${path}")"
    printf '%s\n' '{"exclusions":[]}' > "${path}"
  fi
}

validate_consensus_exclusions() {
  local path="$1"

  python3 - "${path}" <<'PY'
import json
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    ledger = json.load(fh)
if set(ledger) != {"exclusions"} or not isinstance(ledger["exclusions"], list):
    raise SystemExit("consensus exclusions 账本格式非法")

required = {
    "consensus_id",
    "source_issue_id",
    "disposition",
    "description",
    "location",
    "rationale",
    "applies_while",
    "reopen_if",
}
ids = []
for item in ledger["exclusions"]:
    if set(item) != required:
        raise SystemExit("consensus exclusion 字段不完整")
    consensus_id = item["consensus_id"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", consensus_id):
        raise SystemExit("consensus_id 格式非法")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", item["source_issue_id"]):
        raise SystemExit("consensus source_issue_id 格式非法")
    if item["disposition"] not in {"not_a_problem", "no_action_needed"}:
        raise SystemExit("consensus disposition 非法")
    for key in ("description", "location", "rationale", "applies_while", "reopen_if"):
        if not isinstance(item[key], str) or not item[key].strip():
            raise SystemExit(f"consensus {key} 不能为空")
    ids.append(consensus_id)
if len(ids) != len(set(ids)):
    raise SystemExit("consensus_id 必须唯一")
PY
}

ensure_review_backlog() {
  local path="$1"

  if [[ ! -f "${path}" ]]; then
    mkdir -p "$(dirname "${path}")"
    printf '%s\n' '{"items":[]}' > "${path}"
  fi

  python3 - "${path}" <<'PY'
import json
import os
import pathlib
import tempfile
import sys

path = pathlib.Path(sys.argv[1])
with path.open("r", encoding="utf-8") as fh:
    backlog = json.load(fh)
changed = False
for item in backlog.get("items", []):
    if "evidence_kind" not in item:
        item["evidence_kind"] = "insufficient_evidence"
        changed = True
    if "current_state_reachable" not in item:
        item["current_state_reachable"] = False
        changed = True
    if "reproduction" not in item:
        item["reproduction"] = None
        changed = True
if changed:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as fh:
        json.dump(backlog, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
        temp_path = fh.name
    os.replace(temp_path, path)
PY
}

validate_review_backlog() {
  local path="$1"

  python3 - "${path}" <<'PY'
import json
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    backlog = json.load(fh)
if set(backlog) != {"items"} or not isinstance(backlog["items"], list):
    raise SystemExit("review backlog 格式非法")

required = {
    "backlog_id",
    "severity",
    "origin",
    "confidence",
    "evidence_kind",
    "description",
    "evidence",
    "current_state_reachable",
    "reproduction",
    "location",
    "reason_non_blocking",
}
ids = []
for item in backlog["items"]:
    if set(item) != required:
        raise SystemExit("review backlog item 字段不完整")
    if not re.fullmatch(r"backlog-[a-f0-9]{12}(?:-[1-9][0-9]*)?", item["backlog_id"]):
        raise SystemExit("backlog_id 格式非法")
    if item["severity"] not in {"blocking", "important", "minor"}:
        raise SystemExit("review backlog severity 非法")
    if item["origin"] not in {"change_introduced", "task_related", "pre_existing", "out_of_scope"}:
        raise SystemExit("review backlog origin 非法")
    if item["confidence"] not in {"high", "medium", "low"}:
        raise SystemExit("review backlog confidence 非法")
    if item["evidence_kind"] not in {
        "failing_check",
        "runtime_reproduction",
        "safe_poc",
        "document_observation",
        "deterministic_current_path",
        "static_suspicion",
        "future_risk",
        "best_practice",
        "insufficient_evidence",
    }:
        raise SystemExit("review backlog evidence_kind 非法")
    if not isinstance(item["current_state_reachable"], bool):
        raise SystemExit("review backlog current_state_reachable 必须是布尔值")
    reproduction = item["reproduction"]
    if reproduction is not None:
        required_reproduction = {"preconditions", "steps_or_command", "expected", "actual", "observed"}
        if not isinstance(reproduction, dict) or set(reproduction) != required_reproduction:
            raise SystemExit("review backlog reproduction 字段不完整")
        for key in ("preconditions", "steps_or_command", "expected", "actual"):
            if not isinstance(reproduction[key], str) or not reproduction[key].strip():
                raise SystemExit(f"review backlog reproduction {key} 不能为空")
        if not isinstance(reproduction["observed"], bool):
            raise SystemExit("review backlog reproduction observed 必须是布尔值")
    for key in ("description", "evidence", "location", "reason_non_blocking"):
        if not isinstance(item[key], str) or not item[key].strip():
            raise SystemExit(f"review backlog {key} 不能为空")
    ids.append(item["backlog_id"])
if len(ids) != len(set(ids)):
    raise SystemExit("backlog_id 必须唯一")
PY
}

validate_review_backlog_references() {
  local review_json="$1"
  local backlog_path="$2"

  python3 - "${review_json}" "${backlog_path}" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    review = json.load(fh)
with open(sys.argv[2], "r", encoding="utf-8") as fh:
    backlog = json.load(fh)
active = {item["backlog_id"] for item in backlog["items"]}
referenced = {
    issue["related_backlog_id"]
    for issue in review["issues"]
    if issue["related_backlog_id"] is not None
}
unknown = referenced - active
if unknown:
    raise SystemExit(f"引用了不存在的 backlog_id: {sorted(unknown)}")
PY
}

apply_review_backlog_changes() {
  local review_json="$1"
  local backlog_path="$2"

  python3 - "${review_json}" "${backlog_path}" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile

review_path, backlog_path = sys.argv[1:3]
with open(review_path, "r", encoding="utf-8") as fh:
    review = json.load(fh)
with open(backlog_path, "r", encoding="utf-8") as fh:
    backlog = json.load(fh)

active = {item["backlog_id"]: item for item in backlog["items"]}

def normalized_key(issue):
    description = " ".join(issue["description"].lower().split())
    location = " ".join(issue["location"].lower().split())
    return (issue["origin"], location, description)

key_to_id = {normalized_key(item): item["backlog_id"] for item in active.values()}
referenced = {
    issue["related_backlog_id"]
    for issue in review["issues"]
    if issue["related_backlog_id"] is not None
}
unknown = referenced - set(active)
if unknown:
    raise SystemExit(f"引用了不存在的 backlog_id: {sorted(unknown)}")

for issue in review["issues"]:
    related = issue["related_backlog_id"]
    if issue["delivery_blocking"]:
        if related is not None:
            removed = active.pop(related)
            key_to_id.pop(normalized_key(removed), None)
        continue

    item = {
        "backlog_id": related,
        "severity": issue["severity"],
        "origin": issue["origin"],
        "confidence": issue["confidence"],
        "evidence_kind": issue["evidence_kind"],
        "description": issue["description"],
        "evidence": issue["evidence"],
        "current_state_reachable": issue["current_state_reachable"],
        "reproduction": issue["reproduction"],
        "location": issue["location"],
        "reason_non_blocking": issue["non_blocking_reason"],
    }
    key = normalized_key(item)
    if related is None:
        related = key_to_id.get(key)
    if related is None:
        digest = hashlib.sha256("\0".join(key).encode("utf-8")).hexdigest()[:12]
        candidate = f"backlog-{digest}"
        suffix = 1
        while candidate in active and normalized_key(active[candidate]) != key:
            candidate = f"backlog-{digest}-{suffix}"
            suffix += 1
        related = candidate
    item["backlog_id"] = related
    previous = active.get(related)
    if previous is not None:
        key_to_id.pop(normalized_key(previous), None)
    active[related] = item
    key_to_id[key] = related

result = {"items": sorted(active.values(), key=lambda item: item["backlog_id"])}
path = pathlib.Path(backlog_path)
with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as fh:
    json.dump(result, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
    temp_path = fh.name
os.replace(temp_path, path)
PY
}

apply_consensus_changes() {
  local phase="$1"
  local review_json="$2"
  local latest_review="$3"
  local latest_response="$4"
  local ledger_path="$5"

  python3 - "${phase}" "${review_json}" "${latest_review}" "${latest_response}" "${ledger_path}" <<'PY'
import json
import os
import pathlib
import re
import sys
import tempfile

phase, review_path, latest_review_path, response_path, ledger_path = sys.argv[1:6]

with open(review_path, "r", encoding="utf-8") as fh:
    review = json.load(fh)
with open(ledger_path, "r", encoding="utf-8") as fh:
    ledger = json.load(fh)

active = {item["consensus_id"]: item for item in ledger["exclusions"]}
reopened_ids = {
    issue["reopens_consensus_id"]
    for issue in review["issues"]
    if issue["reopens_consensus_id"] is not None
}
unknown_reopens = reopened_ids - set(active)
if unknown_reopens:
    raise SystemExit(f"引用了不存在的 consensus_id: {sorted(unknown_reopens)}")
for consensus_id in reopened_ids:
    del active[consensus_id]

new_exclusions = review["new_consensus_exclusions"]
if phase == "blind":
    if new_exclusions:
        raise SystemExit("独立盲审不得创建 new_consensus_exclusions")
elif phase == "followup":
    with open(latest_review_path, "r", encoding="utf-8") as fh:
        latest_review = json.load(fh)
    with open(response_path, "r", encoding="utf-8") as fh:
        response = fh.read()

    block_pattern = re.compile(
        r"^\s*\d+\.\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s*$"
        r"(.*?)(?=^\s*\d+\.\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s*$|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    decision_pattern = re.compile(r"^\s*-\s+decision:\s*(.*?)\s*$", re.MULTILINE)
    decisions = {}
    for match in block_pattern.finditer(response):
        decision_match = decision_pattern.search(match.group(2))
        if decision_match:
            decisions[match.group(1)] = decision_match.group(1).strip()

    latest_issue_ids = {
        issue["id"]
        for issue in latest_review["issues"]
        if issue["delivery_blocking"] is True
    }
    output_issue_ids = {issue["id"] for issue in review["issues"]}
    for item in new_exclusions:
        source_id = item["source_issue_id"]
        if source_id not in latest_issue_ids:
            raise SystemExit(f"共识排除项引用了非最新 review issue: {source_id}")
        if decisions.get(source_id) not in {"questioned", "rejected"}:
            raise SystemExit(f"只有 questioned/rejected 才能成为共识排除项: {source_id}")
        if source_id in output_issue_ids:
            raise SystemExit(f"同一 issue 不能既保持未解决又成为共识排除项: {source_id}")
        consensus_id = item["consensus_id"]
        if consensus_id in active and active[consensus_id] != item:
            raise SystemExit(f"consensus_id 与现有条目冲突: {consensus_id}")
        active[consensus_id] = item
else:
    raise SystemExit(f"未知 consensus phase: {phase}")

result = {"exclusions": list(active.values())}
ledger = pathlib.Path(ledger_path)
with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=ledger.parent, delete=False) as fh:
    json.dump(result, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
    temp_path = fh.name
os.replace(temp_path, ledger)
PY
}

cleanup_audit_artifacts() {
  local plans_dir="$1"
  local audit_round="$2"

  python3 - "${plans_dir}" "${audit_round}" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
audit_round = int(sys.argv[2])
exact_names = {
    f"artifact-r{audit_round}.md",
    f"blind-review-r{audit_round}.md",
}
iteration_pattern = re.compile(
    rf"^(response|revision|review)-r{audit_round}-i[1-9][0-9]*\.md$"
)

removed = []
for entry in root.iterdir():
    if entry.name in exact_names or iteration_pattern.fullmatch(entry.name):
        if entry.is_file() or entry.is_symlink():
            entry.unlink()
            removed.append(entry.name)

print(f"[reviewer] cleaned blind audit {audit_round} artifacts: {len(removed)}")
PY
}

ensure_workflow_state() {
  local state_path="$1"
  local topic="$2"
  local artifact_type="$3"
  local baseline="$4"
  local max_blind_audits="$5"
  local audit_round="$6"

  python3 - "${state_path}" "${topic}" "${artifact_type}" "${baseline}" "${max_blind_audits}" "${audit_round}" "${SESSION_ROLLOVER_ROUNDS}" "${GOAL_MODE_MAX_BLIND_AUDITS}" <<'PY'
import json
import os
import pathlib
import sys
import tempfile

state_path, topic, artifact_type, baseline, max_blind_audits, audit_round_raw, rollover_raw, goal_max_raw = sys.argv[1:9]
audit_round = int(audit_round_raw)
rollover_every = int(rollover_raw)
goal_max = int(goal_max_raw)
goal_label = f"{goal_max} (goal-mode)"
path = pathlib.Path(state_path)

if path.exists():
    with path.open("r", encoding="utf-8") as fh:
        state = json.load(fh)
    migrated = False
    if state.get("version") in {1, 2}:
        state["version"] = 3
        state["required_qualifying_blind_audits"] = 1
        state["consecutive_qualifying_blind_audits"] = 0
        migrated = True
    if state.get("max_blind_audits") == "unlimited (goal-mode)" and max_blind_audits == goal_label:
        state["max_blind_audits"] = goal_label
        migrated = True
    if state.get("version") != 3:
        raise SystemExit("不支持的 workflow state version")
    if state.get("required_qualifying_blind_audits") != 1:
        state["required_qualifying_blind_audits"] = 1
        state["consecutive_qualifying_blind_audits"] = 0
        migrated = True
    expected = {
        "topic_slug": topic,
        "artifact_type": artifact_type,
        "git_baseline": baseline,
        "max_blind_audits": max_blind_audits,
        "rollover_every": rollover_every,
    }
    for key, value in expected.items():
        if state.get(key) != value:
            raise SystemExit(f"workflow state 与当前参数不一致: {key}")
    if state.get("status") == "handoff_required":
        raise SystemExit("当前会话已达到 10 轮上限；必须在新会话中 resume 后继续")
    if state.get("status") in {"complete", "human_judgment"}:
        raise SystemExit(f"workflow state 不允许继续: {state.get('status')}")
    if state.get("next_blind_audit") != audit_round:
        raise SystemExit(
            f"audit round 与 workflow state 不一致: expected={state.get('next_blind_audit')}, actual={audit_round}"
        )
    if migrated:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as fh:
            json.dump(state, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            temp_path = fh.name
        os.replace(temp_path, path)
    raise SystemExit(0)

completed = audit_round - 1
state = {
    "version": 3,
    "topic_slug": topic,
    "artifact_type": artifact_type,
    "git_baseline": baseline,
    "max_blind_audits": max_blind_audits,
    "rollover_every": rollover_every,
    "required_qualifying_blind_audits": 1,
    "consecutive_qualifying_blind_audits": 0,
    "completed_blind_audits": completed,
    "next_blind_audit": audit_round,
    "session_segment": completed // rollover_every + 1,
    "completed_in_current_session": completed % rollover_every,
    "status": "running",
}
path.parent.mkdir(parents=True, exist_ok=True)
with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
    temp_path = fh.name
os.replace(temp_path, path)
PY
}

complete_workflow_audit() {
  local state_path="$1"
  local audit_round="$2"
  local qualifying_blind_audit="$3"
  local force_complete="$4"
  local plans_dir="$5"

  python3 - "${state_path}" "${audit_round}" "${qualifying_blind_audit}" "${force_complete}" "${plans_dir}" <<'PY'
import json
import os
import pathlib
import sys
import tempfile

state_path, audit_round_raw, qualifying_raw, force_complete_raw, plans_dir = sys.argv[1:6]
audit_round = int(audit_round_raw)
qualifying_blind_audit = qualifying_raw == "true"
force_complete = force_complete_raw == "true"
path = pathlib.Path(state_path)
with path.open("r", encoding="utf-8") as fh:
    state = json.load(fh)

if state["status"] != "running" or state["next_blind_audit"] != audit_round:
    raise SystemExit("workflow state 无法完成当前 audit")

state["completed_blind_audits"] += 1
state["next_blind_audit"] = audit_round + 1
state["completed_in_current_session"] += 1
if qualifying_blind_audit:
    state["consecutive_qualifying_blind_audits"] = min(
        state["consecutive_qualifying_blind_audits"] + 1,
        state["required_qualifying_blind_audits"],
    )
else:
    state["consecutive_qualifying_blind_audits"] = 0

stable = (
    state["consecutive_qualifying_blind_audits"]
    >= state["required_qualifying_blind_audits"]
)
continue_workflow = not force_complete and not stable

if continue_workflow and state["completed_in_current_session"] >= state["rollover_every"]:
    state["status"] = "handoff_required"
    handoff = pathlib.Path(plans_dir) / "session-handoff.md"
    handoff.write_text(
        "# Reviewer Session Handoff\n\n"
        f"- topic: {state['topic_slug']}\n"
        f"- completed-blind-audits: {state['completed_blind_audits']}\n"
        f"- next-blind-audit: {state['next_blind_audit']}\n"
        f"- consecutive-qualifying-blind-audits: {state['consecutive_qualifying_blind_audits']}\n"
        f"- completed-session-segment: {state['session_segment']}\n"
        f"- workflow-state: {path.name}\n"
        "- brief: brief.md\n"
        "- consensus-exclusions: consensus-exclusions.json\n\n"
        "- review-backlog: review-backlog.json\n\n"
        "在全新会话中读取上述持久文件，执行 resume，然后从 next-blind-audit 继续。"
        "不要复制或依赖旧会话聊天历史。\n",
        encoding="utf-8",
    )
elif continue_workflow:
    state["status"] = "running"
else:
    state["status"] = "complete"

with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
    temp_path = fh.name
os.replace(temp_path, path)
print(state["status"])
PY
}

reset_qualifying_blind_audits() {
  local state_path="$1"

  python3 - "${state_path}" <<'PY'
import json
import os
import pathlib
import sys
import tempfile

path = pathlib.Path(sys.argv[1])
with path.open("r", encoding="utf-8") as fh:
    state = json.load(fh)
if state["status"] != "running":
    raise SystemExit("workflow state 当前不能重置 qualifying streak")
state["consecutive_qualifying_blind_audits"] = 0
with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
    temp_path = fh.name
os.replace(temp_path, path)
PY
}

mark_workflow_human_judgment() {
  local state_path="$1"

  python3 - "${state_path}" <<'PY'
import json
import os
import pathlib
import sys
import tempfile

path = pathlib.Path(sys.argv[1])
with path.open("r", encoding="utf-8") as fh:
    state = json.load(fh)
state["status"] = "human_judgment"
with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
    temp_path = fh.name
os.replace(temp_path, path)
PY
}

resume_workflow_session() {
  local state_path="$1"
  local handoff_path="$2"

  python3 - "${state_path}" "${handoff_path}" "${GOAL_MODE_MAX_BLIND_AUDITS}" <<'PY'
import json
import os
import pathlib
import sys
import tempfile

state_path, handoff_path, goal_max_raw = sys.argv[1:4]
goal_max = int(goal_max_raw)
goal_label = f"{goal_max} (goal-mode)"
path = pathlib.Path(state_path)
with path.open("r", encoding="utf-8") as fh:
    state = json.load(fh)
if state.get("version") in {1, 2}:
    state["version"] = 3
    state["required_qualifying_blind_audits"] = 1
    state["consecutive_qualifying_blind_audits"] = min(
        state.get("consecutive_qualifying_blind_audits", 0), 1
    )
if state.get("max_blind_audits") == "unlimited (goal-mode)":
    state["max_blind_audits"] = goal_label
if state.get("version") != 3:
    raise SystemExit("不支持的 workflow state version")

stop_reason = None
if state.get("consecutive_qualifying_blind_audits", 0) >= 1:
    stop_reason = "stable-convergence"
elif state.get("max_blind_audits") == goal_label and state.get("completed_blind_audits", 0) >= goal_max:
    stop_reason = "review-budget-completed"

if stop_reason is not None:
    state["status"] = "complete"
    final_path = path.parent / "final.md"
    if not final_path.exists():
        final_path.write_text(
            "# 审查完成\n\n"
            f"- topic: {state['topic_slug']}\n"
            f"- blind-audits-started: {state['completed_blind_audits']}\n"
            f"- stop-reason: {stop_reason}\n"
            "- review-summary: 迁移到新收敛策略后已满足停止条件；真实制品保留在当前工作区。\n",
            encoding="utf-8",
        )
else:
    if state["status"] != "handoff_required":
        raise SystemExit("workflow state 当前不需要 session resume")
    state["session_segment"] += 1
    state["completed_in_current_session"] = 0
    state["status"] = "running"
with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
    temp_path = fh.name
os.replace(temp_path, path)
handoff = pathlib.Path(handoff_path)
if handoff.exists():
    handoff.unlink()
if stop_reason is not None:
    print(f"[reviewer] workflow completed during migration: {stop_reason}")
else:
    print(
        f"[reviewer] resumed session segment {state['session_segment']}; "
        f"next blind audit: {state['next_blind_audit']}"
    )
PY
}

append_untracked_to_index() {
  local -a untracked=()
  local path

  while IFS= read -r path; do
    case "${path}" in
      .codex/plans/*|.claude/plans/*)
        continue
        ;;
    esac
    untracked+=("${path}")
  done < <(git ls-files --others --exclude-standard)

  if [[ ${#untracked[@]} -gt 0 ]]; then
    git add -N -- "${untracked[@]}"
  fi
}

write_brief() {
  local brief_path="$1"
  local topic="$2"
  local task="$3"
  local artifact_type="$4"
  local max_blind_audits="$5"
  local baseline="$6"

  cat > "${brief_path}" <<EOF
# Reviewer Brief

- topic-slug: ${topic}
- artifact-type: ${artifact_type}
- max-blind-audits: ${max_blind_audits}
- execution-mode: independent-blind-audit-loop
- codex-bin: ${CODEX_BIN}
- codex-review-model: ${CODEX_REVIEW_MODEL}
- launcher: ${SKILL_DIR}/bin/reviewer-run.sh
- git-baseline: ${baseline}

## 原始任务

${task}
EOF
}

ensure_brief() {
  local brief_path="$1"
  shift

  if [[ ! -f "${brief_path}" ]]; then
    write_brief "${brief_path}" "$@"
  fi
}

write_final_md() {
  local latest_artifact="$1"
  local final_path="$2"
  local topic="$3"
  local review_json="$4"
  local audit_round="$5"
  local artifact_type="$6"
  local stop_reason="$7"

  local summary
  summary="$(json_get "${review_json}" "summary")"

  {
    printf '# 审查完成\n\n'
    printf -- '- topic: %s\n' "${topic}"
    printf -- '- artifact-type: %s\n' "${artifact_type}"
    printf -- '- blind-audits-started: %s\n' "${audit_round}"
    printf -- '- stop-reason: %s\n' "${stop_reason}"
    printf -- '- review-summary: %s\n\n' "${summary}"
    cat "${latest_artifact}"
  } > "${final_path}"
}

build_blind_review_prompt() {
  local task="$1"
  local artifact_type="$2"
  local baseline="$3"
  local artifact_path="$4"
  local consensus_exclusions_path="$5"
  local review_backlog_path="$6"

  python3 - \
    "${PROMPTS_DIR}/codex-blind-review-request.md" \
    "$task" \
    "$artifact_type" \
    "$baseline" \
    "$artifact_path" \
    "$consensus_exclusions_path" \
    "$review_backlog_path" <<'PY'
import pathlib
import sys

template_path, task, artifact_type, baseline, artifact_path, consensus_path, backlog_path = sys.argv[1:8]
content = pathlib.Path(template_path).read_text(encoding="utf-8")
replacements = {
    "{{USER_TASK}}": task,
    "{{ARTIFACT_TYPE}}": artifact_type,
    "{{GIT_BASELINE}}": baseline,
    "{{BASELINE_ARTIFACT}}": pathlib.Path(artifact_path).read_text(encoding="utf-8"),
    "{{CONSENSUS_EXCLUSIONS}}": pathlib.Path(consensus_path).read_text(encoding="utf-8"),
    "{{REVIEW_BACKLOG}}": pathlib.Path(backlog_path).read_text(encoding="utf-8"),
}
for key, value in replacements.items():
    content = content.replace(key, value)
print(content, end="")
PY
}

build_followup_review_prompt() {
  local task="$1"
  local artifact_type="$2"
  local audit_round="$3"
  local inner_iteration="$4"
  local max_blind_audits="$5"
  local artifact_path="$6"
  local review_path="$7"
  local response_path="$8"
  local consensus_exclusions_path="$9"
  local review_backlog_path="${10}"

  python3 - \
    "${PROMPTS_DIR}/codex-review-request.md" \
    "$task" \
    "$artifact_type" \
    "$audit_round" \
    "$inner_iteration" \
    "$max_blind_audits" \
    "$artifact_path" \
    "$review_path" \
    "$response_path" \
    "$consensus_exclusions_path" \
    "$review_backlog_path" <<'PY'
import pathlib
import sys

(
    template_path,
    task,
    artifact_type,
    audit_round,
    inner_iteration,
    max_blind_audits,
    artifact_path,
    review_path,
    response_path,
    consensus_path,
    backlog_path,
) = sys.argv[1:12]

content = pathlib.Path(template_path).read_text(encoding="utf-8")
replacements = {
    "{{USER_TASK}}": task,
    "{{ARTIFACT_TYPE}}": artifact_type,
    "{{AUDIT_ROUND}}": audit_round,
    "{{INNER_ITERATION}}": inner_iteration,
    "{{MAX_BLIND_AUDITS}}": max_blind_audits,
    "{{CURRENT_ARTIFACT}}": pathlib.Path(artifact_path).read_text(encoding="utf-8"),
    "{{LATEST_REVIEW}}": pathlib.Path(review_path).read_text(encoding="utf-8"),
    "{{LATEST_AGENT_RESPONSE}}": pathlib.Path(response_path).read_text(encoding="utf-8"),
    "{{CONSENSUS_EXCLUSIONS}}": pathlib.Path(consensus_path).read_text(encoding="utf-8"),
    "{{REVIEW_BACKLOG}}": pathlib.Path(backlog_path).read_text(encoding="utf-8"),
}
for key, value in replacements.items():
    content = content.replace(key, value)
print(content, end="")
PY
}

build_dispute_prompt() {
  local task="$1"
  local artifact_type="$2"
  local topic="$3"
  local audit_round="$4"
  local inner_iteration="$5"
  local max_blind_audits="$6"
  local latest_artifact="$7"
  local latest_review="$8"
  local latest_response="$9"

  python3 - \
    "${PROMPTS_DIR}/dispute-report.md" \
    "$task" \
    "$artifact_type" \
    "$topic" \
    "$audit_round" \
    "$inner_iteration" \
    "$max_blind_audits" \
    "$latest_artifact" \
    "$latest_review" \
    "$latest_response" <<'PY'
import pathlib
import sys

(
    template_path,
    task,
    artifact_type,
    topic,
    audit_round,
    inner_iteration,
    max_blind_audits,
    latest_artifact,
    latest_review,
    latest_response,
) = sys.argv[1:11]

def read_or_none(path: str) -> str:
    if not path or path == "none":
        return "none"
    return pathlib.Path(path).read_text(encoding="utf-8")

content = pathlib.Path(template_path).read_text(encoding="utf-8")
replacements = {
    "{{USER_TASK}}": task,
    "{{ARTIFACT_TYPE}}": artifact_type,
    "{{TOPIC_SLUG}}": topic,
    "{{AUDIT_ROUND}}": audit_round,
    "{{INNER_ITERATION}}": inner_iteration,
    "{{MAX_BLIND_AUDITS}}": max_blind_audits,
    "{{LATEST_ARTIFACT}}": read_or_none(latest_artifact),
    "{{LATEST_REVIEW}}": read_or_none(latest_review),
    "{{LATEST_AGENT_RESPONSE}}": read_or_none(latest_response),
}
for key, value in replacements.items():
    content = content.replace(key, value)
print(content, end="")
PY
}

run_codex_review_json() {
  local prompt_builder="$1"
  local output_json="$2"
  shift 2

  local args
  args=("${CODEX_BIN}" exec -C "${PWD}" -s read-only --output-schema "${SCHEMAS_DIR}/codex-review.schema.json" -o "${output_json}" --color never -)
  if [[ -n "${CODEX_REVIEW_MODEL}" ]]; then args=("${args[@]:0:${#args[@]}-1}" -m "${CODEX_REVIEW_MODEL}" -); fi
  "${prompt_builder}" "$@" | "${args[@]}"
}

run_codex_markdown() {
  local prompt_builder="$1"
  local output_path="$2"
  shift 2

  local args
  args=("${CODEX_BIN}" exec -C "${PWD}" -s read-only -o "${output_path}" --color never -)
  if [[ -n "${CODEX_REVIEW_MODEL}" ]]; then args=("${args[@]:0:${#args[@]}-1}" -m "${CODEX_REVIEW_MODEL}" -); fi
  "${prompt_builder}" "$@" | "${args[@]}"
}

validate_common() {
  local artifact_type="$1"
  local max_blind_audits="$2"
  local audit_round="$3"

  [[ "${artifact_type}" == "code" || "${artifact_type}" == "doc" ]] || fail "--artifact-type 只能是 code 或 doc"
  max_blind_audit_limit "${max_blind_audits}" >/dev/null || fail "--max-blind-audits 必须是正整数或 ${GOAL_MODE_MAX_LABEL}"
  if [[ "${max_blind_audits}" =~ ^[0-9]+$ ]]; then
    (( max_blind_audits >= 1 )) || fail "--max-blind-audits 必须大于等于 1"
  fi
  [[ "${audit_round}" =~ ^[0-9]+$ ]] || fail "--audit-round 必须是正整数"
  (( audit_round >= 1 )) || fail "--audit-round 必须大于等于 1"
  local max_limit
  max_limit="$(max_blind_audit_limit "${max_blind_audits}")"
  if [[ -n "${max_limit}" ]]; then
    (( audit_round <= max_limit )) || fail "--audit-round 不能超过 --max-blind-audits"
  fi
}

run_blind() {
  local task="$1"
  local artifact_type="$2"
  local topic="$3"
  local audit_round="$4"
  local max_blind_audits="$5"
  local baseline="$6"
  local artifact_path="$7"
  local consensus_exclusions_path="$8"
  local review_backlog_path="$9"
  local plans_dir="${10}"

  validate_common "${artifact_type}" "${max_blind_audits}" "${audit_round}"
  [[ -f "${artifact_path}" ]] || fail "artifact 文件不存在: ${artifact_path}"
  mkdir -p "${plans_dir}"
  ensure_brief "${plans_dir}/brief.md" "${topic}" "${task}" "${artifact_type}" "${max_blind_audits}" "${baseline}"
  ensure_consensus_exclusions "${consensus_exclusions_path}"
  validate_consensus_exclusions "${consensus_exclusions_path}"
  ensure_review_backlog "${review_backlog_path}"
  validate_review_backlog "${review_backlog_path}"
  local workflow_state_path="${plans_dir}/workflow-state.json"
  ensure_workflow_state "${workflow_state_path}" "${topic}" "${artifact_type}" "${baseline}" "${max_blind_audits}" "${audit_round}"

  local review_path="${plans_dir}/blind-review-r${audit_round}.md"
  echo "[reviewer] blind audit ${audit_round}: independent Codex review"
  run_codex_review_json build_blind_review_prompt "${review_path}" "${task}" "${artifact_type}" "${baseline}" "${artifact_path}" "${consensus_exclusions_path}" "${review_backlog_path}"
  validate_review_contract "${review_path}" "${artifact_type}"
  validate_review_backlog_references "${review_path}" "${review_backlog_path}"
  apply_consensus_changes blind "${review_path}" none none "${consensus_exclusions_path}"
  apply_review_backlog_changes "${review_path}" "${review_backlog_path}"

  local status next_action
  status="$(json_get "${review_path}" "status")"
  next_action="$(json_get "${review_path}" "next_action")"
  if [[ "${status}" == "pass" && "${next_action}" == "approve" ]]; then
    local force_complete=false
    local max_limit
    max_limit="$(max_blind_audit_limit "${max_blind_audits}")"
    if [[ -n "${max_limit}" ]] && (( audit_round == max_limit )); then
      force_complete=true
    fi
    local workflow_status
    workflow_status="$(complete_workflow_audit "${workflow_state_path}" "${audit_round}" true "${force_complete}" "${plans_dir}")"
    if [[ "${workflow_status}" == "complete" ]]; then
      local stop_reason="stable-convergence"
      if [[ "${force_complete}" == "true" ]] && is_goal_mode_max "${max_blind_audits}"; then
        stop_reason="review-budget-completed"
      elif [[ "${force_complete}" == "true" ]] && (( $(json_get "${workflow_state_path}" "consecutive_qualifying_blind_audits") < 1 )); then
        stop_reason="max-blind-audits-completed"
      fi
      write_final_md "${artifact_path}" "${plans_dir}/final.md" "${topic}" "${review_path}" "${audit_round}" "${artifact_type}" "${stop_reason}"
      cleanup_audit_artifacts "${plans_dir}" "${audit_round}"
      echo "[reviewer] workflow completed: ${stop_reason}"
    else
      cleanup_audit_artifacts "${plans_dir}" "${audit_round}"
      if [[ "${workflow_status}" == "handoff_required" ]]; then
        echo "[reviewer] qualifying blind audit completed; session rollover required before audit $((audit_round + 1))"
      else
        echo "[reviewer] qualifying blind audit completed; continue only if the persisted policy requires another audit"
      fi
    fi
  elif [[ "${next_action}" == "human_judgment" ]]; then
    reset_qualifying_blind_audits "${workflow_state_path}"
    mark_workflow_human_judgment "${workflow_state_path}"
    echo "[reviewer] blind audit requires human judgment"
  else
    reset_qualifying_blind_audits "${workflow_state_path}"
    echo "[reviewer] blind audit found delivery blockers: enter inner convergence"
  fi
}

run_followup() {
  local task="$1"
  local artifact_type="$2"
  local topic="$3"
  local audit_round="$4"
  local inner_iteration="$5"
  local max_blind_audits="$6"
  local baseline="$7"
  local artifact_path="$8"
  local latest_review="$9"
  local latest_response="${10}"
  local consensus_exclusions_path="${11}"
  local review_backlog_path="${12}"
  local plans_dir="${13}"

  validate_common "${artifact_type}" "${max_blind_audits}" "${audit_round}"
  [[ "${inner_iteration}" =~ ^[0-9]+$ ]] || fail "--inner-iteration 必须是正整数"
  (( inner_iteration >= 1 )) || fail "--inner-iteration 必须大于等于 1"
  [[ -f "${artifact_path}" ]] || fail "artifact 文件不存在: ${artifact_path}"
  validate_response_coverage "${latest_review}" "${latest_response}"
  mkdir -p "${plans_dir}"
  ensure_brief "${plans_dir}/brief.md" "${topic}" "${task}" "${artifact_type}" "${max_blind_audits}" "${baseline}"
  ensure_consensus_exclusions "${consensus_exclusions_path}"
  validate_consensus_exclusions "${consensus_exclusions_path}"
  ensure_review_backlog "${review_backlog_path}"
  validate_review_backlog "${review_backlog_path}"
  local workflow_state_path="${plans_dir}/workflow-state.json"
  ensure_workflow_state "${workflow_state_path}" "${topic}" "${artifact_type}" "${baseline}" "${max_blind_audits}" "${audit_round}"

  local review_path="${plans_dir}/review-r${audit_round}-i${inner_iteration}.md"
  echo "[reviewer] blind audit ${audit_round}, inner iteration ${inner_iteration}: follow-up review"
  run_codex_review_json build_followup_review_prompt "${review_path}" "${task}" "${artifact_type}" "${audit_round}" "${inner_iteration}" "${max_blind_audits}" "${artifact_path}" "${latest_review}" "${latest_response}" "${consensus_exclusions_path}" "${review_backlog_path}"
  validate_review_contract "${review_path}" "${artifact_type}"
  validate_review_backlog_references "${review_path}" "${review_backlog_path}"
  apply_consensus_changes followup "${review_path}" "${latest_review}" "${latest_response}" "${consensus_exclusions_path}"
  apply_review_backlog_changes "${review_path}" "${review_backlog_path}"

  local status next_action
  status="$(json_get "${review_path}" "status")"
  next_action="$(json_get "${review_path}" "next_action")"
  if [[ "${status}" == "pass" && "${next_action}" == "approve" ]]; then
    local force_complete=false
    local max_limit
    max_limit="$(max_blind_audit_limit "${max_blind_audits}")"
    if [[ -n "${max_limit}" ]] && (( audit_round == max_limit )); then
      force_complete=true
    fi
    local workflow_status
    workflow_status="$(complete_workflow_audit "${workflow_state_path}" "${audit_round}" false "${force_complete}" "${plans_dir}")"
    if [[ "${workflow_status}" == "complete" ]]; then
      local stop_reason="max-blind-audits-completed"
      if is_goal_mode_max "${max_blind_audits}"; then
        stop_reason="review-budget-completed"
      fi
      write_final_md "${artifact_path}" "${plans_dir}/final.md" "${topic}" "${review_path}" "${audit_round}" "${artifact_type}" "${stop_reason}"
      cleanup_audit_artifacts "${plans_dir}" "${audit_round}"
      echo "[reviewer] workflow completed: ${stop_reason} after inner convergence"
    else
      cleanup_audit_artifacts "${plans_dir}" "${audit_round}"
      if [[ "${workflow_status}" == "handoff_required" ]]; then
        echo "[reviewer] session rollover required before blind audit $((audit_round + 1))"
      else
        echo "[reviewer] blind audit ${audit_round} inner convergence completed; start the next independent blind audit"
      fi
    fi
  elif [[ "${next_action}" == "human_judgment" ]]; then
    reset_qualifying_blind_audits "${workflow_state_path}"
    mark_workflow_human_judgment "${workflow_state_path}"
    echo "[reviewer] inner convergence requires human judgment"
  else
    reset_qualifying_blind_audits "${workflow_state_path}"
    echo "[reviewer] inner convergence still has issues"
  fi
}

run_dispute() {
  local task="$1"
  local artifact_type="$2"
  local topic="$3"
  local audit_round="$4"
  local inner_iteration="$5"
  local max_blind_audits="$6"
  local latest_artifact="$7"
  local latest_review="$8"
  local latest_response="$9"
  local plans_dir="${10}"

  validate_common "${artifact_type}" "${max_blind_audits}" "${audit_round}"
  [[ -f "${latest_artifact}" ]] || fail "latest artifact 文件不存在: ${latest_artifact}"
  [[ -f "${latest_review}" ]] || fail "latest review 文件不存在: ${latest_review}"
  mkdir -p "${plans_dir}"

  echo "[reviewer] generating inner-convergence dispute report"
  run_codex_markdown build_dispute_prompt "${plans_dir}/dispute-report.md" "${task}" "${artifact_type}" "${topic}" "${audit_round}" "${inner_iteration}" "${max_blind_audits}" "${latest_artifact}" "${latest_review}" "${latest_response}"
}

main() {
  local subcommand="${1-}"
  local task=""
  local artifact_type=""
  local topic=""
  local audit_round=""
  local inner_iteration=""
  local max_blind_audits="10"
  local baseline="n/a"
  local artifact_path=""
  local latest_review=""
  local latest_response="none"
  local latest_artifact=""
  local consensus_exclusions_path=""
  local review_backlog_path=""
  local plans_dir=""
  local workdir="${EBISU_PROJECT_ROOT:?缺少项目目录}"

  case "${subcommand}" in
    blind|followup|dispute|resume)
      shift
      ;;
    *)
      usage
      exit 1
      ;;
  esac

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --task) task="${2-}"; shift 2 ;;
      --artifact-type) artifact_type="${2-}"; shift 2 ;;
      --topic) topic="${2-}"; shift 2 ;;
      --audit-round) audit_round="${2-}"; shift 2 ;;
      --inner-iteration) inner_iteration="${2-}"; shift 2 ;;
      --max-blind-audits) max_blind_audits="${2-}"; shift 2 ;;
      --baseline) baseline="${2-}"; shift 2 ;;
      --artifact) artifact_path="${2-}"; shift 2 ;;
      --latest-review) latest_review="${2-}"; shift 2 ;;
      --latest-response) latest_response="${2-}"; shift 2 ;;
      --latest-artifact) latest_artifact="${2-}"; shift 2 ;;
      --consensus-exclusions) consensus_exclusions_path="${2-}"; shift 2 ;;
      --review-backlog) review_backlog_path="${2-}"; shift 2 ;;
      --plans-dir) plans_dir="${2-}"; shift 2 ;;
      --workdir) workdir="${2-}"; shift 2 ;;
      *) fail "未知参数: $1" ;;
    esac
  done

  [[ -n "${topic}" ]] || fail "必须提供 --topic"

  if [[ -n "${workdir}" ]]; then
    cd "${workdir}"
  fi
  if [[ -z "${plans_dir}" ]]; then
    plans_dir="${PLANS_ROOT_NAME}/plans/${topic}"
  fi
  if [[ -z "${consensus_exclusions_path}" ]]; then
    consensus_exclusions_path="${plans_dir}/consensus-exclusions.json"
  fi
  if [[ -z "${review_backlog_path}" ]]; then
    review_backlog_path="${plans_dir}/review-backlog.json"
  fi

  require_cmd python3
  if [[ "${subcommand}" == "resume" ]]; then
    resume_workflow_session "${plans_dir}/workflow-state.json" "${plans_dir}/session-handoff.md"
    exit 0
  fi

  [[ -n "${task}" ]] || fail "必须提供 --task"
  [[ -n "${artifact_type}" ]] || fail "必须提供 --artifact-type"
  [[ -n "${audit_round}" ]] || fail "必须提供 --audit-round"

  require_cmd git
  require_cmd "${CODEX_BIN}"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "当前目录不是 git 仓库"
  if [[ "${artifact_type}" == "code" ]]; then
    append_untracked_to_index
  fi

  case "${subcommand}" in
    blind)
      [[ -n "${artifact_path}" ]] || fail "blind 必须提供 --artifact"
      run_blind "${task}" "${artifact_type}" "${topic}" "${audit_round}" "${max_blind_audits}" "${baseline}" "${artifact_path}" "${consensus_exclusions_path}" "${review_backlog_path}" "${plans_dir}"
      ;;
    followup)
      [[ -n "${inner_iteration}" ]] || fail "followup 必须提供 --inner-iteration"
      [[ -n "${artifact_path}" ]] || fail "followup 必须提供 --artifact"
      [[ -n "${latest_review}" ]] || fail "followup 必须提供 --latest-review"
      [[ "${latest_response}" != "none" ]] || fail "followup 必须提供 --latest-response"
      run_followup "${task}" "${artifact_type}" "${topic}" "${audit_round}" "${inner_iteration}" "${max_blind_audits}" "${baseline}" "${artifact_path}" "${latest_review}" "${latest_response}" "${consensus_exclusions_path}" "${review_backlog_path}" "${plans_dir}"
      ;;
    dispute)
      [[ -n "${inner_iteration}" ]] || fail "dispute 必须提供 --inner-iteration"
      [[ -n "${latest_artifact}" ]] || fail "dispute 必须提供 --latest-artifact"
      [[ -n "${latest_review}" ]] || fail "dispute 必须提供 --latest-review"
      run_dispute "${task}" "${artifact_type}" "${topic}" "${audit_round}" "${inner_iteration}" "${max_blind_audits}" "${latest_artifact}" "${latest_review}" "${latest_response}" "${plans_dir}"
      ;;
  esac
}

main "$@"
