---
created: 2026-08-18
status: active
canonical: false
scope: pi-completion-wave
---

# Pi Agent 完成波次实施计划

## 目标

在已完成 Pi Agent 核心切换、Hindsight 记忆链路和 taiyi 基础联调的基础上，补齐：

- Manager→Agent 的租户化 LightRAG 知识检索与 citation get；
- 真实 provider credential / AI Relay 接入边界；
- 签名 Skill package 的 materialize 与受控 ResourceLoader；
- Agent attachment/artifact 本地生命周期；
- 真实 sandbox、前端和三端 E2E 验收。

## 不变约束

- Agent 继续是 Node.js/TypeScript + 进程内 pi-coding-agent SDK；
- 不重新引入 Run/Task/Loop/Timeline 执行事实源、Gateway、Executor、Driver 或多 runtime；
- 会话、执行内容、附件和原始 Pi 内容留在 Agent；
- Manager 只提供授权配置、Hindsight facade、租户化知识 facade 和脱敏治理摘要；
- LightRAG workspace 必须由 Manager 从 tenant/knowledge_space 派生，不能接受客户端 workspace；
- 并行开发使用独立 worktree；taiyi 共享测试环境的部署和写入串行执行。

## 波次

### Wave 0：共享契约与 fixture（单一 writer）

冻结 provider ref、skill manifest/signature、knowledge workspace/citation、attachment/artifact metadata、错误/审计字段，并补充可复用的本地 fake fixtures。

### Wave 1：独立本地开发线（可并行）

1. **Knowledge/LightRAG**：Manager workspace 派生、授权检查、LightRAG adapter、search/get、索引 intake 接入和测试。
2. **Provider**：Manager credential vault/AI Relay seam、Agent ModelRuntime 受控注入、生产 faux guard 和测试。
3. **Skills**：签名/hash/version 校验、固定资源 materialize、ResourceLoader 接入、拒绝未审核 package 的测试。
4. **Attachment/Artifact**：Agent SQLite metadata、workspace 路径约束、Pi image/file 引用、删除/过期清理和测试。
5. **Frontend projections**：只消费已冻结的 Agent/Manager API；真实数据联调后置，避免浏览器 localStorage 成为真相源。

### Wave 2：单一集成人员合并

将各线接入 SessionHost、Manager facade 和前端主链。检查是否意外引入第二执行状态机或跨租户路径。

### Wave 3：taiyi 串行集成

一次只部署一个候选 commit，按以下顺序验证：

1. health/auth/JWKS/sync；
2. provider/Pi real execution；
3. Hindsight；
4. LightRAG knowledge；
5. sandbox 越界/凭据隔离；
6. attachments/artifacts；
7. Playwright 三端和跨租户撤权/删除/重启恢复。

每次验证后清理测试数据并保留日志、请求结果和回滚点。

## 完成标准

- 本地各线测试、类型检查和构建通过；
- Manager→Agent memory 与 knowledge 都经过当前 snapshot/grant 授权；
- LightRAG 不存在共享 workspace 串租户；
- 真实 provider 模式下 Agent 能完成一次 Pi prompt；
- 未签名 skill、越权 knowledge、越界 filesystem、跨租户 conversation/attachment 均被拒绝；
- taiyi 三端完整 E2E 通过；
- 文档明确列出仍未完成的非目标，不以 faux/mock 结果代替生产验收。

## 当前状态

- Pi 核心切换：已完成；
- Hindsight Manager→Agent：已完成并在 taiyi 验证；
- LightRAG：镜像、服务、直接 API 已验证，Manager 租户化 facade 尚未完成；
- 其余 Wave 1 线：等待本轮只读勘察后开始实现。
