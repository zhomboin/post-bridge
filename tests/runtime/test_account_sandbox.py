"""账号沙箱系统策略准备测试，不修改宿主策略或专属执行文件。"""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "account_sandbox", Path(__file__).parents[2] / "scripts/account_sandbox.py"
)


class AccountSandboxTests(unittest.TestCase):
    def load(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        return module

    def test_policy_attaches_only_to_private_executable(self):
        sandbox = self.load()
        path = Path("/opt/post-bridge/tools/account-sandbox/bwrap")
        name, text = sandbox.policy_text(path)
        self.assertRegex(name, r"^post-bridge-account-[a-f0-9]{16}$")
        self.assertIn(str(path), text)
        self.assertIn("userns,", text)
        self.assertNotIn("/usr/bin/bwrap", text)
        self.assertNotIn("sysctl", text)
        self.assertEqual(sandbox.policy_text(path), (name, text))

    def test_policy_rejects_path_injection(self):
        sandbox = self.load()
        for path in [
            "relative/bwrap",
            "/tmp/../bwrap",
            '/tmp/injected"{}',
            "/tmp/name\nfile",
        ]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                sandbox.policy_text(path)

    def test_unowned_directory_and_symlinks_are_preserved(self):
        sandbox = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sentinel = root / "unrelated"
            sentinel.write_text("retained")
            with self.assertRaises(ValueError):
                sandbox.validate_directory(root)
            self.assertEqual(sentinel.read_text(), "retained")
            link = root / "link"
            link.symlink_to(sentinel)
            with self.assertRaises(ValueError):
                sandbox.validate_directory(link)

    def test_ci_entry_cannot_run_on_local_machine(self):
        sandbox = self.load()
        with (
            patch.object(sandbox.os, "geteuid", return_value=0),
            patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}),
            patch("sys.argv", ["account_sandbox.py", "--ci"]),
            patch.object(sandbox, "install") as install,
        ):
            with self.assertRaises(ValueError):
                sandbox.main()
            install.assert_not_called()

    def test_local_entry_requires_a_non_root_caller(self):
        sandbox = self.load()
        with (
            patch.object(sandbox.os, "geteuid", return_value=0),
            patch.dict(os.environ, {"SUDO_GID": "0"}),
            patch("sys.argv", ["account_sandbox.py", "--local"]),
            patch.object(sandbox, "install") as install,
        ):
            with self.assertRaises(ValueError):
                sandbox.main()
            install.assert_not_called()


if __name__ == "__main__":
    unittest.main()
