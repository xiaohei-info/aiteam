# cc-haha 对话模块：流程图与通俗讲解

> 仅聚焦对话模块（conversation module），以流程图 + 白话解释每个功能分类的实现思路。

---

## 第一部分：整体流程——一条消息的旅程

```mermaid
flowchart TD
    A[👤 用户输入一条消息] --> B[query 入口函数]
    B --> C{需要压缩上下文？}
    C -->|是| D[autocompact / microcompact]
    C -->|否| E[queryModelWithStreaming]
    D --> E
    E --> F[预处理消息]
    F --> G[构建请求参数]
    G --> H[选择 API Provider]
    H --> I[发起流式 HTTP 请求]
    I --> J{收到响应流}
    J -->|正常 chunk| K[解析 & 转发给 UI]
    J -->|超时/断连| L[Watchdog 检测]
    L --> M[fallback 非流式重试]
    K --> N{stop_reason?}
    N -->|tool_use| O[执行工具调用]
    O --> B
    N -->|end_turn| P[✅ 对话轮次结束]
```

**通俗理解**：就像你发了一封信（消息），邮局（query）先检查信封重量（上下文长度），太重就先压缩，然后把信投进不同的邮政系统（Provider），收到回信后一段一段地实时念给你听（流式），如果中途断了就换普通信件（非流式 fallback）重发。

**对应代码位置**：
- 入口：`src/query/deps.ts` — `QueryDeps.callModel`
- 流式函数：`src/services/api/claude.ts:757` — `queryModelWithStreaming`
- 核心私有函数：`src/services/api/claude.ts:1022` — `queryModel`

---

## 第二部分：消息预处理——发出去之前做了什么

```mermaid
flowchart LR
    RAW[原始消息列表] --> A

    subgraph 清理阶段
        A[标准化格式\nnormalizeMessagesForAPI] --> B
        B[修复 tool 配对错误\nensureToolResultPairing] --> C
        C[移除无效块\nstrip*]
    end

    subgraph 优化阶段
        C --> D[注入 Prompt Cache 标记\naddCacheBreakpoints]
        D --> E[限制媒体数量 ≤100\nstripExcessMediaItems]
    end

    E --> FINAL[✅ 准备好的 messagesForAPI]
```

**通俗理解**：类似发邮件前的自动检查——检查格式、修掉不完整的引用、删掉多余的附件，最后打上"可缓存"标签省钱。

**七道处理工序**：

| 序号 | 函数 | 作用 |
|---|---|---|
| 1 | `normalizeMessagesForAPI` | 统一消息格式，合并相邻同类块 |
| 2 | `stripToolReferenceBlocks...` | 非 tool search 模式下移除 tool_reference 块 |
| 3 | `stripCallerField...` | 移除 tool_use 的 caller 字段 |
| 4 | `ensureToolResultPairing` | 修复孤立的 tool_use / tool_result（断点续传场景） |
| 5 | `stripAdvisorBlocks` | 无 advisor beta 时移除 advisor 块 |
| 6 | `stripExcessMediaItems` | 媒体项超 100 个时静默删最旧的（API 硬限制） |
| 7 | `addCacheBreakpoints` | 注入 prompt cache 控制标记（降低 API 费用） |

---

## 第三部分：API Provider 选择——走哪条路

```mermaid
flowchart TD
    START[getAnthropicClient 被调用] --> B1{USE_BEDROCK?}
    B1 -->|是| C1[AnthropicBedrock\nAWS 签名认证]
    B1 -->|否| B2{USE_VERTEX?}
    B2 -->|是| C2[AnthropicVertex\nGoogle OAuth]
    B2 -->|否| B3{USE_FOUNDRY?}
    B3 -->|是| C3[AnthropicFoundry\nAzure AD Token]
    B3 -->|否| B4{claude.ai 订阅？}
    B4 -->|是| C4[Anthropic SDK\nauthToken = OAuth Token]
    B4 -->|否| C5[Anthropic SDK\napiKey = API Key]

    C1 & C2 & C3 & C4 & C5 --> WRAP[buildFetch 包装\n注入追踪 header\n签名请求体]
    WRAP --> SEND[发出请求]
```

**通俗理解**：就像打车选平台——滴滴/优步/高德都能到目的地，但登录方式不同。无论走哪条路，最后都会给请求加上"快递单号"（x-client-request-id）方便查问题。

`buildFetch` 做的两件事：
1. 注入 `x-client-request-id`：每次请求生成唯一 UUID，超时时没有服务端 request-id 也能关联日志
2. `signClaudeCodeCCHBody`：对请求体签名，防止滥用

---

## 第四部分：流式响应处理——接收回信

```mermaid
flowchart TD
    REQ[anthropic.beta.messages.create\nstream: true] --> STREAM[获得事件流]

    STREAM --> WD[启动 Watchdog 计时器]
    STREAM --> LOOP{读取下一个 chunk}

    LOOP --> |text_delta| TXT[拼接文字，实时显示]
    LOOP --> |input_json_delta| TOOL[拼接工具参数 JSON]
    LOOP --> |thinking_delta| THINK[积累思考内容]
    LOOP --> |message_stop| DONE[✅ 完成，释放连接]

    TXT & TOOL & THINK --> RESET[重置 Idle 计时器]
    RESET --> LOOP

    WD -->|90秒无 chunk| ABORT[abort stream]
    ABORT --> FALLBACK[非流式 fallback]
    FALLBACK --> NONSTREAM[create stream: false\n超时 300s]
```

**通俗理解**：就像收广播——每收到一个字就立刻显示，同时有个"看门狗"计时器，如果超过 90 秒没收到任何内容，就断开重连，改用"一次性发完"的方式。

**为什么不用 `BetaMessageStream`**：官方 SDK 的高层封装会对每个 `input_json_delta` 调用 `partialParse()`，当工具参数很长时产生 O(n²) 性能问题。cc-haha 改用底层 `.create({ stream: true })` 自行积累 tool input，性能更好。

**Watchdog 两个计时器**：

| 计时器 | 是否被 chunk 重置 | 目的 |
|---|---|---|
| Idle timer（默认 90s） | 是 | 检测连接静默挂起 |
| Max duration timer（默认禁用） | 否 | 防止服务端一直发小 delta 永不结束 |

---

## 第五部分：Beta Headers——功能开关机制

```mermaid
flowchart LR
    subgraph 会话级 latch（一旦开启本会话内不变）
        L1[Fast Mode]
        L2[Cache Editing]
        L3[AFK / Auto Mode]
    end

    subgraph 每次请求动态判断
        D1[Prompt Caching]
        D2[Tool Search]
        D3[Structured Outputs]
        D4[Extended Thinking]
    end

    L1 & L2 & L3 & D1 & D2 & D3 & D4 --> BETAS[betas: betasParams\n发送给 API]
```

**通俗理解**：Beta Headers 是给服务端的"功能开关暗号"。

- **latch 类**：一旦打开就不能在本次会话里关掉——因为关掉会导致服务端的 prompt cache key 变化，让已缓存的内容全部失效，用户等待时间变长。
- **动态类**：每次请求都根据当前状态重新判断，灵活可变。

---

## 第六部分：重试与降级策略

```mermaid
flowchart TD
    CALL[发出流式请求] --> ERR{出错了？}
    ERR -->|529 过载| BACKOFF[指数退避\n等待后重试]
    ERR -->|401 鉴权失败| REFRESH[刷新 Token\n重新 getClient]
    ERR -->|408/504 超时| RETRY[直接重试]
    ERR -->|流式中断| FALLBACK[切换非流式\nexecuteNonStreamingRequest]
    ERR -->|用户取消 AbortSignal| THROW[直接抛出，不重试]

    BACKOFF & REFRESH & RETRY --> CALL
    FALLBACK --> NSCALL[anthropic.beta.messages.create\nstream: false\n超时 300s / 远程 120s]
    NSCALL --> DONE[返回完整 BetaMessage]
```

**通俗理解**：遇到问题不同的处理方式——过载了就等等再试，身份过期了就先换证，超时了直接重来，流断了就换挂号信，用户自己取消了就停下来。

---

## 功能分类汇总

| 分类 | 核心文件 | 作用 |
|---|---|---|
| 入口调度 | `src/query/deps.ts` | 依赖注入，组织调用顺序 |
| 消息预处理 | `claude.ts` 内部 | 清理、修复、优化消息列表 |
| 客户端创建 | `services/api/client.ts` | 多 Provider 工厂 + 鉴权 |
| 请求参数构建 | `claude.ts: paramsFromContext` | 动态组装 API 参数 |
| 实际 API 调用 | `claude.ts: queryModel L1889` | `anthropic.beta.messages.create` |
| 流式处理 | `claude.ts` 内部 | chunk 解析 + watchdog |
| 重试降级 | `services/api/withRetry.ts` | 错误分类 + 重试策略 |
| 上下文压缩 | `services/compact/*` | 防止超出 context 窗口 |
