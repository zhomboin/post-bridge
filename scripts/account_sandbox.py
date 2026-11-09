"""为项目专用 bubblewrap 配置应用级用户命名空间权限，不调整全局策略。"""

import argparse
import grp
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess

MARKER = "post-bridge-account-sandbox\n"


def policy_text(binary):
    path = str(Path(binary))
    if (
        not re.fullmatch(r"/[A-Za-z0-9_./-]+", path)
        or str(Path(path).resolve()) != path
    ):
        raise ValueError("沙箱执行文件路径必须为规范绝对路径")
    name = "post-bridge-account-" + hashlib.sha256(path.encode()).hexdigest()[:16]
    text = (
        "abi <abi/4.0>,\ninclude <tunables/global>\n\n"
        f'profile {name} "{path}" flags=(unconfined) {{\n  userns,\n}}\n'
    )
    return name, text


def validate_directory(root):
    if not root.is_absolute() or root.resolve() != root:
        raise ValueError("沙箱目录不能经过符号链接")
    if root.exists() and any(root.iterdir()):
        marker = root / ".post-bridge-owner"
        if marker.is_symlink() or not marker.is_file() or marker.read_text() != MARKER:
            raise ValueError("沙箱目录不属于本项目，未覆盖")
    if root.exists() and (root.stat().st_uid != 0 or root.stat().st_mode & 0o022):
        raise ValueError("沙箱目录必须为 root 所有且其他用户不可写")
    for name in ["bwrap", ".post-bridge-owner"]:
        path = root / name
        if (
            path.is_symlink()
            or path.exists()
            and (
                not path.is_file()
                or path.stat().st_uid != 0
                or path.stat().st_nlink != 1
                or path.stat().st_mode & 0o022
            )
        ):
            raise ValueError("沙箱文件不能为符号链接")


def install(root, group_id, policy_directory=Path("/etc/apparmor.d")):
    validate_directory(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o750)
    os.chown(root, 0, group_id)
    root.chmod(0o750)
    marker = root / ".post-bridge-owner"
    marker.write_text(MARKER, encoding="utf-8")
    marker.chmod(0o640)
    source = Path("/usr/bin/bwrap")
    if (
        not source.is_file()
        or source.stat().st_uid != 0
        or source.stat().st_mode & 0o022
    ):
        raise ValueError("系统 bubblewrap 必须为 root 管理的可信文件")
    binary = root / "bwrap"
    shutil.copyfile(source, binary)
    os.chown(binary, 0, group_id)
    binary.chmod(0o750)
    name, text = policy_text(binary)
    enabled = Path("/sys/module/apparmor/parameters/enabled")
    if enabled.exists() and enabled.read_text().strip() == "Y":
        policy = policy_directory / name
        if (
            policy.is_symlink()
            or policy.exists()
            and (
                not policy.is_file()
                or policy.stat().st_uid != 0
                or policy.stat().st_nlink != 1
                or policy.stat().st_mode & 0o022
                or policy.read_text() != text
            )
        ):
            raise ValueError("已有同名 AppArmor 策略不一致，未覆盖")
        policy.write_text(text, encoding="utf-8")
        policy.chmod(0o644)
        subprocess.run(["apparmor_parser", "-r", str(policy)], check=True)
    return binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--ci", action="store_true")
    mode.add_argument("--deploy", action="store_true")
    mode.add_argument("--local", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("准备账号沙箱需要管理员权限")
    if args.ci:
        if os.environ.get("GITHUB_ACTIONS") != "true":
            raise ValueError("CI 入口仅用于 GitHub 临时执行环境")
        group_id = int(os.environ["SUDO_GID"])
        root = Path("/usr/local/lib/post-bridge-ci-account-sandbox")
    elif args.deploy:
        group_id = grp.getgrnam("post-bridge-worker").gr_gid
        root = Path("/opt/post-bridge/tools/account-sandbox")
    else:
        group_id = int(os.environ["SUDO_GID"])
        if group_id == 0:
            raise ValueError("本地入口需由普通开发用户通过 sudo 调用")
        root = Path("/usr/local/lib") / (
            "post-bridge-local-account-sandbox-" + str(group_id)
        )
    binary = install(root, group_id)
    if args.ci:
        with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as stream:
            stream.write("ACCOUNT_SANDBOX_EXECUTABLE=" + str(binary) + "\n")
    print("项目账号沙箱已准备：" + str(binary))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit(
            "账号沙箱配置失败，请核对专用目录、用户组与 AppArmor：" + str(error)
        )
