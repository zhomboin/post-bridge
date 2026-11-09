"""用独立合成服务验证 systemd 生命周期，不连接数据库或平台账号。"""

import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]


def wait_for(predicate, timeout=25):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(0.15)
    raise RuntimeError("独立 systemd 合成检查超时")


def alive(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().split(") ")[1].split()[0] != "Z"
    except OSError:
        return False


def fixture(kind, directory, port):
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        raise RuntimeError("合成服务不应依赖桌面显示")
    if kind == "api":

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200 if self.path == "/healthz" else 404)
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')

            def log_message(self, *args):
                pass

        HTTPServer(("127.0.0.1", port), Handler).serve_forever()
    else:
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
        (directory / "child.pid").write_text(str(child.pid))
        while True:
            time.sleep(1)


def smoke(system=False):
    spec = importlib.util.spec_from_file_location(
        "ubuntu_deploy", ROOT / "scripts/ubuntu_deploy.py"
    )
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)
    identifier = "post-bridge-smoke-" + uuid.uuid4().hex[:12]
    base = (
        Path("/run")
        if system
        else Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))
    )
    directory = Path(tempfile.mkdtemp(prefix=identifier + "-", dir=base))
    directory.chmod(0o755)
    script = directory / "fixture.py"
    shutil.copy2(__file__, script)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    unit_root = (
        Path("/run/systemd/system") if system else Path.home() / ".config/systemd/user"
    )
    unit_root.mkdir(parents=True, exist_ok=True)
    names = [identifier + "-" + kind + ".service" for kind in ["api", "worker"]]
    prefix = ["systemctl"] + ([] if system else ["--user"])

    def control(*args, check=True):
        return subprocess.run(
            [*prefix, *args],
            check=check,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ).stdout.strip()

    def main_pid(name):
        return int(control("show", name, "--property=MainPID", "--value") or "0")

    sentinel = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    known_children = []
    try:
        for kind, name in zip(["api", "worker"], names):
            lines = []
            for line in deploy.render_unit(kind).splitlines():
                if line.startswith(
                    ("User=", "Group=", "EnvironmentFile=", "ReadWritePaths=")
                ):
                    continue
                if line.startswith("WorkingDirectory="):
                    line = "WorkingDirectory=" + str(directory)
                elif line.startswith("ExecStart="):
                    line = f"ExecStart={sys.executable} {script} --fixture {kind} --directory {directory} --port {port}"
                elif line.startswith(("Requires=", "PartOf=")):
                    line = line.split("=")[0] + "=" + names[0]
                elif line.startswith("After="):
                    line = (
                        "After=" + names[0]
                        if kind == "worker"
                        else "After=default.target"
                    )
                elif line == "RestartSec=5":
                    line = "RestartSec=1"
                elif not system and line.startswith(
                    ("ProtectHome=", "ProtectSystem=", "PrivateTmp=")
                ):
                    line = line.split("=")[0] + "=false"
                elif line == "WantedBy=multi-user.target":
                    line = "WantedBy=default.target"
                lines.append(line)
            lines += [
                "",
                "[Service]",
                "UnsetEnvironment=DISPLAY WAYLAND_DISPLAY",
                "ReadWritePaths=" + str(directory),
            ]
            (unit_root / name).write_text("\n".join(lines) + "\n", encoding="utf-8")
        verify = (
            ["systemd-analyze"]
            + ([] if system else ["--user"])
            + ["verify", *[str(unit_root / name) for name in names]]
        )
        subprocess.run(
            verify, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        control("daemon-reload")
        control("start", *names)

        def healthy():
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/healthz", timeout=0.5
                ) as response:
                    return response.status == 200
            except OSError:
                return False

        wait_for(healthy)
        marker = directory / "child.pid"
        wait_for(marker.exists)
        first_child = int(marker.read_text())
        known_children.append(first_child)
        old_pid = main_pid(names[1])
        if old_pid <= 1:
            raise RuntimeError("未找到独立执行器进程")
        os.kill(old_pid, signal.SIGKILL)
        wait_for(lambda: main_pid(names[1]) > 1 and main_pid(names[1]) != old_pid)
        wait_for(lambda: marker.exists() and int(marker.read_text()) != first_child)
        known_children.append(int(marker.read_text()))
        wait_for(lambda: not alive(first_child))
        if int(control("show", names[1], "--property=NRestarts", "--value")) < 1:
            raise RuntimeError("没有观察到崩溃自动重启")
        second_child = known_children[-1]
        control("restart", names[0])
        wait_for(healthy)
        wait_for(lambda: marker.exists() and int(marker.read_text()) != second_child)
        known_children.append(int(marker.read_text()))
        wait_for(lambda: not alive(second_child))
        control("stop", *reversed(names))
        wait_for(lambda: all(not alive(pid) for pid in known_children))
        if sentinel.poll() is not None:
            raise RuntimeError("停止独立服务影响了无关进程")
        print(
            "独立 systemd API/worker 启动、健康、崩溃重启、API 重启及 cgroup 停止通过。"
        )
    finally:
        control("stop", *reversed(names), check=False)
        control("reset-failed", *names, check=False)
        for name in names:
            (unit_root / name).unlink(missing_ok=True)
        control("daemon-reload", check=False)
        sentinel.terminate()
        sentinel.wait(timeout=5)
        # 目录由本次检查随机创建；从不清理生产目录或其他服务。
        if directory.parent == base and directory.name.startswith(identifier + "-"):
            shutil.rmtree(directory)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="独立 systemd 生命周期检查，不操作现有后台或数据库"
    )
    parser.add_argument(
        "--system", action="store_true", help="CI 的系统级合成检查；需要管理员权限"
    )
    parser.add_argument("--fixture", choices=["api", "worker"], help=argparse.SUPPRESS)
    parser.add_argument("--directory", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.fixture:
        fixture(args.fixture, args.directory, args.port)
    else:
        smoke(args.system)
