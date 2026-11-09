"""多平台账号的运行配置隔离测试，只使用合成路径。"""

import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


def module(file):
    spec = importlib.util.spec_from_file_location("accounts_config_test", ROOT / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class PlatformAccountDeploymentTests(unittest.TestCase):
    def test_role_specific_account_files(self):
        deploy = module("scripts/ubuntu_deploy.py")
        config = {
            "DATABASE_URL": "postgres://bridge:synthetic@localhost/bridge",
            "PUBLIC_ORIGIN": "https://bridge.example.org",
            "ADMIN_USERNAME": "admin",
            "CSDN_USERNAME": "synthetic",
            "CSDN_DISPLAY_NAME": "合成账号",
            "API_PLATFORM_ACCOUNTS_FILE": str(deploy.STATE / "api/accounts.json"),
            "WORKER_PLATFORM_ACCOUNTS_FILE": str(deploy.STATE / "worker/accounts.json"),
        }
        api, worker = deploy.environments(deploy.validate_config(config))
        self.assertEqual(
            api["PLATFORM_ACCOUNTS_FILE"], config["API_PLATFORM_ACCOUNTS_FILE"]
        )
        self.assertEqual(
            worker["PLATFORM_ACCOUNTS_FILE"], config["WORKER_PLATFORM_ACCOUNTS_FILE"]
        )
        self.assertNotIn("DATABASE_URL", worker)
        for changed in [
            {"WORKER_PLATFORM_ACCOUNTS_FILE": "/tmp/accounts.json"},
            {"API_PLATFORM_ACCOUNTS_FILE": str(deploy.STATE / "worker/accounts.json")},
            {"WORKER_PLATFORM_ACCOUNTS_FILE": "relative"},
        ]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                deploy.validate_config({**config, **changed})
        del config["API_PLATFORM_ACCOUNTS_FILE"]
        with self.assertRaises(ValueError):
            deploy.validate_config(config)

    def test_local_runtime_passes_account_config_only_to_services(self):
        runtime = module("scripts/runtime.py")
        config = {
            "PLATFORM_ACCOUNTS_FILE": "/private/synthetic/accounts.json",
            "DATABASE_URL": "private-db",
            "INTEGRATION_MASTER_KEY_FILE": "/private/master",
        }
        self.assertEqual(
            runtime.child_env(config)["PLATFORM_ACCOUNTS_FILE"],
            config["PLATFORM_ACCOUNTS_FILE"],
        )
        worker = runtime.child_env(config, worker=True)
        self.assertEqual(
            worker["PLATFORM_ACCOUNTS_FILE"], config["PLATFORM_ACCOUNTS_FILE"]
        )
        self.assertNotIn("DATABASE_URL", worker)
        self.assertNotIn("INTEGRATION_MASTER_KEY_FILE", worker)
