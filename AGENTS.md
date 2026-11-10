# 仓库规范

## 项目结构与范围

本项目提供多用户独立登录、同平台多账号独占绑定的内容分发后台，当前实现 CSDN Markdown 图文草稿与管理员确认发布流程、按对象组织的处理记录，以及统一平台账号工作台中的文章只读列表、统计、账号设置和独立正文查看。PostBridge 侧外部来源注册、签名、平台稿确认、分发查询与来源守卫已实现并本地验证。完整范围见 [需求](docs/requirements.md)，交付状态见 [进度](docs/progress.md)；正式发布的真实平台验收、MDX、其他平台、真实调用方联调与生产验收仍待。

- apps/api：平铺 Go 管理接口、PostgreSQL 队列与初始化；integration_*.go 分担来源认证、注册、签名、内容修订、主动来源事件和本地授权守卫。
- apps/admin/src：React/TypeScript 后台、页面和样式。
- apps/formatter/src：可选 Markdown 内容保护与固定模板卡片渲染，不访问模型、数据库或平台会话；模型调用和持久化由 API 管理。
- apps/worker/src：Node.js/Playwright 固定平台执行器；CSDN 草稿与发布，小红书登录、资料统计及笔记正文图片只读。
- tests/e2e、tests/runtime：跨服务与启动安全测试；单元测试随应用组织。
- contracts/cms.openapi.yaml：外部接入机器契约；tests/fixtures/integration-contract.json：共享合成签名与指纹向量。
- scripts：WSL 本地开发和 Ubuntu 部署的 Shell 入口；.github/workflows：CI。

来源接入开放 CSDN Markdown save_draft，图源域名配置启用后支持转存批准的正文图片，管理员可从绑定账号和有效来源的已核对草稿发起独立发布，外部接入仍只开放保存草稿。接口以 [外部手册](docs/external-integration.md) 和机器契约为准。调用方按固定接口和签名协议接入，无需反向服务；调用方数据库及可靠发送由其自行实现，CMS 事务发件箱仅是建议。可选接入配置与存储密钥仅传给 API，worker 不接收；运行数据与凭据置于仓库外私有配置。

本指南保留根目录，其他文档使用中文 Markdown，放入 docs。所有文件使用 UTF-8 无 BOM。进度和简要变更分别写入 docs/progress.md、docs/version.md；只描述当前状态，已交付任务的详细实施计划及时删除。

## 开发、构建与测试

环境固定 Linux Node.js 22.22.1、npm 10.9.4、Go 1.26.10、PostgreSQL 16 与 Playwright 1.64.1。完整入口见 [开发说明](docs/development.md)。在 WSL 或 Ubuntu 的 Bash 中执行 scripts/dev.sh 构建并启动，使用 scripts/stop.sh 安全停止。服务器常驻部署使用 scripts/ubuntu-deploy.sh。

Linux 工作区的 `npm run build`、`npm run typecheck`、`npm test` 分别构建、检查类型和运行应用用例；Go 使用 go test、go vet。项目入口使用 Bash，命令示例按 Linux Shell 编写。任务结束关闭本次临时进程、服务和容器，保留无关服务。

本地开发与服务器部署分别维护 docs/development.md、docs/ubuntu-deployment.md，必须按步骤写明环境准备、初始化、启动、停止、升级和检查的完整命令；命令注明实际执行环境，文档不复制应用实现代码。

## 编码与测试规范

Go 使用 gofmt；TypeScript 两空格缩进，组件 PascalCase，函数和变量 camelCase。前端、执行器与配置使用固定 Prettier，Python 使用 Black 25.1.0；统一执行 npm run format，提交前执行 npm run format:check。TypeScript 与 go vet 检查代码，CI 补充 npm audit 和 govulncheck；未配置 ESLint。平台适配、调度和页面保持独立；执行器不直接连接数据库，不读取 CMS 数据库。

Go 使用 *_test.go，TypeScript 使用 *.test.ts 或 *.test.tsx。测试采用 Go testing、Vitest、Testing Library 和 Playwright，覆盖正常、边界和异常路径，尤其是幂等、账号互斥、失租、未知结果、取消及重启恢复。修改时同步相关用例；本地只跑受影响范围，GitHub CI 执行全量测试，不访问真实平台账号。

## 前端设计与审阅

界面不添加多余功能说明，只保留必要的标题、按钮、文章、图片、表单、状态、错误与操作确认。

所有前端实现和审阅先阅读并共同遵循项目内 [Frontend Design](.agents/skills/frontend-design/SKILL.md) 与 [Emil Kowalski](.agents/skills/emil-design-eng/SKILL.md)，不以同名全局技能替代。按 [后台规范](docs/admin-ui.md) 检查中文工作台、桌面及 390/320 窄屏、键盘、减少动态效果和日志脱敏；审阅用“调整前／调整后／原因”表格链接实现。

## 提交、PR 与安全

使用功能分支；隔离工作区位于本地 .worktrees。提交采用 docs:、feat:、fix: 等前缀及简明中文说明。PR 说明目的、影响、验证和关联需求，界面变更附合成数据截图。推送和合并前检查最新文档并完成独立代码检视；合入 main 并验证后删除临时分支和工作区。

禁止提交密钥、Cookie、浏览器配置及敏感截图。真实账号操作按明确授权执行；当前指定 CSDN 账号允许登录、草稿验证和文章只读同步；文章编辑、删除及公开发布按明确授权执行。外站结果未知先核对，禁止盲目重试。运行状态与账号目录置于仓库外，分别记录代码、本地、真实平台和生产验收结果。
