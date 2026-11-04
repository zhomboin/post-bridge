"""外部平台认证部署配置测试，仅使用临时目录和合成值。"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,ROOT/file)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

class IntegrationDeploymentTests(unittest.TestCase):
 def config(self):
  return {'DATABASE_URL':'postgresql://bridge:synthetic@127.0.0.1:5432/bridge','PUBLIC_ORIGIN':'https://bridge.example.org','ADMIN_USERNAME':'admin','CSDN_USERNAME':'fixture','CSDN_DISPLAY_NAME':'合成账号','INTEGRATION_ENVIRONMENT':'production','INTEGRATION_SERVICE_ID':'post-bridge'}
 def test_optional_registration_configuration_is_explicit_and_api_only(self):
  deploy=load('integration_deploy','scripts/ubuntu_deploy.py')
  config=deploy.validate_config(self.config())
  api,worker=deploy.environments(config)
  self.assertEqual(api['INTEGRATION_ENVIRONMENT'],'production')
  self.assertEqual(api['INTEGRATION_SERVICE_ID'],'post-bridge')
  self.assertTrue(api['INTEGRATION_MASTER_KEY_FILE'].endswith('/api/integration-master-key'))
  self.assertNotIn('INTEGRATION_MASTER_KEY_FILE',worker)
  self.assertNotIn('INTEGRATION_ENVIRONMENT',worker)
  for update in [{'INTEGRATION_ENVIRONMENT':''},{'INTEGRATION_SERVICE_ID':'evil\nINJECT=1'},{'EXTRA':'value'}]:
   with self.subTest(update=update),self.assertRaises(ValueError):
    deploy.validate_config({**self.config(),**update})
  config=self.config();del config['INTEGRATION_ENVIRONMENT']
  with self.assertRaises(ValueError):deploy.validate_config(config)
 def test_master_key_creation_upgrade_and_loss_fail_closed(self):
  deploy=load('integration_secrets','scripts/ubuntu_deploy.py')
  with tempfile.TemporaryDirectory() as folder:
   state=Path(folder)
   key=deploy.ensure_integration_key(state,enabled=True)
   before=key.read_bytes()
   self.assertEqual(len(bytes.fromhex(before.decode().strip())),32)
   self.assertEqual(key.stat().st_mode&0o777,0o600)
   deploy.ensure_integration_key(state,enabled=True,previously_enabled=True)
   self.assertEqual(key.read_bytes(),before)
   key.unlink()
   with self.assertRaises(ValueError):deploy.ensure_integration_key(state,enabled=True,previously_enabled=True)
   self.assertFalse(key.exists())
 def test_existing_invalid_or_symlink_key_is_rejected(self):
  deploy=load('integration_key_safety','scripts/ubuntu_deploy.py')
  with tempfile.TemporaryDirectory() as folder:
   state=Path(folder);(state/'api').mkdir()
   key=state/'api/integration-master-key'
   key.write_text('invalid');key.chmod(0o600)
   with self.assertRaises(ValueError):deploy.ensure_integration_key(state,enabled=True)
   key.unlink();target=state/'untouched';target.write_text('unchanged');key.symlink_to(target)
   with self.assertRaises(ValueError):deploy.ensure_integration_key(state,enabled=True)
   self.assertEqual(target.read_text(),'unchanged')
 def test_local_runtime_passes_integration_config_only_to_api(self):
  runtime=load('integration_runtime','scripts/runtime.py')
  cfg={'INTEGRATION_MASTER_KEY_FILE':'/private/integration-key','INTEGRATION_ENVIRONMENT':'test','INTEGRATION_SERVICE_ID':'bridge'}
  with patch.object(runtime,'base_env',side_effect=lambda: {}):
   api=runtime.child_env(cfg);worker=runtime.child_env(cfg,worker=True)
  self.assertEqual(api,cfg)
  self.assertEqual(worker,{})

 def test_master_key_loss_after_disabled_upgrade_is_not_silently_replaced(self):
  deploy=load('integration_reenable','scripts/ubuntu_deploy.py')
  with tempfile.TemporaryDirectory() as folder:
   state=Path(folder)
   key=deploy.ensure_integration_key(state,enabled=True)
   deploy.ensure_integration_key(state,enabled=False)
   key.unlink()
   with self.assertRaises(ValueError):
    deploy.ensure_integration_key(state,enabled=True,previously_enabled=False)

if __name__=='__main__':unittest.main()
