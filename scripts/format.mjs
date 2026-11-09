import { spawnSync } from 'node:child_process';

const check = process.argv.includes('--check');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(`无法执行 ${command}，请按开发文档准备格式化工具。`);
    process.exit(1);
  }
}

run(process.execPath, [
  'node_modules/prettier/bin/prettier.cjs',
  check ? '--check' : '--write',
  'apps',
  'tests',
  'scripts',
  'deploy',
  'contracts',
  '.github',
  'package.json',
  '.prettierrc.json',
]);
const tracked = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.go'],
  { encoding: 'utf8' },
);
if (tracked.error || tracked.status !== 0) process.exit(1);
const files = tracked.stdout.split('\0').filter(Boolean);
if (check) {
  const result = spawnSync('gofmt', ['-l', ...files], { encoding: 'utf8' });
  if (result.error || result.status !== 0 || result.stdout.trim()) {
    console.error(result.stdout || '无法检查 Go 格式，请确认已安装 Go。');
    process.exit(1);
  }
} else {
  run('gofmt', ['-w', ...files]);
}
run('python3', ['-m', 'black', ...(check ? ['--check'] : []), 'scripts', 'tests/runtime']);
