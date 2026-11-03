"""Ubuntu 24.04 的独立系统服务安装、升级与检查入口。"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

REPO = Path(__file__).resolve().parents[1]
INSTALL = Path('/opt/post-bridge')
CONFIG = Path('/etc/post-bridge')
SYSTEMD = Path('/etc/systemd/system')
STATE = Path('/var/lib/post-bridge')
BROWSERS = Path('/var/cache/post-bridge/ms-playwright')
NODE = '22.22.1'
NPM = '10.9.4'
GO = '1.26.2'
PLAYWRIGHT = '1.64.1'
UNITS = ['post-bridge-api.service', 'post-bridge-worker.service']


def architecture():
    value = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    if not value:
        raise ValueError('仅支持 Ubuntu amd64 与 arm64')
    return value


def directory(path, mode=0o700):
    path = Path(path)
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValueError('部署目录不可经过符号链接')
    path.mkdir(parents=True, exist_ok=True, mode=mode)
    path.chmod(mode)


def write_private(path, value):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('私有文件不可为符号链接')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        stream.write(value)
    path.chmod(0o600)


def validate_config(value):
    keys = ['DATABASE_URL', 'PUBLIC_ORIGIN', 'ADMIN_USERNAME', 'CSDN_USERNAME', 'CSDN_DISPLAY_NAME']
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('请完整填写部署配置的五个字段，不添加其他环境变量')
    if any(not isinstance(value[k], str) or not value[k].strip() or any(c in value[k] for c in '\r\n\0') for k in keys):
        raise ValueError('配置字段不可为空或包含换行')
    origin = urllib.parse.urlsplit(value['PUBLIC_ORIGIN'])
    if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ['', '/']:
        raise ValueError('PUBLIC_ORIGIN 必须是无路径、无凭据的 HTTPS 站点来源')
    if not re.fullmatch(r'[A-Za-z0-9.-]+', origin.hostname) or origin.port not in [None, 443]:
        raise ValueError('公开域名只允许 ASCII 域名及默认 HTTPS 端口')
    db = urllib.parse.urlsplit(value['DATABASE_URL'])
    if db.scheme not in ['postgres', 'postgresql'] or not db.hostname or not db.username or db.path in ['', '/', '/postgres', '/template0', '/template1']:
        raise ValueError('DATABASE_URL 需要管理员预先准备的独立 PostgreSQL 数据库与角色')
    if 'replace-me' in value['DATABASE_URL'] or value['CSDN_USERNAME'] == 'replace-me' or origin.hostname.endswith('.example.com'):
        raise ValueError('请替换模板中的配置占位值')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value['CSDN_USERNAME']) or len(value['CSDN_DISPLAY_NAME']) > 100:
        raise ValueError('指定账号身份格式不正确')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', value['ADMIN_USERNAME']):
        raise ValueError('管理员账号格式不正确')
    return {**value, 'PUBLIC_ORIGIN': value['PUBLIC_ORIGIN'].rstrip('/')}


def load_config(path):
    path = Path(path)
    if path.is_symlink() or path.stat().st_mode & 0o077 or path.stat().st_uid != os.geteuid():
        raise ValueError('部署配置必须由当前管理员所有，权限为 0600')
    return validate_config(json.loads(path.read_text(encoding='utf-8')))


def ensure_secrets(state=STATE):
    for kind in ['api', 'worker']:
        directory(state / kind)
    admin = state / 'api/admin-password'
    api_token, worker_token = state / 'api/worker-token', state / 'worker/worker-token'
    for path in [admin, api_token, worker_token]:
        if path.is_symlink():
            raise ValueError('凭据不能为符号链接')
        if path.exists() and (path.stat().st_mode & 0o077 or not path.read_text().strip()):
            raise ValueError('已有凭据必须非空且权限为 0600')
    tokens = [p.read_text().strip() for p in [api_token, worker_token] if p.exists()]
    if len(set(tokens)) > 1:
        raise ValueError('现有 API 与执行器密钥不一致；未覆盖任何凭据')
    token = tokens[0] if tokens else secrets.token_urlsafe(32)
    for path in [api_token, worker_token]:
        if not path.exists():
            write_private(path, token + '\n')
    if not admin.exists():
        write_private(admin, secrets.token_urlsafe(32) + '\n')


def environments(config):
    common = {'LANG': 'C.UTF-8', 'API_BASE_URL': 'http://127.0.0.1:18080',
              'CSDN_USERNAME': config['CSDN_USERNAME'], 'CSDN_DISPLAY_NAME': config['CSDN_DISPLAY_NAME']}
    api = {**common, 'DATABASE_URL': config['DATABASE_URL'], 'PUBLIC_ORIGIN': config['PUBLIC_ORIGIN'],
           'API_ADDR': '127.0.0.1:18080', 'REMOTE_LOGIN_URL': 'http://127.0.0.1:18081',
           'ADMIN_USERNAME': config['ADMIN_USERNAME'], 'ADMIN_PASSWORD_FILE': str(STATE / 'api/admin-password'),
           'WORKER_TOKEN_FILE': str(STATE / 'api/worker-token'), 'ADMIN_DIST_DIR': str(INSTALL / 'current/apps/admin/dist'),
           'HOME': str(STATE / 'api')}
    worker = {**common, 'WORKER_TOKEN_FILE': str(STATE / 'worker/worker-token'),
              'LOGIN_CONTROL_ADDR': '127.0.0.1:18081', 'CSDN_PROFILE_DIR': str(STATE / 'worker/profile'),
              'WORKER_HEADLESS': 'true', 'PLAYWRIGHT_BROWSERS_PATH': str(BROWSERS), 'HOME': str(STATE / 'worker')}
    return api, worker


def environment_text(values):
    return ''.join(key + '="' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"\n' for key, value in values.items())


def render_unit(kind):
    if kind not in ['api', 'worker']:
        raise ValueError('未知系统服务')
    text = (REPO / 'deploy/systemd' / ('post-bridge-' + kind + '.service')).read_text(encoding='utf-8')
    return text.replace('@INSTALL@', str(INSTALL)).replace('@CONFIG@', str(CONFIG)).replace('@STATE@', str(STATE)).replace('@ARCH@', architecture())


def command(args, *, env=None, cwd=None):
    # 子进程错误可能包含连接串，部署入口统一处理，不打印命令或 stderr。
    result = subprocess.run([str(item) for item in args], cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        raise RuntimeError(Path(str(args[0])).name + ' 步骤未完成，请检查工具、网络及系统日志；未打印配置或凭据')
    return result.stdout.strip()


def systemctl(*args):
    return command(['systemctl', *args])


def copy_source(source, target):
    target.mkdir(parents=True)
    excluded = shutil.ignore_patterns('node_modules', 'dist', '*.tsbuildinfo', '__pycache__', '.env', '.env.*')
    def ignore(directory, names):
        omitted = excluded(directory, names)
        if any((Path(directory) / name).is_symlink() for name in names if name not in omitted):
            raise ValueError('源码快照不可包含符号链接')
        return omitted
    for item in ['apps', 'package.json', 'package-lock.json']:
        path = source / item
        if path.is_symlink():
            raise ValueError('源码快照不可包含符号链接')
        if path.is_dir():
            shutil.copytree(path, target / item, ignore=ignore)
        else:
            shutil.copy2(path, target / item)


def activate_release(root, release):
    release = release.resolve(strict=True)
    if not release.is_relative_to((root / 'releases').resolve()) or not release.is_dir():
        raise ValueError('只能切换到本部署的发布目录')
    current = root / 'current'
    if current.exists() and not current.is_symlink():
        raise ValueError('current 必须是本部署的发布链接，未覆盖目录')
    pending = root / ('current-' + secrets.token_hex(6))
    pending.symlink_to(release)
    try:
        pending.replace(current)
    finally:
        pending.unlink(missing_ok=True)


def download(url, target):
    with urllib.request.urlopen(url, timeout=120) as response, target.open('wb') as stream:
        shutil.copyfileobj(response, stream)


def tools():
    directory(INSTALL / 'tools', 0o755)
    arch = architecture()
    node = INSTALL / 'tools' / f'node-v{NODE}-linux-{arch}'
    go = INSTALL / 'tools' / f'go-{GO}'
    if not node.exists() or not go.exists():
        with tempfile.TemporaryDirectory(dir=INSTALL / 'tools') as temporary:
            temp = Path(temporary)
            if not node.exists():
                name = f'node-v{NODE}-linux-{arch}.tar.xz'
                archive = temp / name
                download(f'https://nodejs.org/dist/v{NODE}/{name}', archive)
                checks = temp / 'SHASUMS256.txt'
                download(f'https://nodejs.org/dist/v{NODE}/SHASUMS256.txt', checks)
                expected = next(line.split()[0] for line in checks.read_text().splitlines() if line.split()[-1] == name)
                if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
                    raise ValueError('Node 下载校验失败')
                with tarfile.open(archive) as packed:
                    packed.extractall(temp, filter='data')
                (temp / f'node-v{NODE}-linux-{arch}').replace(node)
            if not go.exists():
                go_arch = 'amd64' if arch == 'x64' else 'arm64'
                name = f'go{GO}.linux-{go_arch}.tar.gz'
                archive = temp / name
                catalog = temp / 'go-downloads.json'
                download('https://go.dev/dl/?mode=json&include=all', catalog)
                expected = next(item['sha256'] for version in json.loads(catalog.read_text()) if version['version'] == f'go{GO}' for item in version['files'] if item['filename'] == name)
                download('https://go.dev/dl/' + name, archive)
                if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
                    raise ValueError('Go 下载校验失败')
                with tarfile.open(archive) as packed:
                    packed.extractall(temp, filter='data')
                (temp / 'go').replace(go)
    env = {'PATH': str(node / 'bin') + ':/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
    if command([node / 'bin/node', '--version'], env=env) != 'v' + NODE or command([node / 'bin/npm', '--version'], env=env) != NPM or not command([go / 'bin/go', 'version'], env=env).startswith('go version go' + GO + ' '):
        raise ValueError('工具版本不匹配；未替换已有工具')
    return node, go


def service_user(kind):
    name = 'post-bridge-' + kind
    try:
        user = pwd.getpwnam(name)
        if user.pw_uid == 0 or user.pw_dir != str(STATE / kind) or user.pw_shell != '/usr/sbin/nologin':
            raise ValueError('已有服务用户与独立部署配置不一致')
    except KeyError:
        command(['useradd', '--system', '--user-group', '--home-dir', STATE / kind, '--no-create-home', '--shell', '/usr/sbin/nologin', name])
        user = pwd.getpwnam(name)
    return user


def owner_tree(root, user, readonly=False):
    paths = [root, *root.rglob('*')]
    for path in paths:
        os.chown(path, user.pw_uid if user else 0, user.pw_gid if user else 0, follow_symlinks=False)
        if not path.is_symlink():
            if readonly:
                path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
            elif path.is_dir():
                path.chmod(0o700)
            else:
                path.chmod(0o600)


def build_release(source, release, node, go, user):
    copy_source(source, release)
    for path in [release, *release.rglob('*')]:
        os.chown(path, user.pw_uid, user.pw_gid, follow_symlinks=False)
    cache = STATE / 'worker/build-cache'
    directory(cache)
    os.chown(cache, user.pw_uid, user.pw_gid)
    env = {'PATH': f'{node}/bin:{go}/bin:/usr/bin:/bin', 'HOME': str(cache), 'LANG': 'C.UTF-8',
           'GOCACHE': str(cache / 'go'), 'GOMODCACHE': str(cache / 'gomod')}
    run = lambda args, cwd=release: command(['runuser', '-u', user.pw_name, '--', 'env', '-i', *[key + '=' + value for key, value in env.items()], *args], cwd=cwd)
    run([str(node / 'bin/npm'), 'ci', '--no-audit', '--no-fund'])
    if json.loads((release / 'node_modules/playwright/package.json').read_text())['version'] != PLAYWRIGHT:
        raise ValueError('Playwright 版本不匹配')
    run([str(node / 'bin/npm'), 'run', 'build'])
    (release / 'bin').mkdir(exist_ok=True)
    os.chown(release / 'bin', user.pw_uid, user.pw_gid)
    run([str(go / 'bin/go'), 'build', '-o', str(release / 'bin/post-bridge-api'), './cmd/server'], release / 'apps/api')
    owner_tree(release, None, readonly=True)


def health(timeout=45):
    until = time.monotonic() + timeout
    while True:
        try:
            with urllib.request.urlopen('http://127.0.0.1:18080/healthz', timeout=2) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        if time.monotonic() >= until:
            raise RuntimeError('API 健康检查失败，请通过指定 systemd 单元日志定位')
        time.sleep(.3)


def assert_managed():
    marker = INSTALL / 'installation.json'
    if marker.is_symlink() or not marker.is_file() or json.loads(marker.read_text()) != {'owner': 'post-bridge-ubuntu', 'units': UNITS}:
        raise ValueError('未找到本部署的服务标记，未操作同名服务')


def check():
    assert_managed()
    for unit in UNITS:
        if systemctl('is-active', unit) != 'active':
            raise RuntimeError('系统服务未运行')
    health(timeout=2)
    login_control_health()
    print('API、执行器与回环登录控制服务均已运行；平台账号状态请在后台检查。')


def login_control_health():
    # 控制接口应拒绝匿名访问；只确认回环服务存在，不读取画面或凭据。
    until = time.monotonic() + 15
    while True:
        try:
            with urllib.request.urlopen('http://127.0.0.1:18081/login', timeout=2):
                raise RuntimeError('登录控制接口未拒绝匿名访问')
        except urllib.error.HTTPError as error:
            if error.code == 401:
                break
            raise RuntimeError('登录控制接口健康状态异常') from None
        except OSError:
            if time.monotonic() >= until:
                raise RuntimeError('回环登录控制服务尚未就绪') from None
            time.sleep(.3)


def install(config_path, upgrade=False):
    config = load_config(config_path)
    if platform.system() != 'Linux' or os.geteuid() != 0 or Path('/etc/os-release').read_text().find('VERSION_ID="24.04"') < 0:
        raise ValueError('安装与升级需要 Ubuntu 24.04 管理员权限')
    if upgrade and not (INSTALL / 'current').is_symlink():
        raise ValueError('未找到已有安装，请使用 install')
    manifest = INSTALL / 'installation.json'
    unit_paths = [SYSTEMD / unit for unit in UNITS]
    if any(path.is_symlink() for path in unit_paths):
        raise ValueError('服务单元不可是其他位置的符号链接，未覆盖')
    if ((INSTALL / 'current').exists() or any(path.exists() for path in unit_paths)) and not manifest.is_file():
        raise ValueError('发现未登记的已有服务或代码，未接管或停止')
    if manifest.exists() and json.loads(manifest.read_text()) != {'owner': 'post-bridge-ubuntu', 'units': UNITS}:
        raise ValueError('部署标记与独立服务不匹配')
    if not upgrade and (INSTALL / 'current').is_symlink():
        raise ValueError('已有部署需要使用 upgrade，不重复安装')
    directory(INSTALL, 0o755)
    directory(INSTALL / 'releases', 0o755)
    directory(CONFIG)
    directory(STATE, 0o711)
    users = {kind: service_user(kind) for kind in ['api', 'worker']}
    ensure_secrets()
    directory(STATE / 'worker/profile')
    for kind, user in users.items():
        os.chown(STATE / kind, user.pw_uid, user.pw_gid)
        for name in (['admin-password', 'worker-token'] if kind == 'api' else ['worker-token', 'profile']):
            os.chown(STATE / kind / name, user.pw_uid, user.pw_gid)
    node, go = tools()
    release = INSTALL / 'releases' / (time.strftime('%Y%m%dT%H%M%S') + '-' + secrets.token_hex(4))
    print('正在准备独立代码快照与固定版本依赖。', flush=True)
    build_release(REPO, release, node, go, users['worker'])
    root_env = {'PATH': f'{node}/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8', 'DEBIAN_FRONTEND': 'noninteractive', 'PLAYWRIGHT_BROWSERS_PATH': str(BROWSERS)}
    command(['apt-get', 'update'], env=root_env)
    command(['apt-get', 'install', '-y', '--no-install-recommends', 'ca-certificates', 'fonts-noto-cjk', 'postgresql-client-16'], env=root_env)
    command([node / 'bin/node', release / 'node_modules/playwright/cli.js', 'install-deps', 'chromium'], env=root_env)
    directory(BROWSERS, 0o755)
    command([node / 'bin/node', release / 'node_modules/playwright/cli.js', 'install', 'chromium'], env=root_env)
    # 只检查管理员准备的连接，不创建、删除或重置数据库及角色。
    command(['psql', '-X', '-A', '-t', '-c', 'SELECT current_database()'], env={**root_env, 'PGDATABASE': config['DATABASE_URL'], 'PGCONNECT_TIMEOUT': '5'})
    activate_deployment(config, release)
    print('安装已完成。管理员密码位于 /var/lib/post-bridge/api/admin-password；未输出密码。')
    print('HTTPS 模板位于 /etc/post-bridge/nginx.conf；确认域名与证书后由管理员启用。')


def service_state(unit):
    values = dict(line.split('=', 1) for line in systemctl('show', unit, '--property=ActiveState', '--property=UnitFileState').splitlines() if '=' in line)
    if values.get('UnitFileState') not in ['enabled', 'enabled-runtime', 'disabled'] or values.get('ActiveState') in ['activating', 'deactivating']:
        raise RuntimeError('已有服务状态不稳定或启用方式不受支持，未开始代码切换')
    return {'active': values.get('ActiveState') in ['active', 'reloading'], 'enabled': values['UnitFileState']}


def snapshot_files(paths):
    snapshot = {}
    for path in paths:
        if path.is_symlink() or path.exists() and not path.is_file():
            raise ValueError('部署配置与单元必须是普通文件')
        if path.exists():
            metadata = path.stat()
            snapshot[path] = (path.read_bytes(), metadata.st_mode & 0o777, metadata.st_uid, metadata.st_gid)
        else:
            snapshot[path] = None
    return snapshot


def restore_files(snapshot):
    for path, previous in snapshot.items():
        if previous is None:
            path.unlink(missing_ok=True)
            continue
        data, mode, uid, gid = previous
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            os.fchmod(stream.fileno(), mode)
            os.fchown(stream.fileno(), uid, gid)


def restore_deployment(snapshot, previous, states):
    installed = [unit for unit in UNITS if (SYSTEMD / unit).is_file()]
    if installed:
        systemctl('stop', *reversed(installed))
        # 清除本次 enable 生成的链接，再恢复原先的持久或临时启用方式。
        systemctl('disable', *installed)
        systemctl('disable', '--runtime', *installed)
    restore_files(snapshot)
    if previous:
        activate_release(INSTALL, previous)
    else:
        (INSTALL / 'current').unlink(missing_ok=True)
    systemctl('daemon-reload')
    for unit, state in states.items():
        if state['enabled'] == 'enabled':
            systemctl('enable', unit)
        elif state['enabled'] == 'enabled-runtime':
            systemctl('enable', '--runtime', unit)
        else:
            systemctl('disable', unit)
    if states.get(UNITS[0], {}).get('active'):
        systemctl('start', UNITS[0])
        health()
    if states.get(UNITS[1], {}).get('active'):
        systemctl('start', UNITS[1])
        # 只有原来运行的执行器才恢复；原来停止的单元保持停止。
        if systemctl('is-active', UNITS[1]) != 'active':
            raise RuntimeError('旧执行器尚未恢复运行')
        login_control_health()


def activate_deployment(config, release):
    previous = (INSTALL / 'current').resolve() if (INSTALL / 'current').is_symlink() else None
    if previous and not previous.is_relative_to((INSTALL / 'releases').resolve()):
        raise ValueError('已有代码指向不属于本部署，未切换服务')
    paths = [INSTALL / 'installation.json', *[CONFIG / name for name in ['install.json', 'api.env', 'worker.env', 'nginx.conf']],
             *[SYSTEMD / unit for unit in UNITS]]
    # 含凭据的旧配置只保存在本进程私有内存中，不落入日志或公开备份。
    snapshot = snapshot_files(paths)
    states = {unit: service_state(unit) for unit in UNITS} if previous else {}
    if states.get(UNITS[1], {}).get('active') and not states.get(UNITS[0], {}).get('active'):
        raise RuntimeError('服务依赖状态正在变化，未开始代码切换')
    try:
        if previous:
            systemctl('stop', *reversed(UNITS))
        write_private(CONFIG / 'install.json', json.dumps(config, ensure_ascii=False, indent=2) + '\n')
        for kind, values in zip(['api', 'worker'], environments(config)):
            write_private(CONFIG / (kind + '.env'), environment_text(values))
        nginx = CONFIG / 'nginx.conf'
        if not nginx.exists():
            template = (REPO / 'deploy/nginx/post-bridge.conf').read_text()
            write_private(nginx, template.replace('__SERVER_NAME__', urllib.parse.urlsplit(config['PUBLIC_ORIGIN']).hostname))
        write_private(INSTALL / 'installation.json', json.dumps({'owner': 'post-bridge-ubuntu', 'units': UNITS}))
        activate_release(INSTALL, release)
        for kind, unit in zip(['api', 'worker'], UNITS):
            path = SYSTEMD / unit
            write_private(path, render_unit(kind))
            path.chmod(0o644)
        systemctl('daemon-reload')
        systemctl('enable', *UNITS)
        systemctl('start', UNITS[0])
        health()
        systemctl('start', UNITS[1])
        check()
    except Exception:
        try:
            restore_deployment(snapshot, previous, states)
        except Exception:
            raise RuntimeError('新部署失败；旧部署恢复尚未完成，请检查两个指定服务的系统日志。数据库未回退。') from None
        raise RuntimeError('新部署失败，已恢复原有配置、代码及服务运行状态；数据库未回退。') from None

@contextmanager
def deployment_lock(path=Path('/run/lock/post-bridge-deploy.lock')):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('已有安装、升级或停止操作正在执行，请等待其完成') from None
        yield
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description='Ubuntu 24.04 独立部署；凭据不会输出到终端')
    parser.add_argument('action', choices=['configure', 'install', 'upgrade', 'check', 'stop'])
    parser.add_argument('--config', type=Path, default=CONFIG / 'install.json', help='管理员所有的 0600 JSON 配置；只用于安装或升级')
    args = parser.parse_args()
    if args.action == 'check':
        check()
        return
    if os.geteuid() != 0:
        raise ValueError('系统部署操作需要管理员权限')
    with deployment_lock():
        dispatch(args)


def dispatch(args):
    if args.action == 'configure':
        if os.geteuid() != 0:
            raise ValueError('生成系统私有配置需要管理员权限')
        directory(args.config.parent)
        if args.config.exists() or args.config.is_symlink():
            raise ValueError('配置已存在，未覆盖')
        write_private(args.config, (REPO / 'deploy/ubuntu-config.example.json').read_text())
        print('已生成 0600 私有配置，请在服务器编辑占位值后执行 install。')
    elif args.action in ['install', 'upgrade']:
        install(args.config, args.action == 'upgrade')
    elif args.action == 'stop':
        assert_managed()
        systemctl('stop', *reversed(UNITS))
        print('本项目 API 与执行器已停止，数据库、配置及浏览器状态均保留。')
    else:
        check()


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, subprocess.SubprocessError, StopIteration):
        print('操作未完成，请检查 Ubuntu 版本、私有配置、固定工具和指定服务日志；未输出凭据。', file=sys.stderr)
        sys.exit(1)
