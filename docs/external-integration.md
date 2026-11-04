# 外部系统接入

## 当前范围

PostBridge 已提供注册审批、签名身份、目标能力查询、平台稿预览确认、父分发记录和来源事件处理。当前执行能力只有 CSDN 文字 Markdown 保存草稿；公开发布、图片、MDX、其他平台均未开放；平台文章的自动更新、自动撤回及已有外站副本的显式再次新建仍属后续能力。保存平台草稿不代表文章已公开，来源撤回也不代表自动删除或撤回平台文章。

本文对应 [OpenAPI 契约](../contracts/cms.openapi.yaml)。接口与模型以[注册实现](../apps/api/integration_registry.go)、[内容路由](../apps/api/integration_content_http.go)、[内容模型](../apps/api/integration_content.go)和[反向来源校验](../apps/api/integration_source.go)为依据。PostBridge 侧实现、调用方 CMS 实现、真实平台端到端和生产验收分别记录；调用方 CMS 与生产接入仍待验证。

## 双向身份与职责

| 事项 | 负责方 |
| --- | --- |
| 来源文章发布、内容版本、授权和状态序列 | 调用方 CMS |
| 文章状态变更与待发送事件在同一数据库事务提交 | 调用方 CMS |
| 事务发件箱、稳定事件标识、失败补发及有界退避 | 调用方 CMS |
| 向 PostBridge 申请身份并安全保管一次性密钥 | 调用方 |
| 向 PostBridge 签发独立反向调用身份和密钥 | 调用方来源服务 |
| 提供权威文章分发状态接口 | 调用方来源服务 |
| 邀请、审批、账号与操作授权、管理员确认 | PostBridge 管理员 |
| 平台稿修订、来源核验、排队及状态查询 | PostBridge |
| 外部 CMS、真实账号及生产环境端到端验收 | 双方共同完成，当前未验收 |

调用方到 PostBridge 与 PostBridge 到来源服务使用两套身份及密钥，不能混用。反向注册的具体流程由来源服务实现；本仓库没有替调用方实现反向注册服务，也不会自动创建调用方的数据库事务或发件箱。

服务通过独立的 INTEGRATION_MASTER_KEY_FILE 读取 32 字节密钥的十六进制文本，PUBLIC_ORIGIN 必须为 HTTPS；INTEGRATION_ENVIRONMENT 与 INTEGRATION_SERVICE_ID 单独配置，不从 worker 身份或密钥推导。服务配置中的 master_key 是 PostBridge 用于加密保存密钥的存储密钥，不是发给调用方的 client_secret。审批与轮换返回的 client_secret，以及来源服务签发后写入 source_secret 的反向密钥，均是标准 Base64 编码的随机 32 字节密钥；HMAC 使用 Base64 解码后的字节。

## 注册、审批与激活

1. 管理员创建邀请，限制来源、运行环境、scope、目标账号、操作、有效期和每分钟请求量。邀请最多有效 24 小时，应用有效期最多 366 天，请求上限为每分钟 1 至 600 次。
2. 调用方通过注册接口提交申请，X-Integration-Invitation 头携带一次性邀请。该步骤不使用应用签名；来源与环境必须匹配邀请，申请权限不能超出邀请。
3. 管理员审批申请，校验来源地址及反向身份配置。批准后返回 client_id、key_id、client_secret 和 pending_activation 状态；密钥只返回一次。
4. 调用方使用待激活密钥为激活接口签名。成功后应用和新密钥启用，返回 active；未激活密钥不能调用内容接口。
5. 管理员轮换时生成另一把待激活密钥。新密钥激活后，原启用密钥进入最多十分钟交接期；调用方应及时切换。暂停与撤销会阻止后续业务访问。

注册请求字段为 name、environment、source_id、scopes、accounts、operations、source_url。source_url 必须是无用户信息、无业务路径、无查询及片段的 HTTPS 公网根地址，使用默认 HTTPS 端口。反向访问不接受重定向、私网地址或混合公网与受限地址的 DNS 结果。

邀请令牌使用一次后即消费。注册响应丢失时，请管理员核对已有申请，不能假定重新提交邀请能够再次取得同一结果。申请审批后的密钥通过安全方式交付，列表和详情均不提供密钥查询。一次性内容不要放入地址、日志、截图、前端持久存储或仓库。

### 管理员接口

这些接口使用独立管理员会话；写操作同时需要 X-CSRF-Token 以及与部署 origin 一致的 Origin。调用方签名不能替代管理员会话。

| 方法与路径 | 用途 |
| --- | --- |
| GET /api/integration-invitations | 最近 100 条邀请，不含令牌 |
| POST /api/integration-invitations | 创建一次性邀请 |
| GET /api/integration-registrations | 最近 100 条申请 |
| POST /api/integration-registrations/{id}/approve | 审批并一次签发密钥 |
| POST /api/integration-registrations/{id}/reject | 拒绝待审批申请 |
| GET /api/integration-clients | 最近 100 个应用 |
| GET、PUT /api/integration-clients/{id} | 查看、更新应用与反向来源配置 |
| POST /api/integration-clients/{id}/rotate | 一次签发待激活的新密钥 |
| POST /api/integration-clients/{id}/suspend | 暂停应用 |
| POST /api/integration-clients/{id}/resume | 启用已暂停应用 |
| POST /api/integration-clients/{id}/revoke | 撤销应用 |
| GET /api/integration-audit | 最近 100 条审计，可按 client_id 筛选 |

邀请创建字段为 source_id、environment、scopes、accounts、operations、expires_at、client_expires_at、rate_limit_per_minute。审批与更新字段为 scopes、accounts、operations、expires_at、rate_limit_per_minute，以及下表中的反向来源配置；source_id 可在更新时指定，审批时仍受邀请来源限制。

| 字段 | 含义 |
| --- | --- |
| source_url | 来源服务 HTTPS 公网根地址 |
| source_client_id | 来源服务向 PostBridge 签发的反向客户端标识 |
| source_key_id | 反向密钥标识 |
| source_service_id | 反向请求的目标服务标识 |
| source_environment | 反向请求的运行环境 |
| source_secret | 来源服务签发的独立反向密钥，仅写入；空值保留现有密钥 |

四个反向身份字段只要填写任意一项，就必须全部有效。更新授权会改变 grant_version，原平台稿确认不能绕过授权变化。权限 DTO 允许的 publish 是保留数据值，不能据此认定执行能力支持公开发布；当前只应申请 save_draft。

## 签名协议

[签名实现](../apps/api/integration_signature.go)采用 RFC 9421 的固定 HMAC-SHA256 profile，不接受任意字段组合或参数重排。可直接对照[共享签名与内容指纹向量](../tests/fixtures/integration-contract.json)校验跨语言实现；该文件是合成测试数据，包含的密钥只供自测。Go 校验见[共享契约用例](../apps/api/integration_contract_test.go)，签名边界见[签名固定用例](../apps/api/integration_signature_test.go)。

| 项目 | 要求 |
| --- | --- |
| 协议 | HTTPS，目标 Host 与配置的接收服务 origin 一致 |
| 签名标签与算法 | sig1；hmac-sha256 |
| 必需且唯一的头 | Content-Digest、X-Integration-Client、X-Integration-Environment、X-Integration-Service、Signature-Input、Signature |
| 覆盖字段顺序 | @method、@target-uri、content-digest、x-integration-client、x-integration-environment、x-integration-service |
| Signature-Input 参数顺序 | created、keyid、nonce、alg，格式及空格严格匹配实现 |
| created | Unix 秒，与服务端时间偏差不超过正负 300 秒 |
| keyid 与身份标识 | 1 至 128 个英文字母、数字、下划线或连字符 |
| nonce | 每次请求新生成，16 至 128 个英文字母、数字、下划线或连字符 |
| 重放保护 | 按 client_id、key_id、nonce 组合检查，服务端保留 601 秒 |
| 请求正文 | 原始请求字节，最多 1 MiB；GET 也必须为实际空正文生成摘要 |
| Content-Digest | 对原始正文做 SHA-256，以标准 Base64 编码并使用实现规定的结构化字段格式 |
| Signature | 对签名基串做 HMAC-SHA256，以标准 Base64 编码并使用 sig1 的字节序列格式 |

签名基串按覆盖字段顺序逐行组成，最后追加 @signature-params；行之间使用 LF，末尾不追加换行。请求方法使用实际方法；@target-uri 使用完整 HTTPS origin 加原始 RequestURI，包含原始查询顺序和编码。签名完成后不要重新排列查询、改变正文空白或更换序列化方式。

重试时使用新的 created、nonce 和签名，业务 request_id 或 event_id 保持稳定。固定分钟窗口先对业务请求和激活请求执行共享前置限流：全局每分钟 2400 次，每个连接来源 IP 每分钟 600 次；之后仍独立检查审批给应用的每分钟 1 至 600 次配额。多个实例共享 PostgreSQL 计数。来源按连接地址判断，不信任 X-Forwarded-For；经同一反向代理连接的调用方可能共享每 IP 配额。注册限流另外为全局每分钟 120 次、每个连接来源 IP 10 次、每个邀请令牌 10 次。超出前置限流后不逐请求写入拒绝审计，计数保持有界。429 的 Retry-After 为 60 秒。管理员接口不使用此应用签名协议。

## 权限与外部路由

| 方法与路径 | 必需权限 | 返回 |
| --- | --- | --- |
| POST /api/integrations/v1/registrations | 一次性邀请 | registration_id、pending |
| POST /api/integrations/v1/clients/self/activate | 待激活密钥签名 | active |
| GET /api/integrations/v1/targets | targets:read | 当前授权可用目标的 items |
| POST /api/integrations/v1/preparations | preparations:write | 首次 201；相同请求 200 |
| GET /api/integrations/v1/preparations/{id} | preparations:read | 平台稿、修订及确认结果 |
| POST /api/integrations/v1/distributions | distributions:write | 首次接受 202；相同请求 200 |
| GET /api/integrations/v1/distributions/{id} | distributions:read | 父分发与子任务状态 |
| GET /api/integrations/v1/distributions | distributions:read | 通过 request_id 查询一个原分发结果 |
| POST /api/integrations/v1/source-events | source-events:write | received、applied |

scope、accounts、operations 共同生效。targets 只返回当前账号与操作授权允许的能力；调用方应读取返回的 account_id，而不是传入真实平台用户名。当前恰好一个目标，platform 为 csdn、operation 为 save_draft、body_formats 只有 markdown、images 为 false；标题为 5 至 100 个 Unicode 字符，正文非空且最多 200000 个字符。

接入未配置时，外部接入接口返回 503、integration_disabled；管理员入口仍先校验管理员会话。管理员应完成服务配置后再签发邀请。时间字段使用 RFC 3339；版本和序列使用正整数，不使用浮点数或字符串代替。

## 原稿到已确认平台稿

调用方只允许为已发布且当前授权有效的来源文章发起分发。准备请求携带 request_id、source_id、article_id、source_version、state_seq、authorization_id、authorization_expires_at、content_fingerprint、snapshot 和 targets。source_id 必须与调用身份绑定的来源一致。

snapshot 保存 title、summary、body、body_format、tags、cover_image_url、assets 和可选 original_url。当前 body_format 必须为 markdown，cover_image_url 为空、assets 为空数组。正文不接受图片、HTML、MDX、代码围栏之外的花括号或 import/export；代码围栏中的代码样例可以保留。摘要最多 2000 字符，标签最多 20 个，每个标签非空且最多 64 字符。详情不得被当作公开内容接口，服务端过期或保留期清理后正文可以为空。

准备稿有效期不超过创建后 24 小时，也不会晚于来源授权到期时间。调用方打开返回的 preview_url，由管理员登录 PostBridge 核对来源原稿、平台稿和目标账号。预览页不是外部签名调用的确认接口。

| 管理员方法与路径 | 行为 |
| --- | --- |
| GET /api/integration-preparations | 分页摘要，支持 status；不返回正文和平台稿内容 |
| GET /api/integration-preparations/{id} | 完整受保护详情 |
| PUT /api/integration-preparations/{id} | 用当前 revision 和各 draft.id 保存新修订 |
| POST /api/integration-preparations/{id}/confirm | 用当前 revision 确认 |
| POST /api/integration-preparations/{id}/revoke | 撤销未提交稿件 |

保存后生成新 revision 和 draft_revision_ids，并取消旧确认。确认返回 confirmed、confirmation_fingerprint、draft_revision_ids、targets 和当前来源标识信息。调用方必须重新读取已确认结果，将 preparation_id、draft_revision_ids、confirmation_fingerprint、content_fingerprint 与 targets 原样透传提交；不要重新生成确认指纹，也不要用原稿重新覆盖管理员确认后的平台稿。已提交稿件不可编辑。

### 内容指纹

内容指纹是下列有序 JSON 数组的 UTF-8 字节 SHA-256，输出小写十六进制。字段顺序严格固定：

| 位置 | 值 |
| --- | --- |
| 1 | postbridge-content-v1 |
| 2 | title |
| 3 | summary |
| 4 | body |
| 5 | body_format |
| 6 | tags |
| 7 | cover_image_url |
| 8 | assets |

计算前对 title 去除首尾空白，将 body 的 CRLF 和 CR 统一为 LF；缺失或空指针的 tags、assets 统一为空数组。其余字符串、标签顺序和数组顺序保持不变，不做 Unicode 归一化。original_url 只供展示，不参与内容指纹。

JSON 使用紧凑格式，不转义中文，不额外转义 HTML 字符，保留 JSON 必需的字符串转义，末尾无换行。Go 编码器对 Unicode 行分隔符的处理也应与[指纹实现和用例](../apps/api/integration_content_test.go)一致。assets 当前为空；其保留对象字段顺序为 id、checksum。

### 确认指纹

确认指纹由服务端生成，外部系统只透传。核对实现时，其有序数组为 postbridge-confirmation-v1、准备稿 id、revision、content_fingerprint、targets、drafts、grant_version。

targets 每个对象的字段顺序为 platform、account_id、operation；drafts 每个对象的字段顺序为 id、platform、account_id、operation、title、markdown、revision。数组顺序保持不变。确认绑定的是平台稿修订和当前授权版本，内容指纹仍标识来源原稿，二者不能互换。

## 调用方来源状态接口

调用方必须自行实现 GET /api/v1/integrations/postbridge/articles/{article_id}/distribution-state，并先为 PostBridge 完成反向身份注册和独立授权。OpenAPI 的 x-caller-contract 仅描述调用方应实现的接口，不是 PostBridge 提供的服务路由。

PostBridge 在提交和关键外站写入阶段使用反向身份签名请求。查询参数为 authorization_id、preparation_id、account_id、operation；当前 operation 只会是 save_draft。来源服务必须从自己的权威存储重新判断当前文章、授权与目标，不依赖调用者自报状态或尚未送达的发件箱缓存。

响应必须为 HTTP 200 和 application/json，包含下列全部九个字段。禁止额外字段、重复字段、null、尾随第二个 JSON 值；类型严格匹配。完整响应样例定位到[来源状态 fixture](../apps/api/integration_source_test.go)，本文不复制接口代码。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| article_id | 字符串 | 当前文章标识，必须匹配请求文章 |
| source_version | 正整数 | 当前内容版本 |
| state_seq | 正整数 | 当前来源状态序列，不低于 PostBridge 要求的序列 |
| status | 字符串 | draft、published、private、deleted 之一 |
| content_fingerprint | 字符串 | 当前原稿的内容指纹 |
| authorization_valid | 布尔值 | 当前分发授权仍有效 |
| allowed | 布尔值 | 当前请求的文章、准备稿、账号和操作允许执行 |
| accounts | 字符串数组 | 当前授权允许的目标账号，不能为 null |
| operations | 字符串数组 | 当前授权允许的操作，不能为 null |

允许执行必须同时满足 published、内容指纹一致、来源序列不倒退、authorization_valid 与 allowed 为真，以及目标账号和 save_draft 均在允许列表。提交时还检查返回 source_version 不低于请求版本。

反向请求总时限为 3 秒，响应正文上限为 64 KiB；不发送管理员会话或平台 Cookie，要求不缓存。重定向、非 JSON、超限、超时、DNS 或证书失败按不可确认处理，不能默认允许。来源暂时不可用时任务不继续写入；已经进入外站操作且结果未知的任务转为只读核对，不能盲目再次保存。

## 来源事件与事务发件箱

CMS 必须在同一事务中提交文章变化、source_version 或 state_seq 变化和待发送事件。事务成功后由发件箱独立投递，不应在事务未提交前通知 PostBridge。每个文章的 state_seq 对所有会影响分发的状态变化单调递增；event_id 在同一业务事件的所有重投中保持不变。

| type | status 与授权要求 |
| --- | --- |
| published | status 为 published，authorization_valid 为真，带 64 字符内容指纹 |
| updated | status 为 draft 或 published，带 64 字符内容指纹 |
| unpublished | status 为 draft，authorization_valid 为假 |
| private | status 为 private，authorization_valid 为假 |
| deleted | status 为 deleted，authorization_valid 为假 |
| authorization_revoked | 必填 authorization_id，authorization_valid 为假，只撤销指定授权 |

事件通用字段为 event_id、source_id、article_id、state_seq、source_version、type、status、authorization_valid；content_fingerprint 按事件含义携带，authorization_revoked 必须带有效 authorization_id。已撤销授权不能通过后续事件重用；新的授权必须使用新的授权标识。每次重新投递生成新的签名与 nonce，事件字段保持一致。

相同 event_id 与相同内容返回 received 为真、applied 为假；同标识不同内容会冲突。文章级事件的同一 state_seq 若表达相同实际状态，即使 event_id 不同也可忽略；只有同序列实际状态不同才返回 409。比较字段为来源、文章、序列、内容版本、status、authorization_valid 和 content_fingerprint，不以 event_id 或事件类型本身判断。旧序列接收后不回退已知文章状态；授权撤销单独记录对应授权。撤回、转私密和删除作用于整篇来源文章；撤销授权只作用指定 authorization_id，不影响同一文章其他授权。授权撤销和内容改变会使对应旧确认失效，并阻止后续写入；已发生外站操作时保留未知结果并核对，不删除平台内容。

## 提交、查询与恢复

提交请求使用独立稳定 request_id，并携带 source_id、article_id、source_version、state_seq、content_fingerprint、preparation_id、draft_revision_ids、confirmation_fingerprint 和 targets。PostBridge 校验管理员确认、当前授权版本和反向来源状态，在同一事务中创建父分发与子任务。

202 只表示进入队列。调用方保存返回父分发 id，查询 status、children、external_status、outcome 和最后核对时间。父状态为 in_progress、needs_attention 或 completed；completed 不是公开发布状态。子任务的 external_status 分别为 not_submitted、draft_saved、unknown，不得用 succeeded 推断公开可见。

网络中断或结果未知时，先以原 request_id 查询分发接口；必要时用同一请求内容重投，不能换 request_id 或 preparation_id 来尝试绕过重复保护。已有外站副作用、未知结果、remote_id、有效租约或普通排队任务时拒绝再创建分发，不支持对已有外站副本显式再次新建。只有服务端证明旧任务从未发生外站写入、无远端标识及有效租约，并且旧任务已取消或因来源守卫暂停时，用户才可取得当前有效授权、重新预览并确认后提交新的分发。提交成功时，来源守卫暂停的未写入旧任务会取消、清除正文并保留记录；这不是对未知结果盲目重试。

| 管理员方法与路径 | 行为 |
| --- | --- |
| GET /api/integration-distributions | 按状态分页读取父任务 |
| GET /api/integration-distributions/{id} | 查看子任务、平台状态与处理入口 |
| POST /api/integration-distributions/{id}/resume | 重新核对来源与授权后恢复原任务 |

分页参数为 page、page_size，默认每页 50 条，上限 100 条。应用、邀请、申请与审计列表是最近 100 条的 items，不使用该分页包装。

管理员仅在 resume_allowed 为真时提供恢复操作，提交原 confirmation_fingerprint，服务端仍重新检查来源、授权及有效租约；原冻结正文已不存在时返回 410，必须重新准备和确认，不能恢复空稿。unknown 或 reconciling 的任务保持核对流程，不通过通用重试再保存一次。调用方身份没有直接确认、编辑或恢复管理员任务的接口。

## 错误与重试

错误 JSON 包含 code 和 message，不能只按消息文本判断。注册和业务路由的具体响应见 OpenAPI。

| HTTP 与 code | 调用方处理 |
| --- | --- |
| 400 invalid_request | 修正字段、JSON、时间或范围，不原样循环重试 |
| 401 unauthorized | 核对身份、激活状态、密钥、时钟、摘要、nonce 和签名 |
| 403 forbidden | 核对 scope、账号、操作及邀请上限 |
| 403 csrf_failed | 管理员重新读取会话与请求验证信息 |
| 404 not_found | 核对对象归属与标识，不能据此重新发文 |
| 409 conflict | 核对稳定标识、请求内容、当前修订及授权版本 |
| 409 client_unavailable | 管理员会话仍有效，核对接入应用状态与授权，不误判为管理员退出 |
| 409 source_changed | 重新确认来源内容和当前授权 |
| 410 preparation_expired | 旧平台稿不可继续使用；先核对已有分发，再按当前来源重新准备 |
| 413 request_too_large | 减少请求正文到 1 MiB 以内 |
| 422 unsupported_content | 移除不支持的内容或目标，不自动降级为其他平台/公开发布 |
| 429 rate_limited | 按 Retry-After 有界退避，保持业务稳定标识 |
| 503 source_unavailable | 修复来源服务后再核对，不将不可用视为允许 |
| 503 integration_disabled | 由管理员完成 PostBridge 接入配置 |
| 500 internal_error | 保留业务标识，先查询原结果再有界重投 |

## 接入验收

调用方至少覆盖签名固定用例、过期与重复 nonce、审批与激活、权限收紧、密钥交接、准备稿修订并发、旧确认拒绝、提交响应丢失、重复与乱序事件、来源撤回、反向超时和未知外站结果。PostBridge 本地测试和合成界面检查不能替代真实调用方与真实平台验收。

联调时只使用独立本地私有配置与合成材料；实际地址、账号、凭据和运行目录不进入仓库。提交前确认调用方事务与发件箱、来源状态服务、反向身份注册、真实平台草稿和生产部署都已分别验证；当前这些跨系统验收仍待完成。
