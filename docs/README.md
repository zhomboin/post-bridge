# 项目文档

本项目已提供 CSDN 文字 Markdown 草稿后台、支持小红书只读列表的多平台账号工作台及 PostBridge 侧外部来源接入。本地验证覆盖注册、签名、平台稿确认、来源守卫和分发查询；真实调用方连接、跨网络生产、公开发布及其他平台仍待验收。完整首期尚未通过。

- [需求规划](requirements.md)：完整范围、当前子范围和验收要求。
- [平台账号管理](platform-accounts.md)：CSDN 与小红书账号切换、私有会话配置、登录检查及笔记只读同步。
- [总体进度](progress.md)：代码、本地、真实平台与生产状态。
- [验收记录](acceptance.md)：实际运行证据及未验边界。
- [版本记录](version.md)：简要变更。
- [代码质量与安全](code-quality.md)：全仓审阅范围、已修复问题、格式规范及验证边界。
- [完整实施计划](implementation-plan.md)：阶段依赖与剩余工作。
- [小红书接入方案](xiaohongshu-integration.md)：图文笔记路线、开源参考、系统改动与提交核对边界。
- [小红书实施计划](plans/xiaohongshu-integration.md)：匿名验证、账号能力、图文准备与正式发布的分层关口。
- [外部接入总体方案](cms-integration.md)：双方职责、流程、当前实现和调用方剩余工作。
- [外部系统接入手册](external-integration.md)：注册、签名、指纹、人工确认、轮询与主动取消；后台顶部文档图标可站内阅读，并下载契约与测试向量。
- [外部接口机器契约](../contracts/cms.openapi.yaml)：实际开放接口、模型和权限。
- [后台及内部 API](api.md)：管理员、任务与执行器协议。
- [管理后台规范](admin-ui.md)：界面规则、来源工作台与合成截图。
- [平台能力](platform-capabilities.md)：各平台实际证据与限制。
- [WSL 本地开发](development.md)：工具准备、私有配置、初始化、启动、停止、备份升级及验证的逐步命令。
- [运维说明](operations.md)：来源暂停、密钥、恢复和保留。
- [Ubuntu 部署](ubuntu-deployment.md)：数据库准备、初始化安装、HTTPS、启停、备份升级和排障的逐步命令。
- [前端技能](frontend-skills.md)：设计与审阅要求。
- [贡献指南](../AGENTS.md)：实际结构、测试和提交规范。
