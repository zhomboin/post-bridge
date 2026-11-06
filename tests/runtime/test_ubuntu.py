"""Ubuntu 部署边界测试；不触碰现有系统服务或真实账号。"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('ubuntu_deploy', ROOT / 'scripts/ubuntu_deploy.py')


class UbuntuDeploymentTests(unittest.TestCase):
    def load(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        return module

    def config(self):
        return {'DATABASE_URL': 'postgresql://bridge:synthetic@127.0.0.1:5432/bridge',
                'PUBLIC_ORIGIN': 'https://bridge.example.org', 'ADMIN_USERNAME': 'admin',
                'CSDN_USERNAME': 'fixture', 'CSDN_DISPLAY_NAME': '合成账号'}

    def test_public_origin_and_database_must_be_explicit_and_safe(self):
        deploy = self.load()
        self.assertEqual(deploy.validate_config(self.config())['PUBLIC_ORIGIN'], 'https://bridge.example.org')
        for key, value in [('PUBLIC_ORIGIN', 'http://bridge.example.org'),
                           ('PUBLIC_ORIGIN', 'https://bridge.example.org/path'),
                           ('PUBLIC_ORIGIN', 'https://secret@bridge.example.org'),
                           ('DATABASE_URL', 'postgresql://bridge:password@localhost/postgres'),
                           ('CSDN_DISPLAY_NAME', '账号\nEVIL=1')]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                deploy.validate_config({**self.config(), key: value})

    def test_environment_keeps_public_origin_separate_and_worker_has_no_database(self):
        deploy = self.load()
        api, worker = deploy.environments(self.config())
        self.assertEqual(api['PUBLIC_ORIGIN'], 'https://bridge.example.org')
        self.assertEqual(api['API_BASE_URL'], 'http://127.0.0.1:18080')
        self.assertEqual(api['REMOTE_LOGIN_URL'], 'http://127.0.0.1:18081')
        self.assertEqual(worker['API_BASE_URL'], 'http://127.0.0.1:18080')
        self.assertEqual(worker['LOGIN_CONTROL_ADDR'], '127.0.0.1:18081')
        self.assertEqual(worker['WORKER_HEADLESS'], 'true')
        self.assertEqual(worker['PLAYWRIGHT_BROWSERS_PATH'], '/var/cache/post-bridge/ms-playwright')
        self.assertNotIn('DATABASE_URL', worker)
        self.assertNotIn('ADMIN_PASSWORD_FILE', worker)
        self.assertNotIn('DISPLAY', worker)

    def test_upgrade_keeps_all_existing_secrets_and_profile(self):
        deploy = self.load()
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            deploy.ensure_secrets(state)
            profile = state / 'worker/profile'
            profile.mkdir(mode=0o700)
            (profile / 'fixture').write_text('synthetic')
            before = {path.relative_to(state): path.read_bytes() for path in state.rglob('*') if path.is_file()}
            deploy.ensure_secrets(state)
            self.assertEqual(before, {path.relative_to(state): path.read_bytes() for path in state.rglob('*') if path.is_file()})
            for path in [state / 'api/admin-password', state / 'api/worker-token', state / 'worker/worker-token']:
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual((state / 'api/worker-token').read_bytes(), (state / 'worker/worker-token').read_bytes())

    def test_symlink_secret_is_rejected_without_touching_target(self):
        deploy = self.load()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / 'target'
            target.write_text('unchanged')
            link = root / 'link'
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                deploy.write_private(link, 'changed')
            self.assertEqual(target.read_text(), 'unchanged')

    def test_atomic_activation_preserves_old_release_and_rejects_directory(self):
        deploy = self.load()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, new = root / 'releases/old', root / 'releases/new'
            old.mkdir(parents=True)
            new.mkdir()
            deploy.activate_release(root, old)
            deploy.activate_release(root, new)
            self.assertEqual((root / 'current').resolve(), new)
            self.assertTrue(old.is_dir())
            (root / 'current').unlink()
            (root / 'current').mkdir()
            with self.assertRaises(ValueError):
                deploy.activate_release(root, new)

    def test_service_units_are_foreground_and_stop_only_their_control_group(self):
        deploy = self.load()
        for kind in ['api', 'worker']:
            unit = deploy.render_unit(kind)
            self.assertIn('Type=simple', unit)
            self.assertIn('Restart=on-failure', unit)
            self.assertIn('KillMode=control-group', unit)
            self.assertIn('TimeoutStopSec=90', unit)
            self.assertIn('EnvironmentFile=/etc/post-bridge/' + kind + '.env', unit)
            self.assertIn('User=post-bridge-' + kind, unit)
            self.assertNotIn('runtime.py', unit)
            self.assertNotIn('ExecStop=', unit)
        self.assertIn('dist/main.js', deploy.render_unit('worker'))

    def test_nginx_hides_internal_controls_and_disables_login_frame_caches(self):
        template = (ROOT / 'deploy/nginx/post-bridge.conf').read_text()
        self.assertIn('127.0.0.1:18080', template)
        self.assertIn('location ^~ /internal/', template)
        self.assertIn('return 404;', template)
        self.assertIn('location ^~ /api/account/login', template)
        self.assertIn('proxy_no_cache 1;', template)
        self.assertIn('access_log off;', template)
        self.assertNotIn('18081', template)

    def test_mismatched_existing_tokens_are_not_overwritten(self):
        deploy = self.load()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            deploy.ensure_secrets(root)
            token = root / 'worker/worker-token'
            token.write_text('different-existing-token')
            before = (root / 'api/worker-token').read_bytes()
            with self.assertRaises(ValueError):
                deploy.ensure_secrets(root)
            self.assertEqual(token.read_text(), 'different-existing-token')
            self.assertEqual((root / 'api/worker-token').read_bytes(), before)

    def test_unregistered_installation_cannot_stop_matching_service_names(self):
        deploy = self.load()
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(deploy, 'INSTALL', Path(temp)), patch.object(deploy, 'systemctl') as control:
                with self.assertRaises(ValueError):
                    deploy.assert_managed()
                control.assert_not_called()

    def test_plaintext_world_readable_configuration_is_rejected(self):
        deploy = self.load()
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / 'install.json'
            config.write_text(json.dumps(self.config()))
            config.chmod(0o644)
            with self.assertRaises(ValueError):
                deploy.load_config(config)
            config.chmod(0o600)
            self.assertEqual(deploy.load_config(config)['CSDN_USERNAME'], 'fixture')
    def test_parallel_deployment_operations_are_rejected(self):
        deploy = self.load()
        with tempfile.TemporaryDirectory() as temp:
            lock = Path(temp) / 'deployment.lock'
            with deploy.deployment_lock(lock):
                with self.assertRaises(RuntimeError):
                    with deploy.deployment_lock(lock):
                        self.fail('重复部署不应取得锁')
            with deploy.deployment_lock(lock):
                self.assertEqual(lock.stat().st_mode & 0o777, 0o600)
    def test_failed_upgrade_restores_files_release_and_original_service_states(self):
        for failure, worker_active in [('api-health', True), ('worker-start', True), ('final-check', False)]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                deploy = self.load()
                root = Path(temp)
                install, config, units = root / 'install', root / 'config', root / 'units'
                old, new = install / 'releases/old', install / 'releases/new'
                for path in [old, new, config, units]:
                    path.mkdir(parents=True)
                (install / 'current').symlink_to(old)
                paths = [install / 'installation.json', config / 'install.json', config / 'api.env', config / 'worker.env',
                         config / 'nginx.conf', *[units / name for name in deploy.UNITS]]
                for index, path in enumerate(paths):
                    path.write_text('old-private-content-' + str(index))
                    path.chmod(0o600 if path.parent != units else 0o644)
                before = {path: (path.read_bytes(), path.stat().st_mode & 0o777) for path in paths}
                old_states = {deploy.UNITS[0]: {'active': True, 'enabled': 'enabled'},
                              deploy.UNITS[1]: {'active': worker_active, 'enabled': 'enabled-runtime' if worker_active else 'disabled'}}
                calls, health_calls = [], []
                worker_starts = 0
                def control(*args):
                    nonlocal worker_starts
                    calls.append(args)
                    if args == ('start', deploy.UNITS[1]):
                        worker_starts += 1
                        if failure == 'worker-start' and worker_starts == 1:
                            raise RuntimeError('synthetic worker startup failure')
                    return 'active' if args == ('is-active', deploy.UNITS[1]) else ''
                def healthy(*args, **kwargs):
                    health_calls.append(True)
                    if failure == 'api-health' and len(health_calls) == 1:
                        raise RuntimeError('synthetic new API failure')
                def checked():
                    if failure == 'final-check':
                        raise RuntimeError('synthetic final check failure')
                with patch.object(deploy, 'INSTALL', install), patch.object(deploy, 'CONFIG', config), patch.object(deploy, 'SYSTEMD', units, create=True), \
                     patch.object(deploy, 'service_state', side_effect=lambda name: old_states[name], create=True), \
                     patch.object(deploy, 'systemctl', side_effect=control), patch.object(deploy, 'health', side_effect=healthy), \
                     patch.object(deploy, 'check', side_effect=checked), patch.object(deploy, 'login_control_health') as control_health:
                    with self.assertRaisesRegex(RuntimeError, '已恢复'):
                        deploy.activate_deployment(self.config(), new)
                self.assertEqual((install / 'current').resolve(), old)
                self.assertEqual(before, {path: (path.read_bytes(), path.stat().st_mode & 0o777) for path in paths})
                self.assertGreaterEqual(calls.count(('daemon-reload',)), 2)
                self.assertEqual(calls[-1], ('is-active', deploy.UNITS[1]) if worker_active else ('start', deploy.UNITS[0]))
                self.assertIn(('enable', deploy.UNITS[0]), calls)
                if worker_active:
                    self.assertIn(('enable', '--runtime', deploy.UNITS[1]), calls)
                else:
                    self.assertIn(('disable', deploy.UNITS[1]), calls)
                    self.assertEqual(worker_starts, 1)
                self.assertGreaterEqual(len(health_calls), 2)
                self.assertEqual(control_health.call_count, 1 if worker_active else 0)

    def test_source_snapshot_includes_admin_documentation_assets(self):
        deploy = self.load()
        assets = (
            'docs/external-integration.md',
            'contracts/cms.openapi.yaml',
            'tests/fixtures/integration-contract.json',
        )
        with tempfile.TemporaryDirectory() as temp:
            release = Path(temp) / 'release'
            deploy.copy_source(ROOT, release)
            for asset in assets:
                with self.subTest(asset=asset):
                    self.assertTrue((release / asset).is_file(), asset)
                    self.assertEqual((release / asset).read_bytes(), (ROOT / asset).read_bytes())

    def test_source_snapshot_rejects_asset_directory_symlink(self):
        deploy = self.load()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'source'
            (source / 'apps').mkdir(parents=True)
            for manifest in ('package.json', 'package-lock.json'):
                (source / manifest).write_text('{}')
            external = root / 'external'
            external.mkdir()
            (external / 'external-integration.md').write_text('synthetic')
            (source / 'docs').symlink_to(external, target_is_directory=True)
            release = root / 'release'
            with self.assertRaisesRegex(ValueError, '符号链接'):
                deploy.copy_source(source, release)
            self.assertFalse((release / 'docs/external-integration.md').exists())

    def test_source_snapshot_rejects_symlinks(self):
        deploy = self.load()
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'source'
            source.mkdir()
            (source / 'apps').mkdir()
            (source / 'apps/leak').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                deploy.copy_source(source, Path(temp) / 'release')


if __name__ == '__main__':
    unittest.main()
