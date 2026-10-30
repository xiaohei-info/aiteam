# cc-haha API 调用层架构文档

## 概览

cc-haha（Claude Code 的开源版本）的 API 调用层负责将用户对话消息发送给 Anthropic 模型并处理响应流。整个调用链从 `query()` 入口函数出发，经过依赖注入层、流式包装层，最终落到 `anthropic.beta.messages.create()` 这个 SDK 调用。

---

## 调用链全景

```
query()
  │  (src/query/deps.ts — QueryDeps.callModel)
  ▼
queryModelWithStreaming()
  │  (src/services/api/claude.ts:757)
  ▼
withStreamingVCR(messages, fn)         ← VCR录制/回放包装（用于测试）
  │
  ▼
queryModel()                           ← 核心私有函数 (claude.ts:1022)
  │
  ├─ [azureOpenAI provider] → requestAzureOpenAI()
  │
  └─ [其他 provider] → withRetry(
         getClient = () => getAnthropicClient(...),
         fn = async (anthropic, attempt, context) => {
           anthropic.beta.messages
             .create({ ...params, stream: true }, { signal })
             .withResponse()
         }
       )
```

---

## 一、依赖注入层（query/deps.ts）

```typescript
export type QueryDeps = {
  callModel: typeof queryModelWithStreaming   // 主 API 调用
  microcompact: typeof microcompactMessages  // 上下文微压缩
  autocompact: typeof autoCompactIfNeeded    // 自动压缩
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
```

**设计意图**：通过依赖注入解耦实现，使测试可以直接 override deps 注入 mock，不再需要 spyOn 模块导入（6-8 个测试文件原来各自 spy 同一函数的问题）。

---

## 二、客户端创建层（services/api/client.ts）

### `getAnthropicClient()` — 多 Provider 工厂

根据环境变量决定实例化哪个 SDK 客户端：

| 环境变量 | Provider | SDK |
|---|---|---|
| `CLAUDE_CODE_USE_BEDROCK=1` | AWS Bedrock | `@anthropic-ai/bedrock-sdk` |
| `CLAUDE_CODE_USE_FOUNDRY=1` | Azure AI Foundry | `@anthropic-ai/foundry-sdk` |
| `CLAUDE_CODE_USE_VERTEX=1` | Google Vertex AI | `@anthropic-ai/vertex-sdk` |
| `API_PROVIDER=azureOpenAI` | Azure OpenAI | `azureOpenAI.ts` |
| (默认) | Anthropic 直连 | `@anthropic-ai/sdk` |

### 鉴权逻辑（默认直连模式）

```
鉴权优先级：
1. ANTHROPIC_AUTH_TOKEN (Bearer token, 如 claude.ai OAuth)
2. 显式传入的 apiKey 参数
3. getAnthropicApiKey() 从配置文件读取

Claude.ai 订阅用户 (isClaudeSubscriber):
  使用 authToken: getClaudeAIOAuthTokens().accessToken

标准 API Key 用户:
  使用 apiKey: resolveAnthropicClientApiKey(...)
```

### 自定义 fetch 层（buildFetch）

每个请求都经过 `buildFetch` 包装：

```typescript
function buildFetch(fetchOverride, source): ClientOptions['fetch'] {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    // 注入 x-client-request-id（用于服务端日志关联，尤其是超时场景）
    if (injectClientRequestId) {
      headers.set('x-client-request-id', randomUUID())
    }
    // 签名请求体（Anti-abuse 保护）
    return inner(input, { ...init, headers, body: signClaudeCodeCCHBody(init?.body) })
  }
}
```

**固定请求头**：
```
x-app: cli
User-Agent: <版本信息>
X-Claude-Code-Session-Id: <会话ID>
x-claude-remote-container-id: <容器ID，如有>
x-claude-remote-session-id: <远程会话ID，如有>
```

### Bedrock 鉴权

```typescript
// 方式一：AWS_BEARER_TOKEN_BEDROCK（API Key 认证）
headers['Authorization'] = `Bearer ${token}`

// 方式二：标准 AWS SDK 凭证（IAM Role / STS）
bedrockArgs.awsAccessKey = credentials.accessKeyId
bedrockArgs.awsSecretKey = credentials.secretAccessKey
bedrockArgs.awsSessionToken = credentials.sessionToken
```

### Vertex AI 鉴权

```typescript
new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  // 仅在没有其他 project 配置时才使用 ANTHROPIC_VERTEX_PROJECT_ID
  // 避免触发 GCE metadata server 12 秒超时
})
```

---

## 三、核心请求层（services/api/claude.ts）

### `queryModelWithStreaming()` (L757)

公开导出的入口，仅做 VCR 包装后委托给 `queryModel`：

```typescript
export async function* queryModelWithStreaming({
  messages, systemPrompt, thinkingConfig, tools, signal, options
}): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(messages, systemPrompt, thinkingConfig, tools, signal, options)
  })
}
```

### `queryModel()` (L1022) — 核心私有函数

#### 请求参数构建（paramsFromContext）

每次 retry 都重新构建参数（支持动态调整 max_tokens 等）：

```typescript
return {
  model: normalizeModelStringForAPI(options.model),
  messages: addCacheBreakpoints(messagesForAPI, ...),   // 注入 prompt cache 控制点
  system,                                                // 系统提示（含 cache_control）
  tools: allTools,                                       // 工具定义列表
  tool_choice: options.toolChoice,
  betas: betasParams,                                    // 动态 beta header 列表
  metadata: getAPIMetadata(),                            // 用户 ID 等元数据
  max_tokens: maxOutputTokens,
  thinking,                                              // extended thinking 配置
  temperature,                                           // 仅 thinking 禁用时发送
  context_management,                                    // 上下文管理策略
  output_config: { effort, format, task_budget },        // 输出配置
  speed,                                                 // "fast" 时启用 Fast Mode
  ...extraBodyParams,                                    // Bedrock 额外参数等
}
```

#### Beta Headers 动态管理

Beta headers 采用"latch（锁存）"机制——一旦某个 header 第一次被发送，就在整个会话中保持，避免因切换导致 prompt cache key 变化：

| Beta Header | 触发条件 | Latch |
|---|---|---|
| `prompt-caching-2024-07-31` | 模型支持 prompt caching | 无 |
| `interleaved-thinking-2025-05-14` | extended thinking 启用 | 无 |
| `fast-mode-...` | Fast Mode 开启 | 是 |
| `afk-mode-...` | Auto Mode 激活（仅 ant 内部） | 是 |
| `cache-editing-...` | Cached Microcompact 启用 | 是 |
| `advanced-tool-use-...` | Tool Search 启用 | 否 |
| `structured-outputs-...` | JSON 输出格式 | 否 |

#### 实际 API 调用（L1889）

```typescript
const result = await anthropic.beta.messages
  .create(
    { ...params, stream: true },
    {
      signal,                         // AbortSignal（用户取消）
      headers: { 'x-client-request-id': clientRequestId },
    }
  )
  .withResponse()  // 同时拿到 Response 对象（用于获取 request-id、关闭连接）

stream = result.data           // AsyncIterable<BetaRawMessageStreamEvent>
streamRequestId = result.request_id
streamResponse = result.response
```

> 注意：有意使用底层 `.create()` 而非 `BetaMessageStream`，原因是 `BetaMessageStream` 会对每个 `input_json_delta` 调用 `partialParse()`，造成 O(n²) 性能问题。cc-haha 自行积累 tool input。

---

## 四、重试与降级（services/api/withRetry.ts）

```
withRetry(getClient, fn, retryOptions)
  │
  ├─ 529 过载错误 → 指数退避重试
  ├─ 401 鉴权错误 → 刷新 token 后重试（重新调用 getClient）
  ├─ 408/504 超时 → 重试（max attempt 内）
  └─ 流式失败 → fallback to executeNonStreamingRequest()
       └─ anthropic.beta.messages.create({ stream: false }, { timeout: 300s })
```

**非流式 fallback 超时**：
- 远程会话（`CLAUDE_CODE_REMOTE=1`）：120 秒
- 本地会话：300 秒
- `API_TIMEOUT_MS` 环境变量可覆盖

---

## 五、流式响应处理

### 流式 Watchdog

防止连接静默挂起：

```
CLAUDE_ENABLE_STREAM_WATCHDOG=1        启用
CLAUDE_STREAM_IDLE_TIMEOUT_MS=90000    默认 90 秒（每收到一个 chunk 重置）
CLAUDE_STREAM_MAX_DURATION_MS=0        默认禁用，Desktop 会注入值（不被 chunk 重置）
```

- **Idle timer**：每收到一个 chunk 就重置；超时则 abort stream
- **Max duration timer**：不被 chunk 重置，防止服务端持续发送小 delta 但永不结束

### 资源清理

```typescript
function releaseStreamResources(): void {
  cleanupStream(stream)
  stream = undefined
  streamResponse.body?.cancel().catch(() => {})  // 释放 native TLS/socket buffer
  streamResponse = undefined
}
```
> 原因：`Response` 对象持有 native heap 外的 TLS/socket buffer，必须显式释放，否则造成内存泄漏（GH #32920）。

---

## 六、消息预处理流水线

在实际发出 API 调用前，`messagesForAPI` 经过以下处理：

1. **`normalizeMessagesForAPI()`** — 标准化格式
2. **`stripToolReferenceBlocksFromUserMessage()`** — 非 tool search 模式下移除 tool_reference 块
3. **`stripCallerFieldFromAssistantMessage()`** — 移除 tool_use 的 caller 字段
4. **`ensureToolResultPairing()`** — 修复 tool_use/tool_result 配对错误（断点续传场景）
5. **`stripAdvisorBlocks()`** — 无 advisor beta header 时移除 advisor 块
6. **`stripExcessMediaItems()`** — 媒体项超过 100 个时静默删除最旧的（API 限制）
7. **`addCacheBreakpoints()`** — 注入 prompt cache 控制标记

---

## 七、系统提示构建

```typescript
systemPrompt = [
  getAttributionHeader(fingerprint),     // 归因 header（含消息指纹）
  getCLISyspromptPrefix({ ... }),         // CLI 标准前缀
  ...systemPrompt,                        // 用户/项目系统提示
  ADVISOR_TOOL_INSTRUCTIONS,              // 如启用 advisor
  CHROME_TOOL_SEARCH_INSTRUCTIONS,        // 如启用 Chrome MCP
].filter(Boolean)

// 转为带 cache_control 的 blocks
system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, { ... })
```

---

## 八、环境变量速查

### Provider 选择
| 变量 | 说明 |
|---|---|
| `CLAUDE_CODE_USE_BEDROCK` | 使用 AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | 使用 Google Vertex AI |
| `CLAUDE_CODE_USE_FOUNDRY` | 使用 Azure AI Foundry |

### 鉴权
| 变量 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` | 直连 API Key |
| `ANTHROPIC_AUTH_TOKEN` | Bearer token（OAuth） |
| `ANTHROPIC_CUSTOM_HEADERS` | 自定义请求头，换行分隔 |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock API Key 鉴权 |
| `ANTHROPIC_VERTEX_PROJECT_ID` | Vertex GCP 项目 ID |
| `ANTHROPIC_FOUNDRY_API_KEY` | Foundry API Key |

### 行为控制
| 变量 | 说明 |
|---|---|
| `API_TIMEOUT_MS` | 全局请求超时（默认 600000ms） |
| `CLAUDE_CODE_DISABLE_THINKING` | 禁用 extended thinking |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | 禁用 adaptive thinking，改用 budget |
| `CLAUDE_CODE_DISABLE_FAST_MODE` | 禁用 Fast Mode |
| `CLAUDE_ENABLE_STREAM_WATCHDOG` | 启用流式超时 watchdog |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 流式空闲超时（默认 90000ms） |
| `CLAUDE_STREAM_MAX_DURATION_MS` | 流式最大持续时间（0=禁用） |
| `CC_HAHA_OPENAI_OAUTH_PROVIDER` | 强制使用 OpenAI Codex 传输 |

### 区域覆盖（Bedrock/Vertex）
| 变量 | 说明 |
|---|---|
| `AWS_REGION` / `AWS_DEFAULT_REGION` | Bedrock 区域（默认 us-east-1） |
| `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` | Haiku 专用 Bedrock 区域 |
| `CLOUD_ML_REGION` | Vertex 默认区域 |
| `VERTEX_REGION_CLAUDE_*` | Vertex 模型专用区域 |
