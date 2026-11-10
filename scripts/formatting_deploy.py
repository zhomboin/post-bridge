"""可选格式化服务的部署、凭据隔离与健康检查。"""

import json
import os
from pathlib import Path
import secrets
import urllib.request
import time

UNIT = "post-bridge-formatter.service"


def enabled(config):
    value = config.get("AI_FORMATTING_ENABLED", False)
    if not isinstance(value, bool):
        raise ValueError("部署 AI_FORMATTING_ENABLED 需要布尔值")
    if value and not isinstance(config.get("AI_PROVIDER_CONFIG_FILE"), str):
        raise ValueError("启用格式化需要私有模型配置文件")
    return value


def valid_manifest(value, units):
    return (
        isinstance(value, dict)
        and set(value) == {"owner", "units"}
        and value["owner"] == "post-bridge-ubuntu"
        and value["units"] in (units, [*units, UNIT])
    )


def manifest_units(deploy):
    value = json.loads((deploy.INSTALL / "installation.json").read_text())
    if not valid_manifest(value, deploy.UNITS):
        raise ValueError("部署标记不属于本项目")
    return value["units"]


def private_json(path):
    path = Path(path)
    if (
        path.is_symlink()
        or not path.is_file()
        or path.stat().st_mode & 0o077
        or path.stat().st_uid != os.geteuid()
    ):
        raise ValueError("模型配置需要管理员所有的私有普通文件")
    return json.loads(path.read_text())


def prepare(deploy, config, api_user):
    if not enabled(config):
        return
    user = deploy.service_user("formatter")
    directory = deploy.STATE / "formatter"
    deploy.directory(directory)
    os.chown(directory, user.pw_uid, user.pw_gid)
    api_token = deploy.STATE / "api/formatter-token"
    renderer_token = directory / "token"
    existing = []
    for path in (api_token, renderer_token):
        if path.is_symlink():
            raise ValueError("渲染凭据不能是符号链接")
        if path.exists():
            if not path.is_file() or path.stat().st_mode & 0o077:
                raise ValueError("已有渲染凭据必须为私有普通文件")
            existing.append(path.read_text().strip())
    if existing and (len(set(existing)) != 1 or len(existing[0]) < 32):
        raise ValueError("已有渲染凭据不一致，未覆盖")
    token = existing[0] if existing else secrets.token_urlsafe(32)
    for path, owner in ((api_token, api_user), (renderer_token, user)):
        if not path.exists():
            deploy.write_private(path, token)
        os.chown(path, owner.pw_uid, owner.pw_gid)
    private_json(config["AI_PROVIDER_CONFIG_FILE"])


def copy_provider(deploy, config):
    if not enabled(config):
        return
    provider = private_json(config["AI_PROVIDER_CONFIG_FILE"])
    key_path = Path(provider.get("api_key_file", ""))
    if (
        key_path.is_symlink()
        or not key_path.is_file()
        or key_path.stat().st_mode & 0o077
        or key_path.stat().st_uid != os.geteuid()
    ):
        raise ValueError("DeepSeek 密钥需要管理员所有的私有普通文件")
    key = key_path.read_text().strip()
    if not key or len(key) > 4096 or any(char in key for char in "\r\n\0"):
        raise ValueError("DeepSeek 密钥格式无效")
    user = deploy.service_user("api")
    target = deploy.STATE / "api/deepseek-key"
    deploy.write_private(target, key)
    os.chown(target, user.pw_uid, user.pw_gid)
    provider["api_key_file"] = str(target)
    target = deploy.STATE / "api/deepseek-config.json"
    deploy.write_private(target, json.dumps(provider, ensure_ascii=False))
    os.chown(target, user.pw_uid, user.pw_gid)


def api_environment(deploy, config):
    if not enabled(config):
        return {}
    return {
        "AI_FORMATTING_ENABLED": "true",
        "AI_PROVIDER_CONFIG_FILE": str(deploy.STATE / "api/deepseek-config.json"),
        "FORMATTER_URL": "http://127.0.0.1:18082",
        "FORMATTER_TOKEN_FILE": str(deploy.STATE / "api/formatter-token"),
    }


def environment(deploy):
    return {
        "FORMATTER_ADDR": "127.0.0.1:18082",
        "FORMATTER_TOKEN_FILE": str(deploy.STATE / "formatter/token"),
        "PLAYWRIGHT_BROWSERS_PATH": str(deploy.BROWSERS),
        "HOME": str(deploy.STATE / "formatter"),
        "LANG": "C.UTF-8",
    }


def health(deploy):
    token = (deploy.STATE / "api/formatter-token").read_text().strip()
    request = urllib.request.Request(
        "http://127.0.0.1:18082/healthz",
        headers={"Authorization": "Bearer " + token},
    )
    until = time.monotonic() + 15
    while True:
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        if time.monotonic() >= until:
            raise RuntimeError("格式化服务健康检查失败")
        time.sleep(0.2)
