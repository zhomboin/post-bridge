"""在用户选择的仓库外状态目录启用 DeepSeek 格式化。"""

import argparse
import json
import os
from pathlib import Path
import sys

try:
    import runtime
except ModuleNotFoundError:
    from scripts import runtime


def write_provider(state, key, model):
    state = runtime.check_state(state)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if (
        not state.is_dir()
        or state.stat().st_mode & 0o077
        or state.stat().st_uid != os.geteuid()
    ):
        raise ValueError("模型配置目录需要当前用户所有且权限为 0700")
    key = key.strip()
    if not key or len(key) > 4096 or any(char in key for char in "\r\n\0"):
        raise ValueError("未取得有效 DeepSeek 凭据")
    if not model.strip() or len(model) > 100 or any(char in model for char in "\r\n\0"):
        raise ValueError("模型名称无效")
    key_file = state / "deepseek-key"
    provider_file = state / "deepseek-config.json"
    provider = {"api_key_file": str(key_file), "model": model}
    for path in (key_file, provider_file):
        if (
            path.is_symlink()
            or path.exists()
            and (not path.is_file() or path.stat().st_mode & 0o077)
        ):
            raise ValueError("已有模型配置必须是私有普通文件")
    if key_file.exists() and key_file.read_text().strip() != key:
        raise ValueError("已有模型密钥不同，未覆盖；请按私有凭据轮换流程处理")
    if provider_file.exists() and json.loads(provider_file.read_text()) != provider:
        raise ValueError("已有模型配置不同，未覆盖；请在私有配置中明确调整")
    if not key_file.exists():
        runtime.private_write(key_file, key)
    if not provider_file.exists():
        runtime.private_write(provider_file, json.dumps(provider, ensure_ascii=False))
    return provider_file


def configure(state, key, model="deepseek-flash"):
    state = runtime.check_state(state)
    config_file = state / "runtime.json"
    config = runtime.configuration(state)
    if any(runtime.status(state).values()):
        raise ValueError("请先停止该状态目录的项目进程，再配置格式化")
    provider_file = write_provider(state, key, model)
    config.update(
        {"AI_FORMATTING_ENABLED": True, "AI_PROVIDER_CONFIG_FILE": str(provider_file)}
    )
    # configuration() 的展示路径可由启动器重新计算，持久配置保留其他原有字段。
    runtime.private_write(config_file, json.dumps(config, ensure_ascii=False, indent=2))
    print("DeepSeek 格式化已配置；未输出密钥。")


def main():
    parser = argparse.ArgumentParser(
        description="从已有环境凭据启用可选 DeepSeek 格式化，不输出密钥"
    )
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--state")
    target.add_argument("--provider-dir")
    parser.add_argument("--model", default="deepseek-flash")
    parser.add_argument("--key-stdin", action="store_true")
    args = parser.parse_args()
    key = (
        sys.stdin.read()
        if args.key_stdin
        else os.environ.get("DEEPSEEK_API", os.environ.get("DEEPSEEK_API_KEY", ""))
    )
    if args.provider_dir:
        write_provider(args.provider_dir, key, args.model)
        print("私有模型配置已准备；未启用服务，未输出密钥。")
    else:
        configure(args.state, key, args.model)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError):
        print(
            "格式化配置未完成：请检查专属状态目录、停止状态和私有凭据；未输出凭据。",
            file=sys.stderr,
        )
        sys.exit(1)
