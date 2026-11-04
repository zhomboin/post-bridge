# Repository Guidelines

## 项目结构与范围

本项目提供独立内容分发后台，当前实现 CSDN 文字 Markdown 草稿流程及按对象组织的处理记录。完整范围见 [需求](docs/requirements.md)，交付状态见 [进度](docs/progress.md)；公开发布、其他平台和 CMS 对接仍待实施。

- apps/api：Go 管理接口、认证、PostgreSQL 队列及数据库初始化。
- apps/admin/src：React/TypeScript 后台、页面和样式。
- apps/worker/src：Node.js/Playwright 固定 CSDN 执行器。
- tests/e2e、tests/runtime：跨服务与启动安全测试；单元测试随应用组织。
- scripts：PowerShell 入口与 WSL 运行管理；.github/workflows：CI。

本指南保留根目录，其他文档使用中文 Markdown，放入 docs。所有文件使用 UTF-8 无 BOM。进度和简要变更分别写入 docs/progress.md、docs/version.md；只描述当前状态，已交付任务的详细实施计划及时删除。

## 开发、构建与测试

环境固定 Linux Node.js 22.22.1、npm 10.9.4、Go 1.26.2、PostgreSQL 16 与 Playwright 1.64.1。完整入口见 [开发说明](docs/development.md)。Windows PowerShell 可执行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1` 构建并启动，使用 scripts/stop.ps1 安全停止。

Linux 工作区的 `npm run build`、`npm run typecheck`、`npm test` 分别构建、检查类型和运行应用用例；Go 使用 go test、go vet。不要在 PowerShell 中用 Bash 的串联符，命令分开执行。任务结束关闭本次临时进程、服务和容器，保留无关服务。

## 编码与测试规范

Go 使用 gofmt；TypeScript 两空格缩进，组件 PascalCase，函数和变量 camelCase。当前检查工具为 TypeScript、go vet，未配置 ESLint。平台适配、调度和页面保持独立；执行器不直接连接数据库，不读取 CMS 数据库。

Go 使用 *_test.go，TypeScript 使用 *.test.ts 或 *.test.tsx。测试采用 Go testing、Vitest、Testing Library 和 Playwright，覆盖正常、边界和异常路径，尤其是幂等、账号互斥、失租、未知结果、取消及重启恢复。修改时同步相关用例；本地只跑受影响范围，GitHub CI 执行全量测试，不访问真实平台账号。

## 前端设计与审阅

界面不添加多余功能说明，只保留必要的标题、按钮、文章、图片、表单、状态、错误与操作确认。

所有前端实现和审阅先阅读并共同遵循项目内 [Frontend Design](.agents/skills/frontend-design/SKILL.md) 与 [Emil Kowalski](.agents/skills/emil-design-eng/SKILL.md)，不以同名全局技能替代。按 [后台规范](docs/admin-ui.md) 检查中文工作台、桌面及 390/320 窄屏、键盘、减少动态效果和日志脱敏；审阅用“调整前／调整后／原因”表格链接实现。

## 提交、PR 与安全

使用功能分支；隔离工作区位于本地 .worktrees。提交采用 docs:、feat:、fix: 等前缀及简明中文说明。PR 说明目的、影响、验证和关联需求，界面变更附合成数据截图。推送和合并前检查最新文档并完成独立代码检视；合入 main 并验证后删除临时分支和工作区。

禁止提交密钥、Cookie、浏览器配置及敏感截图。真实账号操作按明确授权执行；当前指定 CSDN 账号仅允许登录和草稿验证。外站结果未知先核对，禁止盲目重试。运行状态与账号目录置于仓库外，分别记录代码、本地、真实平台和生产验收结果。