"""本地 Linux/WSL 运行入口。运行状态只写入仓库外的私有目录。"""
import argparse
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import shlex
import signal
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request

REPO = Path(__file__).resolve().parents[1]
TOOLS = Path.home() / '.local/share/post-bridge/tools'
DEFAULT_STATE = Path.home() / '.local/share/post-bridge/runtime/csdn-task-pipeline'

def check_state(state):
    state = Path(state).expanduser().resolve()
    repositories = [REPO, *(parent for parent in REPO.parents if (parent / '.git').exists())]
    if any(state == root or root in state.parents for root in repositories) or state == Path.home() or state in Path.home().parents or state == Path('/tmp'):
        raise ValueError('运行数据必须位于仓库外的专属目录')
    return state

def private_write(path, value):
    if path.is_symlink():
        raise ValueError('私有文件不能是符号链接')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        stream.write(value)
    path.chmod(0o600)

def identity(pid):
    try:
        stat = Path(f'/proc/{pid}/stat').read_text()
        start = stat[stat.rfind(')') + 2:].split()[19]
        argv = Path(f'/proc/{pid}/cmdline').read_bytes().decode().strip('\0').split('\0')
        return {'pid': pid, 'start': start, 'argv': argv}
    except (OSError, ValueError):
        return None

def owned(record):
    return record is not None and identity(record.get('pid', 0)) == record

def process_record(state, name):
    try:
        return json.loads((state / f'{name}.pid.json').read_text())
    except (OSError, ValueError):
        return None

def status(state):
    return {name: owned(process_record(state, name)) for name in ('api', 'worker', 'database')}

def terminate_record(record):
    if not owned(record):
        return False
    # 仅停止启动器记录且代次、参数都一致的进程，不使用模糊进程名匹配。
    os.kill(record['pid'], signal.SIGTERM)
    until = time.monotonic() + 45
    while owned(record) and time.monotonic() < until:
        time.sleep(.15)
    if owned(record):
        raise RuntimeError('进程尚未安全退出，保留进程信息供检查')
    return True

def stop_process(state, name):
    record = process_record(state, name)
    if not terminate_record(record):
        return False
    (state / f'{name}.pid.json').unlink(missing_ok=True)
    return True

def tool(name, fallback):
    path = TOOLS / fallback
    if path.is_file() and os.access(path, os.X_OK):
        return str(path)
    found = shutil.which(name)
    if found and not found.startswith('/mnt/'):
        return found
    raise RuntimeError(f'缺少Linux版{name}，请按开发文档安装固定版本')

def base_env():
    keep = ('HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'PULSE_SERVER', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR')
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env['LANG'] = 'C.UTF-8'
    node = Path(tool('node', 'node-v22.22.1-linux-x64/bin/node'))
    go = Path(tool('go', 'go-1.26.2/bin/go'))
    env['PATH'] = os.pathsep.join((str(node.parent), str(go.parent), env.get('PATH', '/usr/bin:/bin')))
    return env

def child_env(config, worker=False):
    env = base_env()
    keys = ('API_BASE_URL', 'WORKER_TOKEN_FILE', 'CSDN_USERNAME', 'CSDN_DISPLAY_NAME')
    keys += ('CSDN_PROFILE_DIR', 'PLAYWRIGHT_EXECUTABLE_PATH', 'WORKER_HEADLESS') if worker else ('DATABASE_URL', 'API_ADDR', 'ADMIN_USERNAME', 'ADMIN_PASSWORD_FILE', 'ADMIN_DIST_DIR')
    env.update({k: str(config[k]) for k in keys if k in config})
    return env

def pg_paths():
    root = TOOLS / 'postgres-16.15/usr'
    binary = Path(os.environ.get('POST_BRIDGE_PG_BIN', str(root / 'lib/postgresql/16/bin')))
    if not (binary / 'pg_ctl').is_file():
        installed = shutil.which('pg_config')
        if installed:
            binary = Path(subprocess.check_output([installed, '--bindir'], text=True).strip())
    if not (binary / 'pg_ctl').is_file():
        raise RuntimeError('缺少PostgreSQL16服务端工具，请按开发文档准备')
    env = base_env()
    if root.is_dir() and binary.is_relative_to(root):
        env['LD_LIBRARY_PATH'] = str(root / 'lib/x86_64-linux-gnu')
        share = root / 'share/postgresql/16'
    else:
        share = None
    return binary, share, env

def configuration(state):
    path = state / 'runtime.json'
    info = path.stat()
    if path.is_symlink() or info.st_mode & 0o077:
        raise ValueError('运行配置必须为0600的私有文件')
    value = json.loads(path.read_text(encoding='utf-8'))
    value['ADMIN_DIST_DIR'] = str(REPO / 'apps/admin/dist')
    return value

def setup(state):
    if state.exists() and any(state.iterdir()) and not (state / 'runtime.json').is_file():
        raise ValueError('初始化需要空目录或已有本项目私有配置的专属目录')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    if (state / 'runtime.json').exists():
        return configuration(state)
    username = os.environ.get('CSDN_USERNAME', '')
    display_name = os.environ.get('CSDN_DISPLAY_NAME', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', username) or not display_name.strip():
        raise ValueError('首次初始化需设置CSDN_USERNAME与CSDN_DISPLAY_NAME')
    for name in ('db-password', 'admin-password', 'worker-token'):
        if not (state / name).exists():
            private_write(state / name, secrets.token_urlsafe(32))
    password = (state / 'db-password').read_text().strip()
    profile = Path.home() / '.local/share/post-bridge/accounts' / ('csdn-' + username)
    value = {'DATABASE_URL': 'postgres://postbridge:' + urllib.parse.quote(password, safe='') + '@127.0.0.1:55432/post_bridge?sslmode=disable',
             'API_ADDR': '127.0.0.1:18080', 'API_BASE_URL': 'http://127.0.0.1:18080', 'ADMIN_USERNAME': 'admin',
             'ADMIN_PASSWORD_FILE': str(state / 'admin-password'), 'WORKER_TOKEN_FILE': str(state / 'worker-token'),
             'CSDN_USERNAME': username, 'CSDN_DISPLAY_NAME': display_name, 'CSDN_PROFILE_DIR': str(profile), 'WORKER_HEADLESS': 'true'}
    private_write(state / 'runtime.json', json.dumps(value, ensure_ascii=False, indent=2))
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    return configuration(state)

def database_start(state, config):
    binary, share, env = pg_paths()
    data = state / 'pgdata'
    if not data.exists():
        args = [str(binary / 'initdb'), '-D', str(data), '-U', 'postbridge', '--auth-host=scram-sha-256', '--auth-local=peer', '--pwfile=' + str(state / 'db-password'), '--encoding=UTF8', '--locale=C.UTF-8']
        if share:
            args += ['-L', str(share)]
        subprocess.run(args, env=env, check=True, stdout=subprocess.DEVNULL)
    server_pid = data / 'postmaster.pid'
    already_running = server_pid.exists()
    try:
        if already_running:
            record = identity(int(server_pid.read_text().splitlines()[0]))
            if not record or str(data) not in record['argv']:
                raise RuntimeError('数据库进程身份无法核对，未执行停止或替换')
        else:
            with socket.socket() as sock:
                if sock.connect_ex(('127.0.0.1', 55432)) == 0:
                    raise RuntimeError('55432已被其他服务占用')
            subprocess.run([str(binary / 'pg_ctl'), '-D', str(data), '-l', str(state / 'postgres.log'), '-o', f'-h 127.0.0.1 -p 55432 -k {shlex.quote(str(state))}', '-w', 'start'], env=env, check=True, stdout=subprocess.DEVNULL)
            record = identity(int(server_pid.read_text().splitlines()[0]))
        private_write(state / 'database.pid.json', json.dumps(record))
        url = urllib.parse.urlparse(config['DATABASE_URL'])
        env.update(PGPASSWORD=urllib.parse.unquote(url.password or ''))
        query = subprocess.run([str(binary / 'psql'), '-h', '127.0.0.1', '-p', '55432', '-U', 'postbridge', '-d', 'postgres', '-Atc', "SELECT 1 FROM pg_database WHERE datname='post_bridge'"], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True)
        if query.stdout.strip() != '1':
            subprocess.run([str(binary / 'createdb'), '-h', '127.0.0.1', '-p', '55432', '-U', 'postbridge', 'post_bridge'], env=env, check=True, stdout=subprocess.DEVNULL)
        return not already_running
    except Exception:
        if not already_running and server_pid.exists():
            record = identity(int(server_pid.read_text().splitlines()[0]))
            if record and str(data) in record['argv']:
                terminate_record(record)
        raise

def build(state):
    env = base_env()
    npm = tool('npm', 'node-v22.22.1-linux-x64/bin/npm')
    if not (REPO / 'node_modules').is_dir():
        subprocess.run([npm, 'ci', '--no-audit', '--no-fund'], cwd=REPO, env=env, check=True)
    subprocess.run([npm, 'run', 'build'], cwd=REPO, env=env, check=True)
    (state / 'bin').mkdir(exist_ok=True)
    subprocess.run([tool('go', 'go-1.26.2/bin/go'), 'build', '-o', str(state / 'bin/post-bridge-api'), './cmd/server'], cwd=REPO / 'apps/api', env=env, check=True)

def spawn(state, name, args, env):
    if owned(process_record(state, name)):
        return
    with (state / (name + '.log')).open('ab') as log:
        os.chmod(log.name, 0o600)
        process = subprocess.Popen(args, cwd=REPO, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    try:
        time.sleep(.1)
        record = identity(process.pid)
        if process.poll() is not None or not record:
            raise RuntimeError(f'{name}启动失败，请检查私有日志')
        private_write(state / (name + '.pid.json'), json.dumps(record))
    except Exception:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=20)
        raise

def start(state, skip_build=False):
    config = setup(state)
    previous = status(state)
    if owned(process_record(state, 'login')):
        raise RuntimeError('请先完成登录助手，再启动执行器')
    started_database = False
    try:
        started_database = database_start(state, config)
        if not skip_build:
            build(state)
        spawn(state, 'api', [str(state / 'bin/post-bridge-api')], child_env(config))
        until = time.monotonic() + 30
        while True:
            try:
                with urllib.request.urlopen(config['API_BASE_URL'] + '/healthz', timeout=1) as response:
                    if response.status == 200:
                        break
            except (OSError, ValueError):
                pass
            if time.monotonic() > until:
                raise RuntimeError('API尚未就绪，请检查私有日志')
            time.sleep(.3)
        spawn(state, 'worker', [tool('node', 'node-v22.22.1-linux-x64/bin/node'), str(REPO / 'apps/worker/dist/main.js')], child_env(config, worker=True))
        time.sleep(1)
        if not status(state)['worker']:
            raise RuntimeError('执行器启动失败，请检查专属浏览器锁与配置')
        print(json.dumps({'url': config['API_BASE_URL'], 'username': config['ADMIN_USERNAME'], 'password_file': config['ADMIN_PASSWORD_FILE'], 'running': status(state)}, ensure_ascii=False))
    except Exception:
        for name in ('worker', 'api', 'database'):
            if (name == 'database' and started_database) or (name != 'database' and not previous[name]):
                stop_process(state, name)
        raise

def main():
    parser = argparse.ArgumentParser(description='Post Bridge 本地运行管理')
    parser.add_argument('action', choices=['setup', 'start', 'stop', 'status', 'test', 'login'])
    parser.add_argument('--state', default=str(DEFAULT_STATE))
    parser.add_argument('--skip-build', action='store_true')
    args = parser.parse_args()
    state = check_state(args.state)
    if args.action == 'status':
        print(json.dumps(status(state)))
    elif args.action == 'stop':
        for name in ('login', 'worker', 'api', 'database'):
            stop_process(state, name)
        print(json.dumps(status(state)))
    elif args.action == 'setup':
        config = setup(state)
        database_start(state, config)
        print(json.dumps({'state_dir': str(state), 'username': config['ADMIN_USERNAME'], 'password_file': config['ADMIN_PASSWORD_FILE']}, ensure_ascii=False))
    elif args.action == 'start':
        start(state, args.skip_build)
    elif args.action == 'login':
        stop_process(state, 'worker')
        config = configuration(state)
        if owned(process_record(state, 'login')):
            raise RuntimeError('已有登录窗口，请完成或停止该窗口')
        spawn(state, 'login', [tool('node', 'node-v22.22.1-linux-x64/bin/node'), str(REPO / 'scripts/login-csdn.mjs')], child_env(config, worker=True))
        try:
            while owned(process_record(state, 'login')):
                time.sleep(.3)
        finally:
            stop_process(state, 'login')
            (state / 'login.pid.json').unlink(missing_ok=True)
    elif args.action == 'test':
        env = base_env()
        env['TEST_DATABASE_URL'] = configuration(state)['DATABASE_URL']
        subprocess.run([tool('go', 'go-1.26.2/bin/go'), 'test', '-race', '-count=1', './...'], cwd=REPO / 'apps/api', env=env, check=True)
        subprocess.run([tool('npm', 'node-v22.22.1-linux-x64/bin/npm'), 'run', 'test'], cwd=REPO, env=env, check=True)

if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError):
        print('操作失败，请检查工具版本、私有配置、端口和运行日志；未输出凭据。', file=sys.stderr)
        sys.exit(1)