# Ubuntu 无桌面部署

## 范围与准备

支持 Ubuntu 24.04 的 amd64、arm64 服务器。API 和执行器由 systemd 常驻，浏览器使用无头 Chromium，不安装桌面、不开放远程桌面。WSL 本地开发使用[开发入口](development.md)，服务器安装使用独立的 [Ubuntu Shell 管理入口](../scripts/ubuntu-deploy.sh)。

管理员需准备 Python 3.12、系统 CA 证书、可访问 Node.js、Go、npm、Ubuntu 软件源及 Playwright 下载源的网络，以及公开域名、HTTPS 证书和 Nginx。执行安装需要 root 权限。安装器会安装匹配当前 Playwright 的 Chromium 系统依赖、PostgreSQL 16 客户端和 Noto 中文字体；不会自动接管或重载现有 Nginx。

数据库由管理员预先创建专属 PostgreSQL 16 数据库和专属登录角色，再填写 DATABASE_URL。该角色需要连接目标库并在自己的默认 schema 创建、访问项目表的权限；不要使用其他业务库、postgres 默认库或超级用户。外部数据库应使用有效证书并启用连接校验。安装器只检查连接，API 在启动时执行项目自身的幂等表初始化；安装、升级和停止均不创建、重置或删除数据库及角色。数据库由其管理员独立备份、升级和停止。

## 安装入口

在已检出的源码根目录，通过 [scripts/ubuntu-deploy.sh](../scripts/ubuntu-deploy.sh) 执行下表子命令；入口调用当前服务器 Python 3 中的 [部署管理器](../scripts/ubuntu_deploy.py)，参数原样传递。--help 查看完整参数，--config 可指定管理员私有配置文件。

| 操作 | 子命令与行为 |
| --- | --- |
| 生成配置 | configure：首次生成 /etc/post-bridge/install.json，权限 0600，已有文件不覆盖 |
| 安装 | install：读取私有配置，下载并校验固定工具、构建独立快照、安装浏览器并启动服务 |
| 升级 | upgrade：从当前源码重新构建，复用原配置、凭据和浏览器状态，切换代码后启动服务 |
| 检查 | check：确认两个服务、API 健康及回环登录控制服务的匿名拒绝状态 |
| 停止 | stop：先停止执行器，再停止 API；仅操作本部署登记的两个单元 |

1. 管理员先执行 configure，然后在服务器直接编辑生成的私有配置。字段含义见下表；[配置模板](../deploy/ubuntu-config.example.json)仅用于定位，不包含实际凭据。
2. 填写真实值后执行 install。首次运行会生成后台密码和内部密钥，终端仅提示密码文件位置，不打印密码。管理员在服务器受保护终端读取 /var/lib/post-bridge/api/admin-password 后登录，禁止将密码复制到聊天、截图或仓库。
3. 检查完成后，将生成的 /etc/post-bridge/nginx.conf 纳入管理员自己的 Nginx 站点配置，核对域名与证书路径；验证 Nginx 配置成功后再重载。模板首次生成后由管理员维护，升级不会覆盖。
4. 仅向外开放 HTTPS；HTTP 只用于跳转，API、远程登录控制和数据库端口不得向公网开放。在后台“平台账号”的“账号设置”页签完成远程登录和指定身份检查，再开始草稿任务。

通过 SSH 连接服务器后，在服务器源码目录使用 Shell 入口执行上述子命令。除 check 和帮助外，部署操作需要 root 权限。凭据在服务器私有配置中填写，不放入命令参数、SSH 命令、环境传递列表或聊天。

| 配置字段 | 内容 |
| --- | --- |
| DATABASE_URL | 管理员准备的专属数据库连接；仅 API 使用 |
| PUBLIC_ORIGIN | 对外 HTTPS 站点来源，使用正式域名及默认 HTTPS 端口，不带路径 |
| ADMIN_USERNAME | 后台管理员账号，密码由安装器单独生成 |
| CSDN_USERNAME | 指定平台账号的稳定用户名 |
| CSDN_DISPLAY_NAME | 指定账号显示名，用于身份核对 |
| INTEGRATION_ENVIRONMENT、INTEGRATION_SERVICE_ID | 可选外部来源环境与接收服务标识，必须同时提供；省略则不启用来源接入 |

API 和远程登录控制使用仅本机可访问的内部地址，具体以部署配置为准。PUBLIC_ORIGIN 用于校验公网来源，与执行器的回环 API_BASE_URL 分开。后台登录画面只通过已认证 API 转发，不直接暴露执行器控制接口。

## 可选外部来源接入

启用时在私有安装配置同时填写 INTEGRATION_ENVIRONMENT、INTEGRATION_SERVICE_ID，并保持 HTTPS PUBLIC_ORIGIN。安装器在 API 私有状态中生成 32 字节十六进制存储密钥，文件权限 0600；API 环境接收 INTEGRATION_MASTER_KEY_FILE、环境与服务标识，worker 不接收这些配置。

升级复用原存储密钥，不能用重新生成替代受控恢复。首次启用同时保存私有初始化标记，升级和临时禁用均保留；密钥与标记一同受控备份恢复，不删除标记来绕过缺钥检查。已启用接入后缺少原密钥应停止启用或升级并报错；禁用再启用同样需要保留原密钥。该密钥不等于签发给调用方的 secret，需独立受限备份。具体守卫与测试见[安装器](../scripts/ubuntu_deploy.py)及[部署用例](../tests/runtime/test_ubuntu.py)。

完成配置后由管理员在“内容来源”创建邀请、审批并配置调用权限，准确步骤见[外部手册](external-integration.md)。配置代码和本地用例不代表目标服务器、真实调用方 或跨网络生产已验收。数据库恢复后的应用停用与撤销核对按[运维流程](operations.md)实施，系统尚未自动完成该处置。

## 代码与私有状态

| 位置 | 所有权与用途 |
| --- | --- |
| /opt/post-bridge/releases 与 current | root 管理的代码快照及当前指向；服务不能改写代码 |
| /opt/post-bridge/tools | 固定 Node.js 22.22.1、npm 10.9.4、Go 1.26.2；下载校验后使用 |
| /etc/post-bridge | root 私有配置目录，配置及服务环境文件 0600 |
| /var/lib/post-bridge/api | 独立 API 用户的 0700 目录；后台密码与内部密钥 0600 |
| /var/lib/post-bridge/worker/profile | 独立执行器用户的 0700 持久浏览器目录；升级保留，不与本地登录助手或其他项目共享 |
| /var/lib/post-bridge/worker | 独立执行器用户的 0700 状态目录；仅持有自己的内部密钥和构建缓存 |
| /var/cache/post-bridge/ms-playwright | 固定浏览器下载位置；由锁文件中的 Playwright 1.64.1 安装对应 Chromium |

API 用户为 post-bridge-api，执行器用户为 post-bridge-worker，均禁止交互登录。执行器不接收数据库连接、后台密码或接入 master key/环境/服务配置。运行单元清除 DISPLAY 与 WAYLAND_DISPLAY，并固定 WORKER_HEADLESS。源码、私有配置、数据库和浏览器目录互相分开。

[API 单元](../deploy/systemd/post-bridge-api.service)与[执行器单元](../deploy/systemd/post-bridge-worker.service)直接前台运行构建产物，异常退出自动重启。API 重启会带动执行器重新启动；停止给出最多 90 秒清理时间，剩余子进程仅在所属 systemd 控制组内清理，不按进程名批量停止。两个单元随系统启动。

## 升级与排障

升级前备份专属数据库和私有配置，确认没有正在进行的人工登录或平台操作，并在新的已检出源码中执行 upgrade。安装器先完成构建、浏览器依赖和数据库连通检查，再停止旧服务并切换代码；不会重置账号状态、凭据或数据库。切换前在私有内存中保存现有配置、服务单元、代码指向及启用和运行状态。新服务启动或健康检查失败时，恢复这些文件和状态，重新加载单元，仅启动原本运行的服务，并检查原 API 和执行器健康；原本停止的服务保持停止。恢复未完成会明确报告，不会静默认定成功。数据库不自动回退，因此表结构升级必须向前兼容，原运行程序仍须能读取升级后的表结构。管理员排查后重新执行 upgrade；不要通过重建数据库解决启动问题。

运行检查只证明服务和回环通信已就绪，不代表平台已登录、真实草稿保存通过或生产上线验收完成。平台状态请在“平台账号”头部及“账号设置”页签核对。

通过 systemctl 查看 post-bridge-api.service、post-bridge-worker.service 的状态；通过 journalctl 按这两个精确单元定位启动、连接和退出日志。安装错误统一隐藏子进程输出，避免连接串或凭据出现在终端；配置错误先核对私有文件、固定工具版本、软件源、端口和服务日志。不要开启请求正文、Cookie、密码、验证码或登录画面的日志。

[Nginx 模板](../deploy/nginx/post-bridge.conf)只代理至回环 API，拒绝公网访问 /internal/；登录相关请求关闭访问日志、代理缓存和缓冲，并返回禁止缓存标记。TLS 证书由管理员负责续期。数据库和后台状态应按各自备份策略保留，stop 不清理数据。

## 验证边界

[部署安全测试](../tests/runtime/test_ubuntu.py)覆盖安装快照的文档资源、来源配置、凭据隔离、升级保留、符号链接拒绝、代码切换和代理保护。[CI](../.github/workflows/ci.yml)使用安装器生成独立快照，再从该快照安装依赖、构建后台、执行器和 API。[独立 systemd 检查](../scripts/ubuntu_systemd_smoke.py)使用随机单位名、随机端口和合成服务验证无桌面启动、崩溃重启、API 重启、子进程清理及无关进程保留；结束时删除临时单位与进程。

本地使用用户级 systemd 完成独立合成验证；用户级环境关闭需要系统权限的挂载隔离。CI 以系统级临时单位复验生产单元同源的进程和文件隔离规则。当前没有目标服务器，实际 root 安装、HTTPS 证书、真实账号远程登录及生产验收需在目标环境分别完成；不将本地合成验证记为生产已部署。

## 小红书只读账号

支持配置独立的小红书会话、登录检查和笔记只读同步。完整私有配置字段、逐步启动和部署命令见[平台账号管理](platform-accounts.md)。不配置时保持 CSDN 单平台运行；不开放小红书上传、草稿或发布。
