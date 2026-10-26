#!/usr/bin/env python3

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def fail(message: str, exit_code: int = 1) -> None:
    print(f"错误: {message}", file=sys.stderr)
    raise SystemExit(exit_code)


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def csv_env(name: str, default: str) -> set[str]:
    raw = env(name, default)
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


APPROVED_STATES = csv_env(
    "PUSH_CODE_REVIEW_APPROVED_STATES",
    "approved,pass",
)
CHANGES_REQUESTED_STATES = csv_env(
    "PUSH_CODE_REVIEW_CHANGES_REQUESTED_STATES",
    "changes_requested,fail,blocked",
)
PENDING_STATES = csv_env(
    "PUSH_CODE_REVIEW_PENDING_STATES",
    "pending,running,queued,waiting",
)

PIPELINE_PENDING_STATUSES = {
    "created",
    "pending",
    "preparing",
    "running",
    "waiting_for_resource",
    "manual",
    "scheduled",
}
PIPELINE_FAILED_STATUSES = {
    "failed",
    "canceled",
    "canceling",
    "skipped",
}
STATUS_CHECK_PENDING_STATUSES = {
    "pending",
}
STATUS_CHECK_FAILED_STATUSES = {
    "failed",
}


def gitlab_base_url() -> str:
    raw = env("PUSH_CODE_GITLAB_BASE_URL")
    if not raw:
        fail("配置缺失: PUSH_CODE_GITLAB_BASE_URL")
    normalized = raw.rstrip("/")
    if normalized.endswith("/api/v4"):
        normalized = normalized[: -len("/api/v4")]
    return normalized


def gitlab_api_url(path: str) -> str:
    return f"{gitlab_base_url()}/api/v4{path}"


def project_ref(project_id: str) -> str:
    if not project_id:
        fail("缺少 project_id")
    return urllib.parse.quote(project_id, safe="")


def mr_ref(mr_id: str) -> str:
    if not mr_id:
        fail("缺少 mr_id")
    return urllib.parse.quote(str(mr_id), safe="")


def auth_headers() -> dict[str, str]:
    headers: dict[str, str] = {"Accept": "application/json"}
    token = env("PUSH_CODE_GITLAB_API_TOKEN", env("PUSH_CODE_WEBHOOK_AUTH_TOKEN"))
    if token:
        header_name = env(
            "PUSH_CODE_GITLAB_TOKEN_HEADER_NAME",
            env("PUSH_CODE_WEBHOOK_AUTH_HEADER_NAME", "PRIVATE-TOKEN"),
        )
        scheme = env(
            "PUSH_CODE_GITLAB_TOKEN_SCHEME",
            env("PUSH_CODE_WEBHOOK_AUTH_SCHEME", ""),
        ).strip()
        header_value = token if not scheme else f"{scheme} {token}"
        headers[header_name] = header_value

    extra_name = env(
        "PUSH_CODE_GITLAB_EXTRA_HEADER_NAME",
        env("PUSH_CODE_WEBHOOK_EXTRA_HEADER_NAME"),
    )
    extra_value = env(
        "PUSH_CODE_GITLAB_EXTRA_HEADER_VALUE",
        env("PUSH_CODE_WEBHOOK_EXTRA_HEADER_VALUE"),
    )
    if extra_name and extra_value:
        headers[extra_name] = extra_value
    return headers


def gitlab_ca_bundle() -> str:
    return env("PUSH_CODE_GITLAB_CA_BUNDLE", env("SSL_CERT_FILE", "")).strip()


def gitlab_skip_tls_verify() -> bool:
    return env("PUSH_CODE_GITLAB_SKIP_TLS_VERIFY", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def gitlab_http_client() -> str:
    return env("PUSH_CODE_GITLAB_HTTP_CLIENT", "auto").strip().lower()


def tls_hint_message() -> str:
    return (
        "如果当前环境的 Python 证书链不完整，请配置 PUSH_CODE_GITLAB_CA_BUNDLE，"
        "或把 PUSH_CODE_GITLAB_SKIP_TLS_VERIFY=true 作为临时兜底。"
    )


def build_ssl_context() -> ssl.SSLContext:
    ca_bundle = gitlab_ca_bundle()
    if gitlab_skip_tls_verify():
        return ssl._create_unverified_context()
    if ca_bundle:
        return ssl.create_default_context(cafile=ca_bundle)
    return ssl.create_default_context()


def request_json_via_curl(
    url: str,
    *,
    method: str,
    payload: dict[str, Any] | None = None,
    allow_statuses: set[int] | None = None,
) -> Any:
    curl_bin = shutil.which("curl")
    if not curl_bin:
        raise FileNotFoundError("curl not found")

    headers = auth_headers()
    command = [
        curl_bin,
        "--silent",
        "--show-error",
        "--location",
        "--max-time",
        "60",
        "--request",
        method,
        "--write-out",
        "\n__PUSH_CODE_HTTP_STATUS__:%{http_code}",
        url,
    ]
    for name, value in headers.items():
        command.extend(["--header", f"{name}: {value}"])
    if payload is not None:
        command.extend(["--header", "Content-Type: application/x-www-form-urlencoded"])
        command.extend(["--data", urllib.parse.urlencode(payload, doseq=True)])

    ca_bundle = gitlab_ca_bundle()
    if gitlab_skip_tls_verify():
        command.append("--insecure")
    elif ca_bundle:
        command.extend(["--cacert", ca_bundle])

    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"curl exit code {result.returncode}"
        if "certificate" in detail.lower() or "ssl" in detail.lower():
            detail = f"{detail}。{tls_hint_message()}"
        fail(f"GitLab API 请求失败(curl): {detail}")

    status_marker = "\n__PUSH_CODE_HTTP_STATUS__:"
    body, marker, status_text = result.stdout.rpartition(status_marker)
    if not marker:
        fail("GitLab API 响应缺少 HTTP 状态码")

    try:
        status_code = int(status_text.strip())
    except ValueError as exc:
        fail(f"GitLab API 返回了无法解析的 HTTP 状态码: {exc}")

    if allow_statuses and status_code in allow_statuses:
        return {"_http_error": status_code, "_body": body}
    if status_code >= 400:
        fail(f"GitLab API 返回 HTTP {status_code}: {body}", status_code)

    if not body:
        return {}
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        fail(f"GitLab API 返回了非 JSON 内容: {exc}")


def request_json_via_urllib(
    url: str,
    *,
    method: str,
    payload: dict[str, Any] | None = None,
    allow_statuses: set[int] | None = None,
) -> Any:
    data = None
    headers = auth_headers()
    if payload is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = urllib.parse.urlencode(payload, doseq=True).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=60, context=build_ssl_context()) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if allow_statuses and exc.code in allow_statuses:
            return {"_http_error": exc.code, "_body": body}
        fail(f"GitLab API 返回 HTTP {exc.code}: {body}", exc.code)
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, ssl.SSLError) or "CERTIFICATE_VERIFY_FAILED" in str(reason):
            fail(f"GitLab API TLS 校验失败: {reason}。{tls_hint_message()}")
        fail(f"GitLab API 请求失败: {exc}")

    if not body:
        return {}
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        fail(f"GitLab API 返回了非 JSON 内容: {exc}")


def request_json(
    path: str,
    *,
    method: str,
    payload: dict[str, Any] | None = None,
    allow_statuses: set[int] | None = None,
) -> Any:
    url = gitlab_api_url(path)
    client = gitlab_http_client()
    if client not in {"auto", "curl", "python"}:
        fail("PUSH_CODE_GITLAB_HTTP_CLIENT 只支持 auto、curl、python")

    if client in {"auto", "curl"}:
        try:
            return request_json_via_curl(
                url,
                method=method,
                payload=payload,
                allow_statuses=allow_statuses,
            )
        except FileNotFoundError:
            if client == "curl":
                fail("PUSH_CODE_GITLAB_HTTP_CLIENT=curl，但当前环境未找到 curl")

    return request_json_via_urllib(
        url,
        method=method,
        payload=payload,
        allow_statuses=allow_statuses,
    )


def print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def parse_mr_iid(payload: Any) -> Any:
    if not isinstance(payload, dict):
        fail("创建 MR 响应格式不正确")
    iid = payload.get("iid")
    if iid is None:
        fail("创建 MR 成功响应中缺少 iid")
    return iid


def parse_iso8601(raw: str | None) -> dt.datetime | None:
    if not raw:
        return None
    try:
        return dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def discussion_resolved(discussion: dict[str, Any]) -> bool:
    if "resolved" in discussion:
        return bool(discussion.get("resolved"))
    for note in discussion.get("notes", []):
        if note.get("resolvable") and not note.get("resolved", False):
            return False
    return True


def discussion_resolvable(discussion: dict[str, Any]) -> bool:
    if "resolvable" in discussion:
        return bool(discussion.get("resolvable"))
    return any(bool(note.get("resolvable")) for note in discussion.get("notes", []))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_review_note(note: dict[str, Any]) -> dict[str, Any]:
    body = str(note.get("body") or "")
    updated_at = note.get("updated_at")
    revision_payload = json.dumps(
        {
            "id": note.get("id"),
            "updated_at": updated_at or note.get("created_at"),
            "body_sha256": sha256_text(body),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return {
        "id": note.get("id"),
        "body": body,
        "body_sha256": sha256_text(body),
        "revision_key": sha256_text(revision_payload),
        "author": (note.get("author") or {}).get("username"),
        "created_at": note.get("created_at"),
        "updated_at": updated_at,
        "system": note.get("system", False),
        "internal": note.get("internal", False),
        "resolved": note.get("resolved"),
        "resolvable": note.get("resolvable"),
    }


def normalize_discussion(discussion: dict[str, Any]) -> dict[str, Any]:
    notes = discussion.get("notes", [])
    return {
        "id": discussion.get("id"),
        "individual_note": discussion.get("individual_note", False),
        "resolved": discussion_resolved(discussion),
        "resolvable": discussion_resolvable(discussion),
        "notes": [normalize_review_note(note) for note in notes if isinstance(note, dict)],
    }


def list_discussions(project_id: str, mr_id: str) -> list[dict[str, Any]]:
    path = f"/projects/{project_ref(project_id)}/merge_requests/{mr_ref(mr_id)}/discussions?per_page=100"
    payload = request_json(path, method="GET")
    if not isinstance(payload, list):
        fail("GitLab discussions 响应格式不正确")
    return [normalize_discussion(item) for item in payload if isinstance(item, dict)]


def normalize_note(note: dict[str, Any]) -> dict[str, Any]:
    return normalize_review_note(note)


def list_merge_request_notes(project_id: str, mr_id: str) -> list[dict[str, Any]]:
    path = (
        f"/projects/{project_ref(project_id)}/merge_requests/{mr_ref(mr_id)}/notes"
        "?sort=asc&order_by=created_at&per_page=100"
    )
    payload = request_json(path, method="GET")
    if not isinstance(payload, list):
        fail("GitLab merge request notes 响应格式不正确")
    return [normalize_note(item) for item in payload if isinstance(item, dict)]


def review_note_revision_entries(
    notes: list[dict[str, Any]],
    discussions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    revisions_by_note: dict[str, dict[str, Any]] = {}
    candidates = list(notes)
    for discussion in discussions:
        candidates.extend(
            note for note in discussion.get("notes", []) if isinstance(note, dict)
        )
    for note in candidates:
        if note.get("system", False):
            continue
        note_id = note.get("id")
        identity = str(note_id) if note_id is not None else str(note.get("revision_key") or "")
        entry = {
            "id": note_id,
            "author": note.get("author"),
            "created_at": note.get("created_at"),
            "updated_at": note.get("updated_at"),
            "body_sha256": note.get("body_sha256") or sha256_text(str(note.get("body") or "")),
            "revision_key": note.get("revision_key"),
        }
        previous = revisions_by_note.get(identity)
        if previous is None or (
            str(entry.get("updated_at") or entry.get("created_at") or ""),
            str(entry.get("revision_key") or ""),
        ) >= (
            str(previous.get("updated_at") or previous.get("created_at") or ""),
            str(previous.get("revision_key") or ""),
        ):
            revisions_by_note[identity] = entry
    return sorted(
        revisions_by_note.values(),
        key=lambda item: (str(item.get("id") or ""), str(item.get("revision_key") or "")),
    )


def review_notes_fingerprint(
    notes: list[dict[str, Any]],
    discussions: list[dict[str, Any]],
) -> str:
    payload = json.dumps(
        review_note_revision_entries(notes, discussions),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return sha256_text(payload)


def enrich_meta_with_notes(
    meta: dict[str, Any],
    notes: list[dict[str, Any]],
    discussions: list[dict[str, Any]],
) -> dict[str, Any]:
    next_meta = dict(meta)
    revision_entries = review_note_revision_entries(notes, discussions)
    non_system_notes = [note for note in notes if not note.get("system", False)]
    latest_non_system_note = non_system_notes[-1] if non_system_notes else None
    next_meta["notes_total"] = len(notes)
    next_meta["non_system_notes_total"] = len(non_system_notes)
    next_meta["latest_non_system_note_id"] = latest_non_system_note.get("id") if latest_non_system_note else None
    next_meta["latest_non_system_note_created_at"] = (
        latest_non_system_note.get("created_at") if latest_non_system_note else None
    )
    next_meta["latest_non_system_note_updated_at"] = (
        latest_non_system_note.get("updated_at") if latest_non_system_note else None
    )
    next_meta["latest_non_system_note_body_sha256"] = (
        latest_non_system_note.get("body_sha256") if latest_non_system_note else None
    )
    next_meta["latest_non_system_note_revision_key"] = (
        latest_non_system_note.get("revision_key") if latest_non_system_note else None
    )
    next_meta["latest_non_system_note_author"] = (
        latest_non_system_note.get("author") if latest_non_system_note else None
    )
    next_meta["review_note_revisions_total"] = len(revision_entries)
    next_meta["review_notes_fingerprint"] = sha256_text(
        json.dumps(
            revision_entries,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return next_meta


def normalize_status_check(status_check: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": status_check.get("id"),
        "name": status_check.get("name"),
        "external_url": status_check.get("external_url"),
        "status": str(status_check.get("status") or "").strip().lower(),
    }


def list_status_checks(project_id: str, mr_id: str) -> list[dict[str, Any]]:
    path = f"/projects/{project_ref(project_id)}/merge_requests/{mr_ref(mr_id)}/status_checks"
    payload = request_json(path, method="GET", allow_statuses={403, 404})
    if isinstance(payload, dict) and "_http_error" in payload:
        return []
    if not isinstance(payload, list):
        fail("GitLab status checks 响应格式不正确")
    return [normalize_status_check(item) for item in payload if isinstance(item, dict)]


def normalize_pipeline(pipeline: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": pipeline.get("id"),
        "iid": pipeline.get("iid"),
        "name": pipeline.get("name"),
        "sha": pipeline.get("sha"),
        "ref": pipeline.get("ref"),
        "source": pipeline.get("source"),
        "status": str(pipeline.get("status") or "").strip().lower(),
        "created_at": pipeline.get("created_at"),
        "updated_at": pipeline.get("updated_at"),
        "web_url": pipeline.get("web_url"),
    }


def list_merge_request_pipelines(project_id: str, mr_id: str) -> list[dict[str, Any]]:
    path = f"/projects/{project_ref(project_id)}/merge_requests/{mr_ref(mr_id)}/pipelines?per_page=100"
    payload = request_json(path, method="GET", allow_statuses={403, 404})
    if isinstance(payload, dict) and "_http_error" in payload:
        return []
    if not isinstance(payload, list):
        fail("GitLab merge request pipelines 响应格式不正确")
    return [normalize_pipeline(item) for item in payload if isinstance(item, dict)]


def get_merge_request(project_id: str, mr_id: str) -> dict[str, Any]:
    query = urllib.parse.urlencode(
        {
            "include_diverged_commits_count": "true",
            "include_rebase_in_progress": "true",
            "with_merge_status_recheck": "true",
        }
    )
    path = f"/projects/{project_ref(project_id)}/merge_requests/{mr_ref(mr_id)}?{query}"
    payload = request_json(path, method="GET")
    if not isinstance(payload, dict):
        fail("GitLab merge request 响应格式不正确")
    return payload


def get_project(project_id: str) -> dict[str, Any] | None:
    payload = request_json(f"/projects/{project_ref(project_id)}", method="GET", allow_statuses={403, 404})
    if isinstance(payload, dict) and "_http_error" in payload:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def get_approvals(project_id: str, mr_id: str) -> dict[str, Any] | None:
    path = f"/projects/{project_ref(project_id)}/merge_requests/{mr_ref(mr_id)}/approvals"
    payload = request_json(path, method="GET", allow_statuses={403, 404})
    if isinstance(payload, dict) and "_http_error" in payload:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def resolve_discussion(project_id: str, mr_id: str, thread_id: str, resolved: bool) -> dict[str, Any]:
    payload = request_json(
        f"/projects/{project_ref(project_id)}/merge_requests/{mr_ref(mr_id)}/discussions/{urllib.parse.quote(str(thread_id), safe='')}",
        method="PUT",
        payload={"resolved": "true" if resolved else "false"},
    )
    if not isinstance(payload, dict):
        fail("GitLab discussion resolve 响应格式不正确")
    return normalize_discussion(payload)


def review_grace_seconds() -> int:
    raw = env("PUSH_CODE_GITLAB_INITIAL_REVIEW_GRACE_SECONDS", "60")
    try:
        return max(int(raw), 0)
    except ValueError:
        return 60


def merge_request_head_sha(mr: dict[str, Any]) -> str:
    diff_refs = mr.get("diff_refs") if isinstance(mr.get("diff_refs"), dict) else {}
    return str(mr.get("sha") or diff_refs.get("head_sha") or "").strip()


def pipelines_for_current_head(
    mr: dict[str, Any],
    pipelines: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    head_sha = merge_request_head_sha(mr)
    head_pipeline = mr.get("head_pipeline") if isinstance(mr.get("head_pipeline"), dict) else {}
    normalized_head_pipeline = normalize_pipeline(head_pipeline) if head_pipeline else None
    head_pipeline_id = normalized_head_pipeline.get("id") if normalized_head_pipeline else None
    pipeline_head_sha = (
        str(normalized_head_pipeline.get("sha") or "").strip()
        if normalized_head_pipeline
        else ""
    )
    current_pipeline_shas = {value for value in {head_sha, pipeline_head_sha} if value}
    relevant_by_id: dict[str, dict[str, Any]] = {}

    for pipeline in pipelines:
        pipeline_sha = str(pipeline.get("sha") or "").strip()
        pipeline_id = pipeline.get("id")
        if (
            current_pipeline_shas
            and pipeline_sha not in current_pipeline_shas
            and pipeline_id != head_pipeline_id
        ):
            continue
        if not current_pipeline_shas and pipeline_id != head_pipeline_id:
            continue
        identity = str(pipeline_id) if pipeline_id is not None else json.dumps(
            [pipeline_sha, pipeline.get("source"), pipeline.get("ref"), pipeline.get("status")],
            ensure_ascii=False,
        )
        relevant_by_id[identity] = pipeline

    if normalized_head_pipeline:
        pipeline_sha = str(normalized_head_pipeline.get("sha") or head_sha).strip()
        normalized_head_pipeline["sha"] = pipeline_sha
        identity = (
            str(head_pipeline_id)
            if head_pipeline_id is not None
            else json.dumps(
                [pipeline_sha, "head_pipeline", normalized_head_pipeline.get("status")],
                ensure_ascii=False,
            )
        )
        relevant_by_id[identity] = normalized_head_pipeline

    return sorted(
        relevant_by_id.values(),
        key=lambda item: (int(item.get("id") or 0), str(item.get("status") or "")),
    )


def derive_structured_status(
    mr: dict[str, Any],
    project: dict[str, Any] | None,
    approvals: dict[str, Any] | None,
    status_checks: list[dict[str, Any]],
    pipelines: list[dict[str, Any]] | None = None,
) -> tuple[str, str, dict[str, Any]]:
    detailed_merge_status = str(
        mr.get("detailed_merge_status") or mr.get("merge_status") or ""
    ).strip()
    head_pipeline = mr.get("head_pipeline") if isinstance(mr.get("head_pipeline"), dict) else {}
    head_pipeline_status = str(head_pipeline.get("status") or "").strip().lower()
    current_head_pipelines = pipelines_for_current_head(mr, pipelines or [])
    failed_pipelines = [
        item for item in current_head_pipelines if item.get("status") in PIPELINE_FAILED_STATUSES
    ]
    pending_pipelines = [
        item for item in current_head_pipelines if item.get("status") in PIPELINE_PENDING_STATUSES
    ]
    merge_method = str((project or {}).get("merge_method") or "").strip().lower()
    diverged_commits_count_raw = mr.get("diverged_commits_count")
    try:
        diverged_commits_count = int(diverged_commits_count_raw) if diverged_commits_count_raw is not None else None
    except (TypeError, ValueError):
        diverged_commits_count = None
    meta = {
        "unresolved_threads": 0,
        "detailed_merge_status": detailed_merge_status,
        "has_conflicts": bool(mr.get("has_conflicts", False)),
        "blocking_discussions_resolved": mr.get("blocking_discussions_resolved"),
        "rebase_in_progress": bool(mr.get("rebase_in_progress", False)),
        "merge_error": mr.get("merge_error"),
        "head_pipeline_status": head_pipeline_status,
        "head_pipeline_id": head_pipeline.get("id"),
        "head_sha": merge_request_head_sha(mr),
        "pipelines_total": len(current_head_pipelines),
        "pipelines_failed": len(failed_pipelines),
        "pipelines_pending": len(pending_pipelines),
        "pipeline_failed_ids": [item.get("id") for item in failed_pipelines],
        "pipeline_pending_ids": [item.get("id") for item in pending_pipelines],
        "pipeline_statuses": [
            {"id": item.get("id"), "status": item.get("status"), "source": item.get("source")}
            for item in current_head_pipelines
        ],
        "merge_method": merge_method,
        "diverged_commits_count": diverged_commits_count,
        "status_checks_total": len(status_checks),
        "status_checks_pending": sum(
            1 for item in status_checks if item.get("status") in STATUS_CHECK_PENDING_STATUSES
        ),
        "status_checks_failed": sum(
            1 for item in status_checks if item.get("status") in STATUS_CHECK_FAILED_STATUSES
        ),
    }
    if mr.get("state") == "merged":
        return "approved", "merged", meta
    if mr.get("state") in {"closed", "locked"}:
        return "unknown", str(mr.get("state")), meta
    if meta["rebase_in_progress"]:
        return "pending", "rebase_in_progress", meta
    if detailed_merge_status == "need_rebase":
        return "needs_rebase", "need_rebase", meta
    if meta["has_conflicts"] or detailed_merge_status == "conflict":
        return "needs_rebase", "conflict", meta
    if merge_method in {"ff", "rebase_merge"} and diverged_commits_count and diverged_commits_count > 0:
        return "needs_rebase", f"diverged_commits_count:{diverged_commits_count}", meta
    merge_error = str(meta["merge_error"] or "").lower()
    if "rebase" in merge_error:
        return "needs_rebase", "rebase_failed", meta
    pipeline_blocking_statuses = {
        "ci_must_pass",
        "status_checks_must_pass",
        "security_policy_pipeline_check",
    }
    if detailed_merge_status in {
        "requested_changes",
        "discussions_not_resolved",
        "security_policy_violations",
        "draft_status",
        "jira_association_missing",
        "title_regex",
        "commits_status",
        "merge_request_blocked",
        "locked_paths",
        "locked_lfs_files",
    }:
        return "changes_requested", detailed_merge_status, meta

    # Any failure for the current MR head must win over still-running signals.
    if failed_pipelines:
        if head_pipeline_status in PIPELINE_FAILED_STATUSES:
            if detailed_merge_status in pipeline_blocking_statuses:
                return "changes_requested", f"{detailed_merge_status}:{head_pipeline_status}", meta
            return "changes_requested", f"head_pipeline:{head_pipeline_status}", meta
        return "changes_requested", f"pipelines_failed:{len(failed_pipelines)}", meta
    if meta["status_checks_failed"] > 0:
        return "changes_requested", f"external_status_checks_failed:{meta['status_checks_failed']}", meta

    if detailed_merge_status in {"checking", "unchecked", "preparing", "approvals_syncing"}:
        return "pending", detailed_merge_status, meta
    if detailed_merge_status == "ci_still_running":
        return "pending", "ci_still_running", meta
    if detailed_merge_status in pipeline_blocking_statuses:
        if pending_pipelines:
            pending_status = head_pipeline_status or str(pending_pipelines[0].get("status") or "")
            return "pending", f"{detailed_merge_status}:{pending_status}", meta
        return "pending", detailed_merge_status, meta
    if detailed_merge_status == "not_approved":
        return "pending", "not_approved", meta
    if pending_pipelines:
        if head_pipeline_status in PIPELINE_PENDING_STATUSES:
            return "pending", f"head_pipeline:{head_pipeline_status}", meta
        return "pending", f"pipelines_pending:{len(pending_pipelines)}", meta
    if meta["status_checks_pending"] > 0:
        return "pending", f"external_status_checks_pending:{meta['status_checks_pending']}", meta

    if approvals:
        approvals_required = int(approvals.get("approvals_required") or 0)
        approvals_left = int(approvals.get("approvals_left") or 0)
        if approvals_required > 0:
            if approvals_left == 0:
                return "approved", "approvals_satisfied", meta
            return "pending", f"approvals_left:{approvals_left}", meta

    created_at = parse_iso8601(mr.get("created_at"))
    now = dt.datetime.now(dt.timezone.utc)
    if created_at is not None:
        age = max(int((now - created_at).total_seconds()), 0)
        if age < review_grace_seconds():
            meta["age_seconds"] = age
            return "pending", "awaiting_first_review_signal", meta

    return "approved", "mergeable_after_grace", meta


def apply_discussion_status(
    status: str,
    raw_status: str,
    meta: dict[str, Any],
    discussions: list[dict[str, Any]],
) -> tuple[str, str, dict[str, Any]]:
    unresolved = [item for item in discussions if item["resolvable"] and not item["resolved"]]
    next_meta = dict(meta)
    next_meta["unresolved_threads"] = len(unresolved)
    if unresolved:
        return "changes_requested", f"{len(unresolved)}_unresolved_discussions", next_meta
    return status, raw_status, next_meta


def normalize_status(
    mr: dict[str, Any],
    project: dict[str, Any] | None,
    discussions: list[dict[str, Any]],
    approvals: dict[str, Any] | None,
    status_checks: list[dict[str, Any]],
    pipelines: list[dict[str, Any]] | None = None,
) -> tuple[str, str, dict[str, Any]]:
    status, raw_status, meta = derive_structured_status(
        mr,
        project,
        approvals,
        status_checks,
        pipelines,
    )
    status, raw_status, meta = apply_discussion_status(status, raw_status, meta, discussions)
    if status in APPROVED_STATES:
        return "approved", raw_status, meta
    if status in CHANGES_REQUESTED_STATES:
        return "changes_requested", raw_status, meta
    if status in PENDING_STATES:
        return "pending", raw_status, meta
    if status == "needs_rebase":
        return "needs_rebase", raw_status, meta
    if status == "approved":
        return "approved", raw_status, meta
    if status == "changes_requested":
        return "changes_requested", raw_status, meta
    return "pending", raw_status, meta


def build_workflow_guidance(status: str, raw_status: str, meta: dict[str, Any]) -> dict[str, Any]:
    head_pipeline_status = str(meta.get("head_pipeline_status") or "").strip().lower()
    non_system_notes_total = int(meta.get("non_system_notes_total") or 0)
    has_pending_reviewer_note = non_system_notes_total > 0
    raw_status_text = str(raw_status or "")

    guidance = {
        "review_complete": False,
        "workflow_complete": False,
        "can_announce_completion": False,
        "recommended_next_action": "inspect_current_state",
        "user_facing_state": "review_in_progress",
    }

    if status == "approved":
        guidance.update(
            {
                "review_complete": True,
                "workflow_complete": True,
                "can_announce_completion": True,
                "recommended_next_action": "manual_merge",
                "user_facing_state": "review_passed",
            }
        )
        return guidance

    if status == "timeout":
        guidance.update(
            {
                "recommended_next_action": "report_timeout_and_pause",
                "user_facing_state": "review_timeout",
            }
        )
        return guidance

    if status == "needs_rebase":
        if raw_status_text.startswith("diverged_commits_count:") and head_pipeline_status in PIPELINE_PENDING_STATUSES:
            guidance.update(
                {
                    "recommended_next_action": "keep_waiting_for_structured_status",
                    "user_facing_state": "pipeline_running_status_not_converged",
                }
            )
            return guidance
        guidance.update(
            {
                "recommended_next_action": "rebase_and_force_push",
                "user_facing_state": "rebase_required",
            }
        )
        return guidance

    if status == "changes_requested":
        if head_pipeline_status in PIPELINE_FAILED_STATUSES:
            guidance.update(
                {
                    "recommended_next_action": "inspect_pipeline_failure_and_fix",
                    "user_facing_state": "pipeline_failed",
                }
            )
            return guidance
        guidance.update(
            {
                "recommended_next_action": "inspect_findings_and_fix",
                "user_facing_state": "review_changes_requested",
            }
        )
        return guidance

    if status == "pending":
        if has_pending_reviewer_note:
            guidance.update(
                {
                    "recommended_next_action": "keep_waiting_in_current_session_and_treat_note_as_pending_finding",
                    "user_facing_state": "ci_running_with_pending_finding",
                }
            )
            return guidance
        if head_pipeline_status in PIPELINE_PENDING_STATUSES:
            guidance.update(
                {
                    "recommended_next_action": "keep_waiting_for_ci_in_current_session",
                    "user_facing_state": "waiting_for_ci",
                }
            )
            return guidance
        guidance.update(
            {
                "recommended_next_action": "keep_waiting_for_review_signal_in_current_session",
                "user_facing_state": "waiting_for_review_signal",
            }
        )
        return guidance

    return guidance


def fetch_status_bundle(project_id: str, mr_id: str) -> dict[str, Any]:
    mr = get_merge_request(project_id, mr_id)
    project = get_project(project_id)
    approvals = get_approvals(project_id, mr_id)
    status_checks = list_status_checks(project_id, mr_id)
    pipelines = list_merge_request_pipelines(project_id, mr_id)
    discussions = list_discussions(project_id, mr_id)
    notes = list_merge_request_notes(project_id, mr_id)
    status, raw_status, meta = normalize_status(
        mr,
        project,
        discussions,
        approvals,
        status_checks,
        pipelines,
    )
    meta = enrich_meta_with_notes(meta, notes, discussions)
    workflow_guidance = build_workflow_guidance(status, raw_status, meta)
    return {
        "status": status,
        "raw_status": raw_status,
        "meta": meta,
        "workflow_guidance": workflow_guidance,
        "project": project,
        "merge_request": mr,
        "discussions": discussions,
        "notes": notes,
        "approvals": approvals,
        "status_checks": status_checks,
        "pipelines": pipelines,
    }


def apply_post_rebase_gate(
    output: dict[str, Any],
    bundle: dict[str, Any],
    *,
    expected_head_sha: str = "",
    require_current_head_pipeline: bool = False,
) -> dict[str, Any]:
    """Prevent stale pre-rebase approval from being reported as complete."""
    if expected_head_sha and bundle["meta"].get("head_sha") != expected_head_sha:
        output["status"] = "pending"
        output["raw_status"] = "post_rebase_head_sha_not_updated"
        output["workflow_guidance"] = build_workflow_guidance(
            "pending", output["raw_status"], bundle["meta"]
        )
        output["workflow_guidance"].update(
            {
                "can_announce_completion": False,
                "workflow_complete": False,
                "review_complete": False,
                "recommended_next_action": "keep_waiting_for_post_rebase_head_in_current_session",
                "user_facing_state": "post_rebase_head_not_updated",
            }
        )
    elif require_current_head_pipeline and bundle["status"] == "approved":
        pipeline_statuses = {
            str(item.get("status") or "").strip().lower()
            for item in (
                bundle["meta"].get("pipeline_statuses", [])
                or bundle.get("pipelines", [])
            )
        }
        pipeline_gate_status = ""
        pipeline_gate_state = ""
        if int(bundle["meta"].get("pipelines_total") or 0) == 0:
            pipeline_gate_status = "post_rebase_pipeline_not_created"
            pipeline_gate_state = "post_rebase_pipeline_not_created"
        elif pipeline_statuses & PIPELINE_PENDING_STATUSES:
            pipeline_gate_status = "post_rebase_pipeline_not_completed"
            pipeline_gate_state = "post_rebase_pipeline_running"
        elif "success" not in pipeline_statuses:
            pipeline_gate_status = "post_rebase_pipeline_not_success"
            pipeline_gate_state = "post_rebase_pipeline_not_success"
        if pipeline_gate_status:
            output["status"] = "pending"
            output["raw_status"] = pipeline_gate_status
            output["workflow_guidance"] = build_workflow_guidance(
                "pending", output["raw_status"], bundle["meta"]
            )
            output["workflow_guidance"].update(
                {
                    "can_announce_completion": False,
                    "workflow_complete": False,
                    "review_complete": False,
                    "recommended_next_action": "keep_waiting_for_post_rebase_pipeline_in_current_session",
                    "user_facing_state": pipeline_gate_state,
                }
            )
    return output


def command_create_mr(args: argparse.Namespace) -> int:
    payload = {
        "source_branch": args.branch,
        "target_branch": args.target_branch,
        "title": args.title,
        "description": args.description,
    }
    result = request_json(
        f"/projects/{project_ref(args.project_id)}/merge_requests",
        method="POST",
        payload=payload,
    )
    mr_iid = parse_mr_iid(result)
    output = {
        "mr_id": mr_iid,
        "mr_global_id": result.get("id"),
        "mr_url": result.get("web_url"),
        "raw": result,
    }
    print_json(output)
    return 0


def command_status(args: argparse.Namespace) -> int:
    bundle = fetch_status_bundle(args.project_id, args.mr_id)
    output = {
        "status": bundle["status"],
        "raw_status": bundle["raw_status"],
        "meta": bundle["meta"],
        "workflow_guidance": bundle["workflow_guidance"],
        "notes": bundle["notes"],
        "raw": {
            "project": bundle["project"],
            "merge_request": bundle["merge_request"],
            "approvals": bundle["approvals"],
            "status_checks": bundle["status_checks"],
            "pipelines": bundle["pipelines"],
        },
    }
    print_json(
        apply_post_rebase_gate(
            output,
            bundle,
            expected_head_sha=str(args.expected_head_sha or "").strip(),
            require_current_head_pipeline=bool(args.require_current_head_pipeline),
        )
    )
    return 0


def command_threads(args: argparse.Namespace) -> int:
    discussions = list_discussions(args.project_id, args.mr_id)
    notes = list_merge_request_notes(args.project_id, args.mr_id)
    output = {
        "threads": discussions,
        "notes": notes,
        "summary": {
            "total": len(discussions),
            "unresolved": sum(1 for item in discussions if item["resolvable"] and not item["resolved"]),
            "notes": len(notes),
        },
    }
    print_json(output)
    return 0


def command_wait_review(args: argparse.Namespace) -> int:
    deadline = time.time() + int(args.review_timeout_seconds)
    expected_head_sha = str(args.expected_head_sha or "").strip()
    require_current_head_pipeline = bool(args.require_current_head_pipeline)
    while True:
        bundle = fetch_status_bundle(args.project_id, args.mr_id)
        output = {
            "status": bundle["status"],
            "raw_status": bundle["raw_status"],
            "meta": bundle["meta"],
            "workflow_guidance": bundle["workflow_guidance"],
            "threads": bundle["discussions"],
            "notes": bundle["notes"],
            "raw_status_payload": {
                "project": bundle["project"],
                "merge_request": bundle["merge_request"],
                "approvals": bundle["approvals"],
                "status_checks": bundle["status_checks"],
                "pipelines": bundle["pipelines"],
            },
        }
        # A rebase changes the MR head and causes GitLab to create a new
        # pipeline. Never let approval for the pre-rebase SHA leak through.
        output = apply_post_rebase_gate(
            output,
            bundle,
            expected_head_sha=expected_head_sha,
            require_current_head_pipeline=require_current_head_pipeline,
        )
        if output["status"] == "approved":
            print_json(output)
            return 0
        if output["status"] == "needs_rebase":
            print_json(output)
            return 11
        if output["status"] == "changes_requested":
            print_json(output)
            return 10
        if time.time() >= deadline:
            output["status"] = "timeout"
            output["workflow_guidance"] = build_workflow_guidance(
                "timeout",
                bundle["raw_status"],
                bundle["meta"],
            )
            print_json(output)
            return 124
        time.sleep(int(args.poll_interval_seconds))


def command_comment(args: argparse.Namespace) -> int:
    result = request_json(
        f"/projects/{project_ref(args.project_id)}/merge_requests/{mr_ref(args.mr_id)}/discussions/{urllib.parse.quote(str(args.thread_id), safe='')}/notes",
        method="POST",
        payload={"body": args.body},
    )
    output = {
        "thread_id": args.thread_id,
        "note_id": result.get("id") if isinstance(result, dict) else None,
        "raw": result,
    }
    print_json(output)
    return 0


def command_note(args: argparse.Namespace) -> int:
    result = request_json(
        f"/projects/{project_ref(args.project_id)}/merge_requests/{mr_ref(args.mr_id)}/notes",
        method="POST",
        payload={"body": args.body},
    )
    output = {
        "mr_id": args.mr_id,
        "note_id": result.get("id") if isinstance(result, dict) else None,
        "raw": result,
    }
    print_json(output)
    return 0


def command_resolve_thread(args: argparse.Namespace) -> int:
    discussion = resolve_discussion(args.project_id, args.mr_id, args.thread_id, True)
    output = {
        "thread_id": args.thread_id,
        "resolved": discussion.get("resolved"),
        "raw": discussion,
    }
    print_json(output)
    return 0


def command_reopen_thread(args: argparse.Namespace) -> int:
    discussion = resolve_discussion(args.project_id, args.mr_id, args.thread_id, False)
    output = {
        "thread_id": args.thread_id,
        "resolved": discussion.get("resolved"),
        "raw": discussion,
    }
    print_json(output)
    return 0


def command_check_auth(args: argparse.Namespace) -> int:
    payload = request_json("/user", method="GET")
    output = {
        "id": payload.get("id"),
        "username": payload.get("username"),
        "name": payload.get("name"),
    }
    print_json(output)
    return 0


def command_check_project(args: argparse.Namespace) -> int:
    payload = request_json(f"/projects/{project_ref(args.project_id)}", method="GET")
    output = {
        "id": payload.get("id"),
        "path_with_namespace": payload.get("path_with_namespace"),
        "default_branch": payload.get("default_branch"),
        "web_url": payload.get("web_url"),
    }
    print_json(output)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_mr = subparsers.add_parser("create-mr")
    create_mr.add_argument("--branch", required=True)
    create_mr.add_argument("--target-branch", required=True)
    create_mr.add_argument("--project-id", required=True)
    create_mr.add_argument("--title", required=True)
    create_mr.add_argument("--description", required=False, default="")
    create_mr.set_defaults(func=command_create_mr)

    status = subparsers.add_parser("status")
    status.add_argument("--mr-id", required=True)
    status.add_argument("--project-id", required=True)
    status.add_argument("--expected-head-sha", required=False, default="")
    status.add_argument("--require-current-head-pipeline", action="store_true")
    status.set_defaults(func=command_status)

    threads = subparsers.add_parser("threads")
    threads.add_argument("--mr-id", required=True)
    threads.add_argument("--project-id", required=True)
    threads.set_defaults(func=command_threads)

    wait_review = subparsers.add_parser("wait-review")
    wait_review.add_argument("--mr-id", required=True)
    wait_review.add_argument("--project-id", required=True)
    wait_review.add_argument("--poll-interval-seconds", required=True)
    wait_review.add_argument("--review-timeout-seconds", required=True)
    wait_review.add_argument("--expected-head-sha", required=False, default="")
    wait_review.add_argument(
        "--require-current-head-pipeline",
        action="store_true",
        help="要求当前 MR head 至少已经出现一条 pipeline（用于 rebase 后验证）",
    )
    wait_review.set_defaults(func=command_wait_review)

    comment = subparsers.add_parser("comment")
    comment.add_argument("--mr-id", required=True)
    comment.add_argument("--thread-id", required=True)
    comment.add_argument("--project-id", required=True)
    comment.add_argument("--body", required=True)
    comment.set_defaults(func=command_comment)

    note = subparsers.add_parser("note")
    note.add_argument("--mr-id", required=True)
    note.add_argument("--project-id", required=True)
    note.add_argument("--body", required=True)
    note.set_defaults(func=command_note)

    resolve_thread = subparsers.add_parser("resolve-thread")
    resolve_thread.add_argument("--mr-id", required=True)
    resolve_thread.add_argument("--thread-id", required=True)
    resolve_thread.add_argument("--project-id", required=True)
    resolve_thread.set_defaults(func=command_resolve_thread)

    reopen_thread = subparsers.add_parser("reopen-thread")
    reopen_thread.add_argument("--mr-id", required=True)
    reopen_thread.add_argument("--thread-id", required=True)
    reopen_thread.add_argument("--project-id", required=True)
    reopen_thread.set_defaults(func=command_reopen_thread)

    check_auth = subparsers.add_parser("check-auth")
    check_auth.set_defaults(func=command_check_auth)

    check_project = subparsers.add_parser("check-project")
    check_project.add_argument("--project-id", required=True)
    check_project.set_defaults(func=command_check_project)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
