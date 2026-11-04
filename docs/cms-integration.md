# CMS 接入总体方案

## 范围与当前状态

采用 CMS 主动提交、PostBridge 独立执行。CMS 负责原稿、站内发布、选平台、可靠投递和摘要；PostBridge 提供平台稿预览确认、平台账号、执行及异常处理。

PostBridge 侧已实现受邀注册、审批与一次性密钥、签名激活和调用、不可变平台稿、父分发记录、来源事件与实时来源守卫，并完成本地验证。当前执行范围只有一个 CSDN 目标的文字 Markdown 保存草稿。公开发布、图片、MDX、其他平台、自动更新及撤回平台文章、已有外站副本的显式再次新建仍未交付。存在外站副作用、未知结果或活跃任务时不允许换标识重建；确定未写入且已取消或被来源守卫暂停的旧任务，可在当前授权及新预览确认后由新分发安全取代，具体条件见外部手册。

本次没有修改 CMS 项目。CMS 双向身份、事务发件箱、权威来源状态服务、实际联通以及联合和生产验收仍待完成。准确协议统一见[外部接入手册](external-integration.md)和[OpenAPI](../contracts/cms.openapi.yaml)，本方案不另复制接口字段或签名规则。

## 职责与边界

| 范围 | CMS | PostBridge |
| --- | --- | --- |
| 内容 | 原稿、修订、私有状态及博客发布 | 明确授权的来源快照与独立平台稿 |
| 身份 | 申请调用身份，并向 PostBridge 签发独立反向身份 | 邀请、审批、加密保管密钥、权限与撤销 |
| 投递 | 发布和待发送记录同事务提交，后台可靠重投 | 事务去重、创建父分发及草稿子任务 |
| 生命周期 | 状态序列、事件发件箱及权威状态接口 | 拒绝旧状态、独立记录授权撤销、写入前复查 |
| 界面 | 编辑、选择、确认跳转和摘要 | 预览修订、管理员确认、来源与账号异常处理 |
| 运维 | CMS 数据库、发件箱与博客链路 | 独立服务、数据库、浏览器与来源出站边界 |

两系统不共享数据库、管理员登录或平台凭据；平台稿修改不回写原稿。反向注册由 CMS 自行实现，本仓库只提供对应状态接口的调用约束。生产运行不依赖 AI Agent 或模型密钥。

## 接入流程

1. 管理员向 CMS 发出受限邀请，审核其申请；双方分别准备独立身份和密钥，完成 PostBridge 激活与来源反向配置。
2. CMS 后端读取实际目标能力；第三方目标默认不选，用户主动请求预览后才发送授权快照。
3. 用户跳转 PostBridge 管理员页面检查原稿、目标账号与平台稿；修改生成新修订，确认绑定当前修订。
4. CMS 后端重新读取确认结果；站内发布与待发送意图同事务提交，内容发生变化则重新预览。
5. 发件箱按稳定 request_id 提交已确认结果；PostBridge 实时检查来源发布状态和授权后持久排队，CMS 轮询父分发摘要。
6. 来源变化由 CMS 可靠通知。来源暂停通过“处理来源授权”进入原分发；实际平台登录另走账号设置。未知结果保持只读核对，不换标识重复保存。

来源授权检查与外站保存不能跨系统原子完成，仍有短暂竞争窗口。来源撤回不代表平台稿已被撤回；已生效的外站内容需要独立核对。

## 当前实现定位

| 范围 | 实际文件 |
| --- | --- |
| 身份、邀请与管理员授权 | [integration_auth.go](../apps/api/integration_auth.go)、[integration_registry.go](../apps/api/integration_registry.go)、[integration_signature.go](../apps/api/integration_signature.go) |
| 来源状态与受限出站 | [integration_source.go](../apps/api/integration_source.go) |
| 快照、修订、事件与父分发 | [integration_content.go](../apps/api/integration_content.go)、[integration_content_store.go](../apps/api/integration_content_store.go) |
| 外部及管理员内容路由 | [integration_content_http.go](../apps/api/integration_content_http.go)、[integration_content_admin.go](../apps/api/integration_content_admin.go) |
| 执行前守卫与清理 | [integration_guard.go](../apps/api/integration_guard.go) |
| 来源工作台与平台稿 | [Integrations.tsx](../apps/admin/src/Integrations.tsx)、[IntegrationDraft.tsx](../apps/admin/src/IntegrationDraft.tsx) |
| 可校验契约与共享向量 | [OpenAPI](../contracts/cms.openapi.yaml)、[共享合成向量](../tests/fixtures/integration-contract.json) |
| 部署启用与隔离 | [runtime.py](../scripts/runtime.py)、[ubuntu_deploy.py](../scripts/ubuntu_deploy.py)、[API 配置](../apps/api/runtime.go) |

API 代码保持当前平铺结构，不使用尚未建立的 internal/sources 或 internal/drafts 路径作为已交付定位。

## 调用方剩余工作

- [ ] CMS 实现自身反向身份注册、审批及独立密钥保护，提供手册规定的权威状态接口。
- [ ] 发布页默认仅发布自有博客，按实际能力选择目标，并跳转平台稿预览。
- [ ] 后端核对确认结果，原子保存站内发布与待发送，发送器在事务提交后投递。
- [ ] 持久化来源事件、授权撤销和单调状态序列；重投保持业务标识，重签名时更新 nonce。
- [ ] 经 CMS 后端轮询摘要，准确区分投递、执行、草稿保存和未知结果。
- [ ] 完成双方契约审阅、跨网络 HTTPS 联调、常驻执行和生产恢复演练。

CMS 项目实施路径由其独立 PR 确认，不在本仓库声明已改造其页面、数据库或发送器。图片与公开发布待能力交付后再扩展，不提前暴露未实现选项。

## 分层验收与下一步

| 层次 | 状态与关口 |
| --- | --- |
| PostBridge 代码与本地 | 文字 Markdown 保存草稿来源接入已实现；签名、真实隔离数据库、来源守卫、组件和合成界面已验证，见[验收记录](acceptance.md) |
| 双方契约与 CMS | OpenAPI 与共享向量可用；CMS 实现及双方审阅尚未完成，D01 整体不关闭 |
| 实际 CSDN 来源链路 | 既有草稿能力的真实证据独立保留；本次外部 CMS 到真实草稿仍待联合验证 |
| 跨网络与生产 | 目标 HTTPS、反向来源、常驻、备份恢复及生产验收未完成 |
| 完整首期 | C07、完整 D04 和三平台交付均未完成 |

执行顺序为 CMS 独立实现与契约核对 → 双方模拟联调 → 授权 CSDN 草稿联调 → 跨网络与生产验收。公开发布、素材和其他平台分别通过能力关口后才能扩展完整 D04。详细剩余步骤见[D 计划](plans/d-cms-integration.md)，不以 PostBridge 单侧本地验证代替双方交付。
