# 本地开发与运行

## 当前范围

提供多用户独立登录、同平台多账号的 CSDN 与小红书账号工作台，以及 CSDN 草稿后台：登录、总览、草稿创建与预览、队列、任务详情、账号检查、账号文章只读列表与正文及对象处理记录，以及小红书资料统计、笔记正文图片只读、来源应用、平台稿确认与分发工作台。Go API 管理 PostgreSQL，独立 Node.js/Playwright 执行器操作官方编辑器。关闭网页后任务仍继续；运行时无需 AI Agent、模型服务或模型密钥。

后台直接建稿支持文字 Markdown。启用图源白名单后，外部来源稿还可通过 CSDN 转存受控正文图片。标题为 5—100 字，正文不超过 200000 字。支持围栏代码、表格和公式，拒绝 MDX 和可执行 HTML。管理员可对已核对的 CSDN 来源草稿确认正式发布。验证状态见[总体进度](progress.md)。

## 使用约定与脚本

本页所有命令都在 **WSL Ubuntu 的 Bash 终端**执行；服务器部署使用[Ubuntu 部署说明](ubuntu-deployment.md)。命令逐条执行，某条失败后先处理错误，再执行下一条。安装系统依赖会修改 WSL 系统；初始化和启动会开启项目进程；停止会中断项目服务，执行前确认没有需要保留的进行中操作。

命令中的“〈…〉”需要替换为本机值。真实账号、连接信息和运行目录只填写在本机输入或仓库外私有配置中，不写入 Git。Shell 入口复用 [runtime.py](../scripts/runtime.py)，仍需要 Python 3；不需要 PowerShell 或模型密钥。

| 入口 | 用途 |
| --- | --- |
| [setup.sh](../scripts/setup.sh) | 生成私有配置与凭据，初始化并启动独立数据库 |
| [dev.sh](../scripts/dev.sh) | 启动数据库，构建并启动 API 与执行器；后台页面由 API 提供 |
| [status.sh](../scripts/status.sh) | 查看登记的 API、执行器和数据库进程 |
| [stop.sh](../scripts/stop.sh) | 按顺序停止登录助手、执行器、API 和独立数据库，保留数据 |
| [login-csdn.sh](../scripts/login-csdn.sh) | 停止执行器，在 WSLg 图形窗口人工登录指定账号 |
| [test.sh](../scripts/test.sh) | 运行 Go API 与 Node 工作区测试；不包含 E2E 和 Python 运行安全测试 |

已有工具和私有配置时，可直接按第三至五节进行日常启动、停止与升级；无需重复安装和初始化。

## 一、首次准备开发环境

### 1. 进入源码目录

已有仓库直接进入；需要首次下载时，先执行克隆。源码建议放在 WSL Linux 文件系统中。

```bash
git clone '〈仓库 SSH 地址〉' '〈WSL 源码目录〉'
cd '〈WSL 源码目录〉'
git status --short
```

已有仓库不要重复克隆。检查结果有未提交改动时先保留并处理，不执行强制覆盖或清理。

### 2. 准备基础工具

固定环境为 Ubuntu 24.04、Python 3.12、Node.js 22.22.1、npm 10.9.4、Go 1.26.10、PostgreSQL 16 和 Playwright 1.64.1。以下工具下载命令面向 x86_64 WSL；先确认架构。已有匹配工具时跳过对应安装步骤。

```bash
uname -m
cat /etc/os-release
sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils build-essential git python3 less nano postgresql-16 postgresql-client-16 fonts-noto-cjk bubblewrap apparmor-utils
python3 --version
```

PostgreSQL 软件包可能启动系统默认集群；开发入口只管理自己的独立集群，不停止或复用系统集群。不要以 root 或 sudo 运行本地 setup.sh、dev.sh。

### 3. 安装固定 Node.js 与 npm

工具安装在当前 Linux 用户的私有工具目录。先下载并核对官方 SHA-256，核对通过后再解压。

```bash
export PB_TOOLS="$HOME/.local/share/post-bridge/tools"
install -d -m 700 "$PB_TOOLS/downloads"
cd "$PB_TOOLS/downloads"
curl --fail --location --output node-v22.22.1-linux-x64.tar.xz https://nodejs.org/dist/v22.22.1/node-v22.22.1-linux-x64.tar.xz
curl --fail --location --output node-SHASUMS256.txt https://nodejs.org/dist/v22.22.1/SHASUMS256.txt
sha256sum --ignore-missing --check node-SHASUMS256.txt
tar --extract --xz --file node-v22.22.1-linux-x64.tar.xz --directory "$PB_TOOLS"
export PATH="$PB_TOOLS/node-v22.22.1-linux-x64/bin:$PATH"
node --version
npm install --global --prefix "$PB_TOOLS/node-v22.22.1-linux-x64" npm@10.9.4
npm --version
```

版本输出应分别为 v22.22.1、10.9.4。校验失败时停止，不使用未通过校验的归档。

### 4. 安装固定 Go

模块最低工具链要求为 Go 1.26.10，本地启动器、服务器安装器及 CI 使用同一补丁版本。官方[兼容性说明](https://go.dev/doc/go1compat)以源码兼容为原则；升级后需重新构建，[补丁发布说明](https://go.dev/doc/devel/release#go1.26.0)包含标准库与证书校验修复。

下载归档及官方版本目录。用 less 查看格式化后的目录，找到 version 为 go1.26.10、filename 为 go1.26.10.linux-amd64.tar.gz 的 sha256，按 q 退出，再输入该摘要进行校验。

```bash
cd "$PB_TOOLS/downloads"
curl --fail --location --output go1.26.10.linux-amd64.tar.gz https://go.dev/dl/go1.26.10.linux-amd64.tar.gz
curl --fail --location --output go-downloads.json 'https://go.dev/dl/?mode=json&include=all'
python3 -m json.tool go-downloads.json | less
read -r -p '请输入上述 Go 文件的官方 SHA-256：' PB_GO_SHA256
printf '%s  %s\n' "$PB_GO_SHA256" go1.26.10.linux-amd64.tar.gz | sha256sum --check
install -d -m 755 "$PB_TOOLS/go-1.26.10"
tar --extract --gzip --file go1.26.10.linux-amd64.tar.gz --strip-components=1 --directory "$PB_TOOLS/go-1.26.10"
export PATH="$PB_TOOLS/go-1.26.10/bin:$PATH"
go version
```

输出应包含 go1.26.10 和 linux/amd64。工具下载缓存可留在私有工具目录，不属于项目运行数据。

### 5. 设置当前终端的工具路径

每次打开新的 Bash 终端，先执行以下命令，再进入项目。需要长期保留时，可由本机用户把这些非敏感工具路径加入自己的 Shell 配置；不要提交个人配置文件。

```bash
export PB_TOOLS="$HOME/.local/share/post-bridge/tools"
export PATH="$PB_TOOLS/node-v22.22.1-linux-x64/bin:$PB_TOOLS/go-1.26.10/bin:$PATH"
export POST_BRIDGE_PG_BIN=/usr/lib/postgresql/16/bin
cd '〈WSL 源码目录〉'
command -v node npm go python3
node --version
npm --version
go version
"$POST_BRIDGE_PG_BIN/postgres" --version
```

工具必须来自 Linux，不能指向 Windows 安装。启动器优先使用上述私有目录中的固定工具，再查找 Linux PATH。已有私有 PostgreSQL 工具时，可将 POST_BRIDGE_PG_BIN 改为其服务端 bin 目录；准备方式见 [runtime.py](../scripts/runtime.py)。

### 6. 安装项目依赖和浏览器

在源码根目录执行。浏览器依赖安装可能请求 sudo 权限；浏览器本体由当前 Linux 用户安装，不以 sudo 执行整个 npx 命令。

```bash
npm ci --no-audit --no-fund
npx --no-install playwright --version
npx --no-install playwright install --with-deps chromium
```

执行账号沙箱预检：

```bash
bwrap --version
bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev -- /usr/bin/true
```

Ubuntu 24.04 的 AppArmor 可能拒绝用户命名空间。出现 uid map 权限错误时，由管理员审阅[专用沙箱准备脚本](../scripts/account_sandbox.py)后执行下列命令。它创建 root 管理、当前开发用户组可执行的项目专用文件和对应应用策略，保持全局限制；不修改系统通用 bwrap 策略。

```bash
sudo python3 scripts/account_sandbox.py --local
read -r -p '请输入上述返回的项目沙箱执行文件路径：' PB_SANDBOX
"$PB_SANDBOX" --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev -- /usr/bin/true
```

首次初始化 runtime.json 后，将 ACCOUNT_SANDBOX_EXECUTABLE 填为返回的绝对路径，再启动服务。失败时检查宿主策略，不使用无隔离执行模式。原理见[Ubuntu 官方说明](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)。

Playwright 应为 1.64.1。使用现有浏览器时，可在私有 runtime.json 中填写 PLAYWRIGHT_EXECUTABLE_PATH；不要把本机浏览器路径写入仓库配置。

## 二、初始化本地配置与数据库

### 1. 选定私有状态目录

下面使用启动器的默认位置。已有运行数据必须继续使用原目录；自定义时改为仓库外的专属绝对路径，后续命令保持一致。新终端需重新设置 PB_STATE。

```bash
export PB_STATE="$HOME/.local/share/post-bridge/runtime/csdn-task-pipeline"
./scripts/setup.sh --help
```

不同状态目录仍可能使用同一开发端口及同账号浏览器目录，因此不能靠更换 --state 同时启动多套服务。

### 2. 首次指定账号并初始化

输入平台稳定用户名与显示名；真实值不写入命令历史。已有 runtime.json 时会复用其账号和凭据，临时环境变量不会覆盖配置。

```bash
read -r -p 'CSDN 稳定用户名：' CSDN_USERNAME
read -r -p 'CSDN 显示名：' CSDN_DISPLAY_NAME
export CSDN_USERNAME CSDN_DISPLAY_NAME
./scripts/setup.sh --state "$PB_STATE"
unset CSDN_USERNAME CSDN_DISPLAY_NAME
```

成功后生成权限受限的 runtime.json、管理员密码和内部凭据，并启动独立 PostgreSQL 数据库；API 与执行器尚未启动。状态目录权限为 0700，凭据为 0600。账号浏览器目录单独位于仓库外，位置由 runtime.json 中的 CSDN_PROFILE_DIR 指定。

```bash
./scripts/status.sh --state "$PB_STATE"
```

启动器为自己的独立集群建立非超级用户、不可绕过行权限的 postbridge_app 角色，保留数据库及表，并将 API 连接保存到私有 runtime.json；db-password 仅用于该集群维护，db-application-password 为应用凭据。外部数据库由管理员准备，不能交给本地独立集群入口管理。

此时 database 应为 true，api、worker 应为 false。若初始化后暂不继续，执行本页的停止命令，避免留下数据库进程。

## 三、启动并登录后台

### 1. 构建并启动

使用专用沙箱执行文件时，先编辑私有配置，设置 ACCOUNT_SANDBOX_EXECUTABLE 为准备步骤返回的路径；目录和身份等真实配置不写入仓库。

```bash
nano "$PB_STATE/runtime.json"
```

```bash
./scripts/dev.sh --state "$PB_STATE"
./scripts/status.sh --state "$PB_STATE"
```

dev.sh 会构建后台、执行器和 Go API，等待 API 就绪后启动执行器；状态应全部为 true。启动结果包含管理地址、管理员用户名及密码文件位置，不打印密码。关闭终端或网页不会停止后台服务；WSL 或 Windows 关闭、重启后，需重新执行 dev.sh。

### 2. 打开后台并核对健康

使用启动结果中的管理地址。在本机受保护终端读取密码后输入后台，不复制到聊天、截图或仓库；less 按 q 退出。

```bash
less "$PB_STATE/admin-password"
curl --fail --show-error '〈启动结果中的管理地址〉/healthz'
```

管理员可先在“用户管理”创建普通用户；每个用户在“平台账号”绑定自己的一个或多个账号。同平台账号通过账号选择器切换。进入“平台账号 → 账号设置”，使用“开始远程登录”完成指定账号验证。服务运行不等于平台已登录。

### 3. 可选：使用本地图形登录助手

本步骤需要 WSLg。助手会先停止执行器、独占专属浏览器目录，确认指定账号或等待超时后关闭窗口。完成后重新启动执行器，并在后台检查需要继续的任务。

```bash
./scripts/login-csdn.sh --state "$PB_STATE"
./scripts/dev.sh --state "$PB_STATE" --skip-build
./scripts/status.sh --state "$PB_STATE"
```

只有代码、依赖及构建产物均未变化时才使用 --skip-build；日常修改后的启动使用正常 dev.sh。

## 四、停止服务

先在后台结束人工登录，确认当前平台操作可停止，再执行：

```bash
./scripts/stop.sh --state "$PB_STATE"
./scripts/status.sh --state "$PB_STATE"
```

api、worker、database 均应为 false。停止按登记的进程身份执行，保留数据库、密码、账号会话和日志，不停止无关服务。报错时先查日志，不使用按进程名批量终止或删除浏览器目录的方式处理。

```bash
tail -n 100 "$PB_STATE/api.log"
tail -n 100 "$PB_STATE/worker.log"
tail -n 100 "$PB_STATE/postgres.log"
```

## 五、本地升级：更新代码、依赖或配置

### 1. 停止并保存本地数据

先按上一节停止全部项目进程。备份前在本机查看 runtime.json，确认浏览器目录；它不在状态目录内，需单独备份。备份包含密码和会话，必须保存在仓库外受限目录。

```bash
less "$PB_STATE/runtime.json"
read -r -p '请输入上述 CSDN_PROFILE_DIR 的绝对路径：' PB_PROFILE
test -d "$PB_PROFILE"
umask 077
PB_BACKUP_DIR="$HOME/.local/share/post-bridge/backups/local-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$PB_BACKUP_DIR"
tar --create --gzip --file "$PB_BACKUP_DIR/runtime.tar.gz" --directory "$PB_STATE" .
tar --create --gzip --file "$PB_BACKUP_DIR/account.tar.gz" --directory "$(dirname -- "$PB_PROFILE")" "$(basename -- "$PB_PROFILE")"
```

网页新增账号默认保存在初始 CSDN 会话目录同级的 managed 目录；若私有配置设置 WORKER_PROFILE_ROOT 则使用该目录。备份需包含所有新增和导入账号目录，不能仅保存初始账号。按实际配置对这些仓库外目录逐个执行：

```bash
read -r -p '新增或导入会话根目录：' PB_EXTRA_PROFILE
test -d "$PB_EXTRA_PROFILE"
tar --create --gzip --file "$PB_BACKUP_DIR/accounts-$(date -u +%s).tar.gz" --directory "$(dirname -- "$PB_EXTRA_PROFILE")" "$(basename -- "$PB_EXTRA_PROFILE")"
```

上述 runtime.tar.gz 包含已停止的数据库物理文件，只用于同 PostgreSQL 主版本和兼容环境的受控恢复。若 runtime.json 引用额外的外部接入密钥文件，也需单独受限备份。不要在数据库运行时直接复制 pgdata。

备份后逐个检查归档可读并记录校验值，在独立私有目录和独立端口恢复副本，确认原账号、任务和文章完整后再升级。副本中的多用户验证使用合成身份，不启动连接真实平台的执行器；演练结束关闭其数据库、API 和浏览器，保留备份。校验命令在 WSL/Ubuntu Bash 中执行：

```bash
tar --list --gzip --file "$PB_BACKUP_DIR/runtime.tar.gz" > /dev/null
tar --list --gzip --file "$PB_BACKUP_DIR/account.tar.gz" > /dev/null
sha256sum "$PB_BACKUP_DIR"/*.tar.gz > "$PB_BACKUP_DIR/SHA256SUMS"
sha256sum --check "$PB_BACKUP_DIR/SHA256SUMS"
```

本地存在多套配置时，先用各自 state 参数检查状态并核对数据库、管理员和账号来源；不要因默认端口被占用而改连其他测试库。停止占用端口的服务前确认其归属和影响。完整本地升级与恢复副本的隔离验证结果见[验收记录](acceptance.md)。

### 2. 更新源码或修改私有配置

使用主分支更新时逐条执行以下命令。git status 有输出时先处理自己的改动；不运行强制重置。正在开发功能分支时，按分支流程更新，不强行切换 main。

```bash
git status --short
git switch main
git pull --ff-only origin main
go version
npm ci --no-audit --no-fund
npx --no-install playwright install --with-deps chromium
```

更新后确认 Go 为 1.26.10；工具缺失或版本不符时，先按本页固定 Go 安装步骤准备新工具并重新设置 PATH，再继续构建。只修改代码时不必拉取；只修改配置时不必重装依赖。私有配置在本机编辑，不提交到仓库：

```bash
nano "$PB_STATE/runtime.json"
```

### 3. 重新构建、启动与确认

```bash
./scripts/dev.sh --state "$PB_STATE"
./scripts/status.sh --state "$PB_STATE"
```

首次启用用户隔离时，启动器为其专属本地集群准备受限角色，API 在事务中将已有业务归入 runtime.json 的初始化管理员。必须沿用原 ADMIN_USERNAME、管理员密码、数据库与平台会话；初始化事务失败则停止排查，不能通过清空数据重试。重新打开管理地址，检查已有文章和处理记录归属、普通用户独立登录与账号状态。无需重复初始化或重新生成密码。--skip-build 不适用于此次代码或依赖更新。

## 六、按范围验证与结束开发

### 格式与安全检查

Go 使用 gofmt；TypeScript、TSX、JavaScript、CSS、HTML、JSON 和 YAML 使用锁定的 Prettier；Python 使用 Black 25.1.0。统一入口见[格式化脚本](../scripts/format.mjs)，规则见[Prettier 配置](../.prettierrc.json)和[Python 配置](../pyproject.toml)。文件采用 UTF-8 无 BOM、LF 换行，不手动压缩多个语句或组件到一行。

以下命令在 WSL Bash 中逐条执行。首次准备独立 Python 环境，后续只需激活；格式化工具只用于开发，服务器运行不需要安装 Black。

```bash
sudo apt-get install -y python3-venv
python3 -m venv .local-tmp/format-venv
source .local-tmp/format-venv/bin/activate
python3 -m pip install black==25.1.0
npm run format
npm run format:check
npm audit --registry=https://registry.npmjs.org
go -C apps/api run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
deactivate
```

CI 检查格式、npm 已知漏洞及 Go 实际调用路径。依赖安全报告不等于真实平台或生产验收；现行审阅范围和限制见[代码质量与安全](code-quality.md)。

### 功能回归

日常只执行受影响用例，示例中的路径和名称换为本次改动范围；完整验证交给 GitHub CI。Go 数据库测试需专属测试连接，勿使用生产库。

需要数据库的 Go 用例先输入专属测试连接；输入不回显，也不写入命令历史。用例结束后清理该环境变量。

```bash
read -r -s -p '专属测试数据库连接：' TEST_DATABASE_URL
printf '\n'
export TEST_DATABASE_URL
```

```bash
npm run test --workspace @post-bridge/admin -- '〈测试文件路径〉'
npm run test --workspace @post-bridge/worker -- '〈测试文件路径〉'
go -C apps/api test ./... -run '〈用例名称〉' -count=1
unset TEST_DATABASE_URL
```

需要主动运行 Go 与 Node 测试集时，先确保本地独立数据库运行，并使用现有配置：

```bash
./scripts/test.sh --state "$PB_STATE"
```

test.sh 使用私有配置中的数据库连接，不能指向生产环境；它不包含 E2E 和 Python 启动／部署安全用例。结束开发后执行停止命令，再确认全部项目进程已停止。

## 可选账号存储配置

网页绑定无需增加配置文件。WORKER_PROFILE_ROOT 可在私有 runtime.json 指定新增账号根目录，需位于仓库外且不得与已导入会话目录包含重叠；运行用户所有、权限 0700。ACCOUNT_SANDBOX_EXECUTABLE 仅在系统 bubblewrap 不位于默认位置时设置，必须为可信可执行文件。新增目录引用由服务端生成，不接受用户路径。

导入已有会话时按[平台账号管理](platform-accounts.md)在仓库外准备 JSON 和每账号独立令牌，限制文件 0600、目录 0700；在私有 runtime.json 设置 PLATFORM_ACCOUNTS_FILE 后重启。owner_username 须为已有用户，省略时归初始化管理员。首次迁移复用原会话，不要求重新扫码；后续仍会核对平台身份。

## 可选外部来源配置

日常本地草稿开发仍沿用现有启动方式，不必启用来源接入。需要联调时，在仓库外私有 runtime.json 配置 INTEGRATION_MASTER_KEY_FILE、INTEGRATION_ENVIRONMENT、INTEGRATION_SERVICE_ID，并设置 HTTPS PUBLIC_ORIGIN；值在本地私有配置填写，不提交真实地址、身份或目录。密钥文件保存 32 字节的十六进制文本并限制为 0600，状态目录为 0700；密钥只用于 API 的受控加密存储，不使用 worker 密钥代替。

[runtime.py](../scripts/runtime.py)仅向 API 传递接入配置，worker 不接收 master key。直接启动 API 时使用同名环境配置，并遵循[API 配置](../apps/api/runtime.go)校验。未启用时外部内容接口明确拒绝，不影响原有本地草稿流程。

“内容来源”提供邀请、申请审批、应用配置、一次性密钥、平台稿修订确认和分发记录。一次性密钥只保存在弹窗临时内存，关闭、离开或隐藏后清理；来源暂停走“处理来源授权”，与平台账号登录区分。准确调用步骤和调用方实施职责见[外部手册](external-integration.md)。登录后点击顶部文档图标可在站内阅读，也可下载 OpenAPI 和共同测试向量。网页直接读取仓库的现行文档，在构建时打包；修改手册后需重新构建后台。

## 草稿流程

1. 登录管理后台，在“平台账号”的“账号设置”页签点击“开始远程登录”，在弹窗内扫码、填写手机号和验证码或拖动验证；服务器无需桌面。手机号不含国家区号；填入后在官方画面获取短信或确认登录。指定账号确认后关闭登录会话并恢复等待任务，弹窗保留结果。关闭按钮或 Escape 结束未完成会话并清空输入。本地登录助手作为可选方式，需要 WSLg 或 Linux 图形环境，使用后通过开发入口重启执行器并手动继续；无桌面服务器使用后台远程登录。
2. 新建草稿，检查标题、Markdown 预览及范围提示，提交后保留任务详情链接。请求标识与内容快照一起去重，同标识不同内容会被拒绝。
3. 执行器领取任务，核对账号后打开编辑器、记录草稿 ID、填写并确认标题同步，核对原生请求标题后保存。重新读取平台标题和正文一致后才显示“草稿已保存”，可跳转 CSDN 编辑器检查。
4. 在“处理记录”按文章或账号查看每次提交，点击进入本次流程、结果、状态图及内容变更。整体对比取最早采集前值和最新采集后值，也可选择单轮执行；没有快照的已有任务显示未采集。全部日志入口继续支持级别、任务和时间筛选。
5. 登录失效进入等待；超时或外站结果不确定后，后台自动查询草稿列表并核对正文，无需提供 ID。完整匹配直接成功；两次完整查询确认未保存后有限重试原任务。重复、残稿或查询耗尽会明确失败，可选择重新核对或人工结束；具体规则见[运维说明](operations.md)。

## 平台账号

进入“平台账号”默认显示“文章”。在该页签点击“同步文章”，后台完整读取账号文章与草稿并保存快照。文章页支持标题搜索、状态筛选和分页；“数据统计”集中展示汇总和默认可见的六项趋势图，账号头部始终显示平台头像、身份、连接状态及最后同步时间；“刷新本地状态”只刷新本系统数据，不重复抓取 CSDN。

页签、筛选和分页随地址保存；刷新、浏览器前进后退，以及从独立正文返回，都恢复原状态。“账号设置”提供检查登录和远程登录，离开设置会结束未完成验证。

点击文章进入独立详情，无正文缓存时自动创建一次只读任务，读取平台真实正文、摘要、标签和分类；活动任务不重复创建，失败或取消后可手动读取，已有缓存可“刷新正文”。直接显示 Markdown 源文，仅有 HTML 时显示 HTML 源文，不执行脚本、链接或加载正文图片。CSDN 原文与编辑器链接在新窗口打开，本系统不保存、删除或发布已有文章。

首次同步前为空；同步失败保留已有数据，未知状态独立显示。需要登录时前往账号页完成验证，读取任务随后恢复。同步成功后清除旧正文缓存，详情会按需重新读取；正文缓存保留 30 天。

## 测试与文件

源码位于 apps/api、apps/admin、apps/worker；跨服务测试位于 tests/e2e，启动安全测试位于 tests/runtime。Go 使用 testing 与真实隔离数据库，前端使用 Vitest/Testing Library，执行器使用本地模拟编辑器，端到端使用 Playwright。

在 Linux 工具环境中使用根工作区的 build、typecheck、test、test:e2e 脚本。E2E 和 Go 集成测试通过 TEST_DATABASE_URL 连接测试库，创建并删除随机 schema；不得指向无隔离权限的生产库。GitHub CI 运行全量验证；日常本地只运行受影响用例。接口与限制见[API 契约](api.md)，异常和保留规则见[运维说明](operations.md)。
## Ubuntu 服务器

常驻服务使用[Ubuntu 部署说明](ubuntu-deployment.md)及独立安装器，不使用 WSL 后台启动脚本。开发入口默认仅在回环 18081 启用远程登录控制；通过已登录后台转发，不向外开放该端口。

## 小红书账号

支持配置独立的小红书会话、登录检查和笔记只读同步。完整私有配置字段、逐步启动和部署命令见[平台账号管理](platform-accounts.md)。不配置时保持 CSDN 单平台运行；不开放小红书上传、草稿或发布。
