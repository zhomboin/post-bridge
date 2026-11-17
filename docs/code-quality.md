# 代码质量与安全

统一内容接口、平台注册和合成平台验证见[内容平台接入](content-platforms.md)。

## 检视范围

检视范围包含 API、后台、执行器、formatter、共享契约、数据库表结构、开发部署入口、测试和 CI。重点核对认证与 CSRF、来源签名与重放、账号隔离、任务互斥、失租与取消、未知结果恢复、平台写入边界、图片地址、日志脱敏及前端异步清理。结果基于源码、依赖公告和本地合成验证，不作为生产渗透测试结论。

## 当前保护与已处理问题

| 级别 | 检查项 | 当前处理 |
| --- | --- | --- |
| P1 | CSDN 纯文本草稿的非读取请求 | [执行器](../apps/worker/src/csdn.ts)仅允许已确认的保存端点和请求方法，自动保存同样要求草稿状态，写入不跟随重定向；未知结果继续只读核对 |
| P2 | 数据库驱动与文本处理依赖公告 | [模块配置](../apps/api/go.mod)固定 pgx 5.9.2、x/crypto 0.58.0、x/text 0.43.0 和对应间接依赖，保持 Go 1.26.11 |
| P2 | 无效百分号编码中断详情页面 | [路由](../apps/admin/src/App.tsx)安全处理无效编码，显示页面不存在并保留导航 |
| P2 | 严格模式重新建立 effect 后操作结果和按钮状态丢失 | [操作钩子](../apps/admin/src/runtime.tsx)在 effect 建立时恢复挂载标记，卸载时撤销请求 |

依赖安全检查由 CI 运行 npm audit 与 govulncheck，固定版本见 [package-lock.json](../package-lock.json)和 [go.mod](../apps/api/go.mod)。[OpenPGP 停止维护公告](https://pkg.go.dev/vuln/GO-2026-5932)属于间接模块范围，项目的 x/crypto 用于 bcrypt，未导入 OpenPGP。

账号归属、数据库行权限、独立会话与真实沙箱生命周期的补充检视和证据见[账号认证存储](account-ownership.md)与[验收记录](acceptance.md)。

## 格式约定

Go 使用 gofmt 并展开过长的结构体初始化；前后台、执行器、JavaScript、CSS、HTML、JSON 和 YAML 使用 Prettier 3.9.10；Python 使用 Black 25.1.0。SQL 表结构按字段分行，Shell 保持分步命令。所有文本使用 UTF-8 无 BOM 和 LF。

[机器契约](../contracts/cms.openapi.yaml)采用 JSON 兼容的 YAML 子集，格式化固定使用 JSON 解析器，与服务端验证和下载读取方式一致。有意义的界面空格保留。来源弹窗与授权表单拆为独立组件；全局样式按基础、工作台、适配、登录、文章、处理记录与账号分文件，保持加载顺序；应用测试按任务、登录和导航分组。代码文件均控制在 1000 行以内。

统一命令和工具准备见[开发说明](development.md)，CI 同时检查格式、依赖安全和完整功能。部署步骤见[Ubuntu 部署](ubuntu-deployment.md)。

## 验证与边界

CI 执行依赖审计、格式、契约、Go race、后台、执行器、formatter、部署和合成端到端。已合入变更的结果见[验收记录](acceptance.md)。改动时按影响选择定向用例，真实账号兼容、真实调用方和生产部署另行验收。

现有合成界面可查看[文章窄屏](assets/code-quality-articles-320.png)和[来源授权桌面](assets/code-quality-integrations-1440.png)。
