# B：独立系统基础实施计划

> 执行人员使用 executing-plans 分任务推进，独立审阅使用 subagent-driven-development。先读[总计划](../implementation-plan.md)、[需求](../requirements.md)、[后台规范](../admin-ui.md)。目标是在模拟来源、模拟平台下形成可运行的独立系统。

## 实施约定

前置为 A05 路线结论；任务编号表示依赖，不要求一次提交整个阶段。每个代码任务先建立下述测试并确认因缺少目标行为而失败，再最小实现并运行对应范围，最后同步文档和提交。禁止把真实账号用于 CI。

## B01：工程、契约与 CI 基础

前置：A05。当前已存在根 Node 工作区、[Go API](../../apps/api)、[后台](../../apps/admin)、[执行器](../../apps/worker)、[来源机器契约](../../contracts/cms.openapi.yaml)、[启动脚本](../../scripts/dev.ps1)、[停止脚本](../../scripts/stop.ps1)、[CI](../../.github/workflows/ci.yml)及[开发说明](../development.md)。内部 worker 机器契约和完整多平台工程关口继续按未完成范围推进，不使用拟建 internal 目录替代实际文件定位。

- [ ] 核实并固定技术版本、镜像和依赖许可；确定 Go、前端和执行器测试工具及 PowerShell Core 运行方式。
- [ ] 先写独立 API 健康检查、前端可加载、执行器心跳和非法配置启动失败的最小冒烟用例，确认失败。
- [ ] 建立根 Node 工作区、中央集成测试配置、三单元启动、数据库连接、模拟来源及平台夹具，契约明确来源与内部执行器的不同认证和数据范围。
- [ ] 实现总计划的脚本入口与目标白名单；开发、测试资源使用运行标识记录，失败和停止只回收本次创建的资源。
- [ ] GitHub CI 在干净环境执行所有单元测试、集成测试、模拟端到端、类型与格式检查和构建；开始时缺少的套件不能以空跑伪报覆盖。
- [ ] 本地完成一次启动、打开页面、健康检查及停止验证，记录实际命令与预期，更新 AGENTS 中的真实结构。

测试定位：`tests/integration/bootstrap.test.ts`、`tests/e2e/smoke.spec.ts`、`apps/api/internal/config/config_test.go`。通过：干净检出按文档可正常启动并退出；CI 可复现。

## B02：数据模型、约束和迁移

前置：B01。拟建：`apps/api/migrations/001_initial.sql`、`apps/api/internal/storage/postgres.go`、`apps/api/internal/jobs/state.go`、`apps/api/internal/publications/model.go`、`docs/data-model.md`。

- [ ] 建立调用应用、一次性邀请、审批、凭据版本、最小权限、来源、账号、原稿引用、快照、平台稿、父子任务、执行尝试、外站副本、会话及操作日志的数据清单。
- [ ] 编写唯一约束、关系归属和状态转换测试，覆盖跨来源同名原稿、重复请求、无效状态及事务回滚。
- [ ] 实现迁移、查询索引和时区策略；执行状态与外站状态分列，外站状态带证据来源和确认时间。
- [ ] 为账号租期、任务领取代次、事件顺序号和保留清理建立存储条件；最小外站关联与可删除正文分开保存。
- [ ] 验证空库迁移、升级失败回滚或恢复流程，记录数据职责与约束。

测试定位：`tests/integration/database.test.ts`、`apps/api/internal/jobs/state_test.go`。通过：数据库约束能拒绝重复和不合法关联，状态不可混用。

## B03：管理员认证与凭据保护

前置：B02。拟建：`apps/api/internal/auth/session.go`、`auth/http.go`、`auth/middleware.go`、`apps/api/internal/secrets/store.go`、`apps/api/cmd/admin/main.go`。

- [ ] 测试未登录、过期、退出、错误密码、暴力尝试限制、跨站写请求及错误会话归属。
- [ ] 实现单管理员初始化与密码散列，禁止默认通用密码；使用受保护的服务端会话和 Cookie。
- [ ] 实现请求来源校验、防跨站请求伪造、会话轮换与退出失效；管理员密钥与来源、执行器密钥分开。
- [ ] 实现专门的凭据保护与轮换接口，账号浏览器持久化目录使用受限权限和独立备份保护，不声称普通目录已自动加密。
- [ ] 覆盖密钥缺失、轮换失败、旧凭据撤销与日志脱敏；不向接口返回保存的明文秘密。

测试定位：`apps/api/internal/auth/session_test.go`、`apps/api/internal/secrets/store_test.go`。通过：未登录无法访问任何管理资源，退出后远程入口也失效。

## B04：来源登记与受限接口

当前 PostBridge 侧 CSDN 文字草稿子范围已实现，准确协议见[外部手册](../external-integration.md)及[OpenAPI](../../contracts/cms.openapi.yaml)。任意调用方按固定协议独立接入，无需反向服务或先发送来源事件。

实际文件：[integration_auth.go](../../apps/api/integration_auth.go)、[integration_registry.go](../../apps/api/integration_registry.go)、[integration_signature.go](../../apps/api/integration_signature.go)。

- [x] 实现受邀注册、审批、一次密钥签发、激活、权限更新、轮换、暂停和撤销；身份、环境与接收服务分别绑定。
- [x] 固定签名与正文摘要、时间窗口、共享 nonce、前置及应用配额；认证和限流存储不可用时拒绝。
- [x] 校验 scope、来源、账号、操作与资源归属；来源身份不能访问管理、执行器或浏览器接口。
- [x] 应用授权只包含来源、权限、账号、操作、期限与请求上限，不需要反向地址或凭据。
- [x] 草稿关键写入前复核本地快照授权与应用权限；来源暂停需重新确认后恢复原任务，未知结果只读核对。
- [x] 用真实隔离数据库及合成来源测试重放、越权、轮换、缩权、失效、迟到状态、授权到期及主动取消边界。
- [ ] 与真实调用方完成固定签名、人工确认、提交／查询／取消的 HTTPS 联调。
- [ ] 图片、公开提交和其他平台能力完成后扩展对应授权与写入边界。

测试定位：[integration_auth_test.go](../../apps/api/integration_auth_test.go)、[integration_signature_test.go](../../apps/api/integration_signature_test.go)、[integration_guard_test.go](../../apps/api/integration_guard_test.go)。B04 当前草稿服务端子范围完成，双方完整关口仍依赖 D。

## B05：不可变快照与确认流程

实际文件：[integration_content.go](../../apps/api/integration_content.go)、[integration_content_store.go](../../apps/api/integration_content_store.go)、[integration_content_http.go](../../apps/api/integration_content_http.go)、[IntegrationDraft.tsx](../../apps/admin/src/IntegrationDraft.tsx)。

- [x] 保存来源快照与独立平台稿；编辑生成新修订和稿件标识，不覆盖旧确认。
- [x] 确认绑定来源内容指纹、平台稿修订、目标账号、操作和授权版本；提交仅接受当前确认。
- [x] 区分内容版本、状态序列和指纹，校验纯状态变化、指纹变化及同标识冲突。
- [x] 本地快照授权有效且人工确认通过时事务创建分发与子任务；已提交稿不可修改。
- [x] 对未提交稿实行有效期与撤销清理，未知结果和活跃任务保留必要内容。
- [ ] 真实调用方实现可靠发送，联合验证私有/未授权内容不外传及确认一致性。
- [ ] 图片、MDX 和其他平台的结构化转换及预览按 C01/C02 继续实施。

测试定位：[integration_content_test.go](../../apps/api/integration_content_test.go)、[integration_content_http_test.go](../../apps/api/integration_content_http_test.go)、[Integrations.test.tsx](../../apps/admin/tests/Integrations.test.tsx)。已交付文字草稿修订确认子范围，不代表全部内容转换完成。

## B06：持久化调度与任务隔离

实际文件：[store.go](../../apps/api/store.go)、[model.go](../../apps/api/model.go)、[integration_content_store.go](../../apps/api/integration_content_store.go)、[integration_content_admin.go](../../apps/api/integration_content_admin.go)、[integration_guard.go](../../apps/api/integration_guard.go)。

- [x] CSDN 草稿任务使用事务领取、账号互斥、租期与领取代次，旧领取不能提交结果。
- [x] 来源父分发与子任务同事务持久化；稳定请求去重；有副作用或活跃任务拒绝重建，确定未写入的取消/来源暂停任务经新确认可安全替代并保留记录。
- [x] 草稿有限安全重试、取消、登录恢复及未知结果核对沿用原任务，不以换标识重发。
- [x] 已收到来源事件与本地授权守卫阻止后续写入；管理员恢复重查来源、授权、原确认与租约。
- [ ] 完成真实调用方、API 与执行器跨进程重启和断网联合验收。
- [ ] 扩展多账号和多平台调度，验证部分成功保留及独立子任务恢复，不以单 CSDN 结果代替。

测试定位：[integration_guard_test.go](../../apps/api/integration_guard_test.go)、[integration_test.go](../../apps/api/integration_test.go)、[auto_reconcile_test.go](../../apps/api/auto_reconcile_test.go)。当前草稿持久化与来源隔离子范围已验证，完整多平台验收未通过。

## B07：执行器协议、模拟适配与清理

前置：B06。拟建：`apps/worker/src/index.ts`、`runtime/client.ts`、`runtime/runner.ts`、`runtime/supervisor.ts`、`adapters/mock.ts`；维护内部契约。

- [ ] 测试内部身份、过期领取代次、心跳中断、超时、浏览器崩溃、启动失败和退出信号。
- [ ] 实现领取、心跳、步骤上报及结果上报，模拟适配器可确定性注入失败、等待和提交不确定。
- [ ] 执行器使用固定程序直接调用 Playwright，不通过 AI Agent 或 Playwright CLI 调度。增加无模型密钥、无 Agent 进程且无法连接模型服务时的任务用例，验证仍能独立完成模拟闭环；按实际运行依赖及请求检查，不将开发设计技能计为运行依赖。
- [ ] 实现总并发、步骤及执行时限，API 或领取权限失效时停止新的副作用操作。
- [ ] 监督器记录本次子进程和页面，取消或退出时先停止领取、保存状态，再回收浏览器进程与锁；不得终止无关进程。
- [ ] 验证父进程异常退出后可发现并回收遗留资源，临界提交保留核对状态，不仅测试正常关闭。

测试定位：`apps/worker/src/runtime/runner.test.ts`、`runtime/supervisor.test.ts`、`tests/integration/worker-recovery.test.ts`。通过：执行器独立运行、凭据受限、任务结束无临时资源残留。

## B08：账号隔离与远程登录验证

前置：B03、B06、B07；真实验证另需 A 中的明确授权。拟建：`apps/api/internal/accounts/service.go`、`accounts/remote_session.go`、`apps/worker/src/runtime/browser.ts`、`runtime/remote-session.ts`、`deploy/browser/Dockerfile`。

- [ ] 使用模拟登录站点测试账号目录隔离、连接状态、同账号人工与自动控制互斥，以及跨会话越权。
- [x] CSDN 使用专属浏览器目录与无头远程验证弹窗；画面及受限输入仅经管理员会话代理，不开放远程桌面或调试端口。其他平台按各自适配继续实施。
- [ ] 临时会话绑定管理员、账号及期限；每次连接和续接鉴权，退出、超时、验证完成立即撤销和关闭进程。
- [ ] 等待时释放全局槽位并保留账号归属，其他账号继续；恢复前校验会话和外站提交结果。
- [ ] 解绑取消未执行任务、清理账号凭据；执行中任务按提交阶段核对，不声称已撤销已生效的外站内容。

测试定位：`apps/api/internal/accounts/remote_session_test.go`、`apps/worker/src/runtime/browser.test.ts`、`tests/integration/remote-session.test.ts`。通过：模拟会话全链路安全可用，真实登录能力按平台分别记证据。

## B09：日志、审计、查询和设置

前置：B03、B06、B07。拟建：`apps/api/internal/logs/service.go`、`logs/redact.go`、`logs/http.go`、`apps/api/internal/settings/service.go`、`settings/health.go`。

- [ ] 测试三类日志字段、敏感信息过滤、脚本内容、来源越权、非法时间范围、超限分页与保留期限。
- [ ] 接入任务执行、系统运行、管理员操作记录；敏感字段从产生处过滤，查询与显示再做保护。
- [ ] 按后台规范提供时间、级别、平台及任务筛选，稳定排序与服务端分页；支持关联任务，不提供任意文件读取或原始日志下载。
- [ ] 建立有限配置、清理作业和健康摘要，覆盖任务积压、账号需处理、执行器离线与磁盘占用。
- [ ] 区分没有记录、已清理、无权限和服务错误，验证清理不会删除正在执行任务所需数据。

测试定位：`apps/api/internal/logs/service_test.go`、`logs/redact_test.go`、`apps/api/internal/settings/service_test.go`。通过：后台所需日志与提醒接口可用且权限、查询和保留均有上限。

## B10：后台工程和通用交互

前置：B01、B03，其他页面可用模拟接口准备。拟建：`apps/admin/src/app/router.tsx`、`app/providers.tsx`、`components/app-shell.tsx`、`components/status-label.tsx`、`features/auth/login-page.tsx`、`styles/tokens.css`。

- [ ] 先阅读两个项目设计技能与后台规范，明确中文字体、六色基础方案、导航及列表布局，不复制示例图表。
- [ ] 建立登录、受保护路由、会话失效、左侧导航与移动端导航的行为测试，确认缺失行为。
- [ ] 实现主题规则、表单、焦点、错误与加载组件，普通内容页面不持有来源或平台密钥；管理员一次签发只在临时内存展示并清理。
- [ ] 验证键盘、减少动态效果、320／390／1440 像素布局、长标题和触摸交互。
- [ ] 按两个技能审阅，用“调整前／调整后／原因”表格记录必要改动，脱敏截图放在 PR 验证附件，不保存真实账号截图。

测试定位：`apps/admin/src/app/router.test.tsx`、`components/app-shell.test.tsx`、`features/auth/login-page.test.tsx`。通过：真实认证的后台框架可用，不只是静态菜单。

## B11：总览、发布记录、任务详情与日志页面

前置：B09、B10。拟建：`apps/admin/src/features/overview/page.tsx`、`features/publications/list-page.tsx`、`features/jobs/detail-page.tsx`、`features/logs/page.tsx`、`features/logs/use-log-query.ts`。

- [ ] 测试筛选、分页、详情返回、父子任务与日志跳转、未知审核、部分失败和查询过期数据。
- [ ] 接入真实管理接口，区分执行状态和外站状态，显示证据来源及最后确认时间。
- [ ] 实现 5 秒刷新、暂停、手动刷新和断连退避；隐藏、离开或会话失效立即清理请求与定时器。
- [ ] 日志纯文本显示、长行摘要和按需详情；跟随默认关闭，浏览历史页不因新日志跳动，筛选与滚动上下文可恢复。
- [ ] 验证模拟的大量日志、空结果、异常、移动端及读屏状态提示，按两个技能审阅并链接实现。

测试定位：各页面同目录 `*.test.tsx`、`tests/e2e/management.spec.ts`。通过：管理员能够由异常提醒定位平台任务与脱敏日志，退出后无轮询残留。

## B12：来源、账号、分发稿、验证与设置页面

- [x] 当前来源工作台、CSDN 平台稿修订确认与父分发处理已接入实际 API，见 [Integrations.tsx](../../apps/admin/src/Integrations.tsx)、[IntegrationDraft.tsx](../../apps/admin/src/IntegrationDraft.tsx) 和 [界面审阅](../admin-ui.md)。其余完整平台和设置范围继续按下列未完成项推进。

前置：B04、B05、B08、B09、B10。拟建：`apps/admin/src/features/sources/page.tsx`、`features/accounts/page.tsx`、`features/drafts/editor-page.tsx`、`features/verification/page.tsx`、`features/settings/page.tsx`。

- [ ] 测试来源连接、账号失效、凭据轮换、分平台编辑、确认冲突、验证到期与非法设置。
- [ ] 接入对应接口并明确模拟预览能力；真实平台转换在 C01 后补齐，不能把模拟预览标为已支持。
- [ ] 实现写操作的服务端确认、影响范围说明及危险操作确认；不确定提交仅提供核对入口。
- [ ] 分发稿分别展示标题、正文、标签、封面和配图顺序，兼容性问题在确认前阻止对应平台提交。
- [ ] 完成完整模拟流程、移动端与双技能审阅，更新开发和总体进度文档。

测试定位：各页面同目录 `*.test.tsx`、`tests/e2e/publishing.spec.ts`。阶段通过：无需真实 CMS 或账号即可通过模拟来源完成登录、预览确认、异步执行、等待恢复及日志查看。
