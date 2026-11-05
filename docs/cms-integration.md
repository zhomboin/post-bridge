# 外部系统接入总体方案

## 范围与当前状态

PostBridge 是独立运行的内容分发服务，任何调用方均按固定 HTTP 接口和 HMAC 认证接入。新增调用方只需管理员邀请、审批和授权配置，无需修改 PostBridge、共享数据库或提供反向服务。CMS、脚本和其他后端使用同一协议。

当前提供受邀注册、一次性应用密钥、签名激活、防重放、scope／账号／操作授权、轮换撤销、不可变平台稿与管理员预览确认、父分发查询和主动取消。执行范围只有一个 CSDN 目标的文字 Markdown 保存草稿。公开发布、图片、MDX、其他平台、自动更新／撤回外站文章及已有副本再次新建未开放。结果以轮询查询为基础，Webhook 尚未实现。

准确字段、签名、限制与错误统一见[外部手册](external-integration.md)和[OpenAPI](../contracts/cms.openapi.yaml)。本仓库不实现调用方原稿业务；真实调用方、真实平台端到端及生产验收分别记录。

## 职责与边界

| 范围 | 调用方 | PostBridge |
| --- | --- | --- |
| 内容 | 选择明确授权的内容并声明版本、序列和授权期限 | 保存独立快照与平台稿，不回写原稿 |
| 身份 | 申请并安全保存服务端应用密钥 | 邀请、审批、激活、权限与撤销 |
| 投递 | 稳定请求标识、失败查询及有界重投 | 幂等、持久队列、父分发及子任务 |
| 确认 | 读取已确认修订并透传提交 | 管理员预览、编辑修订和人工确认 |
| 状态 | 主动取消；按业务需要发送可选来源事件 | 根据本地授权、快照和已收到事件检查执行 |
| 运行 | 自行选择可靠发送方式 | 独立数据库、API、执行器与平台账号 |

双方不共享管理员登录、平台 Cookie 或数据库。调用方业务浏览器不持有签名密钥，PostBridge 不读取调用方数据库，也不主动请求其状态接口。CMS 可用事务发件箱提高发布与投递一致性，但这属于 CMS 内部实现建议，不是接入门槛。

## 接入流程

1. 管理员创建受限邀请，审批调用方申请并交付一次性应用密钥；调用方按固定签名协议激活。
2. 调用方后端读取实际目标能力，发送明确授权的文字快照与分发授权期限，取得准备稿和预览入口。
3. 管理员在 PostBridge 核对原稿、目标账号及平台稿，修改生成新修订，确认绑定当前稿件和授权版本。
4. 调用方重新读取确认结果，使用稳定 request_id 提交准备稿对应的版本、序列、指纹和目标；变更内容或序列时重新准备与确认。
5. PostBridge 检查本地快照与当前权限后持久排队。调用方轮询父分发，区分已接受、执行完成、草稿保存和未知结果。
6. 需要停止时，调用方取消自身未产生副作用的分发，或主动发送状态／授权失效事件。来源暂停通过原分发处理，平台登录另走账号设置；未知结果继续只读核对。

PostBridge 无法得知未收到的调用方变化；授权应设置适当期限，重要撤销应可靠发送。已生效的外站内容不会因本地取消或来源变化自动删除。

## 实现定位

| 范围 | 文件 |
| --- | --- |
| 身份、审批与签名 | [integration_auth.go](../apps/api/integration_auth.go)、[integration_registry.go](../apps/api/integration_registry.go)、[integration_signature.go](../apps/api/integration_signature.go) |
| 快照、修订、事件与分发 | [integration_content.go](../apps/api/integration_content.go)、[integration_content_store.go](../apps/api/integration_content_store.go)、[integration_content_http.go](../apps/api/integration_content_http.go) |
| 本地执行授权守卫 | [integration_guard.go](../apps/api/integration_guard.go) |
| 来源工作台与人工确认 | [Integrations.tsx](../apps/admin/src/Integrations.tsx)、[IntegrationDraft.tsx](../apps/admin/src/IntegrationDraft.tsx) |
| 固定协议与共享向量 | [OpenAPI](../contracts/cms.openapi.yaml)、[共享向量](../tests/fixtures/integration-contract.json) |

## 联合验收

| 层次 | 关口 |
| --- | --- |
| PostBridge 代码与本地 | 固定认证、无反向服务的准备／确认／提交、权限守卫、主动取消及未知结果处理，见[验收记录](acceptance.md) |
| 真实调用方 | 按手册实现并审阅连接器，验证可靠发送、确认流程、轮询和撤销；当前未验收 |
| 真实平台端到端 | 明确授权后验证调用方 → PostBridge → CSDN 草稿；既有单独草稿证据不能替代本链路 |
| 跨网络与生产 | HTTPS、时钟、常驻执行、备份恢复及生产验收仍待 |
| 完整首期 | 公开发布、素材及其他平台按能力关口推进，完整 D04 与 C07 未完成 |

CMS 适配属于一个可独立交付的调用方项目，不阻碍 PostBridge 标准接口独立运行。后续步骤见[D 计划](plans/d-cms-integration.md)。
