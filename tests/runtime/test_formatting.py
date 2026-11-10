"""AI 格式化的私有配置、服务隔离和回退边界。"""

import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FormattingRuntimeTests(unittest.TestCase):
    def test_local_key_is_api_only(self):
        runtime = load("formatting_local_runtime", "scripts/runtime.py")
        config = {
            "AI_FORMATTING_ENABLED": "true",
            "FORMATTER_URL": "http://127.0.0.1:18082",
            "FORMATTER_TOKEN_FILE": "/private/token",
        }
        with (
            patch.object(runtime, "base_env", return_value={}),
            patch.dict(os.environ, {"DEEPSEEK_API": "synthetic"}),
        ):
            api = runtime.child_env(config)
            worker = runtime.child_env(config, worker=True)
            renderer = runtime.formatting_runtime.formatter_env(config, lambda: {})
        self.assertEqual(api["DEEPSEEK_API"], "synthetic")
        for env in (worker, renderer):
            self.assertNotIn("DEEPSEEK_API", env)
            self.assertNotIn("AI_PROVIDER_CONFIG_FILE", env)

    def test_preparation_reuses_private_token_and_rejects_symlink(self):
        runtime = load("formatting_tokens", "scripts/runtime.py")
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            config = {"AI_FORMATTING_ENABLED": True}
            first = runtime.formatting_runtime.prepare(
                state, config, runtime.private_write
            )
            token = Path(first["FORMATTER_TOKEN_FILE"])
            before = token.read_bytes()
            runtime.formatting_runtime.prepare(state, config, runtime.private_write)
            self.assertEqual(before, token.read_bytes())
            self.assertEqual(token.stat().st_mode & 0o777, 0o600)
            other = state / "linked"
            other.symlink_to(token)
            with self.assertRaises(ValueError):
                runtime.formatting_runtime.prepare(
                    state,
                    {**config, "FORMATTER_TOKEN_FILE": str(other)},
                    runtime.private_write,
                )

    def test_deployment_feature_is_explicit_and_separate(self):
        deploy = load("formatting_deployment", "scripts/ubuntu_deploy.py")
        config = {
            "AI_FORMATTING_ENABLED": True,
            "AI_PROVIDER_CONFIG_FILE": "/private/provider",
        }
        base = {
            "DATABASE_URL": "postgresql://bridge:synthetic@127.0.0.1:5432/bridge",
            "PUBLIC_ORIGIN": "https://bridge.example.org",
            "ADMIN_USERNAME": "admin",
            "CSDN_USERNAME": "fixture",
            "CSDN_DISPLAY_NAME": "合成账号",
        }
        self.assertEqual(
            deploy.validate_config({**base, **config})["AI_FORMATTING_ENABLED"], True
        )
        env = deploy.formatting_deploy.api_environment(
            SimpleNamespace(STATE=Path("/private")), config
        )
        self.assertIn("AI_PROVIDER_CONFIG_FILE", env)
        renderer = deploy.formatting_deploy.environment(
            SimpleNamespace(STATE=Path("/private"), BROWSERS=Path("/browsers"))
        )
        self.assertNotIn("DATABASE_URL", renderer)
        self.assertNotIn("DEEPSEEK_API", renderer)
        unit = deploy.render_unit("formatter")
        self.assertIn("KillMode=control-group", unit)
        self.assertNotIn("worker.env", unit)

    def test_managed_marker_accepts_only_declared_optional_service(self):
        deploy = load("formatting_markers", "scripts/ubuntu_deploy.py")
        for units in (deploy.UNITS, [*deploy.UNITS, deploy.formatting_deploy.UNIT]):
            self.assertTrue(
                deploy.formatting_deploy.valid_manifest(
                    {"owner": "post-bridge-ubuntu", "units": units}, deploy.UNITS
                )
            )
        self.assertFalse(
            deploy.formatting_deploy.valid_manifest(
                {
                    "owner": "post-bridge-ubuntu",
                    "units": [*deploy.UNITS, "other.service"],
                },
                deploy.UNITS,
            )
        )

    def test_private_provider_files_are_reused_without_overwriting(self):
        config = load("formatting_config_fixture", "scripts/formatting_config.py")
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "provider"
            path = config.write_provider(folder, "synthetic-only", "deepseek-flash")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual((folder / "deepseek-key").stat().st_mode & 0o777, 0o600)
            before = path.read_bytes()
            config.write_provider(folder, "synthetic-only", "deepseek-flash")
            self.assertEqual(path.read_bytes(), before)
            with self.assertRaises(ValueError):
                config.write_provider(folder, "different-synthetic", "deepseek-flash")
            self.assertEqual((folder / "deepseek-key").read_text(), "synthetic-only")
            with self.assertRaises(ValueError):
                config.write_provider(
                    ROOT / ".local-tmp/model", "synthetic-only", "deepseek-flash"
                )

    def test_optional_service_and_key_are_restored_after_upgrade_failure(self):
        deploy = load("formatting_restore", "scripts/ubuntu_deploy.py")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            units = root / "units"
            units.mkdir()
            for unit in [*deploy.UNITS, deploy.formatting_deploy.UNIT]:
                (units / unit).write_text("synthetic-unit")
            key = root / "key"
            key.write_text("previous-synthetic")
            snapshot = deploy.snapshot_files([key])
            key.write_text("changed-synthetic")
            states = {
                unit: {"active": True, "enabled": "enabled"}
                for unit in [*deploy.UNITS, deploy.formatting_deploy.UNIT]
            }
            with (
                patch.object(deploy, "SYSTEMD", units),
                patch.object(deploy, "systemctl", return_value="active") as control,
                patch.object(deploy, "activate_release"),
                patch.object(deploy, "health"),
                patch.object(deploy, "login_control_health"),
                patch.object(deploy.formatting_deploy, "health") as formatter_health,
            ):
                deploy.restore_deployment(snapshot, root / "previous", states)
            self.assertEqual(key.read_text(), "previous-synthetic")
            formatter_health.assert_called_once()
            starts = [
                call.args for call in control.call_args_list if call.args[0] == "start"
            ]
            self.assertEqual(
                starts,
                [
                    ("start", deploy.formatting_deploy.UNIT),
                    ("start", deploy.UNITS[0]),
                    ("start", deploy.UNITS[1]),
                ],
            )

    def test_insecure_model_configuration_is_rejected(self):
        deploy = load("formatting_private_config", "scripts/ubuntu_deploy.py")
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "provider.json"
            path.write_text(json.dumps({"model": "deepseek-flash"}))
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                deploy.formatting_deploy.private_json(path)
            path.chmod(0o600)
            self.assertEqual(
                deploy.formatting_deploy.private_json(path)["model"], "deepseek-flash"
            )
