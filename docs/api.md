# 后台与内部接口

## 本轮交付边界

实现多用户独立登录、CSDN 草稿与受控发布、账号文章快照与正文、持久队列、任务详情和日志，以及 CSDN 与小红书账号切换、小红书登录检查及笔记只读快照。每个用户可绑定同平台多个独占账号；小红书内容写入不开放。PostBridge 侧来源接入已实现，真实调用方连接及生产验收仍待。基础运行使用 Go、PostgreSQL 和 Node.js/Playwright；可选 DeepSeek 格式化使用独立队列和 formatter 服务，平台执行不启动 Agent。

API 管理数据库，执行器通过受限内部接口领取和上报，不直接访问数据库。管理界面只操作管理接口。本文为三单元共享契约，字段变化需同时更新实现与用例。

PostBridge 已实现调用平台受邀注册、审批、一次性密钥、激活、逐请求签名、平台稿修订确认、分发查询及来源守卫。准确外部协议统一见[外部接入手册](external-integration.md)和[OpenAPI](../contracts/cms.openapi.yaml)，双方职责见[总体方案](cms-integration.md)；不在本文复制第二套协议。跨网络业务读写只对已注册且有效授权的应用开放；注册入口也须持有效邀请。外部调用方统一使用固定协议，无需反向服务；本文管理接口不能作为外部接口复用，执行器密钥不授予调用方。

## 响应与权限

- 管理 API 使用 HttpOnly、SameSite=Strict 的服务端会话 Cookie；生产 HTTPS 下加 Secure。登录和会话查询返回用户及 csrf_token，其他管理写请求带 X-CSRF-Token，并校验 Origin。
- 内部接口使用单独的 Bearer 执行器密钥，不接受管理员 Cookie 替代。管理登录不能调用内部领取接口。
- 错误响应含 code、message；不得返回密钥、Cookie、完整页面、原始网络响应或文章正文作为错误详情。
- 分页列表含 items、total、page、page_size，默认每页 50、最大 100；来源应用、邀请、申请和审计仅返回最近 100 条 items。日志默认最近 24 小时，单次最多 31 天。时间字段为带时区的 ISO 8601，界面按本地时区显示。
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
| POST /api/jobs/{id}/resume | 会话及 CSRF | 仅处理平台登录等待；来源暂停必须经父分发重新确认，普通恢复被拒绝；已开始外站操作只核对 |
| POST /api/jobs/{id}/reconcile | 可选 remote_id | 仅核对既有草稿；管理员输入仅作候选，匹配后才绑定；无 ID 时自动查询草稿列表；数字 ID 为可选候选，不创建或改写草稿 |
| POST /api/jobs/{id}/resolve | confirmed_browser_stopped、note | 明确保留已有或可能存在的草稿并结束任务；无有效领取且执行器近期确认浏览器空闲后才允许，不删除或改写草稿，不再自动重试，记录管理员决定 |
| GET /api/processes | q、status、platform、kind、job_id、level、from、to、page、page_size | 按任务分页的对象处理记录，含平台、对象、账号、步骤、结果和事件统计，不含正文 |
| GET /api/jobs/{id}/history | page、page_size | 本次处理全部保留日志，按时间正序分页；transitions 单独返回完整压缩状态流转，不受当前页或列表时间范围限制 |
| GET /api/jobs/{id}/changes | 可选 attempt | 受保护的提交内容、实际前后快照、已采集轮次及内容保留状态；未指定轮次取最早 before 和最新 after |
| GET /api/logs | job_id、level、q、from、to、page、page_size | 脱敏日志列表，不返回任务正文 |
| GET /api/settings | 会话 | draft_only、platform、limits、poll_interval_ms、worker_last_seen_at；当前只读 |

登录返回的 user 含 id、username、role。管理员角色仅额外开放用户管理，不可访问其他用户业务数据。user_id 和账号归属由服务端会话决定，不能由请求指定。账号含 owner_user_id、enabled、verified；status 为 unchecked、connected、needs_login、blocked 或 disconnected。网页新绑定先为未核验状态，平台身份确认后才能创建任务和授予来源权限。

/api/account 及其文章、登录、设置接口用 account_id 查询参数选择账号；省略时选择当前用户第一个有效账号。无账号不使用其他用户默认账号。创建任务可传 account_id；任务详情操作始终从任务本身取得账号。所有列表、数量及对象读取限制当前用户；越权对象返回 404。去重按用户及调用主体划分，同用户相同标识不同账号或内容返回 409。

## 用户管理

仅 admin 角色可调用 GET /api/users、POST /api/users 和 PATCH /api/users/{user}。创建输入 username、password，密码为 12—72 字节；创建普通用户。修改接受 enabled 或 password，提升认证版本并撤销该用户全部本站会话。禁止停用自己、修改其他用户、由客户端提升角色；普通用户返回 403。用户列表不返回密码哈希。后台提供创建和启停，密码重置通过受保护的 PATCH 接口执行。

## 任务字段与状态

任务对象另含 owner_user_id、connection_version、created_by，以及可选 integration_distribution_id，用于定位外部来源父分发。任务对象：id、request_id、platform、account_id、account_username、kind、article_id、title、markdown（仅详情和执行器）、status、outcome、stage、attempts、retry_count、max_retries、reconcile_count、auto_reconcile_started、absence_checks、last_absence_at、run_mode、external_started、remote_id、reconcile_candidate_id、manual_resolved、remote_url、cancel_requested、error_code、error_message、retry_allowed、created_at、updated_at、started_at、finished_at、available_at。

- kind 为 save_draft、check_account、sync_articles 或 read_article；读取任务由文章专用接口创建，使用 account_username 绑定账号，正文读取另含 article_id。读取任务不设置 external_started 和 remote_id，成功仍为 not_submitted，不表示外站保存或发布。
- status 为 queued、running、waiting_user、reconciling、succeeded、failed、cancelled。waiting_user 表示等待处理；有 integration_distribution_id 且 error_code 为 source_guard_failed 或 source_changed 时显示“来源待处理”，进入原父分发处理来源授权，不引导平台登录或普通恢复。
- outcome 为 not_submitted、draft_saved 或 unknown；任务成功不表示文章已公开。
- run_mode 为 execute 或 reconcile；核对只读，不调用填稿或新建。
- stage 使用 queued、checking_login、opening_editor、draft_acquired、filling、saving、verifying、finished 等稳定英文标识，界面显示中文。
- remote_id 仅接受数字；remote_url 由服务端根据固定 CSDN 域名与 ID 生成，不接受任意网址。
- attempts 记录所有领取次数；retry_count 与 max_retries 单独控制安全网络重试，最多 3 次，自动与手动重试共用预算，退避 5、20、60 秒。登录恢复和只读核对不占该预算。登录问题等待人工处理，不重复登录。核对使用独立读取预算；draft_absent 表示一次完整空结果，draft_conflict 表示重复或残稿，reconcile_unavailable 表示查询失败，reconcile_exhausted 表示自动读取预算耗尽。

日志字段：id、job_id、attempt、level、stage、message、created_at、status、outcome、run_mode。后三项在事件产生时记录；已有事件没有该值时保持空，不按当前任务状态补填。level 为 info、warning、error。事件消息采用固定描述和受限摘要，不包含密码、令牌、Cookie、正文或完整页面；前端按纯文本展示。

处理记录一行对应一个任务，额外返回 object_type、object_id、object_name、account_name、event_count、warning_count 和 error_count。object_type 为 article 或 account。列表按最近任务更新或事件时间筛选，重试不产生额外列表行；重复对象的不同任务分别返回。

内容快照字段包括 id、attempt、phase、object_type、captured_at 及适用的 title、markdown、status、remote_id、username、display_name。phase 为 before 或 after。内容不混入日志，读取必须登录并禁止缓存。未采集不返回虚假快照；空标题或正文仍显式返回空字符串。

## 后台账号入口

后台统一入口为 /account，默认文章页签；数据统计使用 tab=stats，账号设置使用 tab=settings。q、status、page 保留文章筛选与分页；页签切换、刷新及浏览器历史恢复这些参数。独立正文 /articles/{id} 的返回地址指向账号文章页。已有 /articles 查询入口保留条件并归一到平台账号。

页签复用本文现有管理接口，不新增平台写入或服务端能力。远程登录仅在账号设置挂载，离开时撤销未完成会话并停止请求。

## 多平台账号与小红书只读接口

全部接口需要本站用户会话；写请求同时校验 Origin 和 CSRF。私有配置方式见[账号管理](platform-accounts.md)。

| 方法与路径 | 结果 |
| --- | --- |
| POST /api/accounts | platform、username、可选 display_name 和小红书 user_id；归属取会话，返回 201。每用户最多一百个有效绑定；重复绑定返回 409 |
| DELETE /api/accounts/{account} | 解绑，撤销连接与新任务资格；业务记录保留；未确认的平台结果返回 409 account_unresolved；不能转让归属 |
| GET /api/accounts | items 中每项包含 account 和 capabilities；不返回凭据、浏览器路径或 Cookie |
| GET /api/accounts/{account} | 指定账号及能力开关 |
| POST /api/accounts/{account}/check | 传入 request_id，创建 check_account 任务 |
| GET /api/accounts/{account}/notes | 小红书本地快照；q、status、page、page_size 支持搜索和分页 |
| POST /api/accounts/{account}/notes/sync | 传入 request_id，创建 sync_notes；同一账号活跃同步合并 |
| GET /api/accounts/{account}/notes/{note} | note、body、fetched_at、read_job；仅限当前账号快照内笔记，正文未读为 null |
| POST /api/accounts/{account}/notes/{note}/read | 传入 request_id，为已发布笔记创建或复用 read_note；需所属用户、Origin 与 CSRF |

笔记返回 items、total、page、page_size、snapshot 和 sync_job。snapshot 为 null 表示从未同步，空 items 且 snapshot 非空表示已同步空账号。条目含 id、title、status、platform_status、posted_at、type、cover_urls、note_url，以及 views、likes、comments、favorites、shares。时间可为空，统计可为 null；未知状态保持 unknown。note_url 仅为已发布条目的固定官方查看地址，不是发布接口。

snapshot 的 profile 为昵称、头像、简介、关注、粉丝和获赞与收藏；stats 包含明确起止时间的七日指标，trend 为北京时间日期的六项趋势。净增粉丝可为负，其他计数不得为负；缺失不补零。列表不含正文。详情 body 包含 id、user_id、title、text、images、tags；正文按纯文本显示，媒体仅接受受限平台 HTTPS 域名。正文按账号和笔记存储，读取失败保留缓存，账号或连接变更后拒绝旧上报。

账号列表和账号专属路由仅开放当前用户所属账号。停用账号的专属路由返回 404，重试或恢复任务返回 409；历史任务和本地快照不删除。

每个账号使用不同执行器凭据，服务端按凭据决定可领取与上报的账号；客户端不能通过请求参数更改归属。sync_notes 成功上报需同时包含 account_identity 与 notes，二者 username、user_id 必须匹配任务冻结身份和当前绑定。仅完整、未取消且租约有效的结果可原子替换快照。异常不会覆盖旧快照；跨账号上报拒绝。

read_note 的成功上报使用 account_identity 与 note，笔记标识、作者、任务账号、连接及有效租约同时核对；不接受 articles、article 或 notes 冒充正文。实现和使用见[小红书只读工作台](xiaohongshu-readonly.md)。

## 统一账号内容接口

所有入口要求当前用户会话；POST 同时要求本站来源和 CSRF。账号必须属于当前用户，平台由账号绑定决定。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/content-platforms | 查询平台注册能力和内容限制；不代表当前调用者获得写入授权 |
| GET | /api/accounts/{account}/contents | 查询本地内容；支持 q、status、page、page_size |
| POST | /api/accounts/{account}/contents/sync | 使用 request_id 创建列表同步任务 |
| GET | /api/accounts/{account}/contents/{id} | 查询摘要、正文缓存、采集时间与读取任务 |
| POST | /api/accounts/{account}/contents/{id}/read | 使用 request_id 创建正文读取任务 |

列表返回 items、total、page、page_size、snapshot、sync_job。摘要含字符串 id、title、status、platform_status、posted_at、kind、cover_urls、metrics 和经校验的 extensions，不含正文。状态支持 published、draft、reviewing、rejected、recycled、unknown；平台不认识的状态保持 unknown。指标包含 value、unit、begin_at、end_at，缺失值保留 null。

详情返回 platform、item、body、fetched_at、read_job。body 区分 format、text、html、images、tags 和平台扩展，HTML 作为文本处理。平台标识需按 URL 路径段编码；不要求纯数字。请求分页上限 100 条，每次同步上限 2000 条；快照与正文大小限制分别为 6 MiB、2 MiB。

新平台使用 sync_contents／read_content，成功结果使用 contents／content 和 content_identity；服务端核对任务账号、原生身份、连接版本与租约。完整同步替换列表，部分同步只更新取得的条目，失败保留已有数据。CSDN 与小红书执行器继续使用各自受校验的结果格式，并在同一事务建立公共投影。新旧任务入口共享请求去重，现有专属接口继续可用。缓存与平台注册规则见[内容平台接入](content-platforms.md)。

## 账号文章契约

列表返回 items、total、page、page_size、snapshot 与 sync_job。状态参数为 published、draft、rejected、recycled、unknown，空值查询全部含草稿。snapshot 包含账号、profile、counts、stats、trend、synced_at；分页与筛选只操作持久化快照。

文章条目含 id、title、status、platform_status、posted_at、type、views、likes、comments、favorites、exposures、gained_fans、quality_score、is_top、fans_only、vip_only、editor_type、cover_urls，以及服务端生成的 blog_url、editor_url。仅已发布条目提供公开文章链接；链接存在不代表本次完成公开可达性验证。

profile 提供昵称、头像地址、等级、积分、原创文章数与粉丝数；stats 提供文章数、阅读、点赞、评论、收藏、展现、粉丝及可获取的昨日变化。trend 按日期提供阅读、评论、收藏、粉丝净变化、推广与外链点击。未取得指标为 null，净变化可为负，不以零替代未知。

body 含 id、title、markdown、html、description、tags、categories、type、visibility、platform_status、reason。所有正文接口要求本站用户会话，正文不进入任务记录、列表、日志和错误信息。平台 HTML 只作为文本返回；界面禁用原始 HTML，正文链接只允许 HTTP/HTTPS，禁止自动加载外站图片。

同步成功的内部完成请求携带 articles，正文成功携带 article；与完成状态在同一事务提交。其他任务、失败、取消、过期领取和账号不匹配均不能保存读取载荷。最多 2000 条文章、366 条趋势；快照最大 6 MiB、单篇正文最大 2 MiB，内部完成接口最大 8 MiB。普通管理请求维持 1 MiB。

完整同步一次替换快照并清除旧正文缓存；分页不全、重复、总数变化或超限整体失败，保留旧数据。正文缓存最长 30 天，账号变更后旧数据不再可见，旧账号上报不能改变新账号状态。同一活动读取复用任务，并保留各请求标识的幂等映射。

## 内部执行器接口

所有内部请求使用独立 Bearer 密钥，正文只含对应任务所需字段。

| 方法与路径 | 输入 | 返回与约束 |
| --- | --- | --- |
| POST /internal/worker/claim | worker_id | 无任务返回 204；有任务返回 job、lease_token、lease_seconds、lease_expires_at |
| POST /internal/worker/heartbeat | worker_id、browser_idle、profile_available | 登记存活及本地浏览器空闲证明，不领取任务；profile_available 必须检查专属配置锁和可能遗留的浏览器进程 |
| POST /internal/worker/jobs/{id}/heartbeat | lease_token | 返回 cancel_requested；过期或错误领取返回 409 |
| POST /internal/worker/jobs/{id}/progress | lease_token、stage、可选 remote_id、external_started、message、observation | 核对领取代次；进度上报仅能设置外站已开始；只有服务端接受两次完整空查询后才可清除未知状态，由正常任务取得或核对匹配后的远端 ID 绑定后不能换成另一个；管理员输入的候选 ID 不在 progress 直接绑定 |
| POST /internal/worker/jobs/{id}/complete | lease_token、status、可选 remote_id、error_code、error_message、retryable | status 为 succeeded、failed、waiting_user、reconciling、cancelled；服务端校验合法转换及副作用边界 |

observation 含 phase、title、markdown、status 及可选 remote_id，表示实际内容；before 只允许执行方式为 execute 的 filling，after 只允许 verifying。仅文章任务可上报，使用有效租约在事务中保存；同一任务、轮次、阶段的相同内容可重复，不同内容返回冲突。标题最长 100 字，正文最长 200000 字，不允许 NUL，超限实测值跳过采集而不截断。账号检查由 API 在领取及结果事务内记录检查前后状态。

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
| WORKER_PROFILE_ROOT | 可选新增账号私有根目录，默认在初始会话同级 managed 中 |
| ACCOUNT_SANDBOX_EXECUTABLE | 可选可信 bubblewrap 路径，默认 /usr/bin/bwrap |
| CSDN_PROFILE_DIR | 仓库外专属浏览器配置目录，Linux 权限 0700 |
| PLAYWRIGHT_EXECUTABLE_PATH | 可选开发浏览器路径；部署时使用匹配的固定浏览器版本 |
| WORKER_HEADLESS | 默认 true；账号页提供无桌面远程验证，本地助手为可选入口 |
| ADMIN_DIST_DIR | 可选后台构建产物目录，由 API 提供同站点访问 |
| INTEGRATION_MASTER_KEY_FILE | 可选 API 私有存储密钥文件，32 字节十六进制，不是调用方 secret |
| INTEGRATION_ENVIRONMENT、INTEGRATION_SERVICE_ID | 来源接入环境和接收服务标识，启用时分别配置，PUBLIC_ORIGIN 必须为 HTTPS |

本轮提供独立本地数据库、初始化、启动、测试和停止入口。运行数据、密钥、登录状态和诊断文件不写入 Git。数据库日志保留和任务内容清理遵循有限期限，不清理正在执行或待核对任务所需的内容。

## 后台远程登录

远程登录在“平台账号”的“账号设置”页签发起，输入和画面仅转发到当前账号登记的 IPv4 回环执行器。本站用户会话和写操作 CSRF 均需验证，会话绑定具体发起者；其他本站用户会话只能看到忙碌提示。所有响应禁缓存，不转发管理员 Cookie、请求来源凭据或任何任意网址。

| 方法与路径 | 行为 |
| --- | --- |
| GET /api/account/login | 查询本人会话状态；未启用返回明确错误，他人会话不返回 ID |
| POST /api/account/login | 空请求或空对象创建临时登录；等待当前任务释放浏览器后启动 |
| DELETE /api/account/login/{id} | 撤销本人会话并关闭浏览器 |
| GET /api/account/login/{id}/frame | 返回本人会话的内存 JPEG，视口固定 1280×800 |
| POST /api/account/login/{id}/input | 受限点击、文字、手机号或验证码填写、白名单按键、拖动点列及滚动，不接受网址或脚本 |

会话最长十分钟，活动期间六十秒无画面或输入后关闭。状态为 idle、pending、active、succeeded、failed、expired、cancelled；他人占用时返回 busy。输入大小至多 16 KiB，文字至多 2000 字、拖动 2—128 个点、坐标限制在视口内。手机号和验证码填写分别只接受 5—20 位与 4—8 位数字，按字段匹配固定认证来源内唯一可用输入，不自动获取短信或提交登录。认证页面未就绪时保持 pending；最多三次页面加载仍失败后返回 failed 及固定加载失败提示，关闭浏览器。其他执行器错误继续脱敏。停止与过期拒绝迟到输入。远端 Tab 和 Shift+Tab 仅在固定认证来源的可用文字输入间循环，不在后台账号页背景导航。指定身份成功确认采用幂等事务，只恢复本账号因 needs_login 等待且未取消的任务；未知外站结果仍进入核对，预算不重置。

公开来源 PUBLIC_ORIGIN 与内部 API_BASE_URL 分离。REMOTE_LOGIN_URL 仅作初始账号兼容入口，固定回环地址；账号执行器使用独立凭据登记动态回环入口，不接受外网地址。LOGIN_CONTROL_ADDR 用于调度器回环健康检查。部署与配置入口见[Ubuntu 部署说明](ubuntu-deployment.md)。

## 账号内容展示

账号快照的 profile.avatar_url 用于头部头像，后台只允许 HTTPS 的固定头像域 profile-avatar.csdnimg.cn，不接收带凭据、端口或片段的地址，失败显示占位。CSP 只为图片追加此域，不开放其他外站资源。

统计中的六项日趋势默认使用图表，缺失值保留未知。详情 GET 保持只读查询；前端首次打开无缓存详情时调用现有正文读取接口一次，活动、失败或取消任务不自动重复。读取结果优先直接显示 Markdown 源文，无 Markdown 时显示 HTML 源文；平台标签和脚本不执行。

## CSDN 正式发布

已核对的 CSDN 集成草稿可以由管理员在 PostBridge 单独确认发布。外部接入接口的授权范围仍为保存草稿。草稿必须关联同一账号、已确认的平台稿和有效的来源授权。

| 管理接口 | 用途 |
| --- | --- |
| GET /api/jobs/{id}/publish | 使用草稿任务标识，读取待确认的文章、目标账号、冻结选项及确认令牌。已有发布任务时返回该任务。 |
| POST /api/jobs/{id}/publish | 使用草稿任务标识和确认令牌提交发布任务，返回 202。同一稿件确认重复提交时返回已有任务。 |

发布操作复用原 CSDN 草稿标识。执行器提交前再次核对目标账号、文章和冻结设置。只有读回已发布状态才显示发布成功。平台已受理与结果未知分别记录，均按原任务只读核对。发布至少需要一个标签。转载或翻译需要单篇填写 HTTPS 原文链接并确认授权。自动选封面、定时发布、多平台发布与 GitCode 备份不属于此操作。

## AI 格式化接口

全部属于登录用户管理接口，写入要求既有同源和 CSRF 校验，签名来源应用不能调用。任务及图片按用户隔离；新建与编辑要求可选功能已启用。

| 接口 | 请求与结果 |
| --- | --- |
| GET /api/formatting-capabilities | 返回 enabled、目标平台、模板和原稿上限 |
| POST /api/formatting-sessions | request_id、platforms、allow_ai_processing；本地提供 snapshot 和 CSDN account_id，来源提供 preparation_id、base_revision，服务端读取原稿 |
| GET /api/formatting-sessions/{id} | 获取授权仍有效的原稿快照 |
| GET /api/formatting-sessions/{id}/jobs | 当前会话任务摘要 |
| POST /api/formatting-sessions/{id}/jobs | request_id、platform、template；返回 202，新请求排队，相同请求返回 200，内容不同返回 409 |
| GET /api/formatting-jobs | page、page_size 分页；可按 preparation_id、platform 筛选，只返回摘要，不返回正文 |
| GET /api/formatting-jobs/{id} | 状态、阶段、用量、版本及完整结果 |
| POST /api/formatting-jobs/{id}/cancel | 取消活动任务，不重复请求未知模型结果 |
| POST /api/formatting-jobs/{id}/adopt | revision；CSDN 明确采用，来源稿新建修订并清除旧确认 |
| POST /api/formatting-jobs/{id}/csdn-draft | revision；仅本地 CSDN，冻结结果创建幂等 save_draft 任务 |
| PUT /api/formatting-jobs/{id} | revision、request_id、template、output；只编辑小红书并排队重绘，不调用模型 |
| POST /api/formatting-jobs/{id}/confirm | revision；确认当前小红书文字、图片摘要和顺序，不创建平台任务 |
| GET /api/formatting-assets/{id} | 私有 PNG；download=1 下载，授权失效或到期拒绝 |

字段类型由 [格式化契约](../contracts/formatting-model.json)生成。状态为 queued、running、succeeded、needs_review、failed、cancelled、adopted；needs_review 表示容量等阻塞问题，需要调整。修订不匹配返回 409，用量或队列限制返回 429，未启用返回 503，内容校验失败返回 422。响应不包含模型密钥、原始异常或平台会话。详情与采用会重新核对来源授权；列表只有摘要。

原稿、图片、额度和服务配置见 [AI 格式化](ai-formatting.md)。XHS 上传和发布没有对应接口。

## 账号执行调度

GET /internal/worker/accounts 仅接受调度器主凭据，返回账号身份、归属、连接版本、受控目录引用和当前连接执行令牌；不对网页或账号执行器开放。调度器只按需要启动独立账号环境。

账号执行凭据仅能访问自身任务、心跳、POST/DELETE /internal/worker/control、POST/DELETE /internal/worker/login-lease 和 POST /internal/worker/identity。control 登记或注销自身回环登录入口；登录租约受全局八个、每用户两个浏览器名额限制。identity 仅在浏览器核验后确认独占身份；小红书同时上报官方稳定用户标识，冲突返回 409。解绑或停用用户后拒绝执行器请求；重新绑定不会恢复旧令牌。

实现与数据库约束见[账号归属与认证存储](account-ownership.md)。
