# 平台账号管理

## 已开放能力

后台“平台账号”支持切换 CSDN 与小红书，每个平台绑定一个账号。CSDN 保持文章、统计、正文、草稿及受控发布流程；小红书仅提供登录检查和已有笔记只读列表。外部来源接口仍只开放 CSDN 草稿。

小红书复用管理员已在官方页面登录的专属浏览器目录，同时匹配预期小红书号和官方稳定用户标识。账号绑定通过仓库外私有配置管理；此范围不提供网页内新增、换绑、删除账号或小红书远程登录。相同账号标识不能静默换成其他身份。

笔记列表保留完整同步快照，支持本地搜索、分页和状态筛选。未知状态显示“状态待确认”，缺失统计显示“—”。同步失败、取消、失租或结构变化不覆盖上次快照。读取超过 2000 条、100 页或分页未完整结束时停止并报错。未开放笔记正文、素材、草稿、发布、编辑或删除。

## 本地启用

1. 先按[开发说明](development.md)准备固定工具、初始化私有状态并停止服务。PowerShell 调用：`wsl.exe -d Ubuntu --cd <项目目录> bash scripts/stop.sh --state <私有状态目录>`。
2. 将[账号配置模板](../deploy/platform-accounts.example.json)复制到仓库外私有状态目录。PowerShell 调用：`Copy-Item -LiteralPath <模板绝对路径> -Destination <私有账号配置绝对路径>`。填入下表字段，禁止提交真实配置。
3. 为小红书单独生成至少 32 字符的随机执行器凭据，写入仓库外私有文件。可以在密码管理器生成，不使用账号密码或 Cookie 代替；不能与 CSDN 共用。
4. 设置目录权限：`wsl.exe -d Ubuntu chmod 700 <私有状态目录> <已登录会话目录>`；设置文件权限：`wsl.exe -d Ubuntu chmod 600 <私有账号配置文件> <小红书凭据文件>`。配置必须由运行用户持有。保留现有浏览器会话，不与 CSDN 共用目录，不同时运行其他浏览器。
5. 在私有 runtime.json 中增加 PLATFORM_ACCOUNTS_FILE，值为账号配置文件的 Linux 绝对路径。启动器向 API 和 worker 传递该字段；未配置时只运行 CSDN。
6. 启动：`wsl.exe -d Ubuntu --cd <项目目录> bash scripts/dev.sh --state <私有状态目录>`。浏览器打开私有配置中的管理地址，使用管理员凭据登录。
7. 在“平台账号”选择小红书，进入“账号设置”点击“检查登录状态”。检查完成后进入“笔记”，点击“同步笔记”，查看同步任务及列表；空账号显示“账号暂无笔记”。
8. 使用完毕按步骤 1 停止服务。停止执行器释放目录锁，账号会话保留供下次使用。

| 字段 | 填写要求 |
| --- | --- |
| accounts | 仅包含一个小红书账号，CSDN 继续使用现有配置 |
| id | 稳定的本地账号标识，由字母、数字、下划线或连字符组成，不使用 csdn-main |
| platform | 固定为 xiaohongshu |
| username | 预期小红书号，不是手机号或显示昵称 |
| user_id | 官方账号信息中的 24 位十六进制稳定标识，来自已核对的私有登录证据 |
| display_name | 后台显示名称 |
| profile_dir | 仓库外已登录小红书会话的 Linux 绝对路径 |
| worker_token_file | 小红书独立执行器凭据文件的 Linux 绝对路径 |

## Ubuntu 常驻部署

1. 先按[Ubuntu 部署](ubuntu-deployment.md)准备服务账号、数据库、HTTPS 和安装配置。只读接入不会代替生产验收。
2. 在 API 私有状态目录和 worker 私有状态目录分别准备账号 JSON。两份配置的账号身份保持一致；worker_token_file 分别指向各自目录内的凭据副本，内容相同，不能共用 CSDN 凭据。
3. 将已验证的会话安全迁入 worker 私有状态目录，两份账号 JSON 的 profile_dir 均指向此目录。先确认原浏览器关闭，目录仅由 worker 服务用户持有；不要把账号会话放入部署包、安装快照或 Git。
4. 设置属主：`wsl.exe -d Ubuntu sudo chown <API服务用户>:<API服务组> <API账号配置> <API小红书凭据>`；`wsl.exe -d Ubuntu sudo chown -R <worker服务用户>:<worker服务组> <worker小红书专属目录>`。目录 0700，JSON 和凭据 0600。实际服务器在其管理终端执行对应命令。
5. 在私有安装配置中同时设置 API_PLATFORM_ACCOUNTS_FILE 和 WORKER_PLATFORM_ACCOUNTS_FILE，分别指向对应服务私有状态目录内的 JSON。部署器将它们映射到各服务的 PLATFORM_ACCOUNTS_FILE，不向 worker 传递数据库或来源存储密钥。
6. 按部署文档执行 `bash scripts/ubuntu-deploy.sh upgrade --config <私有安装配置>`。PowerShell 经 WSL 调用：`wsl.exe -d Ubuntu --cd <项目目录> sudo bash scripts/ubuntu-deploy.sh upgrade --config <私有安装配置>`。
7. 检查服务：`wsl.exe -d Ubuntu --cd <项目目录> sudo bash scripts/ubuntu-deploy.sh check`。经 HTTPS 后台完成账号选择、登录检查与笔记同步；分别确认任务账号、结果和时间。

## 故障处理

- 需要登录：任务进入“等待处理”，管理员在同一专属官方会话完成登录后恢复任务；本范围没有小红书远程登录弹窗。不要更换身份绕过检查。
- 账号不匹配：任务失败且账号受限，核对私有配置与官方身份，不覆盖已有数据或自动换绑。
- 浏览器占用：关闭使用相同会话的其他浏览器，再重试。禁止手动删除仍被活跃浏览器使用的锁。
- 结构或分页变化：同步失败并保留旧快照，先检查只读适配与合成用例，再按明确范围复验。非空真实列表、原生状态值和大账号分页仍需真实样例验收。

实现入口：[API 账号与路由](../apps/api/platform_accounts.go)、[笔记与快照](../apps/api/notes.go)、[执行器](../apps/worker/src/xiaohongshu.ts)、[后台工作台](../apps/admin/src/XiaohongshuAccount.tsx)。
