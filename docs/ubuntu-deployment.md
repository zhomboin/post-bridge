# Ubuntu 无桌面部署

## 内容服务部署约定

公共内容表随 API 初始化事务创建并启用账号行权限。已有账号首次查询时自动建立投影，不需要手工迁移或清表；升级前按本页步骤备份数据库和私有配置，升级后核对账号列表、文章与笔记分页、正文和同步任务。平台声明与生成类型包含在应用源码中，无新增必填环境变量；合成平台不注册到正式环境。接入规则见[内容平台接入](content-platforms.md)。

## 使用约定与入口

支持 Ubuntu 24.04 amd64、arm64。以下命令在 **目标服务器的 Bash 终端**执行；首次 SSH 命令可在 WSL Bash 中执行。本地开发见[开发说明](development.md)，不要在服务器用 dev.sh 替代 systemd 常驻部署。

命令逐条执行，失败后先排查，不继续后续步骤。“〈…〉”全部替换为目标环境值；真实账号、地址、目录、连接和密钥只保存在目标机器的私有配置中。安装、停止、启动、升级及 Nginx 重载会修改系统或影响服务，应由管理员确认目标、备份及操作时机后执行。

管理入口为 [scripts/ubuntu-deploy.sh](../scripts/ubuntu-deploy.sh)，内部调用 Python 3 的 [ubuntu_deploy.py](../scripts/ubuntu_deploy.py)。安装器固定下载 Node.js 22.22.1、npm 10.9.4、Go 1.26.10，并安装 Playwright 1.64.1 对应 Chromium。服务器不需要桌面、WSLg 或远程桌面；基础功能无需模型密钥，可选 DeepSeek 格式化单独配置。

小红书资料统计与正文图片只读不增加必填环境变量；API 启动时建立按账号保护的正文缓存表。仍须按本页步骤备份数据库、配置和全部账号会话后升级。升级后选择对应账号同步笔记，核对资料与统计；只有已有真实笔记才能验收正文读取，见[只读工作台](xiaohongshu-readonly.md)。

| 操作 | 命令 | 行为 |
| --- | --- | --- |
| 首次配置 | sudo ./scripts/ubuntu-deploy.sh configure | 生成 root 所有、0600 的私有配置，已有文件不覆盖 |
| 首次安装 | sudo ./scripts/ubuntu-deploy.sh install | 构建独立代码快照并启动 API、worker，启用 AI 时增加 formatter 单元 |
| 检查 | sudo ./scripts/ubuntu-deploy.sh check | 检查部署标记、API、执行器及登录控制接口 |
| 停止 | sudo ./scripts/ubuntu-deploy.sh stop | 停止登记的可选排版、执行器和 API；保留数据库、配置与账号会话 |
| 再次启动 | sudo systemctl start post-bridge-api.service post-bridge-worker.service | 启动已有部署，不重建代码 |
| 升级 | sudo ./scripts/ubuntu-deploy.sh upgrade | 从当前源码构建并切换部署，复用凭据与账号会话 |

部署入口没有 start 或 restart 子命令；已有部署使用 systemctl 启停。check 推荐使用 sudo，因为它要读取 root 私有的部署标记。--help 不需要 sudo。

已有部署时，日常操作看第五节，升级看第六节；无需重复生成配置或首次安装。

## 一、准备服务器与源码

### 1. 连接并检查环境

```bash
ssh '〈部署用户〉@〈服务器地址〉'
cat /etc/os-release
uname -m
sudo -v
```

确认 Ubuntu 24.04，架构为 x86_64 或 aarch64，部署用户具备 sudo 权限。

### 2. 安装基础工具

以下命令安装 Python 3.12、源码下载工具和 Nginx。安装 Nginx 可能启动默认站点；已有 Nginx 的服务器按管理员现有配置管理，不覆盖其他站点。

```bash
sudo apt-get update
sudo apt-get install -y python3 ca-certificates git curl nginx nano less bubblewrap apparmor-utils
python3 --version
systemctl --version
```

需要能访问 Node.js、Go、npm、Ubuntu 软件源及 Playwright 下载源。公开域名、DNS 记录、已签发的 HTTPS 完整证书与私钥由管理员提前准备；安装器不签发证书、不改防火墙，也不自动接管 Nginx。只开放 HTTPS；HTTP 用于跳转，数据库和内部控制端口不向公网开放。

### 3. 获取源码

源码与运行数据分开。已有仓库跳过 clone，进入原源码目录；源码目录不是 /opt/post-bridge/current。

```bash
git clone '〈仓库 SSH 地址〉' '〈服务器源码目录〉'
cd '〈服务器源码目录〉'
git switch main
git status --short
git pull --ff-only origin main
./scripts/ubuntu-deploy.sh --help
```

工作区有未提交改动时先处理，不强制覆盖。安装器读取当前目录对应的源码，自动生成独立发布快照，服务不会直接运行源码工作区。

## 二、准备专属 PostgreSQL 数据库

数据库需要 PostgreSQL 16、专属数据库及非超级用户登录角色。安装器只检查连接；项目 API 首次启动时初始化自己的表，不创建、重置或删除数据库及角色。

### 1. 新服务器使用本机数据库

仅在需要新建本机数据库、且同名角色和库不存在时执行。下面 post_bridge 为示例专属名称；如使用其他名称，后续配置和备份命令保持一致。已有数据库或使用托管数据库时跳过这些创建命令，沿用数据库管理员提供的专属连接。

```bash
sudo apt-get install -y postgresql-16 postgresql-client-16
sudo systemctl start postgresql
sudo -u postgres createuser --pwprompt --no-superuser --no-createdb --no-createrole post_bridge
sudo -u postgres createdb --owner=post_bridge post_bridge
psql --host 127.0.0.1 --port 5432 --username post_bridge --dbname post_bridge --password --command 'SELECT current_database(),current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user;'
```

rolsuper 与 rolbypassrls 必须均为 false，API 启动会拒绝不符合的角色。密码在交互提示中填写，不作为命令参数。不要给应用 postgres 超级用户权限，也不要指向 postgres、template0、template1 或其他业务库。已有数据库的角色需有目标 schema 的建表与访问权限。

已有专属数据库从超级用户运行方式升级时，先完成第六节停机与备份，再由数据库管理员建立受限应用角色、将本项目 schema 与对象所属者改为该角色，并更新私有 DATABASE_URL。API 不会自行给角色降权或更改外部数据库对象所属者；不要向其他业务角色或整个集群执行批量归属操作。

### 2. 外部数据库

由数据库管理员提供主机、端口、专属角色、库名与 CA。使用可信 CA 和主机名校验；DATABASE_URL 中配置 sslmode=verify-full，所引用 CA 必须可被 API 服务用户读取。不要把数据库端口开放到公网。确认连接可用后继续，数据库备份和维护由其管理员负责。

## 三、初始化私有配置并安装

### 1. 生成并编辑配置

在源码根目录执行；configure 仅首次使用，不在升级时重新生成。

```bash
sudo ./scripts/ubuntu-deploy.sh configure
sudoedit /etc/post-bridge/install.json
sudo stat --format='%U %a %n' /etc/post-bridge/install.json
```

权限应为 root 所有、600。按 [配置模板](../deploy/ubuntu-config.example.json) 填写字段，不把真实配置复制回仓库。

| 字段 | 填写要求 |
| --- | --- |
| DATABASE_URL | 专属 PostgreSQL 连接；密码含特殊字符时对连接串密码部分进行 URL 编码；外部连接启用证书校验 |
| PUBLIC_ORIGIN | 对外 HTTPS 域名来源，默认 HTTPS 端口，无路径、查询或账号信息 |
| ADMIN_USERNAME | 后台管理员名；密码由安装器生成，不在此配置明文密码 |
| CSDN_USERNAME | 指定账号的稳定用户名 |
| CSDN_DISPLAY_NAME | 指定账号显示名，用于身份核对 |
| INTEGRATION_ENVIRONMENT、INTEGRATION_SERVICE_ID | 可选，必须同时提供；不启用外部来源时省略 |
| CSDN_IMAGE_HOSTS | 可选，允许转存的正文图片源域名，逗号分隔；未配置时不启用该图源能力 |

需要自定义输入文件时，configure、install、upgrade 均支持 --config；文件仍须位于仓库外、root 所有、权限 0600。该参数只改变输入配置位置，运行环境和安装目录仍使用本页默认部署布局。沿用默认文件最便于后续维护。

```bash
sudo ./scripts/ubuntu-deploy.sh configure --config '〈仓库外私有配置文件〉'
sudoedit '〈仓库外私有配置文件〉'
```

上述自定义步骤与默认 configure 二选一，后续 install、upgrade 需添加相同 --config 参数。

### 2. 首次安装并启动

默认配置使用以下命令。安装器会创建独立服务用户，下载并核对固定工具，安装浏览器与 Linux 依赖，构建快照，检查数据库连接，再启用并启动 API、执行器。

```bash
sudo ./scripts/ubuntu-deploy.sh install
sudo ./scripts/ubuntu-deploy.sh check
sudo systemctl status post-bridge-api.service post-bridge-worker.service --no-pager
sudo systemctl is-enabled post-bridge-api.service post-bridge-worker.service
```

使用自定义配置时，只将上述 install 命令替换为下列命令，不重复执行两次安装；check 命令保持不变。

```bash
sudo ./scripts/ubuntu-deploy.sh install --config '〈仓库外私有配置文件〉'
```

安装器包含 bubblewrap，并通过[专用沙箱准备脚本](../scripts/account_sandbox.py)建立 root 管理、仅 worker 用户组可执行的私有副本与对应 AppArmor 应用策略。保持全局用户命名空间限制，不覆盖系统通用 bwrap 策略。升级时同步系统可信副本；部署用户还应执行以下只读预检，失败时核对宿主策略：

```bash
sudo -u post-bridge-worker setpriv --no-new-privs /opt/post-bridge/tools/account-sandbox/bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev -- /usr/bin/true
```

两个服务应为 active，开机启用状态应为 enabled。首次安装成功已完成启动，不需要再执行其他启动脚本；已有安装使用 upgrade，不重复 install。内部检查通过只代表服务可用，不代表 HTTPS、平台登录或真实发稿已验收。

## 四、配置 HTTPS 并登录后台

### 1. 编辑生成的 Nginx 配置

安装器仅生成项目模板，不自动重载 Nginx。核对域名、完整证书与私钥路径，确认文件已由证书管理流程准备好。

```bash
sudoedit /etc/post-bridge/nginx.conf
```

模板默认的证书路径面向已有 Let's Encrypt 证书；使用其他证书存放位置时在本机配置中修改。模板只代理回环 API，拒绝公网 /internal/；保持登录请求的日志关闭和禁止缓存设置。

### 2. 首次启用项目站点

以下使用 Ubuntu 的 sites-available/sites-enabled 布局。先检查同名文件不存在；检查失败说明已有配置，应编辑并复用已有项目站点，不覆盖或强制替换。使用其他 Nginx 布局时由管理员纳入既有配置。

```bash
sudo test ! -e /etc/nginx/sites-available/post-bridge.conf
sudo test ! -e /etc/nginx/sites-enabled/post-bridge.conf
sudo install --mode=644 /etc/post-bridge/nginx.conf /etc/nginx/sites-available/post-bridge.conf
sudo ln --symbolic /etc/nginx/sites-available/post-bridge.conf /etc/nginx/sites-enabled/post-bridge.conf
sudo nginx -t
```

仅当 nginx -t 成功，且确认不影响其他站点后，启动或重载 Nginx：

```bash
sudo systemctl start nginx
sudo systemctl reload nginx
curl --fail --show-error '〈PUBLIC_ORIGIN 的 HTTPS 地址〉/healthz'
```

### 3. 获取密码并确认账号

仅在服务器受保护终端读取管理员密码，按 q 退出；不把密码复制到聊天、截图或 Git。

```bash
sudo less /var/lib/post-bridge/api/admin-password
```

浏览器打开配置中的 HTTPS 管理地址，用 ADMIN_USERNAME 和该密码登录。进入“平台账号 → 账号设置 → 开始远程登录”，在后台弹窗完成官方认证与指定身份核对。服务器不运行 login-csdn.sh，不需要桌面。完成后检查账号连接状态；首次上线的真实操作按授权范围单独验收。

## 五、日常检查、停止与再次启动

### 1. 检查

```bash
cd '〈服务器源码目录〉'
sudo ./scripts/ubuntu-deploy.sh check
sudo systemctl status post-bridge-api.service post-bridge-worker.service --no-pager
```

检查成功不等于账号登录有效，平台状态仍在后台核对。

### 2. 停止

先结束后台人工登录并确认没有需要保留的进行中操作。停止仅影响这两个项目单元，最多等待各单元的安全清理时间，不停止 Nginx 或数据库；Nginx 暂时返回上游不可用属于停机结果。

```bash
sudo ./scripts/ubuntu-deploy.sh stop
sudo systemctl is-active post-bridge-api.service post-bridge-worker.service
```

两个单元应为 inactive；is-active 在全部停止时返回非零，这是此步骤的预期结果。stop 不取消开机启动，服务器重启后仍会自动启动这两个项目单元。

### 3. 再次启动或重启

已有部署无需重新 install。先启动 API，再启动执行器，随后检查：

```bash
sudo systemctl start post-bridge-api.service
sudo systemctl start post-bridge-worker.service
sudo ./scripts/ubuntu-deploy.sh check
```

需要重启正在运行的部署时，API 重启会联动执行器；操作前先结束人工登录并确认可以中断项目服务。

```bash
sudo systemctl restart post-bridge-api.service
sudo ./scripts/ubuntu-deploy.sh check
```

上述启停不重建代码，不应用刚编辑的 install.json；配置变更需要按下一节执行 upgrade。

## 六、升级代码或应用配置

以下采用停机备份方式，操作清晰且能取得一致的项目状态。若采用数据库服务商快照或其他备份方式，也必须保存同一恢复点所需的数据、凭据和账号状态。

### 1. 确认当前状态并停止项目

确认没有进行中的人工登录或平台操作，记录源码提交后再更新。检查失败应先排查；当前服务原本已停止时直接进入备份，不把停止状态当作升级故障。

```bash
cd '〈服务器源码目录〉'
git status --short
sudo ./scripts/ubuntu-deploy.sh check
sudo ./scripts/ubuntu-deploy.sh stop
```

停止不关闭数据库，后续仍能执行 pg_dump。不要在账号浏览器仍运行时直接打包其目录。

### 2. 创建私有备份目录并记录代码

```bash
umask 077
PB_BACKUP_DIR="$HOME/.local/share/post-bridge/backups/server-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$PB_BACKUP_DIR"
git rev-parse HEAD > "$PB_BACKUP_DIR/source-commit.txt"
sudo readlink /opt/post-bridge/current > "$PB_BACKUP_DIR/release-path.txt"
```

备份位于仓库外，包含凭据和会话，需按受限备份策略保存。

### 3. 备份专属数据库

将下列主机、端口、角色与库名替换为 install.json 对应值；密码在提示中输入，不写入命令行。pg_dump 已由安装器安装。使用外部数据库时先设置 CA 与证书校验；本机数据库可跳过这两条环境设置。

```bash
export PGSSLMODE=verify-full
export PGSSLROOTCERT='〈数据库 CA 文件的绝对路径〉'
```

```bash
pg_dump --host '〈数据库主机〉' --port '〈数据库端口〉' --username '〈专属数据库角色〉' --dbname '〈专属数据库名〉' --password --format=custom --file "$PB_BACKUP_DIR/database.dump"
pg_restore --list "$PB_BACKUP_DIR/database.dump" > /dev/null
```

导出或目录读取失败就停止升级，处理备份问题；目录读取通过只代表归档可识别，不能替代恢复演练。不要对在线数据库直接打包数据目录。

### 4. 备份私有配置、账号状态及项目单元

该命令只打包本项目的配置与状态。浏览器状态已在停止后保存；外部来源存储密钥与初始化标记一并包含。Nginx 项目站点使用本页布局时，再执行第二个归档命令；其他布局需换为管理员实际维护的项目配置路径。

```bash
sudo tar --create --gzip --file "$PB_BACKUP_DIR/private-state.tar.gz" --directory / etc/post-bridge var/lib/post-bridge opt/post-bridge/installation.json etc/systemd/system/post-bridge-api.service etc/systemd/system/post-bridge-worker.service
sudo tar --create --gzip --file "$PB_BACKUP_DIR/nginx-site.tar.gz" --directory / etc/nginx/sites-available/post-bridge.conf etc/nginx/sites-enabled/post-bridge.conf
sudo chmod 600 "$PB_BACKUP_DIR/private-state.tar.gz" "$PB_BACKUP_DIR/nginx-site.tar.gz"
sudo tar --list --gzip --file "$PB_BACKUP_DIR/private-state.tar.gz" > /dev/null
```

证书私钥由现有证书管理与备份流程保管；不得把备份放入源码目录或上传到公开附件。升级不会清理旧发布目录，保留其代码供受控恢复。

### 5. 更新源码或修改配置

确认工作区干净后更新 main。仅修改配置时跳过拉取；只修改代码时无需编辑私有配置。

```bash
git status --short
git switch main
git pull --ff-only origin main
```

```bash
sudoedit /etc/post-bridge/install.json
```

不要重新运行 configure，不删除原密码、内部令牌、接入存储密钥或初始化标记。升级复用这些文件。

### 6. 执行升级并检查

```bash
sudo ./scripts/ubuntu-deploy.sh upgrade
sudo ./scripts/ubuntu-deploy.sh check
sudo systemctl status post-bridge-api.service post-bridge-worker.service --no-pager
curl --fail --show-error '〈PUBLIC_ORIGIN 的 HTTPS 地址〉/healthz'
```

使用自定义输入配置时，将上述 upgrade 命令替换为：

```bash
sudo ./scripts/ubuntu-deploy.sh upgrade --config '〈仓库外私有配置文件〉'
```

首次启用用户隔离时，必须沿用 ADMIN_USERNAME 和全部私有配置。API 初始化事务将已有账号、文章、任务和来源归入该管理员；保留标识、内容、请求去重和有效平台会话。迁移失败不得清库重试，按私有日志处理；成功后用管理员核对原有记录，再创建普通用户检验各自账号列表。新账号目录位于 worker 私有状态中的 managed 根目录，备份 var/lib/post-bridge 时一并保留。

upgrade 会下载并校验 Go 1.26.10，复用已匹配的工具；不需要管理员先替换系统 Go。它自动安装锁定的依赖、构建后台和执行器及 API，并启动新部署，无需在服务器源码目录单独执行 npm ci 或 dev.sh。确认后台能登录、账号状态正常，再恢复已授权的业务操作。

安装器不会覆盖已存在的 /etc/post-bridge/nginx.conf，也不会更新启用站点；仅当本次需要调整 Nginx 时，人工核对模板并编辑实际站点，再校验和重载：

```bash
sudoedit /etc/nginx/sites-available/post-bridge.conf
sudo nginx -t
sudo systemctl reload nginx
```

### 7. 升级失败时

- 构建、下载或数据库连接失败：不会切换到新发布；本流程已预先停机，原服务仍保持停止，排查后重试 upgrade。
- 新服务启动或健康检查失败：安装器尝试恢复原配置、代码指向、单元及原启用／运行状态。本流程原状态为停止，因此成功恢复也不会自动启动原服务。
- 需要恢复原服务时，先确认旧代码与当前数据库结构兼容，再按“再次启动”步骤执行；报告“恢复尚未完成”时先查指定单元日志，不盲目反复安装。
- 数据库不自动回退。不要删除数据库、重置凭据或直接恢复旧数据来解决启动问题；数据库恢复需单独授权、核对来源撤销与防重放状态，并按[运维说明](operations.md)执行。

## 七、查看故障日志

```bash
sudo journalctl --unit post-bridge-api.service --lines 100 --no-pager
sudo journalctl --unit post-bridge-worker.service --lines 100 --no-pager
sudo journalctl --unit nginx --lines 100 --no-pager
```

先核对私有配置、工具下载网络、数据库连接、端口和浏览器依赖。安装器隐藏子进程输出以避免暴露连接和凭据；不要开启请求正文、Cookie、密码、验证码或登录画面日志。对外分享前仅提取脱敏错误。

## 可选外部来源接入

启用时在私有安装配置同时填写 INTEGRATION_ENVIRONMENT、INTEGRATION_SERVICE_ID，并保持 HTTPS PUBLIC_ORIGIN。安装器在 API 私有状态中生成 32 字节十六进制存储密钥，文件权限 0600；API 环境接收 INTEGRATION_MASTER_KEY_FILE、环境与服务标识，worker 不接收这些配置。

升级复用原存储密钥，不能用重新生成替代受控恢复。首次启用同时保存私有初始化标记，升级和临时禁用均保留；密钥与标记一同受控备份恢复，不删除标记来绕过缺钥检查。已启用接入后缺少原密钥应停止启用或升级并报错；禁用再启用同样需要保留原密钥。该密钥不等于签发给调用方的 secret，需独立受限备份。具体守卫与测试见[安装器](../scripts/ubuntu_deploy.py)及[部署用例](../tests/runtime/test_ubuntu.py)。

完成配置后由管理员在“内容来源”创建邀请、审批并配置调用权限，准确步骤见[外部手册](external-integration.md)。配置代码和本地用例不代表目标服务器、真实调用方 或跨网络生产已验收。数据库恢复后的应用停用与撤销核对按[运维流程](operations.md)实施，系统尚未自动完成该处置。

## 代码与私有状态

| 位置 | 所有权与用途 |
| --- | --- |
| /opt/post-bridge/releases 与 current | root 管理的代码快照及当前指向；服务不能改写代码 |
| /opt/post-bridge/tools | 固定 Node.js 22.22.1、npm 10.9.4、Go 1.26.10；下载校验后使用 |
| /etc/post-bridge | root 私有配置目录，配置及服务环境文件 0600 |
| /var/lib/post-bridge/api | 独立 API 用户的 0700 目录；后台密码与内部密钥 0600 |
| /var/lib/post-bridge/worker/profile | 独立执行器用户的 0700 持久浏览器目录；升级保留，不与本地登录助手或其他项目共享 |
| /var/lib/post-bridge/worker | 独立执行器用户的 0700 状态目录；仅持有自己的内部密钥和构建缓存 |
| /var/cache/post-bridge/ms-playwright | 固定浏览器下载位置；由锁文件中的 Playwright 1.64.1 安装对应 Chromium |

API 用户为 post-bridge-api，执行器用户为 post-bridge-worker，均禁止交互登录。执行器不接收数据库连接、后台密码或接入 master key/环境/服务配置。运行单元清除 DISPLAY 与 WAYLAND_DISPLAY，并固定 WORKER_HEADLESS。源码、私有配置、数据库和浏览器目录互相分开。

[API 单元](../deploy/systemd/post-bridge-api.service)与[执行器单元](../deploy/systemd/post-bridge-worker.service)直接前台运行构建产物，异常退出自动重启。API 重启会带动执行器重新启动；停止给出最多 90 秒清理时间，剩余子进程仅在所属 systemd 控制组内清理，不按进程名批量停止。两个单元随系统启动。

## 升级恢复机制与验收边界

升级前备份专属数据库和私有配置，确认没有正在进行的人工登录或平台操作，并在新的已检出源码中执行 upgrade。安装器先完成构建、浏览器依赖和数据库连通检查，再停止旧服务并切换代码；不会重置账号状态、凭据或数据库。切换前在私有内存中保存现有配置、服务单元、代码指向及启用和运行状态。新服务启动或健康检查失败时，恢复这些文件和状态，重新加载单元，仅启动原本运行的服务，并检查原 API 和执行器健康；原本停止的服务保持停止。恢复未完成会明确报告，不会静默认定成功。数据库不自动回退，因此表结构升级必须向前兼容，原运行程序仍须能读取升级后的表结构。管理员排查后重新执行 upgrade；不要通过重建数据库解决启动问题。

运行检查只证明服务和回环通信已就绪，不代表平台已登录、真实草稿保存通过或生产上线验收完成。平台状态请在“平台账号”头部及“账号设置”页签核对。

通过 systemctl 查看 post-bridge-api.service、post-bridge-worker.service 的状态；通过 journalctl 按这两个精确单元定位启动、连接和退出日志。安装错误统一隐藏子进程输出，避免连接串或凭据出现在终端；配置错误先核对私有文件、固定工具版本、软件源、端口和服务日志。不要开启请求正文、Cookie、密码、验证码或登录画面的日志。

[Nginx 模板](../deploy/nginx/post-bridge.conf)只代理至回环 API，拒绝公网访问 /internal/；登录相关请求关闭访问日志、代理缓存和缓冲，并返回禁止缓存标记。TLS 证书由管理员负责续期。数据库和后台状态应按各自备份策略保留，stop 不清理数据。

## 验证边界

部署前先确认 PR 的格式、依赖安全、构建和测试检查通过，检查入口及范围见[代码质量与安全](code-quality.md)。格式化和源码拆分不需要改动私有配置；依赖修复通过安装器重新构建生效。Black 仅用于开发和 CI，运行服务器无需额外安装。

[部署安全测试](../tests/runtime/test_ubuntu.py)覆盖安装快照的文档资源、来源配置、凭据隔离、升级保留、符号链接拒绝、代码切换和代理保护。[CI](../.github/workflows/ci.yml)使用安装器生成独立快照，再从该快照安装依赖、构建后台、执行器和 API。[独立 systemd 检查](../scripts/ubuntu_systemd_smoke.py)使用随机单位名、随机端口和合成服务验证无桌面启动、崩溃重启、API 重启、子进程清理及无关进程保留；结束时删除临时单位与进程。

本地使用用户级 systemd 完成独立合成验证；用户级环境关闭需要系统权限的挂载隔离。CI 以系统级临时单位复验生产单元同源的进程和文件隔离规则。当前没有目标服务器，实际 root 安装、HTTPS 证书、真实账号远程登录及生产验收需在目标环境分别完成；不将本地合成验证记为生产已部署。

## 可选导入已有账号会话

网页新增账号无需文件配置。导入已验证会话时，在停止执行器后准备两份各服务可读的账号文件和独立令牌。以下命令在服务器 Bash 中执行，只适用于新建的额外账号；已有文件保留，不覆盖已有凭据。每个额外账号使用独立标识、目录和令牌，不能使用个人日常浏览器目录。

```bash
sudo systemctl stop post-bridge-worker.service
sudo install -d -m 700 -o post-bridge-worker -g post-bridge-worker /var/lib/post-bridge/worker/imported-extra
sudo install -m 600 -o post-bridge-worker -g post-bridge-worker /dev/null /var/lib/post-bridge/worker/imported-extra-token
openssl rand -hex 32 | sudo tee /var/lib/post-bridge/worker/imported-extra-token > /dev/null
sudo install -m 600 -o post-bridge-api -g post-bridge-api /var/lib/post-bridge/worker/imported-extra-token /var/lib/post-bridge/api/imported-extra-token
sudo install -m 600 -o post-bridge-api -g post-bridge-api deploy/platform-accounts.example.json /var/lib/post-bridge/api/accounts.json
sudo install -m 600 -o post-bridge-worker -g post-bridge-worker deploy/platform-accounts.example.json /var/lib/post-bridge/worker/accounts.json
sudoedit /var/lib/post-bridge/api/accounts.json
sudoedit /var/lib/post-bridge/worker/accounts.json
sudoedit /etc/post-bridge/install.json
```

已有 accounts.json 时跳过模板复制，在原文件的 accounts 中追加；两份文件的 id、platform、username、user_id、owner_username 保持一致，owner_username 必须是已存在的本站用户。API 文件的 worker_token_file 指向 API 私有令牌副本，worker 文件指向 worker 私有令牌；profile_dir 指向对应的 worker 会话目录。将已核对、已关闭浏览器的专属会话保存到该目录，并核对 worker 所有、目录 0700 和文件受限权限。

install.json 中 API_PLATFORM_ACCOUNTS_FILE 和 WORKER_PLATFORM_ACCOUNTS_FILE 分别填写上述文件位置。按第六节备份并执行 upgrade，再运行 check，登录对应用户检查账号及只读同步。不要仅启动旧部署以为新配置已生效；不要把包含真实身份与目录的文件提交到 Git。

## DeepSeek 格式化

可选服务不改变基础草稿与来源流程。以下命令在目标服务器 Bash 执行；启用会发送获授权的原稿到 DeepSeek。先按本页备份数据库与私有配置，再选择维护窗口。

1. 准备 root 私有模型配置目录。从终端隐藏输入已有 DeepSeek 密钥，脚本生成私有配置；密钥不进入命令参数或仓库：

```bash
sudo install -d -m 700 /etc/post-bridge/model
read -r -s -p 'DeepSeek 密钥：' PB_DEEPSEEK_KEY
printf '\n'
printf '%s' "$PB_DEEPSEEK_KEY" | sudo python3 scripts/formatting_config.py --provider-dir /etc/post-bridge/model --key-stdin
unset PB_DEEPSEEK_KEY
sudoedit /etc/post-bridge/install.json
```

2. 在已有私有部署 JSON 中增加下表字段，不更改数据库和账号配置。模型可在 deepseek-config.json 的 model 字段调整；默认 deepseek-flash。参数及范围见 [AI 格式化](ai-formatting.md)。

| 字段 | 值 |
| --- | --- |
| AI_FORMATTING_ENABLED | 布尔值 true |
| AI_PROVIDER_CONFIG_FILE | /etc/post-bridge/model/deepseek-config.json |

3. 已部署环境执行 upgrade；首次部署则在完成前述数据库、凭据与 HTTPS 准备后执行 install。安装器安装中文和等宽字体、构建排版服务，隔离 API、worker 和 formatter 用户，只向 API 提供模型密钥：

```bash
sudo ./scripts/ubuntu-deploy.sh upgrade
sudo ./scripts/ubuntu-deploy.sh check
sudo systemctl status post-bridge-api.service post-bridge-worker.service post-bridge-formatter.service --no-pager
```

4. 登录后台，用合成原稿验证生成、取消、CSDN 采用和小红书下载。check 仅证明服务就绪，不会验证余额、真实模型输出、平台写入或生产验收。排障检查三个精确单元的日志，不记录原文、模型响应或凭据。

5. 停止和再次启动已经启用的部署：

```bash
sudo ./scripts/ubuntu-deploy.sh stop
sudo systemctl start post-bridge-formatter.service post-bridge-api.service post-bridge-worker.service
sudo ./scripts/ubuntu-deploy.sh check
```

6. 升级继续使用本页备份与 upgrade。可选服务启动或健康检查失败时，安装器恢复切换前的配置、代码及运行状态；数据库不回退。关闭功能时在私有 install.json 将开关改为 false 后执行 upgrade，安装器只停用本项目登记的 formatter 单元。备份数据库、/etc/post-bridge 和 /var/lib/post-bridge/api 私有配置，不把密钥提交到 Git；恢复后重新核对权限和授权。

## 小红书只读账号

支持配置独立的小红书会话、登录检查和笔记只读同步。完整私有配置字段、逐步启动和部署命令见[平台账号管理](platform-accounts.md)。不配置时保持 CSDN 单平台运行；不开放小红书上传、草稿或发布。
