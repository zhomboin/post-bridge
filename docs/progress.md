# 总体进度

## 当前交付

| 范围 | 当前能力 | 说明 |
| --- | --- | --- |
| 用户与平台账号 | 独立本站登录，管理员管理用户，每用户可绑定多个 CSDN 或小红书账号。账号、会话、任务和数据按用户隔离 | [账号归属](account-ownership.md)、[账号管理](platform-accounts.md) |
| CSDN | 后台文字 Markdown 草稿、外部来源受控图文草稿、发布预设、管理员从已核对的来源草稿确认独立发布。支持只读同步文章和草稿、统计、正文及对象处理记录 | [接口](api.md)、[图文与发布验收计划](plans/csdn-rich-publishing.md) |
| 小红书 | 登录检查、资料、七日统计、笔记列表和独立正文图片只读详情。与 CSDN 复用内容查询、任务和存储服务 | [只读工作台](xiaohongshu-readonly.md)、[通用内容服务](content-platforms.md) |
| 外部来源 | 受邀注册、签名认证、平台稿修订与确认、分发查询、取消和本地授权守卫。签名调用方可提交单个获批 CSDN 账号的 Markdown 草稿任务。结果通过轮询查询 | [接入手册](external-integration.md)、[OpenAPI](../contracts/cms.openapi.yaml) |
| 可选格式化 | DeepSeek 整理 CSDN 稿或制作小红书本地图文。微信公众号可无模型保真排版、核对差异、映射本地素材和复制确认，也可逐篇授权获取 AI 辅助建议 | [格式化说明](ai-formatting.md)、[样稿对照](plans/platform-formatting-observations.md) |
| 运行 | WSL Shell 开发入口、Ubuntu systemd 安装升级、Nginx HTTPS 模板及可选 formatter。Go 固定为 1.26.11 | [本地开发](development.md)、[Ubuntu 部署](ubuntu-deployment.md)、[运维](operations.md) |

## 验证状态

| 层次 | 已有证据 | 待验收 |
| --- | --- | --- |
| 代码与合成验证 | 隔离 PostgreSQL、执行器、formatter 和后台回归覆盖权限、幂等、取消、失租、重启、素材和界面。[全量 CI](https://github.com/zhomboin/post-bridge/actions/runs/43553760864)覆盖格式、契约、构建、依赖安全及合成浏览器流程，当前主线功能基线对应的 PR 检查通过 | 生产容量与完整跨平台故障恢复 |
| 本地业务环境 | 完成备份恢复演练、账号归属迁移，以及原 CSDN 与导入小红书会话复核。恢复副本通过合成多用户、多账号隔离 | 同平台多真实账号和目标服务器迁移 |
| CSDN 真实平台 | 账号登录、后台文字草稿、列表与正文只读同步已验。单张合规 JPEG 转存并保存重开，以及指定旧稿经官方表单提交、用户公开阅读已有独立证据 | PostBridge 自动正式发布、完整审核、自动化公开页核验及图片边界 |
| 小红书真实平台 | 指定账号登录与会话重启、资料、七日统计及空笔记列表只读通过 | 非空笔记及分页、真实正文图片、素材上传、远端草稿和发布 |
| 格式化 | 13 份合成稿完成公众号本地保真校验。真实 DeepSeek 的合成样本对照中，小红书 9/10 次、公众号建议 3/4 次通过校验，无效结果已拦截 | 公众号真实草稿保存、重开与图片粘贴，小红书目标平台保存及效果对照 |
| 对外联调与生产 | PostBridge 侧固定协议及签名向量通过本地验证。systemd、安装快照和升级恢复具备合成验证 | 真实调用方连接及可靠投递、跨网络 HTTPS、目标常驻部署、监测和备份恢复 |

详细证据见[验收记录](acceptance.md)与[平台能力](platform-capabilities.md)。

## 完整首期进度

| 阶段 | 剩余关口 |
| --- | --- |
| [A 平台能力](plans/a-platform-validation.md) | CSDN 剩余发布和素材边界，小红书图文能力，知乎目标账号与发布能力 |
| [B 系统基础](plans/b-system-foundation.md) | 现有后台、队列、账号及来源基础可用；完整多平台分发契约、监测及综合闭环待核对 |
| [C 平台发布](plans/c-platform-publishing.md) | CSDN 自动发布真实验证、封面、审核跟踪、MDX 和其余平台写入 |
| [D 外部接入](plans/d-cms-integration.md) | 真实调用方实现、共同契约审阅、可靠投递及联调 |
| [E 上线运维](plans/e-release-operations.md) | 目标环境安装、HTTPS、容量、生产恢复与最终验收 |

当前授权覆盖已指定 CSDN 账号的登录、草稿和只读验证，以及已指定小红书账号的只读检查。其他公开提交、平台写入和删除按明确授权执行。后续顺序与完整要求见[实施计划](implementation-plan.md)和[需求](requirements.md)。
