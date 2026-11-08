# C：平台发布闭环实施计划

> 执行人员使用 executing-plans 按任务推进，独立审阅使用 subagent-driven-development。依据[总计划](../implementation-plan.md)、[需求](../requirements.md)和[后台规范](../admin-ui.md)。先完成 B 阶段模拟闭环，真实账号操作仍需单独明确授权。

## C01：结构化内容转换与真实预览

当前 CSDN 文字 Markdown 平台稿预览、修订保存和确认绑定已实现于 [IntegrationDraft.tsx](../../apps/admin/src/IntegrationDraft.tsx) 与 [integration_content_store.go](../../apps/api/integration_content_store.go)。通用结构化转换、图片和其他平台仍按下列未完成项推进。

前置：B05、B07、B12。拟建：`apps/worker/src/content/parse.ts`、`content/transform.ts`、`content/validate.ts`、`tests/fixtures/content/`；维护：`apps/api/internal/drafts/service.go`、分发稿页面及 `docs/platform-capabilities.md`。

- [ ] 针对段落、标题、列表、链接、代码、图片、表格、公式和自定义 MDX 组件建立输入输出样例，先验证转换及拒绝行为。
- [ ] 使用结构化解析形成通用内容结构，再由平台转换器处理；禁止执行原稿中的组件、脚本或表达式。
- [ ] 对不支持内容生成可见清单，未修正前阻止对应平台提交，不静默删除或截断。
- [ ] 将实际转换结果保存为平台稿修订，预览与提交使用同一不可变内容；平台字段限制在预览、确认和执行前都检查。
- [ ] 覆盖多页面编辑、来源版本变化、仅状态变化及恶意链接；更新平台稿页面和双技能审阅记录。

测试定位：`apps/worker/src/content/transform.test.ts`、`content/validate.test.ts`、`tests/integration/content-preview.test.ts`。通过：可解释的兼容性检查、可确认的真实预览与任务快照一致。

## C02：安全素材获取与平台上传准备

前置：B04、B07、C01。拟建：`apps/api/internal/media/fetch.go`、`media/access.go`、`media/cleanup.go`、`apps/worker/src/content/media.ts`；维护素材契约和忽略规则。

- [ ] 测试未登记域名、跳转至内网、IPv4/IPv6 本机地址、云凭据地址、DNS 地址变化、伪造扩展名、超大及超时响应。
- [ ] 仅获取来源允许的素材，每次解析、实际连接及重定向均校验目标；限制协议、体积、类型、时长和跳转次数。
- [ ] 实际检查文件内容和平台限制，临时保存于受限目录；执行器仅能读取所属任务素材，服务端提供短期、受认证的内部访问。
- [ ] 平台上传后替换临时图片引用，不能长期依赖 CMS 下载地址；失败保留可诊断的脱敏原因，不泄露素材凭据。
- [ ] 验证取消、失败、来源撤销和到期清理，避免删除仍由有效任务使用的素材；完善受保护截图与诊断保留策略。

测试定位：`apps/api/internal/media/fetch_test.go`、`media/access_test.go`、`apps/worker/src/content/media.test.ts`。通过：地址防护与实际连接一致，素材不进入公开目录或仓库。

## C03：平台协议、提交边界与结果核对

- [x] 当前 CSDN save_draft 的关键写入阶段已接入本地快照授权守卫、权限复查和来源暂停；未知结果保持核对，见 [integration_guard.go](../../apps/api/integration_guard.go)、[integration_guard_test.go](../../apps/api/integration_guard_test.go)。此项仅为文字草稿子范围。

管理员从已核对 CSDN 来源草稿独立确认正式发布已实现；外部接入仍只开放保存草稿。CSDN 自动化正式发布真实验收、通用多平台提交与 C03 整体仍待。

前置：B06—B08、C01、C02。拟建：`apps/worker/src/adapters/types.ts`、`adapters/registry.ts`、`runtime/publish.ts`、`runtime/reconcile.ts`、`apps/api/internal/publications/reconcile.go`。

- [ ] 使用模拟平台写出提交前失败、点击后断网、平台已接受但响应丢失、进程崩溃和失租的行为测试。
- [ ] 固定适配器职责：能力、会话检查、字段校验、素材上传、填稿、提交、结果核对和审核查询；不提供任意脚本接口。
- [ ] 将验证过的 UI 路径写为普通程序和明确的状态判断；页面不匹配时停止，不在线请求模型猜测控件或生成操作。验证真实适配器可由后台独立调用，无需 AI Agent 参与。
- [ ] 公开提交能力完成后，点击提交前持久化提交意图、领取代次与步骤，并复查本地快照版本、指纹、授权期限与已收到的来源状态。当前草稿守卫不替代该验收；实际 CMS 任务仍须双方通过 D02/D03，协议见[外部手册](../external-integration.md)。
- [ ] 明确未提交可安全重试、已确认提交可查询、提交不确定只可核对三类恢复；优先检查平台创作记录和已有外站关联，记录证据和时间。
- [ ] 人工确认需管理员权限、外站记录依据和操作审计；无法判断继续保持未知，不以按钮点击作为成功依据。
- [ ] 确认旧执行器停止后才允许同账号重新操作，验证并发核对、重复结果上报及状态幂等。

测试定位：`apps/worker/src/runtime/publish.test.ts`、`runtime/reconcile.test.ts`、`apps/api/internal/publications/reconcile_test.go`。通过：提交临界故障不会进入普通自动重试，审核未知可正确展示。

## C04：CSDN 真实适配

前置：A02、C03，且当前测试操作已授权。拟建：`apps/worker/src/adapters/csdn/index.ts`、`csdn/editor.ts`、`csdn/result.ts`、同目录测试及脱敏页面夹具。

- [ ] 根据 A02 结论编写编辑器定位、字段、图片与代码呈现的夹具测试；页面结构不符必须停止。
- [ ] 实现官方接口或经验证的浏览器路径，执行前检查实际登录状态，按可理解名称和稳定结构定位控件。
- [ ] 验证上传、填稿、必填字段、提交及核对完整流程，并把结果映射到统一状态模型。
- [ ] 在计划部署环境执行授权测试，验证链接、内容、提交与审核证据，遇到验证进入受保护流程。
- [ ] 按授权处理测试文章，更新平台能力和验收文档，保留待核对边界；完成适配器独立检视。

测试定位：`apps/worker/src/adapters/csdn/*.test.ts`，真实结果登记 `docs/acceptance.md`。通过：目标账号由服务器自动发布，人工验证只处理平台要求，非逐个平台人工点击提交。

## C05：知乎真实适配

前置：A03、C03，且当前操作已授权。拟建：`apps/worker/src/adapters/zhihu/index.ts`、`zhihu/editor.ts`、`zhihu/result.ts` 及同目录测试。

- [ ] 依据 A03 形成稳定定位、话题和正文格式的脱敏夹具，验证定位失效时停止。
- [ ] 实现实际可用的发布方式及会话检查，按验证结果处理图片、代码、表格和公式。
- [ ] 接入统一上传、字段校验、提交证据、结果核对和可查询审核状态；不可查询则保留未知。
- [ ] 授权测试覆盖正常发布、会话失效、部分内容不兼容与提交临界异常，不通过无依据的重试验证恢复。
- [ ] 清理授权内容与资源，记录独立的知乎能力和验收结果，不借用其他平台结果。

测试定位：`apps/worker/src/adapters/zhihu/*.test.ts`。通过：真实文章及已知限制均有可核对证据。

## C06：小红书真实适配

路线见[小红书接入方案](../xiaohongshu-integration.md)，具体执行见[专项计划 X03—X07](xiaohongshu-integration.md)。匿名入口、登录与重启、笔记空列表及图文上传前页面已实测，适配尚未实现；非空笔记、实际图文编辑、平台账号模型、素材和结果核对仍需通过各自关口。

前置：A04、C03，且当前操作已授权。拟建：`apps/worker/src/adapters/xiaohongshu/index.ts`、`xiaohongshu/editor.ts`、`xiaohongshu/result.ts` 及同目录测试。

- [ ] 依据 A04 测试图文编辑器、标题、正文、封面、配图顺序、话题和必填项。
- [ ] 实现会话检查和独立图文内容校验，长文不适配时要求预览阶段人工编辑，不直接截断发布。
- [ ] 接入媒体上传、自动提交、结果核对与审核状态映射，保留不能取得链接或状态的实际限制。
- [ ] 在目标环境完成授权图文发布和需要验证后的恢复，测试素材不合格时阻止提交。
- [ ] 清理授权内容和资源，更新小红书独立证据及界面中的能力提示。

测试定位：`apps/worker/src/adapters/xiaohongshu/*.test.ts`。通过：图文发布完整闭环成立，不能以仅打开页面或保存草稿交付。

## C07：三平台综合恢复验收

前置：C04—C06。拟建：`tests/integration/publishing-recovery.test.ts`、`tests/e2e/platform-status.spec.ts`；维护：`docs/acceptance.md`、`docs/platform-capabilities.md`、`docs/progress.md`。

- [ ] 用模拟夹具覆盖一平台成功一平台失败、等待验证释放槽位、解绑、取消、租期失效、重启及平台页面变化。
- [ ] 在“提交意图记录前／后、点击后、结果落库前”分别注入故障，验证不确定结果进入核对，成功结果保留。
- [ ] 验证关闭前端后服务端继续、同账号自动任务与人工会话不冲突、账号之间互相隔离、暂停期间不重复登录。
- [ ] 分平台执行已授权的真实链路检查，交叉确认内容、外站状态、证据时间和清理结果，不在 CI 自动真实发文。
- [ ] 检查崩溃、取消、服务停止后无浏览器子进程、页面和执行锁残留，验证任务再次恢复的状态正确。
- [ ] 更新总体进度与独立验收记录，所有平台未通过时继续保留未完成状态。

阶段通过：三个目标平台分别满足真实发布闭环，异常恢复符合统一提交边界，后台状态和日志可解释实际结果。
