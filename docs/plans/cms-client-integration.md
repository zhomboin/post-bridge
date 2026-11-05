# CMS 侧 PostBridge 接入方案与改造计划

状态：方案已整理，CMS 业务代码、应用注册、真实联调和生产变更尚未实施。方案依据 PostBridge 的[外部手册](../external-integration.md)、[OpenAPI](../../contracts/cms.openapi.yaml)和[共享向量](../../tests/fixtures/integration-contract.json)。接口字段与签名格式以这些文件为准。

## 目标与首期范围

CMS 是操作主入口，PostBridge 是独立服务。CMS 后端以获批应用身份调用固定接口；不要求 PostBridge 为 CMS 改代码，也不向其提供反向身份、验签服务或来源状态查询接口。两个系统的管理员登录相互独立。

首期从 CMS 的已发布文章发起一次 CSDN 文字 Markdown 草稿分发。保留现有博客发布操作，先完成站内发布，再读取发布后的版本创建外部分发。PostBridge 失败不回滚博客发布，也不把博客发布成功显示为外部分发成功。

默认不选择第三方目标。草稿、私有、归档文章不得通过此入口外发；存量文章不自动授权或批量发送。公开发布、正文图片、MDX、其他平台、外站副本再次新建、自动更新及自动撤回均不在首期范围。

## 已核对的 CMS 结构

下列路径属于 rendering-cms-platform 仓库；拟新增文件不是已实现能力。方案保存在 PostBridge 仓库供评审，实施时同步至 CMS 的权威计划、任务入口及职责说明。

| 当前依据 | 核对结果与改造位置 |
| --- | --- |
| backend/go.mod | Go 1.26.10；Chi、pgx、sqlc 与迁移体系沿用，不套用 PostBridge 工具版本 |
| backend/internal/articles/handler.go | 文章创建、更新、发布、下架、私有及恢复入口直接调用查询；需要接入本地事务协调 |
| backend/sql/articles.sql、backend/migrations/ | articles.version 和修订由数据库维护；直接使用稳定 article_id，新增迁移编号实施前检查 |
| backend/internal/http/middleware.go | 通用后台认证允许 admin 和 editor；分发模块还需逐项检查 admin |
| backend/cmd/server/main.go、backend/internal/config/config.go | 装配独立连接器、配置与后台投递器；不得在入口堆业务逻辑 |
| frontend/src/pages/articles/ArticleEditorPage.tsx | 当前发布是先保存再发布，两次操作后版本会变化；外部分发从发布后的记录开始 |
| frontend/src/api/client.ts | 401 会刷新或清除 CMS 登录；不能直接透传 PostBridge 的认证错误 |
| frontend/src/api/articles.ts、frontend/src/routes/index.tsx、frontend/src/layouts/AdminLayout.tsx | 保持已有文章 API，新增类型化分发 API、记录页和文章入口 |
| backend/cmd/import-mdx/main.go | 导入也会写文章；已存在分发授权的文章必须纳入失效通知，不能只覆盖页面按钮 |

## 注册、认证与配置

### 注册流程

1. PostBridge 管理员创建邀请，固定 source_id、environment、账号、操作、权限和期限。
2. CMS 管理员通过 CMS 后端提交注册申请；后端调用 POST /api/integrations/v1/registrations，使用 X-Integration-Invitation。
3. 注册内容为 name、environment、source_id、scopes、accounts、operations，不包含来源 URL 或反向凭据。保存返回的 registration_id，邀请只使用一次。
4. PostBridge 管理员审批，取得一次性 client_id、key_id、client_secret。通过安全方式交付给 CMS 运行环境；首期使用仓库外私有密钥文件或生产密钥挂载，不通过 CMS 业务页面返回签名密钥。
5. CMS 后端读取密钥，为 POST /api/integrations/v1/clients/self/activate 签名；收到 active 后再允许业务投递。
6. CMS 的“测试连接”只执行 GET /api/integrations/v1/targets，并说明目标读取是否成功，不能把这一次读取当成全部写权限已验证。

注册超时不得盲目重新消费邀请；由管理员在 PostBridge 核对已有申请。CMS 不代替 PostBridge 管理员审批、查询秘密或建立管理员会话。

### 权限与密钥

基础业务申请 targets:read、preparations:write、preparations:read、distributions:write、distributions:read。由于本 CMS 方案要可靠通知撤销，额外申请 source-events:write；这是 CMS 的业务选择，不是 PostBridge 对所有调用方的准入要求。操作只申请 save_draft，账号从实际获批目标读取，不使用真实平台用户名作 account_id。

CMS 只需生成请求签名，不实现接收服务签名、防重放数据库或反向认证。服务间密钥与 CMS JWT、管理员密码、平台 Cookie、PostBridge 存储主密钥完全分开。

后端私有配置包括启用开关、HTTPS 服务根地址、environment、service_id、source_id、client_id、key_id、密钥引用、超时和请求预算。文件路径和实际值不进入 Git；数据库只保留连接元数据及安全引用。关闭开关停止新投递，不伪报远端任务已取消。

轮换流程为 PostBridge 签发待激活新密钥，CMS 安全配置新版本并签名激活，再切换所有实例。交接期最多十分钟；切换完成后停用原密钥。配置加载和切换必须原子，失败保留明确待处理状态，不用 CMS 登录凭据兜底。

### 固定签名规则

连接器统一处理六个必需头、原始正文摘要、完整目标 URI、固定覆盖字段与参数顺序。client_secret 先标准 Base64 解码为随机密钥字节，再计算 HMAC。GET 对实际空正文签名；每次请求或重试重新生成 created、nonce 和签名，业务标识及请求内容不变。

使用共享签名与指纹向量逐字节测试，不自行放宽 RFC 9421 profile。服务时钟需同步；业务请求最多 1 MiB。正文先序列化成冻结字节，再计算摘要并发送，签名后不改查询顺序、编码或 JSON 空白。

HTTP 客户端只访问配置的 PostBridge origin，校验证书，不跟随重定向，不转发 CMS Authorization 或 Cookie。建议总超时十秒、连接超时两秒，响应设置有界上限；准备稿含双份正文，响应上限不能误设成仅能容纳小型状态响应。

## 内容提交与人工确认

| 顺序 | CMS 行为 | PostBridge 固定接口 |
| --- | --- | --- |
| 1 | 已发布文章点击“保存 CSDN 草稿”，核对兼容性、当前版本与目标 | GET /api/integrations/v1/targets |
| 2 | 本地事务保存授权、序列、冻结快照和稳定准备请求标识 | 暂无远端调用 |
| 3 | 后台投递准备请求，保存 preparation_id、preview_url、revision、有效期 | POST /api/integrations/v1/preparations |
| 4 | CMS 打开受校验的预览地址，由管理员在 PostBridge 编辑与确认 | PostBridge 管理员界面 |
| 5 | 用户回到 CMS 检查确认，CMS 后端重新读取准备稿 | GET /api/integrations/v1/preparations/{id} |
| 6 | 核对 CMS 当前文章和本地授权，冻结独立提交请求后可靠投递 | POST /api/integrations/v1/distributions |
| 7 | 保存父分发 ID，按原提交标识恢复丢失响应并同步结果 | GET /api/integrations/v1/distributions/{id} 或带 request_id 的查询 |

打开预览使用新标签页，CMS 保留本地分发记录。PostBridge 无需新增 CMS 专用回跳或回调；用户回到 CMS 点击“检查确认并提交”。CMS 浏览器提交的“已确认”布尔值、指纹和版本均不能作为可信确认依据。

提交前必须由 CMS 后端核对：准备稿属于本次记录；source_id、article_id、来源版本、状态序列、内容指纹、目标一致；confirmed 为真；本地授权和准备稿未到期。draft_revision_ids、confirmation_fingerprint、targets 从 PostBridge 读取后原样透传，不生成确认指纹，也不以原稿覆盖已确认平台稿。

### 快照映射与兼容性

| CMS 内容 | 发往 PostBridge 的内容 |
| --- | --- |
| articleId | article_id，稳定 UUID 字符串 |
| version | source_version，正整数；使用本次站内发布或保存后的返回值 |
| 标题、摘要、tags | snapshot.title、summary、tags；保留冻结后的标签顺序 |
| bodyMdx | 通过兼容性检查后成为 snapshot.body，body_format 为 markdown |
| 封面 | 首期不发送；有封面时必须由用户明确选择“本次不分发封面”，否则拒绝准备 |
| 素材 | assets 固定为空数组；正文图片不能静默删除后发送 |
| 自有博客地址 | 可选 original_url，由可信配置和文章标识构建，不参与内容指纹 |
| 目标 | 选择实际能力返回的 platform、account_id、operation |

拒绝正文图片、HTML、MDX 组件、围栏外表达式和 import/export；保留合规代码围栏。不得执行 MDX 来“转换”，也不能仅改 body_format 就当作 Markdown。标题、正文、摘要、标签和整体请求大小按现行手册限制；不兼容时返回可定位的错误，保留 CMS 原文。

content_fingerprint 按手册有序 JSON 数组及 SHA-256 生成：标题去首尾空白，正文换行统一 LF，空标签／素材使用空数组，其他顺序保持；JSON 转义包括 Unicode 行分隔符，均由共享向量和边界用例验证。

### 版本与授权

每次分发授权使用新的 authorization_id；准备和提交分别使用稳定、独立的 request_id。本地动作也有幂等标识，双击或浏览器重开读取已有意图，不自动创建第二次分发。

state_seq 是每篇文章独立持久化的单调序列，与 articles.version 分开维护。文章或分发授权状态变化时在锁内分配序列；相同 state_seq 不得表达不同内容版本或状态。

source_version、state_seq 必须与已确认准备稿相同。文章即使只有状态或元数据变化，只要当前版本已变化，也不能直接使用旧准备稿提交；首期统一重新准备并人工确认。已提交任务则以冻结快照为准，根据实际变化决定撤销，不改写远端任务正文。

默认授权期限建议为二十四小时，并受运营登记的应用期限约束；实际放行仍由 PostBridge 决定。准备稿最多有效二十四小时且不晚于授权到期，已入队后也不能越过应用或快照授权期限继续写入。延长授权生成新授权与新确认，不能本地篡改既有冻结记录。

## CMS 数据与事务

建议新增四类数据，不保存签名密钥明文：

| 数据 | 主要字段与约束 |
| --- | --- |
| postbridge_connections | 服务及应用身份、密钥引用、启用状态和脱敏连接检查结果 |
| postbridge_article_states | article_id、当前 state_seq、已观察文章版本及必要状态标记；并发更新锁行 |
| postbridge_attempts | 操作者、文章版本、授权 ID／期限、明确封面选择、不可变快照、准备及提交请求、远端准备稿／父分发 ID、确认结果和各级状态 |
| postbridge_outbox | prepare、submit、cancel、source_event 指令；稳定业务标识、冻结内容、租约、重试次数、下次执行时间及脱敏错误 |

对连接加业务标识唯一约束，对未关闭的本地分发意图防并发重复创建；远端已有副本或活跃任务仍以 PostBridge 的重复保护为准。完整快照只通过已认证 admin 接口按需读取，不进入公开文章 API 或日志。保留期不能依赖 article_logs 的修订保留数量；任务需要的冻结记录独立保存。

文章写入、触发器递增版本、分发状态变更、本地授权撤销和待发送失效通知必须在同一 CMS 数据库事务提交。改造文章写入协调层并使用 sqlc 的 WithTx；覆盖后台、导入和其他实际写入口。新增发布文章首次不自动创建分发授权，普通博客操作不产生外发。

首期不新增文章删除功能。后续如果加入硬删除，须保留分发标识及必要失效记录，不通过级联删除丢弃待投递通知。

远端 HTTP 调用在本地事务之外执行。投递器支持多实例抢占、租约到期恢复和进程重启补发，不能把提交意图只放在浏览器或进程内存。

## 状态查询与展示

前端请求 CMS 后端，CMS 返回持久化摘要。后台同步器集中查询 PostBridge；不要让每个浏览器刷新都触发一次远端请求。

建议活动任务远端轮询从十五秒开始，失败有界退避并加入抖动；需要处理的记录降频并保留手动刷新，全部终态停止定时查询。每应用设共享请求预算，失效通知优先于提交，提交优先于查询，遵守获批配额和 Retry-After。

CMS 页面对本地摘要可在可见时每五秒刷新；隐藏、离开或会话失效停止页面轮询。后台对已接受任务的同步不依赖页面保持打开。查询异常保留旧结果，标注最后同步时间，不把断网改写为失败或成功。

| 证据 | CMS 展示 |
| --- | --- |
| 本地已保存意图，尚未得到远端准备稿 | 待准备／待投递 |
| 平台稿 prepared、未确认 | 待确认；显示预览入口及到期时间 |
| 重新读取确认后，提交尚未取得结果 | 待提交或提交结果待查 |
| 返回远端 202 或父状态 in_progress | 已入队／处理中，不显示保存成功 |
| 子任务 succeeded 且 external_status、outcome 为 draft_saved | CSDN 草稿已保存 |
| 子任务 cancelled，父状态 completed | 已取消；completed 本身不代表成功 |
| unknown、reconciling、needs_attention 或失败子任务 | 结果未知或需要处理；链接 PostBridge 处理入口 |
| 授权失效、准备稿到期、源版本不符 | 已失效／需重新准备，不自动换 ID 重发 |

父状态、各子任务状态、external_status、outcome、remote_id、remote_url 和最后核对时间分别保存。界面使用“草稿已保存”，不使用“已公开发布”。PostBridge 返回的预览和详情链接只允许配置的 HTTPS origin 与对应资源路径；外站链接另按可信平台域校验。

## 主动取消与内容失效

PostBridge 的来源事件是可选协议。本 CMS 为满足下架、私有和撤销后的安全要求，首期选择实现可靠主动失效，不增加反向查询。

下架、转私有或撤销授权时，本地事务立即关闭继续投递权限，并保存稳定 authorization_revoked 事件；每个已发授权分别通知。内容改变同样撤销不再适用的授权，需重新准备后再分发。通知只带标识、版本、序列和失效信息，不发送私有正文，不为不兼容内容伪造指纹。

取消本地意图时先阻止尚未发送的准备／提交指令；已发出请求或结果不确定时，投递失效通知并以原 submit request_id 查询，找到分发后调用 POST /api/integrations/v1/distributions/{id}/cancel。失效指令不得被尚未确认的提交指令长期阻塞。

取消返回只表示请求已按实际阶段处理，继续查询最终状态；409 distribution_not_cancellable 表示可能已有外站副作用，应转处理入口继续核对。取消不代表删除审计快照或外站文章。

本地检查、网络投递和远端执行之间存在时差，不承诺 CMS 修改一提交，PostBridge 就同步停止。CMS 本地马上停止新投递，远端只有收到取消／失效通知或授权到期后才能阻止后续写入；已经发生的操作保留结果并核对，不新增副本作为补偿。

## 错误、重试与恢复

| 情况 | CMS 处理 |
| --- | --- |
| 注册超时 | 标记申请结果待核对；不自动重用已消费邀请 |
| 准备响应丢失 | 使用原准备 request_id 和冻结内容重投，不创建新授权 |
| 提交响应丢失 | 先按原提交 request_id 查询，再按需原样重投；404 也不能作为从未执行的证明 |
| 400、422 | 修正内容或字段，停止无意义重试 |
| PostBridge 401、403 | 标记接入认证／授权待处理；不透传为 CMS 登录 401，不清除 CMS JWT |
| 409、410 | 核对当前版本、确认、权限和已有副本；不自动更换标识重发 |
| 429 | 遵守 Retry-After，保持业务标识并使用共享配额退避 |
| 网络、网关或暂时 5xx | 新签名、原正文和业务标识，有界重试；integration_disabled 转配置待处理 |
| 结果未知或需要人工处理 | 保留记录，继续查询或跳转 PostBridge；不提供普通“再保存一次”按钮 |

新模块向前端返回 code、message、retryable 和必要业务标识；同步调整 frontend/src/api/client.ts 的错误类型，使业务 code 可读取，保留现有文章接口兼容性。上游认证故障与 CMS 会话失效必须分开。

## 拟新增 CMS 内部接口与页面

下列都是 CMS 拟实现的受保护接口，不是 PostBridge 已有路由。统一位于 /api/v1/admin，逐项验证登录及 admin 角色；不提供任意 URL 或任意远端 API 代理。

| CMS 方法与路径 | 用途 |
| --- | --- |
| GET /postbridge/connection | 脱敏连接元数据与配置状态 |
| POST /postbridge/registrations | 提交一次性邀请申请，不返回签名密钥 |
| POST /postbridge/activate | 使用后端私有密钥激活 |
| POST /postbridge/check | 仅检查目标读取能力 |
| GET /postbridge/targets | 返回缓存／刷新后的实际获批能力 |
| POST /articles/{id}/postbridge/preparations | 检查文章及本地幂等标识，建立冻结授权与准备意图 |
| GET /postbridge/attempts、GET /postbridge/attempts/{id} | 本地记录、状态、最后同步时间及安全处理链接 |
| POST /postbridge/attempts/{id}/submit | 后端读取远端确认，校验本地版本并建立提交意图 |
| POST /postbridge/attempts/{id}/refresh | 有预算地同步确认或任务状态 |
| POST /postbridge/attempts/{id}/cancel | 本地撤销并调度远端失效／取消 |

准备、提交和取消若走后台队列，CMS 返回的 202 仅表示本地意图已接受，不能当作 PostBridge 已入队。通过本地 attempt 状态显示实际阶段。

后台增加“分发记录”和仅管理员可见的“PostBridge 接入”；已发布文章列表／阅读页提供分发入口。隐藏未实现目标，写操作防双击、绑定本地稳定意图；记录详情保持筛选分页。显示必要的账号、版本、授权期限、状态和错误，不增加宣传或架构说明文案。

## 实施顺序与验收关口

以下全部为待实施。实施时使用功能分支与 .worktrees 隔离，按计划执行和测试先行流程分阶段交付；本方案不启动业务开发或身份签发。

| 阶段 | 文件与改造范围 | 验收关口 |
| --- | --- | --- |
| C1 文档与契约对齐 | CMS 的 AGENTS.md、docs/plans/2026-11-05-postbridge-integration.md、docs/plans/current-tasks.md、docs/README.md、docs/progress.md | 职责、六项权限、人工确认、文字子集与状态语义统一；不包含反向服务或验签实现任务 |
| C2 连接器与配置 | 新增 backend/internal/postbridge/client.go、signer.go、snapshot.go 及对应测试；修改 config/config.go | 共享签名／指纹向量、原始 GET、超时、禁止重定向、请求大小与错误分类通过；密钥不进入响应或日志 |
| C3 数据与可靠投递 | 新增 migrations、sql/postbridge.sql、repository.go、dispatcher.go 及测试 | 幂等、行锁、事务回滚、多实例租约、重启和丢响应恢复通过；sqlc 版本匹配生成文件头 |
| C4 授权与失效协调 | 新增 articles/mutation_service.go；接入 articles/handler.go、导入和实际文章写入口 | 下架、私有、内容改变与撤销同事务记录失效；无私有正文外发；并发提交与失效有补偿记录 |
| C5 业务 API 与状态 | 新增 postbridge/service.go、handler.go、state.go 及测试；修改 cmd/server/main.go 装配 | admin 权限、冻结准备、远端人工确认核对、原样提交、查询和取消形成模拟闭环 |
| C6 CMS 页面 | 新增 frontend/src/api/postbridge.ts、pages/postbridge/；调整 api/client.ts、文章页、布局及路由 | 不暴露密钥，状态不误报，链接受限；桌面、390／320、键盘与刷新恢复通过 |
| C7 文档与联调 | 同步 docs/apis/postbridge.md、docs/sql/schema.md、配置部署、运维及当前任务 | 单独记录本地模拟、真实调用方、真实 CSDN 草稿和跨网络生产证据；检视后 PR 交付 |

- [ ] C1 文档与业务规则对齐。
- [ ] C2 连接器、签名、指纹和私有配置。
- [ ] C3 迁移、持久记录及可靠投递。
- [ ] C4 文章变更与授权失效事务。
- [ ] C5 注册、准备、确认、提交、查询和取消闭环。
- [ ] C6 管理页面及文章入口。
- [ ] C7 文档、检视和分层验收。

本地只运行受影响范围，完整回归交给 CMS GitHub CI。重点覆盖管理员／编辑者隔离、无反向服务、未授权和私有内容、发布后版本、同序号不同版本、准备稿改稿取消确认、授权到期、重复点击、注册及提交丢响应、乱序撤销、密钥交接、429、取消完成竞态和 unknown 不重复写入。

生产迁移前备份数据库；实际主机、身份、密钥和部署参数留在私有配置。真实平台和生产写入按对应任务明确授权执行；本次仅交付方案，未验收能力保持待办。后续业务完成后删除已完成的详细执行稿，将交付结果保留在主进度和变更记录中。
