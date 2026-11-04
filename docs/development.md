# 本地开发与运行

## 当前范围

提供单管理员、单 CSDN 账号的草稿后台：登录、总览、草稿创建与预览、队列、任务详情、账号检查及对象处理记录。Go API 管理 PostgreSQL，独立 Node.js/Playwright 执行器操作官方编辑器。关闭网页后任务仍继续；运行时无需 AI Agent、模型服务或模型密钥。

仅支持文字 Markdown，标题 5—100 字、正文不超过 200000 字。可包含围栏代码、表格和公式，不接收图片、MDX 或可执行 HTML。公开发布、CMS 接入、其他平台及生产验收见[总体进度](progress.md)。

## 环境与入口

在 Windows PowerShell 中从项目根目录运行。使用 Ubuntu WSL、Python 3.12、Linux Node.js 22.22.1、npm 10.9.4、Go 1.26.2、PostgreSQL 16 和 Playwright 1.64.1；具体依赖由锁文件固定。需准备 Chromium 与对应 Linux 运行库，中文显示需 Noto CJK 字体。

启动器优先使用当前用户私有工具目录中的固定工具，其次使用 Linux PATH；不会调用 Windows npm。工具安装位置见 [runtime.py](../scripts/runtime.py)。可通过 POST_BRIDGE_PG_BIN 指定 PostgreSQL 服务端工具目录。浏览器可在私有运行配置中用 PLAYWRIGHT_EXECUTABLE_PATH 指定。

| PowerShell 命令 | 作用 |
| --- | --- |
| `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1` | 初始化私有配置与独立本地数据库 |
| `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1` | 构建后台、API 和执行器，启动服务 |
| `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/status.ps1` | 查看本项目进程状态 |
| `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/stop.ps1` | 依次安全停止执行器、API 和独立数据库 |
| `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/login-csdn.ps1` | 暂停执行器，在 WSLg 隔离窗口人工登录 |
| `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1` | 执行 Go 与 Node 完整测试，日常按改动范围选择用例 |

ExecutionPolicy 仅作用于本次 PowerShell 进程，解决 UNC 脚本签名限制，不修改系统策略。首次初始化前，将 CSDN_USERNAME、CSDN_DISPLAY_NAME 设为目标账号；如通过 Windows 调用 WSL，需使用 WSLENV 传递这两个变量，也可直接在 WSL 设置。已有私有配置会复用。修改代码或配置后先停止服务，再运行启动入口，使新构建生效。

默认管理地址为 http://127.0.0.1:18080，数据库仅监听本机 55432，账号为 admin。密码只写入启动结果列出的私有文件，不在终端打印；在本机读取后输入登录表单，禁止粘贴到聊天或提交 Git。私有目录默认位于当前 Linux 用户的 .local/share/post-bridge/runtime/csdn-task-pipeline，权限 0700，凭据文件 0600。可用 StateDir 参数指定仓库外的专属状态目录。

## 草稿流程

1. 登录管理后台，在 CSDN 账号页点击“开始远程登录”，在弹窗内扫码、填写手机号和验证码或拖动验证；服务器无需桌面。手机号不含国家区号；填入后在官方画面获取短信或确认登录。指定账号确认后关闭登录会话并恢复等待任务，弹窗保留结果。关闭按钮或 Escape 结束未完成会话并清空输入。本地登录助手作为可选方式，使用后重启执行器并手动继续。
2. 新建草稿，检查标题、Markdown 预览及范围提示，提交后保留任务详情链接。请求标识与内容快照一起去重，同标识不同内容会被拒绝。
3. 执行器领取任务，核对账号后打开编辑器、记录草稿 ID、填写并确认标题同步，核对原生请求标题后保存。重新读取平台标题和正文一致后才显示“草稿已保存”，可跳转 CSDN 编辑器检查。
4. 在“处理记录”按文章或账号查看每次提交，点击进入本次流程、结果、状态图及内容变更。整体对比取最早采集前值和最新采集后值，也可选择单轮执行；没有快照的已有任务显示未采集。全部日志入口继续支持级别、任务和时间筛选。
5. 登录失效进入等待；超时或外站结果不确定后，后台自动查询草稿列表并核对正文，无需提供 ID。完整匹配直接成功；两次完整查询确认未保存后有限重试原任务。重复、残稿或查询耗尽会明确失败，可选择重新核对或人工结束；具体规则见[运维说明](operations.md)。

## 测试与文件

源码位于 apps/api、apps/admin、apps/worker；跨服务测试位于 tests/e2e，启动安全测试位于 tests/runtime。Go 使用 testing 与真实隔离数据库，前端使用 Vitest/Testing Library，执行器使用本地模拟编辑器，端到端使用 Playwright。

在 Linux 工具环境中使用根工作区的 build、typecheck、test、test:e2e 脚本。E2E 和 Go 集成测试通过 TEST_DATABASE_URL 连接测试库，创建并删除随机 schema；不得指向无隔离权限的生产库。GitHub CI 运行全量验证；日常本地只运行受影响用例。接口与限制见[API 契约](api.md)，异常和保留规则见[运维说明](operations.md)。
## Ubuntu 服务器

常驻服务使用[Ubuntu 部署说明](ubuntu-deployment.md)及独立安装器，不使用 WSL 后台启动脚本。开发入口默认仅在回环 18081 启用远程登录控制；通过已登录后台转发，不向外开放该端口。
