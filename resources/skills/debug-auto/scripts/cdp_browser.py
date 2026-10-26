#!/usr/bin/env python3

"""真实浏览器 CDP 通道：探测、启动、停止。

debug-auto 的浏览器能力阶梯靠这个脚本落地：

1. `detect`：本机是否已经有开着调试端口的浏览器可以直接连（真实 profile、真实登录态）。
2. `launch`：探测不到时，用本机真实 Chrome 内核配一个独立 `--user-data-dir` 起一个可调试实例。

关于 Chrome 136+：`--remote-debugging-port` 对**默认** profile 目录已经不再生效，
必须搭配非默认的 `--user-data-dir`。所以这个脚本永远不会使用用户日常 profile 目录——
`detect` 只做连接，`launch` 只新建独立目录，两者都不写用户的默认 profile。

只依赖 python 标准库。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HTTP_TIMEOUT_SECONDS = 1.5
LAUNCH_TIMEOUT_SECONDS = 25.0
SETTLE_SECONDS = 3.0
STOP_TIMEOUT_SECONDS = 5.0
POLL_INTERVAL_SECONDS = 0.2
DEFAULT_LAUNCH_PORT = 9222
PROFILE_DIR_NAME = "chimata-cdp-profile"

# CDP 端点只可能在 loopback 上，必须绕过一切代理：环境里设了 http_proxy 时，
# 代理返回的错误响应（HTTP 200 + 一段错误文案）会被误判成"实例在线"。
# 本机实测过这种假阳性，所以这里不依赖 no_proxy 是否配置正确。
LOOPBACK_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 探测顺序：环境变量显式指定的端口优先，其余按常见调试端口扫描。
SCAN_PORTS = (9222, 9223, 9224, 9225, 9226, 9227, 9228)
ENDPOINT_ENV_KEYS = ("CDP_ENDPOINT", "CDP_URL")
PORT_ENV_KEYS = ("CHROME_CDP_PORT", "CDP_PORT")

# 各平台真实 Chrome 系内核的默认安装位置。用户可以用 CDP_BROWSER 覆盖。
MACOS_BROWSERS = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
)
LINUX_BROWSERS = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser",
)
WINDOWS_BROWSERS = (
    r"%PROGRAMFILES%\Google\Chrome\Application\chrome.exe",
    r"%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe",
    r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
    r"%PROGRAMFILES%\Microsoft\Edge\Application\msedge.exe",
    r"%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe",
    r"%LOCALAPPDATA%\Chromium\Application\chrome.exe",
    r"%PROGRAMFILES%\BraveSoftware\Brave-Browser\Application\brave.exe",
)




AGENT_KIND = os.environ.get("EBISU_TERMINAL", "ebisu")
PROJECT_ROOT = str(Path(os.environ.get("EBISU_PROJECT_ROOT", os.getcwd())).resolve())
PROJECT_NAME = Path(PROJECT_ROOT).name or "workspace"
PROJECT_HASH = hashlib.sha256(PROJECT_ROOT.encode("utf-8")).hexdigest()[:12]
RUNTIME_ROOT = (
    Path(tempfile.gettempdir())
    / "chimata-debug-workflow"
    / ("%s-%s" % (PROJECT_NAME, PROJECT_HASH))
    / AGENT_KIND
)


def runtime_dir() -> Path:
    return RUNTIME_ROOT / "cdp-browser"


def state_file() -> Path:
    return runtime_dir() / "launched.json"


def read_json(path: Path) -> Dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def emit(payload: Dict[str, Any], exit_code: int = 0) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    raise SystemExit(exit_code)


def fail(reason: str, hint: str = "", exit_code: int = 2) -> None:
    payload: Dict[str, Any] = {"status": "error", "reason": reason}
    if hint:
        payload["hint"] = hint
    emit(payload, exit_code)


def http_json(url: str, timeout: float = HTTP_TIMEOUT_SECONDS) -> Optional[Dict[str, Any]]:
    try:
        with LOOPBACK_OPENER.open(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


def probe_port(port: int) -> Optional[Dict[str, Any]]:
    """端口上是否是一个可调试的真实浏览器；是则返回它的 CDP 端点信息。"""
    payload = http_json("http://127.0.0.1:%d/json/version" % port)
    if not payload:
        return None
    websocket_url = payload.get("webSocketDebuggerUrl")
    if not websocket_url:
        return None
    return {
        "port": port,
        "endpoint": "http://127.0.0.1:%d" % port,
        "web_socket_debugger_url": websocket_url,
        "browser": payload.get("Browser") or "unknown",
        "user_agent": payload.get("User-Agent") or "",
    }


def port_from_endpoint(raw: str) -> Optional[int]:
    text = raw.strip()
    if not text:
        return None
    if "://" not in text:
        text = "http://" + text
    try:
        parsed = urllib.parse.urlsplit(text)
    except ValueError:
        return None
    try:
        return parsed.port
    except ValueError:
        return None


def env_ports() -> List[int]:
    ports: List[int] = []
    for key in ENDPOINT_ENV_KEYS:
        port = port_from_endpoint(os.environ.get(key, ""))
        if port:
            ports.append(port)
    for key in PORT_ENV_KEYS:
        raw = os.environ.get(key, "").strip()
        if raw.isdigit():
            ports.append(int(raw))
    return ports


def candidate_ports(extra: Optional[int] = None) -> List[int]:
    ordered: List[int] = []
    for port in env_ports() + ([extra] if extra else []) + list(SCAN_PORTS):
        if port and port not in ordered:
            ordered.append(port)
    return ordered


def find_debuggable(extra_port: Optional[int] = None) -> Optional[Dict[str, Any]]:
    for port in candidate_ports(extra_port):
        hit = probe_port(port)
        if hit:
            return hit
    return None


def browser_candidates() -> List[str]:
    if sys.platform == "darwin":
        return list(MACOS_BROWSERS)
    if sys.platform.startswith("win"):
        return list(WINDOWS_BROWSERS)
    return list(LINUX_BROWSERS)


def find_browser() -> Tuple[Optional[str], str]:
    """返回 (浏览器可执行文件, 失败原因)。

    `CDP_BROWSER` 是显式指定：找不到就报错，不能悄悄换成平台默认浏览器，
    否则用户以为用的是自己指定的那个，实际却在另一个内核上排障。
    """
    override = os.environ.get("CDP_BROWSER", "").strip()
    candidates = [override] if override else browser_candidates()
    for candidate in candidates:
        expanded = os.path.expandvars(candidate)
        if Path(expanded).is_file():
            return expanded, ""
        if not os.path.isabs(candidate):
            located = shutil.which(candidate)
            if located:
                return located, ""
    if override:
        return None, "CDP_BROWSER 指向的浏览器不存在: %s" % override
    return None, "未找到本机 Chrome 系浏览器"


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def pick_port(preferred: Optional[int]) -> int:
    """挑一个能真正绑上的端口：指定端口优先，否则从常见调试端口开始找。"""
    if preferred and port_is_free(preferred):
        return preferred
    for port in SCAN_PORTS:
        if port_is_free(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def profile_dir(override: Optional[str]) -> Path:
    if override:
        return Path(override).expanduser()
    # 独立的临时 profile：既满足 Chrome 136+ 对非默认目录的要求，
    # 又能在多轮排障之间保留登录态，且完全不动用户日常 profile。
    return Path(tempfile.gettempdir()) / PROFILE_DIR_NAME


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


# Chromium 在受限环境里起不来自己那套沙箱时的典型日志特征：子进程 sandbox_init
# 被拒 → GPU/Network 子进程连环崩溃 → 主进程重试若干次后 FATAL 退出。
# 表现就是"Chrome 一闪就没"，但崩溃报告只写 EXC_BREAKPOINT，看不出真正原因，
# 所以这里认日志而不是认退出码。
SANDBOX_FAILURE_MARKERS = (
    "Failed to initialize sandbox",
    "sandbox initialization failed",
    "GPU process isn't usable",
)


def sandbox_failure_detected(log_text: str) -> bool:
    return any(marker in log_text for marker in SANDBOX_FAILURE_MARKERS)


def log_path() -> Path:
    return runtime_dir() / "chrome.log"


def read_text(path: Path, limit: int = 0) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if limit and len(text) > limit:
        return text[-limit:]
    return text


def log_tail(path: Path, lines: int = 12) -> str:
    text = read_text(path)
    if not text:
        return ""
    return "\n".join(text.strip().splitlines()[-lines:])


def extra_browser_args() -> List[str]:
    """CDP_BROWSER_ARGS 是给受限环境的逃生舱（例如容器里需要 --disable-dev-shm-usage）。"""
    raw = os.environ.get("CDP_BROWSER_ARGS", "").strip()
    if not raw:
        return []
    try:
        return shlex.split(raw)
    except ValueError:
        return raw.split()


def build_command(
    browser: str,
    port: int,
    profile: Path,
    url: str,
    headless: bool,
    no_sandbox: bool,
    extra_args: List[str],
) -> List[str]:
    command = [
        browser,
        "--remote-debugging-port=%d" % port,
        "--user-data-dir=%s" % profile,
        # 只放行回环来源，与桌面应用自身的做法一致，不开通配符。
        "--remote-allow-origins=http://127.0.0.1,http://localhost",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if headless:
        command.append("--headless=new")
    if no_sandbox:
        command.append("--no-sandbox")
    command.extend(extra_args)
    if url:
        command.append(url)
    return command


def start_attempt(
    browser: str,
    port: int,
    profile: Path,
    url: str,
    headless: bool,
    no_sandbox: bool,
    timeout: float,
) -> "Tuple[subprocess.Popen, Optional[Dict[str, Any]], str]":
    """起一次实例并等 CDP 就绪，返回 (进程, 命中信息, 失败原因)。

    Chrome 的 stdout/stderr 落到日志文件而不是 /dev/null：启动失败的真实原因
    （沙箱、profile 锁、内核不兼容）只在日志里。
    """
    destination = log_path()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with open(destination, "w", encoding="utf-8") as sink:
        process = subprocess.Popen(
            build_command(browser, port, profile, url, headless, no_sandbox, extra_browser_args()),
            stdout=sink,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            return process, None, "浏览器启动后立即退出（exit %s）" % process.returncode
        hit = probe_port(port)
        if hit:
            return process, hit, ""
        time.sleep(POLL_INTERVAL_SECONDS)
    return process, None, "等待 CDP 就绪超时（%.0f 秒）" % timeout


def settle(process: "subprocess.Popen", seconds: float) -> str:
    """就绪之后再观察一小段，返回空串表示站住了。

    必须做这一步：受限环境里 Chrome 常常先把 CDP 暴露出来，过一两秒才因为
    GPU/Network 子进程连环失败而 FATAL 退出。只看"CDP 是否就绪"会误判成功，
    于是重试逻辑永远没机会触发。
    """
    deadline = time.time() + seconds
    while time.time() < deadline:
        code = process.poll()
        if code is not None:
            return "浏览器在就绪后随即退出（exit %s）" % code
        time.sleep(POLL_INTERVAL_SECONDS)
    return ""


def command_detect(args: argparse.Namespace) -> None:
    hit = find_debuggable(args.port)
    if hit:
        hit["status"] = "ready"
        hit["mode"] = "attach"
        hit["hint"] = "已存在可调试的真实浏览器，优先复用它取证据；不要另起实例。"
        emit(hit)
    emit(
        {
            "status": "miss",
            "mode": "attach",
            "scanned_ports": candidate_ports(args.port),
            "hint": (
                "没有可复用的调试实例。用 launch 以真实 Chrome 内核起一个独立 profile 的实例；"
                "若本机没有 Chrome 系浏览器，再退回 Playwright。"
            ),
        },
        1,
    )


def command_launch(args: argparse.Namespace) -> None:
    existing = find_debuggable(args.port)
    if existing and not args.force:
        existing["status"] = "ready"
        existing["mode"] = "attach"
        existing["hint"] = "端口上已有可调试实例，直接复用，未重复启动。"
        emit(existing)

    browser, reason = find_browser()
    if not browser:
        fail(
            reason,
            "可以用 CDP_BROWSER 指定浏览器可执行文件路径，或退回 Playwright 的 Chromium。",
        )

    port = pick_port(args.port or DEFAULT_LAUNCH_PORT)
    if not port_is_free(port) and not probe_port(port):
        fail("端口 %d 已被其他进程占用" % port, "换一个 --port，或先释放该端口。")

    profile = profile_dir(args.profile)
    profile.mkdir(parents=True, exist_ok=True)

    # 第一次按默认安全策略起；只有在日志证明"环境不允许 Chrome 建自己的沙箱"时，
    # 才用 --no-sandbox 重试一次。不做无条件放宽。
    relaxed = bool(args.no_sandbox)
    process = None
    hit: Optional[Dict[str, Any]] = None
    problem = ""
    for attempt in (1, 2):
        process, hit, problem = start_attempt(
            browser,
            port,
            profile,
            args.url,
            args.headless,
            relaxed,
            args.timeout,
        )
        if hit and not problem:
            problem = settle(process, args.settle)
        if hit and not problem:
            break
        if process is not None:
            stop_process(process.pid)
        if relaxed or not sandbox_failure_detected(read_text(log_path())):
            fail(
                problem or "浏览器没有稳定跑起来",
                "Chrome 的启动日志在 %s，末尾如下：\n%s\n"
                "如果确认是本机环境不允许 Chrome 建立自己的沙箱，可以加 --no-sandbox 重试。"
                % (log_path(), log_tail(log_path())),
            )
        relaxed = True

    if not hit or process is None:
        fail("无法启动可调试的浏览器实例", "Chrome 的启动日志在 %s" % log_path())

    state = {
        "pid": process.pid,
        "port": port,
        "endpoint": hit["endpoint"],
        "browser": browser,
        "profile": str(profile),
        "url": args.url or "",
        "sandbox": "relaxed" if relaxed else "default",
    }
    write_json(state_file(), state)

    hit["status"] = "ready"
    hit["mode"] = "launch"
    hit["pid"] = process.pid
    hit["profile"] = str(profile)
    hit["sandbox"] = "relaxed" if relaxed else "default"
    hit["chrome_log"] = str(log_path())
    if relaxed:
        hit["hint"] = (
            "本机环境不允许 Chrome 建立自己的沙箱，已自动改用 --no-sandbox 重试成功。"
            "这是沙箱环境的限制，不代表浏览器本身有问题；汇报时需要说明这一点。"
            "排障结束时执行 stop 收尾。"
        )
    else:
        hit["hint"] = "排障结束时执行 stop 收尾，不要留下常驻调试端口。"
    emit(hit)


def stop_process(pid: int) -> bool:
    if not pid_alive(pid):
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    deadline = time.time() + STOP_TIMEOUT_SECONDS
    while time.time() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(POLL_INTERVAL_SECONDS)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    return True


def command_status(args: argparse.Namespace) -> None:
    state = read_json(state_file())
    pid = int(state.get("pid") or 0)
    port = int(state.get("port") or 0)
    hit = probe_port(port) if port else None

    payload: Dict[str, Any] = {
        "status": "ready" if hit else ("stale" if state else "idle"),
        "mode": "launch",
        "pid": pid,
        "pid_alive": pid_alive(pid),
        "port": port,
        "endpoint": hit["endpoint"] if hit else (state.get("endpoint") or ""),
        "browser": state.get("browser") or "",
        "profile": state.get("profile") or "",
        "sandbox": state.get("sandbox") or "",
        "chrome_log": str(log_path()),
        "state_file": str(state_file()),
    }
    payload["hint"] = (
        "实例仍在运行，可以直接连；结束时记得 stop。"
        if hit
        else "没有由本脚本启动的活跃实例；需要时先 detect 再 launch。"
    )
    emit(payload)


def command_stop(args: argparse.Namespace) -> None:
    state = read_json(state_file())
    pid = int(state.get("pid") or 0)
    profile = state.get("profile") or ""

    # 先记录真实的前置状态，否则「本来就挂了」会被误报成「本次杀掉了」。
    was_running = pid_alive(pid)
    terminated = stop_process(pid) if was_running else False

    purged = False
    if args.purge and profile:
        target = Path(profile)
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
            purged = target.exists() is False

    if state_file().exists():
        state_file().unlink()

    emit(
        {
            "status": "stopped",
            "stopped_pid": pid,
            "was_running": was_running,
            "terminated": terminated,
            "purged_profile": purged,
            "profile": profile,
            "hint": "调试端口已关闭。" if was_running else "没有找到由本脚本启动的活跃实例。",
        }
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="探测、启动、停止用于 debug-auto 的真实浏览器 CDP 实例。"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    detect = subparsers.add_parser("detect", help="探测本机已有的可调试浏览器实例")
    detect.add_argument("--port", type=int, default=None, help="额外优先探测这个端口")

    launch = subparsers.add_parser("launch", help="用真实 Chrome 内核启动一个可调试实例")
    launch.add_argument("--url", default="", help="启动后打开的目标地址")
    launch.add_argument("--port", type=int, default=None)
    launch.add_argument("--profile", default=None, help="独立的 user-data-dir，默认建在临时目录")
    launch.add_argument("--headless", action="store_true")
    launch.add_argument("--timeout", type=float, default=LAUNCH_TIMEOUT_SECONDS)
    launch.add_argument(
        "--settle",
        type=float,
        default=SETTLE_SECONDS,
        help="CDP 就绪后继续观察的秒数，用来识别「先就绪、随后崩溃」；传 0 可跳过",
    )
    launch.add_argument("--force", action="store_true", help="即使已有实例也强制另起一个")
    launch.add_argument(
        "--no-sandbox",
        action="store_true",
        help="直接以 --no-sandbox 启动（受限沙箱环境用；默认只在日志证明有必要时才自动重试）",
    )

    subparsers.add_parser("status", help="查看本脚本启动的实例状态")

    stop = subparsers.add_parser("stop", help="停止本脚本启动的实例")
    stop.add_argument("--purge", action="store_true", help="同时删除它使用的独立 profile 目录")

    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "detect":
        command_detect(args)
    elif args.command == "launch":
        command_launch(args)
    elif args.command == "status":
        command_status(args)
    else:
        command_stop(args)


if __name__ == "__main__":
    main()
