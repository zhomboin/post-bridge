# CSDN 账号文章只读接入

## 设计与范围

实现文章列表、状态筛选、统计、正文查看和 CSDN 跳转。沿用当前工作台的配色、字体与紧凑列表；详情使用独立页面，返回时恢复筛选。平台读取由执行器串行处理，网络层禁止保存、删除、发布等写请求。

采用持久化快照和按需正文。实时代理容易超时，定时全量抓取增加外站负载，因此选择主动同步；页面轮询只查询本地状态。同步完整读取全部与草稿分页，校验账号、总数和重复 ID；成功后一次替换，失败保留旧数据。未知状态不推断审核中。正文只读，平台 HTML 不执行。

## 共享数据契约

| 对象 | 字段 |
| --- | --- |
| Article | id、title、status（published/draft/rejected/recycled/unknown）、platform_status、posted_at（ISO 8601）、type、views、likes、comments、favorites、exposures、gained_fans、quality_score、is_top、fans_only、vip_only、editor_type、cover_urls；API 补充 blog_url、editor_url |
| ArticleSnapshot | username、profile、counts（total/published/draft/rejected/recycled/unknown）、stats、trend、items |
| profile | nickname、avatar_url、level、points、original_articles、followers |
| stats | articles、views、likes、comments、favorites、exposures、followers、yesterday_views、yesterday_followers、yesterday_favorites；未获取值为 null |
| trend 条目 | date、views、comments、favorites、followers、promotion_clicks、outlink_clicks |
| ArticleBody | id、title、markdown、html、description、tags（字符串数组）、categories（字符串数组）、type、visibility、platform_status、reason |
| Job | 新增 sync_articles、read_article；后者使用 article_id，禁止 remote_id 和 external_started |
| 完成请求 | 同步成功携带 articles；正文成功携带 article；其他任务、失败、失租和取消不得保存载荷 |

## 管理接口

| 路径 | 行为 |
| --- | --- |
| GET /api/account/articles | q、status、page、page_size；返回 items、total、page、page_size、snapshot、sync_job；snapshot 含 username、profile、counts、stats、trend、synced_at，不含 items；首次为 null |
| POST /api/account/articles/sync | request_id；返回任务，要求会话与 CSRF，同类活动任务复用 |
| GET /api/account/articles/{id} | 返回 article（条目）、body（未读为 null）、fetched_at、read_job；无快照条目为 404 |
| POST /api/account/articles/{id}/read | request_id；只接受快照内数字 ID，返回任务并复用同条目的活动读取 |

读取沿用租约、心跳、取消、恢复与登录后继续，在未知草稿结果阻塞写任务时仍可执行。成功载荷经服务端账号、大小和字段校验后，与完成任务在同一事务提交。正文不进入任务与日志；同步成功清除旧正文缓存，缓存保留 30 天；账号变更后旧数据不可见。内部完成请求单独允许最大 8 MiB，管理请求保持 1 MiB。

## 实施与验证

- [ ] 执行器独立只读适配器与模拟站测试，覆盖原生分页、账号汇总、趋势、正文、错账号、写请求阻断、分页不全和未知状态。
- [ ] API 快照和任务，测试鉴权、CSRF、幂等、失租、失败保留、账号隔离和分页。
- [ ] 后台列表、统计、详情与安全外链，覆盖加载、空结果、错误和筛选恢复。
- [ ] 模拟跨服务验证和 1440、390、320 像素、键盘、减少动态效果检查。
- [ ] 更新文档、独立检视与 PR，真实只读验证不编辑、删除或发布。

完成后删除本实施文档，在进度、接口、能力、验收和版本文档保留简明结果。


## 独立审阅补充

任务绑定账号贯穿创建、续期、进度与完成；正文 ID 必须精确匹配任务且仍属于当前快照。账号切换后旧领取不能改变新账号状态。正文预览关闭原始 HTML、图片及危险链接，外站链接固定域名并绑定账号与数字 ID。分页完整性检查区分同分页序列重复和跨列表一致条目，超限整体失败。
