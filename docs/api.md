# CSDN 后台接口

## 本轮交付边界

实现独立管理员登录、CSDN 登录状态检查、文字 Markdown 草稿任务、账号文章只读快照与正文、持久队列、任务详情和日志。仅支持一个 CSDN 账号，公开发布和其他平台均不开放；CMS 连接与图片上传继续待实施，生产远程登录仍待实际环境验收。正式运行只需 Go、PostgreSQL 和 Node.js/Playwright，不启动 Agent 或调用大模型。

API 管理数据库，执行器通过受限内部接口领取和上报，不直接访问数据库。管理界面只操作管理接口。本文为三单元共享契约，字段变化需同时更新实现与用例。

## 响应与权限

- 管理 API 使用 HttpOnly、SameSite=Strict 的服务端会话 Cookie；生产 HTTPS 下加 Secure。登录和会话查询返回用户及 csrf_token，其他管理写请求带 X-CSRF-Token，并校验 Origin。
- 内部接口使用单独的 Bearer 执行器密钥，不接受管理员 Cookie 替代。管理登录不能调用内部领取接口。
- 错误响应含 code、message；不得返回密钥、Cookie、完整页面、原始网络响应或文章正文作为错误详情。
- 列表响应统一含 items、total、page、page_size，默认每页 50、最大 100；日志默认最近 24 小时，单次最多 31 天。时间字段为带时区的 ISO 8601，界面按本地时区显示。
- 创建任务请求上限 1 MiB；标题 5—100 个字符，Markdown 非空且最多 200000 个字符。当前拒绝图片、MDX 和可执行 HTML，代码围栏中的代码样例正常保留。界面预览不执行 HTML。

## 管理接口

| 方法与路径 | 输入 | 返回与行为 |
| --- | --- | --- |
| GET /healthz | 无 | 仅服务就绪状态，不泄露配置 |
| POST /api/login | username、password | user 与 csrf_token；失败使用通用错误并限制尝试速率 |
| GET /api/session | 会话 | user 与 csrf_token，失效返回 401 |
| POST /api/logout | 会话及 CSRF | 撤销会话并清除 Cookie |
| GET /api/overview | 会话 | counts 按状态计数、worker_last_seen_at、account 状态 |
| GET /api/account | 会话 | id、platform、username、display_name、status、last_checked_at、last_error |
| GET /api/account/articles | q、status、page、page_size | 文章列表及快照摘要；首次 snapshot 为 null；不含正文 |
| POST /api/account/articles/sync | request_id | 新建或复用活动同步任务；需会话、CSRF 与来源验证 |
| GET /api/account/articles/{id} | 数字文章 ID | article、body、fetched_at、read_job；正文未读时 body 为 null，无快照条目为 404 |
| POST /api/account/articles/{id}/read | request_id | 仅为当前账号快照内文章新建或复用活动正文读取任务 |
| POST /api/account/check | request_id | 新建 check_account 任务，返回任务；不修改平台内容 |
| POST /api/jobs | request_id、kind、platform、title、markdown | 当前 kind 仅 save_draft，platform 仅 csdn；新建 202，重复相同内容返回已有任务，同标识不同内容 409 |
| GET /api/jobs | q、status、page、page_size | 任务列表，不含 Markdown 正文 |
| GET /api/jobs/{id} | 会话 | 完整任务，含不可变 Markdown 正文和结果 |
| POST /api/jobs/{id}/cancel | 会话及 CSRF | 排队任务可取消；执行中设置 cancel_requested，待执行器确认停止后转换状态 |
| POST /api/jobs/{id}/retry | 会话及 CSRF | 仅失败、尚无外站副作用且未达安全重试上限时允许，返回任务 |
| POST /api/jobs/{id}/resume | 会话及 CSRF | 登录完成后继续等待任务；已开始外站操作则只进入核对 |
| POST /api/jobs/{id}/reconcile | 可选 remote_id | 仅核对既有草稿；管理员输入仅作候选，匹配后才绑定；无 ID 时自动查询草稿列表；数字 ID 为可选候选，不创建或改写草稿 |
| POST /api/jobs/{id}/resolve | confirmed_browser_stopped、note | 明确保留已有或可能存在的草稿并结束任务；无有效领取且执行器近期确认浏览器空闲后才允许，不删除或改写草稿，不再自动重试，记录管理员决定 |
| GET /api/logs | job_id、level、q、from、to、page、page_size | 脱敏日志列表，不返回任务正文 |
| GET /api/settings | 会话 | draft_only、platform、limits、poll_interval_ms、worker_last_seen_at；当前只读 |

登录返回的 user 含 username。账号 id 固定 csdn-main；username 由服务配置确定，不由任务请求覆盖。账号 status 为 unchecked、connected、needs_login 或 blocked。

## 任务字段与状态

任务对象：id、request_id、platform、account_id、kind、title、markdown（仅详情和执行器）、status、outcome、stage、attempts、retry_count、max_retries、reconcile_count、auto_reconcile_started、absence_checks、last_absence_at、run_mode、external_started、remote_id、reconcile_candidate_id、manual_resolved、remote_url、cancel_requested、error_code、error_message、retry_allowed、created_at、updated_at、started_at、finished_at、available_at。

- kind 为 save_draft、check_account、sync_articles 或 read_article；读取任务由文章专用接口创建，使用 account_username 绑定账号，正文读取另含 article_id。读取任务不设置 external_started 和 remote_id，成功仍为 not_submitted，不表示外站保存或发布。
- status 为 queued、running、waiting_user、reconciling、succeeded、failed、cancelled。
- outcome 为 not_submitted、draft_saved 或 unknown；任务成功不表示文章已公开。
- run_mode 为 execute 或 reconcile；核对只读，不调用填稿或新建。
- stage 使用 queued、checking_login、opening_editor、draft_acquired、filling、saving、verifying、finished 等稳定英文标识，界面显示中文。
- remote_id 仅接受数字；remote_url 由服务端根据固定 CSDN 域名与 ID 生成，不接受任意网址。
- attempts 记录所有领取次数；retry_count 与 max_retries 单独控制安全网络重试，最多 3 次，自动与手动重试共用预算，退避 5、20、60 秒。登录恢复和只读核对不占该预算。登录问题等待人工处理，不重复登录。核对使用独立读取预算；draft_absent 表示一次完整空结果，draft_conflict 表示重复或残稿，reconcile_unavailable 表示查询失败，reconcile_exhausted 表示自动读取预算耗尽。

日志字段：id、job_id、attempt、level、stage、message、created_at。level 为 info、warning、error。事件消息采用固定描述和受限摘要，不包含密码、令牌、Cookie、正文或完整页面；前端按纯文本展示。

## 账号文章契约

列表返回 items、total、page、page_size、snapshot 与 sync_job。状态参数为 published、draft、rejected、recycled、unknown，空值查询全部含草稿。snapshot 包含账号、profile、counts、stats、trend、synced_at；分页与筛选只操作持久化快照。

文章条目含 id、title、status、platform_status、posted_at、type、views、likes、comments、favorites、exposures、gained_fans、quality_score、is_top、fans_only、vip_only、editor_type、cover_urls，以及服务端生成的 blog_url、editor_url。仅已发布条目提供公开文章链接；链接存在不代表本次完成公开可达性验证。

profile 提供昵称、头像地址、等级、积分、原创文章数与粉丝数；stats 提供文章数、阅读、点赞、评论、收藏、展现、粉丝及可获取的昨日变化。trend 按日期提供阅读、评论、收藏、粉丝净变化、推广与外链点击。未取得指标为 null，净变化可为负，不以零替代未知。

body 含 id、title、markdown、html、description、tags、categories、type、visibility、platform_status、reason。所有正文接口要求管理员会话，正文不进入任务记录、列表、日志和错误信息。平台 HTML 只作为文本返回；界面禁用原始 HTML，正文链接只允许 HTTP/HTTPS，禁止自动加载外站图片。

同步成功的内部完成请求携带 articles，正文成功携带 article；与完成状态在同一事务提交。其他任务、失败、取消、过期领取和账号不匹配均不能保存读取载荷。最多 2000 条文章、366 条趋势；快照最大 6 MiB、单篇正文最大 2 MiB，内部完成接口最大 8 MiB。普通管理请求维持 1 MiB。

完整同步一次替换快照并清除旧正文缓存；分页不全、重复、总数变化或超限整体失败，保留旧数据。正文缓存最长 30 天，账号变更后旧数据不再可见，旧账号上报不能改变新账号状态。同一活动读取复用任务，并保留各请求标识的幂等映射。

## 内部执行器接口

所有内部请求使用独立 Bearer 密钥，正文只含对应任务所需字段。

| 方法与路径 | 输入 | 返回与约束 |
| --- | --- | --- |
| POST /internal/worker/claim | worker_id | 无任务返回 204；有任务返回 job、lease_token、lease_seconds、lease_expires_at |
| POST /internal/worker/heartbeat | worker_id、browser_idle、profile_available | 登记存活及本地浏览器空闲证明，不领取任务；profile_available 必须检查专属配置锁和可能遗留的浏览器进程 |
| POST /internal/worker/jobs/{id}/heartbeat | lease_token | 返回 cancel_requested；过期或错误领取返回 409 |
| POST /internal/worker/jobs/{id}/progress | lease_token、stage、可选 remote_id、external_started、message | 核对领取代次；进度上报仅能设置外站已开始；只有服务端接受两次完整空查询后才可清除未知状态，由正常任务取得或核对匹配后的远端 ID 绑定后不能换成另一个；管理员输入的候选 ID 不在 progress 直接绑定 |
| POST /internal/worker/jobs/{id}/complete | lease_token、status、可选 remote_id、error_code、error_message、retryable | status 为 succeeded、failed、waiting_user、reconciling、cancelled；服务端校验合法转换及副作用边界 |

同一账号只允许一个有效领取；租期 60 秒，执行器每 15 秒续期，过期领取不能继续写入。领取事务使用 PostgreSQL 行锁并跳过已锁定任务。

## 防重复、恢复与账号互斥

1. 请求标识与不可变内容指纹一起去重；同标识不同内容明确冲突。
2. 打开新建编辑器前必须成功上报 external_started，之后可能已有平台自动草稿。获取平台 ID 后立即持久化，再继续填写和保存。
3. 执行器身份在同一私有账号目录内持久化，重启后继续使用，不跨不同账号目录复用。账号检查和只读核对在网络层禁止保存及其他写请求；草稿读回同时验证内容及当前适配器已实测的草稿状态值 2，未知值保持待核对。
4. 已开始外站操作时遇到超时、崩溃、失租或停止，延迟 20 秒进入自动只读核对。每个写入阶段最多核对 4 轮，轮次、连续空结果和下一次执行时间持久化，重启不重置。旧待核对任务首次领取检查时自动纳入。
5. 核对优先读取已绑定 ID 或可选候选；无 ID 时读取管理页原生草稿列表接口的全部分页，校验账号、数量和状态，再读取同标题候选正文。唯一完整匹配才绑定，禁止关联其他任务的草稿。连续两次间隔至少 20 秒的完整空结果才能确认未保存并重排原任务，消耗最多 3 次写入重试预算。已有 ID 不匹配或重复、残稿不自动重写。
6. 同账号存在未解决的未知结果时，普通新建任务不执行；允许自动及按需只读核对；冲突或 4 轮读取耗尽时明确失败，保留未知结果和账号写入限制，不无限显示执行中。领取到期后 API 恢复状态，执行器同时使用私有配置锁，确认前一个浏览器仍在运行时拒绝启动第二个。
7. 取消执行中任务先通知执行器关闭浏览器；若已可能保存草稿则继续自动只读核对，不再恢复写入；登录恢复也保留取消意图。
8. 空稿或半成品无法匹配完整快照时，管理员可选择保留草稿并人工结束。必须无有效领取、执行器 45 秒内报告浏览器空闲且配置可用，再由管理员确认并填写原因；任务记 failed、manual_resolved=true，保留 external_started、unknown 结果及已知远端 ID，禁止该任务重试，解除其账号阻塞。不能把人工结束记为保存成功或已撤回。
9. 接到停止信号、取消或续期失效，执行器停止新操作并关闭本任务浏览器。退出后释放本地锁，保留受限账号目录，不终止无关服务。

## 配置约定

| 配置 | 作用 |
| --- | --- |
| DATABASE_URL | 本项目独立 PostgreSQL 连接 |
| API_ADDR、API_BASE_URL | API 监听与执行器连接地址，开发默认回环地址 |
| ADMIN_USERNAME、ADMIN_PASSWORD_FILE | 初始管理员及私有密码文件，禁止内置通用密码 |
| WORKER_TOKEN_FILE | 管理端与执行器共享的私有内部凭据文件 |
| CSDN_USERNAME、CSDN_DISPLAY_NAME | 预期账号身份，身份不符时不修改平台内容 |
| CSDN_PROFILE_DIR | 仓库外专属浏览器配置目录，Linux 权限 0700 |
| PLAYWRIGHT_EXECUTABLE_PATH | 可选开发浏览器路径；部署时使用匹配的固定浏览器版本 |
| WORKER_HEADLESS | 默认 true；账号页提供无桌面远程验证，本地助手为可选入口 |
| ADMIN_DIST_DIR | 可选后台构建产物目录，由 API 提供同站点访问 |

本轮提供独立本地数据库、初始化、启动、测试和停止入口。运行数据、密钥、登录状态和诊断文件不写入 Git。数据库日志保留和任务内容清理遵循有限期限，不清理正在执行或待核对任务所需的内容。

## 后台远程登录

远程登录在账号页发起，输入和画面仅转发到固定 IPv4 回环执行器。管理员会话和写操作 CSRF 均需验证，会话绑定具体发起者；其他管理员会话只能看到忙碌提示。所有响应禁缓存，不转发管理员 Cookie、请求来源凭据或任何任意网址。

| 方法与路径 | 行为 |
| --- | --- |
| GET /api/account/login | 查询本人会话状态；未启用返回明确错误，他人会话不返回 ID |
| POST /api/account/login | 空请求或空对象创建临时登录；等待当前任务释放浏览器后启动 |
| DELETE /api/account/login/{id} | 撤销本人会话并关闭浏览器 |
| GET /api/account/login/{id}/frame | 返回本人会话的内存 JPEG，视口固定 1280×800 |
| POST /api/account/login/{id}/input | 受限点击、文字、手机号或验证码填写、白名单按键、拖动点列及滚动，不接受网址或脚本 |

会话最长十分钟，活动期间六十秒无画面或输入后关闭。状态为 idle、pending、active、succeeded、failed、expired、cancelled；他人占用时返回 busy。输入大小至多 16 KiB，文字至多 2000 字、拖动 2—128 个点、坐标限制在视口内。手机号和验证码填写分别只接受 5—20 位与 4—8 位数字，按字段匹配固定认证来源内唯一可用输入，不自动获取短信或提交登录。认证页面未就绪时保持 pending；最多三次页面加载仍失败后返回 failed 及固定加载失败提示，关闭浏览器。其他执行器错误继续脱敏。停止与过期拒绝迟到输入。远端 Tab 和 Shift+Tab 仅在固定认证来源的可用文字输入间循环，不在后台账号页背景导航。指定身份成功确认采用幂等事务，只恢复本账号因 needs_login 等待且未取消的任务；未知外站结果仍进入核对，预算不重置。

公开来源 PUBLIC_ORIGIN 与内部 API_BASE_URL 分离。REMOTE_LOGIN_URL 仅支持固定回环地址；执行器通过 LOGIN_CONTROL_ADDR 启用控制服务，内部鉴权沿用私有执行器密钥。部署与配置入口见[Ubuntu 部署说明](ubuntu-deployment.md)。
