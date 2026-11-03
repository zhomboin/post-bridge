# CSDN 后台任务接口

## 本轮交付边界

实现独立管理员登录、CSDN 登录状态检查、文字 Markdown 草稿任务、持久队列、任务详情和日志。仅支持一个 CSDN 账号，公开发布和其他平台均不开放；CMS 连接、图片上传及生产远程登录入口继续待实施。正式运行只需 Go、PostgreSQL 和 Node.js/Playwright，不启动 Agent 或调用大模型。

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

- kind 为 save_draft 或 check_account；后者由账号检查接口创建。
- status 为 queued、running、waiting_user、reconciling、succeeded、failed、cancelled。
- outcome 为 not_submitted、draft_saved 或 unknown；任务成功不表示文章已公开。
- run_mode 为 execute 或 reconcile；核对只读，不调用填稿或新建。
- stage 使用 queued、checking_login、opening_editor、draft_acquired、filling、saving、verifying、finished 等稳定英文标识，界面显示中文。
- remote_id 仅接受数字；remote_url 由服务端根据固定 CSDN 域名与 ID 生成，不接受任意网址。
- attempts 记录所有领取次数；retry_count 与 max_retries 单独控制安全网络重试，最多 3 次，自动与手动重试共用预算，退避 5、20、60 秒。登录恢复和只读核对不占该预算。登录问题等待人工处理，不重复登录。核对使用独立读取预算；draft_absent 表示一次完整空结果，draft_conflict 表示重复或残稿，reconcile_unavailable 表示查询失败，reconcile_exhausted 表示自动读取预算耗尽。

日志字段：id、job_id、attempt、level、stage、message、created_at。level 为 info、warning、error。事件消息采用固定描述和受限摘要，不包含密码、令牌、Cookie、正文或完整页面；前端按纯文本展示。

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
| WORKER_HEADLESS | 默认 true；人工登录由单独助手在验证主机完成 |
| ADMIN_DIST_DIR | 可选后台构建产物目录，由 API 提供同站点访问 |

本轮提供独立本地数据库、初始化、启动、测试和停止入口。运行数据、密钥、登录状态和诊断文件不写入 Git。数据库日志保留和任务内容清理遵循有限期限，不清理正在执行或待核对任务所需的内容。
