"""可选 AI 格式化的本地进程与私有环境。"""

from pathlib import Path
import secrets
import urllib.parse
import urllib.request
import time


API_KEYS = (
    "AI_FORMATTING_ENABLED",
    "AI_PROVIDER_CONFIG_FILE",
    "FORMATTER_URL",
    "FORMATTER_TOKEN_FILE",
)
FORMATTER_KEYS = (
    "FORMATTER_ADDR",
    "FORMATTER_TOKEN_FILE",
    "PLAYWRIGHT_BROWSERS_PATH",
    "FORMATTER_FONT_FILE",
    "FORMATTER_CODE_FONT_FILE",
)


def enabled(config):
    value = config.get("AI_FORMATTING_ENABLED", False)
    if not isinstance(value, (bool, str)) or value not in (
        True,
        False,
        "true",
        "false",
    ):
        raise ValueError("AI_FORMATTING_ENABLED 只能为布尔值")
    return value in (True, "true")


def prepare(state, config, private_write):
    if not enabled(config):
        return config
    value = dict(config)
    token = Path(value.get("FORMATTER_TOKEN_FILE", state / "formatter-token"))
    if token.is_symlink():
        raise ValueError("渲染凭据不能是符号链接")
    if not token.exists():
        if token.parent.resolve() != state.resolve():
            raise ValueError("外部渲染凭据必须由管理员预先准备")
        private_write(token, secrets.token_urlsafe(32))
    if not token.is_file() or token.stat().st_mode & 0o077:
        raise ValueError("渲染凭据必须为私有普通文件")
    value["AI_FORMATTING_ENABLED"] = "true"
    value["FORMATTER_TOKEN_FILE"] = str(token)
    value.setdefault("FORMATTER_ADDR", "127.0.0.1:18082")
    value.setdefault("FORMATTER_URL", "http://" + value["FORMATTER_ADDR"])
    url = urllib.parse.urlsplit(value["FORMATTER_URL"])
    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port:
        raise ValueError("渲染服务必须使用本机回环地址")
    return value


def formatter_env(config, base_env):
    env = base_env()
    env.update({key: str(config[key]) for key in FORMATTER_KEYS if key in config})
    return env


def health(config, timeout=2):
    token = Path(config["FORMATTER_TOKEN_FILE"]).read_text().strip()
    request = urllib.request.Request(
        config["FORMATTER_URL"].rstrip("/") + "/healthz",
        headers={"Authorization": "Bearer " + token},
    )
    until = time.monotonic() + 10
    while True:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        if time.monotonic() >= until:
            raise RuntimeError("渲染服务尚未就绪")
        time.sleep(0.2)
