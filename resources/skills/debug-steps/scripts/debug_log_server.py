#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

READY_TIMEOUT_SECONDS = 5.0
POLL_INTERVAL_SECONDS = 0.1
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = int(os.environ.get("DEBUG_LOG_PORT", "47821"))

# 日志服务只监听 loopback，健康检查必须绕过一切代理：环境里设了 http_proxy 时，
# 代理返回的错误响应会被误判成"服务在线"（cdp_browser.py 里同款防御）。
LOOPBACK_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))




AGENT_KIND = os.environ.get("EBISU_TERMINAL", "ebisu")
PROJECT_ROOT = str(Path(os.environ.get("EBISU_PROJECT_ROOT", os.getcwd())).resolve())
SCRIPT_PATH = str(Path(__file__).resolve())
PROJECT_NAME = Path(PROJECT_ROOT).name or "workspace"
PROJECT_HASH = hashlib.sha256(PROJECT_ROOT.encode("utf-8")).hexdigest()[:12]
RUNTIME_ROOT = Path(tempfile.gettempdir()) / "chimata-debug-workflow" / f"{PROJECT_NAME}-{PROJECT_HASH}" / AGENT_KIND


def runtime_dir(session: str) -> Path:
    return RUNTIME_ROOT / session


def state_file_for(session: str) -> Path:
    return runtime_dir(session) / "session.json"


def log_file_for(session: str) -> Path:
    return runtime_dir(session) / "debug.log"


def server_log_for(session: str) -> Path:
    return runtime_dir(session) / "server.log"


def pid_file_for(session: str) -> Path:
    return runtime_dir(session) / "server.pid"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Manage the debug workflow local log server.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name in ("start", "status", "reset", "show", "cleanup"):
        sub = subparsers.add_parser(name)
        sub.add_argument("--session", default="default")
        if name == "start":
            sub.add_argument("--host", default=DEFAULT_HOST)
            sub.add_argument("--port", type=int, default=DEFAULT_PORT)

    serve = subparsers.add_parser("serve")
    serve.add_argument("--session", required=True)
    serve.add_argument("--host", required=True)
    serve.add_argument("--port", type=int, required=True)
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def clear_log(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")


def append_log(path: Path, text: str) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = text if text.endswith("\n") else text + "\n"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(normalized)
    return len(normalized.encode("utf-8"))


def load_state(session: str) -> dict[str, Any]:
    state = read_json(state_file_for(session))
    if not state:
        return {"status": "missing", "session": session, "agent": AGENT_KIND, "project_root": PROJECT_ROOT}
    state.setdefault("session", session)
    state.setdefault("agent", AGENT_KIND)
    state.setdefault("project_root", PROJECT_ROOT)
    return state


def health_url(state: dict[str, Any]) -> str | None:
    host = state.get("host")
    port = state.get("port")
    if not host or not port:
        return None
    return f"http://{host}:{port}/health"


def ping(state: dict[str, Any], timeout: float = 0.5) -> bool:
    url = health_url(state)
    if not url:
        return False
    try:
        with LOOPBACK_OPENER.open(url, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload.get("project_root") == PROJECT_ROOT and payload.get("agent") == AGENT_KIND
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return False


def enrich_state(state: dict[str, Any], session: str) -> dict[str, Any]:
    state = dict(state)
    state["session"] = session
    state["agent"] = AGENT_KIND
    state["project_root"] = PROJECT_ROOT
    state["state_dir"] = str(runtime_dir(session))
    state["log_file"] = str(log_file_for(session))
    state["server_log"] = str(server_log_for(session))
    if state.get("host") and state.get("port"):
        state["endpoint"] = f"http://{state['host']}:{state['port']}/log"
        state["clear_url"] = f"http://{state['host']}:{state['port']}/clear"
        state["session_url"] = f"http://{state['host']}:{state['port']}/session"
        state["health_url"] = f"http://{state['host']}:{state['port']}/health"
    state["healthy"] = ping(state)
    return state


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=True, indent=2))


def remove_if_exists(path: Path) -> None:
    if path.exists():
        path.unlink()


def remove_runtime(session: str) -> None:
    state_dir = runtime_dir(session)
    if state_dir.exists():
        shutil.rmtree(state_dir)


def maybe_terminate(pid: int | None) -> None:
    if not pid:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except PermissionError:
        return
    deadline = time.time() + 2.0
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except PermissionError:
        return


def parse_pid(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def prepare_runtime(session: str) -> None:
    runtime_dir(session).mkdir(parents=True, exist_ok=True)
    clear_log(log_file_for(session))
    clear_log(server_log_for(session))
    remove_if_exists(state_file_for(session))
    remove_if_exists(pid_file_for(session))


def read_log_tail(path: Path, max_lines: int = 40, max_chars: int = 4000) -> str:
    if not path.exists():
        return ""
    content = path.read_text(encoding="utf-8", errors="replace").strip()
    if not content:
        return ""
    lines = content.splitlines()
    tail = "\n".join(lines[-max_lines:])
    if len(tail) > max_chars:
        tail = tail[-max_chars:]
    return tail


def start_error_payload(session: str, host: str, attempted_ports: list[int]) -> dict[str, Any]:
    payload = {
        "status": "error",
        "session": session,
        "agent": AGENT_KIND,
        "project_root": PROJECT_ROOT,
        "message": "failed to start debug log server",
        "host": host,
        "attempted_ports": attempted_ports,
        "state_dir": str(runtime_dir(session)),
        "log_file": str(log_file_for(session)),
        "server_log": str(server_log_for(session)),
    }
    server_log_tail = read_log_tail(server_log_for(session))
    if server_log_tail:
        payload["server_log_tail"] = server_log_tail
    state = load_state(session)
    if state.get("status") != "missing":
        payload["last_state"] = enrich_state(state, session)
    return payload


def start_session(session: str, host: str, requested_port: int) -> int:
    state = load_state(session)
    if state.get("status") != "missing" and ping(state):
        print_json(enrich_state(state, session) | {"status": "ready"})
        return 0

    maybe_terminate(parse_pid(state.get("pid")))

    ports_to_try = [requested_port]
    if requested_port != 0:
        ports_to_try.append(0)

    for candidate_port in ports_to_try:
        prepare_runtime(session)
        log_handle = server_log_for(session).open("ab")
        try:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-u",
                    str(SCRIPT_PATH),
                    "serve",
                    "--session",
                    session,
                    "--host",
                    host,
                    "--port",
                    str(candidate_port),
                ],
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        finally:
            log_handle.close()
        deadline = time.time() + READY_TIMEOUT_SECONDS
        while time.time() < deadline:
            current = load_state(session)
            if current.get("pid") == process.pid and ping(current):
                print_json(enrich_state(current, session) | {"status": "ready"})
                return 0
            if process.poll() is not None:
                break
            time.sleep(POLL_INTERVAL_SECONDS)
        maybe_terminate(process.pid)

    print_json(start_error_payload(session, host, ports_to_try))
    return 1


def status_session(session: str) -> int:
    state = enrich_state(load_state(session), session)
    if state.get("status") != "missing" and not state.get("healthy") and state.get("pid"):
        state["status"] = "stale"
    print_json(state)
    return 0 if state.get("status") != "missing" else 1


def reset_session(session: str) -> int:
    state = load_state(session)
    if state.get("status") == "missing":
        print_json(enrich_state(state, session))
        return 1
    clear_log(log_file_for(session))
    print_json(enrich_state(state, session) | {"status": "reset"})
    return 0


def show_session(session: str) -> int:
    log_path = log_file_for(session)
    if not log_path.exists():
        return 1
    sys.stdout.write(log_path.read_text(encoding="utf-8"))
    return 0


def cleanup_session(session: str) -> int:
    state = load_state(session)
    maybe_terminate(parse_pid(state.get("pid")))
    remove_runtime(session)
    print_json(
        {
            "status": "cleaned",
            "session": session,
            "agent": AGENT_KIND,
            "project_root": PROJECT_ROOT,
            "state_dir": str(runtime_dir(session)),
        }
    )
    return 0


class DebugHandler(BaseHTTPRequestHandler):
    server_version = "ChimataDebugServer/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _metadata(self) -> dict[str, Any]:
        server = self.server
        return {
            "status": "ok",
            "agent": AGENT_KIND,
            "project_root": PROJECT_ROOT,
            "session": server.session,
            "host": server.server_address[0],
            "port": server.server_address[1],
            "endpoint": f"http://{server.server_address[0]}:{server.server_address[1]}/log",
            "clear_url": f"http://{server.server_address[0]}:{server.server_address[1]}/clear",
            "session_url": f"http://{server.server_address[0]}:{server.server_address[1]}/session",
            "health_url": f"http://{server.server_address[0]}:{server.server_address[1]}/health",
            "log_file": str(server.log_file),
            "server_log": str(server.server_log),
            "state_dir": str(server.state_dir),
            "pid": os.getpid(),
        }

    def _write_state(self) -> None:
        write_json(state_file_for(self.server.session), self._metadata())
        pid_file_for(self.server.session).write_text(f"{os.getpid()}\n", encoding="utf-8")

    def _send_json(self, status_code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=True, indent=2).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _read_payload(self) -> tuple[dict[str, Any], bytes]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b""
        content_type = self.headers.get("Content-Type", "")
        if "application/json" in content_type and raw:
            try:
                payload = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                payload = {}
        elif raw:
            payload = {"content": raw.decode("utf-8")}
        else:
            payload = {}
        if not isinstance(payload, dict):
            payload = {"content": json.dumps(payload, ensure_ascii=False, indent=2)}
        return payload, raw

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path in {"/health", "/session"}:
            self._write_state()
            self._send_json(200, self._metadata())
            return
        self._send_json(404, {"status": "not_found", "path": self.path})

    def do_DELETE(self) -> None:
        if self.path == "/log":
            clear_log(self.server.log_file)
            self._write_state()
            self._send_json(200, self._metadata() | {"status": "cleared"})
            return
        self._send_json(404, {"status": "not_found", "path": self.path})

    def do_POST(self) -> None:
        if self.path == "/clear":
            clear_log(self.server.log_file)
            self._write_state()
            self._send_json(200, self._metadata() | {"status": "cleared"})
            return
        if self.path != "/log":
            self._send_json(404, {"status": "not_found", "path": self.path})
            return

        payload, raw = self._read_payload()
        mode = str(payload.get("mode", "append"))
        content = payload.get("content")
        if content is None and payload:
            payload_without_mode = dict(payload)
            payload_without_mode.pop("mode", None)
            content = json.dumps(payload_without_mode, ensure_ascii=False, indent=2)
        if content is None:
            content = raw.decode("utf-8") if raw else ""
        content = str(content)

        if mode == "replace":
            clear_log(self.server.log_file)
            bytes_written = append_log(self.server.log_file, content) if content else 0
        elif mode == "append":
            bytes_written = append_log(self.server.log_file, content) if content else 0
        else:
            self._send_json(400, {"status": "invalid_mode", "mode": mode})
            return

        self._write_state()
        log_size = self.server.log_file.stat().st_size if self.server.log_file.exists() else 0
        self._send_json(
            200,
            self._metadata()
            | {
                "status": "written",
                "mode": mode,
                "bytes_written": bytes_written,
                "log_size": log_size,
            },
        )


class DebugHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, host: str, port: int, session: str):
        self.session = session
        self.state_dir = runtime_dir(session)
        self.log_file = log_file_for(session)
        self.server_log = server_log_for(session)
        super().__init__((host, port), DebugHandler)


def serve(session: str, host: str, port: int) -> int:
    server: DebugHTTPServer | None = None
    try:
        server = DebugHTTPServer(host, port, session)
        clear_log(server.log_file)

        def handle_stop(signum: int, frame: Any) -> None:
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, handle_stop)
        signal.signal(signal.SIGINT, handle_stop)

        metadata = {
            "status": "ready",
            "agent": AGENT_KIND,
            "project_root": PROJECT_ROOT,
            "session": session,
            "host": server.server_address[0],
            "port": server.server_address[1],
            "endpoint": f"http://{server.server_address[0]}:{server.server_address[1]}/log",
            "clear_url": f"http://{server.server_address[0]}:{server.server_address[1]}/clear",
            "session_url": f"http://{server.server_address[0]}:{server.server_address[1]}/session",
            "health_url": f"http://{server.server_address[0]}:{server.server_address[1]}/health",
            "log_file": str(server.log_file),
            "server_log": str(server.server_log),
            "state_dir": str(server.state_dir),
            "pid": os.getpid(),
        }
        write_json(state_file_for(session), metadata)
        pid_file_for(session).write_text(f"{os.getpid()}\n", encoding="utf-8")
        server.serve_forever(poll_interval=0.2)
    except Exception:
        traceback.print_exc()
        return 1
    finally:
        if server is not None:
            server.server_close()

    return 0


def main() -> int:
    args = parse_args()

    if args.command == "start":
        return start_session(args.session, args.host, args.port)
    if args.command == "status":
        return status_session(args.session)
    if args.command == "reset":
        return reset_session(args.session)
    if args.command == "show":
        return show_session(args.session)
    if args.command == "cleanup":
        return cleanup_session(args.session)
    if args.command == "serve":
        return serve(args.session, args.host, args.port)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
