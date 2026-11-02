# 前端技能与使用规则

## 项目安装

两个技能安装在项目的 `.agents/skills/`，随 Git 管理，供所有贡献者使用，不依赖个人全局技能。技能和许可证保留上游原文，项目需求与使用说明使用中文。业务文档仍集中在 `docs/`，技能目录属于工具配置。

| 技能 | 项目入口 | 官方来源 | 固定来源提交 |
| --- | --- | --- | --- |
| Frontend Design | [SKILL.md](../.agents/skills/frontend-design/SKILL.md) | [Anthropic](https://github.com/anthropics/skills/tree/ca45fc496a3436251f191354091d557da31c15b5/skills/frontend-design) | ca45fc496a3436251f191354091d557da31c15b5 |
| Emil Kowalski's Skill | [SKILL.md](../.agents/skills/emil-design-eng/SKILL.md) | [Emil Kowalski](https://github.com/emilkowalski/skills/tree/f1090bec277140d02ed202440185ad9d02ac1490/skills/emil-design-eng) | f1090bec277140d02ed202440185ad9d02ac1490 |

Emil 的官方主技能名为 `emil-design-eng`，已通过[作者网站](https://emilkowal.ski/skill)确认。保留 Frontend Design 的 Apache 2.0 许可证及 Emil 的 MIT 许可证；更新技能时同步检查来源、许可和本页记录，不自动跟随上游变动。`.gitattributes` 固定文档与技能文件使用 LF 换行，避免跨环境检出改变技能原文。

## 强制工作方式

1. 所有前端创建、修改和审阅均先阅读项目内两个技能以及[管理后台规范](admin-ui.md)，包括登录、后台页面、共享组件、响应式和动效。
2. Frontend Design 用于明确产品语境、信息层级、配色、字体与布局，并在实现前审查设计是否符合管理任务。
3. Emil 技能用于检查交互反馈、动效频率与时长、打断恢复、性能及可访问性；高频操作以即时响应为准。
4. 完成后依据两个技能共同审阅；审阅表使用“调整前／调整后／原因”三列，列出文件定位和必要验证。未发现问题时明确记录检查范围，不虚构整改项。
5. 项目需求和用户明确指示优先于技能的通用建议；具体后台业务和默认样式以管理后台规范为准。发现实质冲突时先记录并解决，再实现。

## 加载与验证

支持仓库技能发现的工具可从下一轮对话加载 `.agents/skills/`；未自动加载时按根目录 `AGENTS.md` 中的入口显式阅读。项目内规范为共同依据，避免误用同名全局技能替代已固定的来源。

本次安装与规范编写不代表前端已经实现，也未安装 React、组件库或构建工具。工程初始化时再核实并固定运行依赖，提供实际启动与验证命令。
