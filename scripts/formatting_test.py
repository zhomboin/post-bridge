"""启动隔离排版服务运行测试，不接触平台账号或真实模型。"""

import argparse
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def run(command):
    with tempfile.TemporaryDirectory(prefix="post-bridge-formatter-test-") as folder:
        token = secrets.token_urlsafe(32)
        token_file = Path(folder) / "renderer-token"
        token_file.write_text(token)
        token_file.chmod(0o600)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.environ["HOME"],
            "FORMATTER_ADDR": f"127.0.0.1:{port}",
            "FORMATTER_TOKEN_FILE": str(token_file),
        }
        for key in (
            "PLAYWRIGHT_BROWSERS_PATH",
            "FORMATTER_FONT_FILE",
            "FORMATTER_CODE_FONT_FILE",
        ):
            if key in os.environ:
                env[key] = os.environ[key]
        child = subprocess.Popen(
            ["node", "apps/formatter/dist/main.js"],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            url = f"http://127.0.0.1:{port}"
            request = urllib.request.Request(
                url + "/healthz", headers={"Authorization": "Bearer " + token}
            )
            until = time.monotonic() + 15
            while True:
                if child.poll() is not None:
                    raise RuntimeError("测试排版服务未启动")
                try:
                    with urllib.request.urlopen(request, timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    pass
                if time.monotonic() >= until:
                    raise RuntimeError("测试排版服务未就绪")
                time.sleep(0.1)
            test_env = dict(
                os.environ, TEST_FORMATTER_URL=url, TEST_FORMATTER_TOKEN=token
            )
            # CI 与默认验证不允许意外发起付费模型请求。
            test_env.pop("TEST_DEEPSEEK_REAL_KEY", None)
            return subprocess.call(command, cwd=ROOT, env=test_env)
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


def main():
    parser = argparse.ArgumentParser(description="运行带隔离排版服务的合成测试")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not args.command:
        parser.error("需要测试命令")
    raise SystemExit(run(args.command))


if __name__ == "__main__":
    main()
