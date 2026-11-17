# 项目文档

PostBridge 提供多用户独立登录、同平台多账号管理、CSDN Markdown 图文草稿和管理员确认发布、CSDN 与小红书只读工作台，以及固定协议的外部来源接入。可选格式化支持 CSDN 平台稿、小红书本地图文和微信公众号本地保真排版及 AI 辅助建议。完整首期的进度与待验收项见[总体进度](progress.md)。

## 开发与部署

- [WSL 本地开发](development.md) — 准备工具、初始化、启动、停止、备份升级和检查。
- [Ubuntu 部署](ubuntu-deployment.md) — 准备数据库、安装、配置 HTTPS、启停、备份升级和排障。
- [运维说明](operations.md) — 任务恢复、来源撤销、密钥和记录保留。
- [仓库规范](../AGENTS.md)、[代码质量与安全](code-quality.md)、[前端技能](frontend-skills.md)。

## 功能与接口

- [平台账号管理](platform-accounts.md)、[账号归属与认证存储](account-ownership.md)、[小红书只读工作台](xiaohongshu-readonly.md)。
- [AI 平台稿格式化](ai-formatting.md)、[管理后台规范](admin-ui.md)、[内容平台接入](content-platforms.md)。
- [后台及内部 API](api.md)、[外部接入方案](cms-integration.md)、[外部接入手册](external-integration.md)、[OpenAPI](../contracts/cms.openapi.yaml)。

## 需求与验收

- [需求](requirements.md)、[未完成工作与验收顺序](implementation-plan.md)、[验收记录](acceptance.md)、[平台能力](platform-capabilities.md)、[版本记录](version.md)。
- [CSDN 图文与发布计划](plans/csdn-rich-publishing.md)、[小红书接入方案](xiaohongshu-integration.md)和[专项计划](plans/xiaohongshu-integration.md)。
- [多平台内容转换方案](platform-formatting-design.md)、[专项计划](plans/platform-formatting.md)和[样稿对照](plans/platform-formatting-observations.md)。
