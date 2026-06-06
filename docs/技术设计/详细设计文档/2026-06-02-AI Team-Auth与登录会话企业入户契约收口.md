---
created: 2026-06-02
updated: 2026-06-02
status: ready-for-development-review
stage: phase2-contract-freeze
canonical_name: 2026-06-02-AI Team-Auth与登录会话企业入户契约收口
source_docs:
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-06-02-AI Team-Phase2共享契约与架构冻结说明.md
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-05-28-AI Team-共享运行口径定稿版.md
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-05-27-AI Team-Team Panel领域模型与数据架构详细设计.md
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-05-27-AI Team-前端页面与接口契约详细设计.md
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-05-28-AI Team-Team Panel内部服务与聚合视图详细设计.md
  - /home/ubuntu/code/aiteam/AGENTS.md
supersedes:
  - (对现有auth/session/enterprise-entrance相关分散描述的收口和具体化)
---

# AI Team Auth 与登录会话企业入户契约收口

## 1. 文档定位

本文是 Phase 2 开发启动前对 **认证、会话、企业入户入口** 子系统的契约统一收口。目的只有一个：让后续 P2-S14（backend auth）和 P2-S15（frontend auth）实现卡在实现 auth 相关逻辑时，无需再跨多份文档自行拼凑 auth 语义。

本文不新建架构，只对以下已在设计体系中出现但未统一收口的 auth 表面做正式冻结：

1. 登录 provider seam（微信扫码 / 手机号验证码 + mock provider 替换路径）
2. Token 与会话生命周期（access token / refresh token / 设备上限 / 速率限制）
3. 企业入户入口（注册/邀请/加入/首次企业创建时的 redirect 逻辑）
4. auth 对象与 enterprise / membership / role 的关系
5. 安全与审计准入标准

若已有详细设计与本文冲突，auth 子系统一律以本文为准。

## 2. 方案调研与复用判断

### 2.1 已参考材料

- **Keycloak** (开源身份平台)：参考其 realm 级 brute force detection、session limits、offline token 管理、user session 生命周期模式
- **Auth.js / NextAuth** (开源身份库)：参考其 JWT session strategy、refresh token rotation、callback/redirect 模式
- **SuperTokens** (开源会话管理)：参考其 short-lived access token + long-lived refresh token 的 theft detection 模式、rate limiting 分层
- **Clerk / Stytch / Logto** (商业身份产品)：参考其 multi-provider 组织/邀请/onboarding redirect 模式

### 2.2 复用判断

| 来源 | 复用方式 | 说明 |
|------|----------|------|
| Keycloak session limits + brute force | 接口层借鉴 | V1 自建简化版 device 上限 + 登录频控，不引入 Keycloak 依赖 |
| Auth.js JWT refresh rotation | 选择性复用 | 复用 access/refresh token 双 token 模式，但 V1 只在服务端签发与校验，不暴露 refresh token 到浏览器 local storage |
| SuperTokens theft detection pattern | 选择性复用 | 借鉴 refresh token family + 重用检测，但 V1 简化：同一 refresh token 被使用两次则整族失效 |
| Clerk/Logto org onboarding redirect | 接口层借鉴 | 借鉴"登录后按企业状态决策 redirect"的通用模式，但 V1 仅做 PC Web 路径 |
| 商业 provider 全托管方案 | 明确不采用 | V1 不自建一套通用 IdP，也不引入外部 Auth SaaS 依赖 |

**结论**：V1 auth 采用自建轻量实现，取业内成熟的 token 双轮换 + refresh token family + 登录频控 + device 上限 + provider-neutral contract 路线，但不引入外部身份平台依赖。

## 3. auth provider seam 契约

### 3.1 总原则

- 登录/注册/会话恢复的统一契约发生在 Team Panel 层，不穿透到浏览器直接解析 provider 专有协议
- 提供两大业务入口：**微信扫码** 与 **手机号验证码**，但实际 provider 调用必须通过可插拔的 mock 层
- Phase 2 只冻结 provider-neutral contract，不接通真实微信开放平台 / 真实短信网关

### 3.2 provider-neutral 接口契约

#### POST /api/auth/login/wechat/init

```
请求: 无 (内部生成 state)
响应:
  {
    "state": "wx_abc123",
    "qr_url": "/mock/wechat-qr?state=wx_abc123",
    "expires_in": 300
  }
mock 行为：qr_url 指向本地 mock 页面，永远可扫
错误：
  - 429: 同 IP 超频
  - 503: mock provider 不可用 (不应出现在 prod 配置下)
```

#### GET /api/auth/login/wechat/poll?state=wx_abc123

```
响应 (pending):
  { "status": "pending" }

响应 (scanned):
  { "status": "scanned" }

响应 (confirmed — 用户在 mock 页面点了确认):
  {
    "status": "confirmed",
    "code": "mock_auth_code_wx_001"
  }

响应 (expired):
  { "status": "expired" }
```

#### POST /api/auth/login/wechat/callback

```
请求:
  {
    "state": "wx_abc123",
    "code": "mock_auth_code_wx_001"
  }
响应:
  {
    "wechat_union_id": "mock_union_abc",
    "wechat_open_id": "mock_open_abc",
    "nickname": "测试用户",
    "avatar_url": null,
    "is_new_user": true,
    "access_token": "eyJ...",
    "expires_in": 900
  }
Set-Cookie: refresh_token=rt_abc123...; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/refresh; Max-Age=604800
```

#### POST /api/auth/login/phone/send-code

```
请求:
  { "phone": "13800138000" }
响应:
  { "expires_in": 300 }
mock 行为：不真实发短信，日志输出 code
错误：
  - 429: 同一手机号 60s 冷却 / 同 IP 10次/min 超过阈值
```

#### POST /api/auth/login/phone/verify

```
请求:
  {
    "phone": "13800138000",
    "code": "888888"
  }
响应 (同 callback 形状):
  {
    "phone": "13800138000",
    "is_new_user": true,
    "access_token": "eyJ...",
    "expires_in": 900
  }
Set-Cookie: refresh_token=rt_abc456...; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/refresh; Max-Age=604800
mock 行为：code 固定为 "888888"
错误：
  - 400: 验证码错误或过期
  - 429: 验证尝试超频
```

### 3.3 provider seam 实现约束

- `/api/auth/login/*` 路由只暴露 provider-neutral contract，不暴露 `wechat_code` / `sms_send_id` 等实现细节
- provider 实现映射发生在 Team Panel application 层内部，通过一个 `AuthProviderRegistry` 按 `provider` 分发
- mock provider 与真实 provider 必须实现相同的 provider interface，只通过配置切换
- 所有 provider 调用的成功 / 失败 / 超时语义，mock provider 必须可稳定复现

## 4. token 与会话生命周期

### 4.1 双 token 模式

| Token | TTL | 存储位置 | 用途 |
|-------|-----|----------|------|
| access_token | 15 min | httpOnly cookie | API 鉴权 |
| refresh_token | 7 days | httpOnly cookie (path=/api/auth/refresh) | 无感刷新 access_token |

约束：

- refresh_token 不暴露给浏览器 JavaScript（不在响应 body 中返回，仅通过 `Set-Cookie` 下发 `HttpOnly; Secure; SameSite=Lax; Path=/api/auth/refresh` cookie）
- access_token 可用于响应 body 中返回前端以便页面组件读取用户身份，但响应中 `access_token` 字段为只读身份信息载体，API 鉴权仍以 cookie 为准
- 每次使用 refresh_token 换新 access_token 时，旧 refresh_token 立即失效，下发新 refresh_token（token rotation）
- 若一次 refresh_token 被重放（使用已失效的旧 refresh_token），该 token family 全部失效 → 用户必须重新登录

### 4.2 API

#### POST /api/auth/refresh

```
Cookie: refresh_token=rt_abc123
响应:
  {
    "access_token": "eyJ... (新)",
    "expires_in": 900
  }
Set-Cookie: refresh_token=rt_def456; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/refresh; Max-Age=604800
```

#### GET /api/me

```
Header: Authorization: Bearer eyJ... (access_token)
OR Cookie: access_token=eyJ...
响应 (企业成员):
  {
    "user_id": "usr_001",
    "nickname": "测试用户",
    "avatar_url": "...",
    "current_enterprise": {
      "enterprise_id": "ent_001",
      "name": "Acme AI Lab",
      "role": "owner"
    },
    "enterprises": [
      { "enterprise_id": "ent_001", "name": "Acme AI Lab", "role": "owner" },
      { "enterprise_id": "ent_002", "name": "Beta Corp", "role": "member" }
    ]
  }
响应 (未加入任何企业):
  {
    "user_id": "usr_003",
    "nickname": "新用户",
    "avatar_url": null,
    "current_enterprise": null,
    "enterprises": [],
    "onboarding": {
      "action": "create_or_join_enterprise"
    }
  }
```

### 4.3 access_token payload

```json
{
  "sub": "usr_001",
  "iat": 1717363200,
  "exp": 1717364100,
  "enterprise_id": "ent_001",
  "role": "owner",
  "jti": "at_jti_abc123"
}
```

约束：

- access_token 中不放 permission list，只放 role；permission 解析由 Team Panel 根据 `enterprise_id + role` 实时判断
- 不允许前端自解析 access_token 做权限判断；前端权限应以 `/api/me` 响应为准

### 4.4 登出

#### POST /api/auth/logout

```
行为：
- 清空 access_token cookie
- 清空 refresh_token cookie
- 当前 refresh_token 加入黑名单 (TTL = 原 refresh_token 剩余有效期)
- 该用户的所有 refresh_token family 可选批量失效 (如果前端传 all_devices=true)

请求 (可选):
  { "all_devices": true }
```

## 5. 设备管理

### 5.1 user_device 对象

```json
{
  "device_id": "dev_001",
  "user_id": "usr_001",
  "device_name": "Chrome / Windows",
  "last_ip": "203.0.113.1",
  "last_ua": "Mozilla/5.0 ...",
  "last_active_at": "2026-06-02T10:00:00Z",
  "created_at": "2026-05-28T09:00:00Z"
}
```

### 5.2 设备上限

- 默认每用户最多 **5 个活跃设备**
- 超限时：最早活跃的设备（按 `last_active_at` 排序）自动失效，其关联的 refresh_token 全部吊销
- 设备计数以 `user_id + 设备指纹 (device_id)` 为唯一键；相同浏览器只需对应一条 device 记录

### 5.3 设备管理接口

#### GET /api/me/devices

响应设备列表（名称、最后活跃时间、是否当前设备）。

#### DELETE /api/me/devices/{device_id}

吊销指定设备的全部 session。

## 6. 速率限制

### 6.1 分层限流

| 目标 | 窗口 | 限制 | 动作 |
|------|------|------|------|
| 登录尝试 (同 IP) | 1 min | 10 | 429 + Retry-After |
| 登录尝试 (同 phone/user) | 1 min | 5 | 429 |
| 验证码发送 (同 phone) | 60s | 1 | 429 + 冷却倒计时 |
| API 全局限流 (同 user) | 1 min | 120 | 429 |
| refresh token 使用 | 累计 | — | 重放 → 整 family 失效 |

### 6.2 实现方式

- V1 使用内存计数 + Redis (可选) 两层：内存用于低延迟，Redis 用于多进程一致性
- 若 Redis 不可用，降级为纯内存计数，日志告警

## 7. 企业入户入口

### 7.1 入户决策树

登录/注册成功后，按以下顺序决策 redirect 目标：

```
用户登录成功
  ├── is_new_user == true ?
  │     └── 进入企业创建/加入流程
  │           ├── 有邀请码? → 加入指定企业 → /app/workbench
  │           ├── 无邀请码? → 创建企业 → /app/workbench
  │           └── 加入/创建失败? → 重试或引导联系管理员
  ├── enterprises 为空?
  │     └── 同新用户：进入创建/加入流程
  ├── current_enterprise 存在?
  │     └── GET /api/enterprises/current 验证 (若被移除则切到 next enterprise)
  │           ├── 有效 → /app/workbench
  │           └── 无效 → 切入其他企业或创建/加入流程
  └── enterprises 不为空但无 current?
        └── 选择企业页面 → /app/workbench
```

### 7.2 企业创建

#### POST /api/auth/onboarding/create-enterprise

```
请求:
  {
    "name": "Acme AI Lab",
    "slug": "acme-ai-lab"  (可选，不传则自动生成)
  }
响应:
  {
    "enterprise_id": "ent_001",
    "name": "Acme AI Lab",
    "slug": "acme-ai-lab",
    "role": "owner"
  }
行为:
- 创建 enterprise 记录
- 创建 membership(user_id, role=owner, status=active)
- 更新 /api/me 的 current_enterprise
- 返回 201 + 新 access_token (含 enterprise_id)
```

### 7.3 邀请加入

#### POST /api/auth/onboarding/join-enterprise

```
请求:
  { "invite_code": "INV-abc123" }
响应:
  {
    "enterprise_id": "ent_002",
    "name": "Beta Corp",
    "role": "member"
  }
错误:
  - 404: 邀请码无效或已过期
  - 409: 已是该企业成员
```

### 7.4 邀请码管理 (企业后台)

#### POST /api/enterprise-admin/invites

```
请求:
  {
    "role": "member",
    "max_uses": 50,
    "expires_in_hours": 72
  }
响应:
  {
    "invite_id": "inv_001",
    "invite_code": "INV-abc123",
    "invite_url": "https://aiteam.example.com/join?code=INV-abc123",
    "expires_at": "2026-06-05T10:00:00Z"
  }
```

#### GET /api/enterprise-admin/invites

```
响应: 邀请码列表 (code, role, uses, max_uses, expires_at, status)
```

#### DELETE /api/enterprise-admin/invites/{invite_id}

```
响应: 204
行为: 使邀请码立即失效
```

## 8. auth 对象与 enterprise / membership / role 的关系

### 8.1 核心对象关系

```
UserProfile (user_id, nickname, avatar, phone, wechat_union_id)
  ├── 1:N UserDevice (device_id, user_id, ...)
  ├── 1:N RefreshTokenFamily (family_id, user_id, device_id, ...)
  │     └── 1:N RefreshToken (token_hash, family_id, ...)
  └── 1:N Membership (user_id, enterprise_id, role, status)
        └── Enterprise (enterprise_id, name, slug, ...)
```

### 8.2 新增数据库表

在 `2026-05-27-AI Team-Team Panel领域模型与数据架构详细设计.md` 已建模的 `enterprise`、`membership` 基础上，auth 子系统新增以下表：

#### 6.A user_profile

用途：用户身份主表（独立于 enterprise 存在）。

字段：

- `user_id` PK
- `nickname`
- `avatar_url` nullable
- `phone` nullable, UNIQUE (若绑定)
- `wechat_union_id` nullable, UNIQUE (若绑定)
- `created_from` enum(`wechat`,`phone`)
- `last_login_at` nullable
- `status` enum(`active`,`disabled`)
- 审计字段

索引：

- `uk_user_phone(phone)` where phone IS NOT NULL
- `uk_user_wechat(wechat_union_id)` where wechat_union_id IS NOT NULL
- `idx_user_status(status)`

#### 6.B user_device

用途：活跃设备记录与上限控制。

字段：

- `device_id` PK
- `user_id` FK -> user_profile
- `device_name`
- `device_fingerprint`
- `last_ip`
- `last_ua`
- `last_active_at`
- `created_at`

唯一键：

- `uk_device_user_fingerprint(user_id, device_fingerprint)`

索引：

- `idx_device_user_active(user_id, last_active_at)`

#### 6.C refresh_token_family

用途：refresh token rotation 的 family 根，用于整族吊销。

字段：

- `family_id` PK
- `user_id` FK -> user_profile
- `device_id` FK -> user_device
- `status` enum(`active`,`revoked`)
- `revoked_at` nullable
- `created_at`

索引：

- `idx_token_family_user(user_id)`
- `idx_token_family_device(device_id)`

#### 6.D refresh_token

用途：refresh token 哈希存储，不存明文。

字段：

- `token_hash` PK
- `family_id` FK -> refresh_token_family
- `replaces_token_hash` nullable
- `expires_at`
- `used_at` nullable
- `created_at`

索引：

- `idx_refresh_token_family(family_id)`

#### 6.E enterprise_invite

用途：企业邀请码管理。

字段：

- `invite_id` PK
- `enterprise_id` FK -> enterprise
- `invite_code` UNIQUE
- `role` enum(`enterprise_admin`,`finance_admin`,`member`)
- `created_by`
- `max_uses`
- `use_count` default 0
- `expires_at`
- `status` enum(`active`,`revoked`,`exhausted`,`expired`)
- 审计字段

索引：

- `uk_invite_code(invite_code)`
- `idx_invite_enterprise(enterprise_id, status)`

### 8.3 与 enterprise / membership / role 的映射

- `UserProfile` 不与 Hermes Profile 一一对应 — 它是自然人账户
- `Membership` 是 UserProfile 与 Enterprise 的关系，role 值仍使用定稿版枚举：`owner | enterprise_admin | finance_admin | member`
- 登录后的 `current_enterprise` 仅作为前端默认上下文的提示，真实鉴权依赖 `membership.role + enterprise_id` 判定
- 平台角色 `system_admin | system_operator` 不由 `membership` 表达，由独立平台鉴权机制支撑
- 用户可同时属于多个企业，但 `/api/me` 只返回一个 `current_enterprise`

### 8.4 手机号 / UnionID 唯一性

- 同一手机号只能绑定到一个 `user_profile`
- 同一微信 union_id 只能绑定到一个 `user_profile`
- 若新登录的 union_id 或 phone 已存在且绑定到不同企业，视为同一用户登录已有账号（合并路径，V1 不做自动合并，只提示已绑定）

## 9. 安全与审计准入标准

### 9.1 安全约束

| 约束 | 要求 |
|------|------|
| access_token 传输 | 仅 https 环境允许 cookie；API 调用时可用 Authorization header |
| refresh_token 传输 | 仅 httpOnly cookie，path=/api/auth/refresh |
| 密码学 | access_token 使用 HS256；refresh_token 使用 256-bit random |
| 防重放 | refresh_token rotation + 重放检测 |
| 防篡改 | access_token signature 验证（iat/exp/sub 校验） |
| 防 CSRF | SameSite=Lax cookie |
| 防 XSS | access_token 不落 localStorage；refresh_token httpOnly |
| 防暴力破解 | IP + user 双纬度限流 |
| 设备上限 | max 5 devices |
| 登出 | 立即清 cookie + refresh_token 黑名单 |

### 9.2 审计事件

以下事件必须写入 `audit_event`：

| event_type | actor_type | 触发时机 |
|------------|------------|----------|
| `user.login` | `user` | 登录成功 |
| `user.login_failed` | `system` | 登录失败（含原因：wrong_code, expired_code, rate_limited） |
| `user.logout` | `user` | 主动登出 |
| `user.token_refreshed` | `system` | refresh token 成功换新 |
| `user.token_revoked` | `system` | 重放检测触发整族吊销 |
| `user.device_limit_exceeded` | `system` | 设备超限 → 最旧设备被踢 |
| `enterprise.created` | `user` | 企业创建 |
| `enterprise.joined` | `user` | 通过邀请码加入企业 |
| `invite.created` | `user` | 管理员创建邀请码 |
| `invite.revoked` | `user` | 管理员吊销邀请码 |

### 9.3 审计 payload 最小要求

```json
{
  "user.login": {
    "provider": "wechat | phone",
    "device_id": "dev_001",
    "ip": "203.0.113.1",
    "is_new_user": true
  },
  "user.token_revoked": {
    "family_id": "fam_001",
    "reason": "replay_detected",
    "device_id": "dev_001",
    "ip": "203.0.113.2"
  }
}
```

### 9.4 准入 checklist

后端 auth 实现卡在提交 PR 前必须通过以下验证：

1. access_token 过期后 refresh 成功，旧 token 拒绝访问
2. refresh_token 重放导致整族吊销，该 device 被踢出
3. 同 IP 1min 内超过 10 次登录尝试返回 429
4. 验证码 60s 冷却生效
5. 第 6 台设备登录使最早设备 session 失效
6. `GET /api/me` 在无有效 token 下返回 401
7. 登录后若无企业，`/api/me` 返回 `onboarding.action = create_or_join_enterprise`
8. 创建企业后 `/api/me` 的 `current_enterprise` 立即更新
9. 邀请码用完/max_uses 达到后拒绝新加入
10. 所有 auth 关键操作有 audit_event 落库

## 10. 接口分组与路由

```
/api/auth/login/wechat/init       POST
/api/auth/login/wechat/poll       GET
/api/auth/login/wechat/callback   POST
/api/auth/login/phone/send-code   POST
/api/auth/login/phone/verify      POST
/api/auth/refresh                 POST
/api/auth/logout                  POST
/api/me                           GET
/api/me/devices                   GET
/api/me/devices/{device_id}       DELETE
/api/auth/onboarding/create-enterprise  POST
/api/auth/onboarding/join-enterprise    POST
/api/enterprise-admin/invites          GET, POST
/api/enterprise-admin/invites/{id}     DELETE
/api/enterprises/current          GET
```

## 11. 与其他设计文档的关系

### 11.1 与数据架构详细设计

- 本文新增 `user_profile`、`user_device`、`refresh_token_family`、`refresh_token`、`enterprise_invite` 五张表
- 不修改 `enterprise`、`membership`、`audit_event` 等已有表
- `membership` 表继续承担 `user_id → enterprise → role` 的映射，不新增 auth-specific 的 enterprise 关系表
- 数据库仍为 PostgreSQL，与领域模型详细设计选型一致

### 11.2 与前端页面与接口契约详细设计

- 本文为 P01 登录页提供完整的后端 API 定义（此前端设计只有一行聚合描述）
- 新增的 device/invite/onboarding 页面契约将在 P2-S15 中展开

### 11.3 与 Phase 2 共享契约与架构冻结说明

- 本文是 Phase 2 freeze doc (§4.2 Auth / identity、§7.2 Auth tests) 的具体落地
- 继承其 mock-first provider 原则、PC-only 原则
- auth 子系统的任何实现不得越过本文新增 provider（如真实微信/短信），也不得新增真实支付/外送链路

### 11.4 与共享运行口径定稿版

- 不修改已有事件协议、cursor format、Conversation/TeamRun 状态机、RunTimelineEvent 结构
- 新增 auth 内部审计事件（`user.login`、`user.token_revoked` 等）仅写入 `audit_event` 表，不接入 `run_event` 流

## 12. 已知限制与 Phase 2 非目标

| 限制 | 处理方式 |
|------|----------|
| 无第三方 OAuth（Google/GitHub） | Phase 2 不提供，统一留到 Phase 3 |
| 无 MFA | V1 不做短信/微信之外的二因素 |
| 无 SSO / SAML / OIDC | V1 不做，企业管理员手动管理成员 |
| 无密码登录 | V1 仅微信扫码 + 手机号验证码 |
| 无邮箱登录 | V1 不做 |
| 无用户自助注销 | V1 不做，留到 Phase 3 |
| 移动端 auth | 不在 Phase 2 范围 |

## 13. 验证方式

本文有效性不以"看起来合理"作为标准，而是以以下条件全部成立为准：

1. P2-S14 后端 auth 卡在实现时不需跨多份文档自行解释 token / session / rate limit
2. P2-S15 前端 auth 卡在实现时不需自行发明 cookie 读写逻辑
3. `/api/auth/*` 系列接口可在 mock provider 下跑通 10 条准入 checklist
4. 实现出的 auth 对象不新增任何 Phase 2 freeze doc 已禁止的角色/状态/事件

## 14. 实施建议

1. 数据层先建 `user_profile`、`user_device`、`refresh_token_family`、`refresh_token`、`enterprise_invite` 五张表
2. 实现 `AuthProviderRegistry` + mock WeChat / mock Phone provider
3. 实现 JWT 签发/校验中间件（access_token cookie + Authorization header 双通道）
4. 实现 refresh token rotation + 重放检测
5. 实现登录频控（内存 + 可选 Redis）
6. 实现设备管理 + 上限踢出
7. 实现企业入户 API（create/join/invites）
8. 补齐审计事件
