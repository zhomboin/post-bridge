import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('runtime', Path(__file__).parents[2] / 'scripts/runtime.py')
class RuntimeSafetyTests(unittest.TestCase):
    def load(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        return module
    def test_status_does_not_create_state(self):
        runtime = self.load()
        with tempfile.TemporaryDirectory() as base:
            path = Path(base) / 'not-created'
            self.assertEqual(runtime.status(path), {'api': False, 'worker': False, 'database': False})
            self.assertFalse(path.exists())
    def test_rejects_state_in_repository(self):
        runtime = self.load()
        for root in [runtime.REPO, *(parent for parent in runtime.REPO.parents if (parent / '.git').exists())]:
            with self.assertRaisesRegex(ValueError, '仓库外'):
                runtime.check_state(root / 'secrets')
    def test_reused_pid_is_never_signalled(self):
        runtime = self.load()
        child = subprocess.Popen(['sleep', '30'])
        try:
            with tempfile.TemporaryDirectory() as base:
                state = Path(base)
                record = {'pid': child.pid, 'start': 'wrong-generation', 'argv': ['sleep', '30']}
                (state / 'worker.pid.json').write_text(json.dumps(record))
                self.assertFalse(runtime.stop_process(state, 'worker'))
                self.assertIsNone(child.poll())
        finally:
            child.terminate()
            child.wait(timeout=5)
    def test_worker_env_has_no_database_or_admin_credentials(self):
        runtime = self.load()
        config = {'DATABASE_URL': 'secret', 'ADMIN_PASSWORD_FILE': '/secret/admin', 'WORKER_TOKEN_FILE': '/private/worker', 'CSDN_USERNAME': 'fixture', 'API_BASE_URL': 'http://127.0.0.1:18080'}
        env = runtime.child_env(config, worker=True)
        self.assertNotIn('DATABASE_URL', env)
        self.assertNotIn('ADMIN_PASSWORD_FILE', env)
        self.assertNotIn('OPENAI_API_KEY', env)
        self.assertEqual(env['CSDN_USERNAME'], 'fixture')

    def test_remote_login_defaults_and_process_configuration_are_separate(self):
        runtime = self.load()
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory)
            runtime.private_write(state/'runtime.json',json.dumps({'API_BASE_URL':'http://127.0.0.1:18080','PUBLIC_ORIGIN':'https://example.test'}))
            config=runtime.configuration(state)
            self.assertEqual(config['LOGIN_CONTROL_ADDR'],'127.0.0.1:18081')
            self.assertEqual(config['REMOTE_LOGIN_URL'],'http://127.0.0.1:18081')
            api=runtime.child_env(config)
            worker=runtime.child_env(config,worker=True)
            self.assertEqual(api['REMOTE_LOGIN_URL'],config['REMOTE_LOGIN_URL'])
            self.assertNotIn('LOGIN_CONTROL_ADDR',api)
            self.assertEqual(worker['LOGIN_CONTROL_ADDR'],config['LOGIN_CONTROL_ADDR'])
            self.assertNotIn('PUBLIC_ORIGIN',worker)
            self.assertNotIn('REMOTE_LOGIN_URL',worker)

    def test_database_failure_stops_only_new_cluster(self):
        runtime = self.load()
        with tempfile.TemporaryDirectory() as base:
            state = Path(base)
            (state / 'pgdata').mkdir()
            current = {'pid': 123, 'start': '1', 'argv': ['/tools/postgres', '-D', str(state / 'pgdata')]}
            def command(args, **kwargs):
                if args[0].endswith('pg_ctl'):
                    (state / 'pgdata/postmaster.pid').write_text('123\n')
                    return subprocess.CompletedProcess(args, 0)
                raise subprocess.CalledProcessError(1, args)
            with patch.object(runtime, 'pg_paths', return_value=(Path('/tools'), None, {})), patch.object(runtime, 'identity', return_value=current), patch.object(runtime.subprocess, 'run', side_effect=command), patch.object(runtime, 'terminate_record', create=True) as terminate, patch.object(runtime.socket, 'socket') as sockets:
                sockets.return_value.__enter__.return_value.connect_ex.return_value = 1
                with self.assertRaises(subprocess.CalledProcessError):
                    runtime.database_start(state, {'DATABASE_URL': 'postgres://postbridge:password@127.0.0.1:55432/post_bridge'})
                terminate.assert_called_once_with(current)
    def test_failed_record_write_reaps_new_child(self):
        runtime = self.load()
        processes = []
        original = subprocess.Popen
        def capture(*args, **kwargs):
            process = original(*args, **kwargs)
            processes.append(process)
            return process
        with tempfile.TemporaryDirectory() as base:
            with patch.object(runtime.subprocess, 'Popen', side_effect=capture), patch.object(runtime, 'private_write', side_effect=OSError('fixture')):
                with self.assertRaises(OSError):
                    runtime.spawn(Path(base), 'worker', ['sleep', '30'], os.environ.copy())
            self.assertIsNotNone(processes[0].poll())

    def test_existing_database_is_preserved_on_connection_failure(self):
        runtime = self.load()
        with tempfile.TemporaryDirectory() as base:
            state = Path(base)
            (state / 'pgdata').mkdir()
            (state / 'pgdata/postmaster.pid').write_text('123\n')
            record = {'pid': 123, 'start': '1', 'argv': ['/tools/postgres', '-D', str(state / 'pgdata')]}
            with patch.object(runtime, 'pg_paths', return_value=(Path('/tools'), None, {})), patch.object(runtime, 'identity', return_value=record), patch.object(runtime.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'fixture')), patch.object(runtime, 'terminate_record') as terminate:
                with self.assertRaises(subprocess.CalledProcessError):
                    runtime.database_start(state, {'DATABASE_URL': 'postgres://postbridge:password@127.0.0.1:55432/post_bridge'})
                terminate.assert_not_called()
    def test_identity_failure_reaps_new_child(self):
        runtime = self.load()
        processes = []
        original = subprocess.Popen
        def capture(*args, **kwargs):
            process = original(*args, **kwargs)
            processes.append(process)
            return process
        with tempfile.TemporaryDirectory() as base:
            with patch.object(runtime.subprocess, 'Popen', side_effect=capture), patch.object(runtime, 'identity', return_value=None):
                with self.assertRaises(RuntimeError):
                    runtime.spawn(Path(base), 'worker', ['sleep', '30'], os.environ.copy())
            self.assertIsNotNone(processes[0].poll())

    def test_stop_closes_login_helper_before_worker(self):
        runtime = self.load()
        with tempfile.TemporaryDirectory() as base:
            with patch.object(runtime.sys, 'argv', ['runtime.py', 'stop', '--state', base]), patch.object(runtime, 'stop_process') as stop, patch('builtins.print'):
                runtime.main()
                self.assertEqual([call.args[1] for call in stop.call_args_list], ['login', 'worker', 'api', 'database'])

if __name__ == '__main__':
    unittest.main()