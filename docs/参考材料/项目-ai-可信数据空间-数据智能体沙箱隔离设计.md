# tianwen-ai 沙箱隔离详细设计

> 独立设计文档。吸收概要设计 5.4a 节与详细设计第三章沙箱部分全部内容，作为沙箱隔离的唯一权威设计。概要设计与详细设计中的沙箱相关章节概述并引用本文档。

## 一、技术架构

### 1.1 两种隔离方案机制

tianwen-ai 底座 `pi-coding-agent` 自带 `read`/`write`/`edit`/`bash` 四个通用工具及 `!command` 用户命令，默认在宿主文件系统执行；Pi 官方明确不提供内置 sandbox（`security.md` "No Built-in Sandbox, this is intentional"），`tool_call` 拦截是确认式软拦截而非硬隔离。Pooled 部署（概要 5.7 节）多会话共享宿主，必须外引沙箱补上这一缺口。候选方案两种：

#### 方案一：Gondolin microVM（Pi 官方 pattern 2）

在宿主机上运行 QEMU 启动轻量虚拟机，每个 Agent 会话对应一个 microVM 实例。Pi 进程留在宿主，工具调用经 Extension 拦截后路由进 VM 内执行。VM 拥有**独立内核**，与宿主物理隔离。

- 工作目录：宿主把 `{EFS 根}/{user_id}/{session_id}/` bind-mount 到 VM 内 `/workspace`
- 工具路由：Extension 覆盖 Pi 的 `read`/`write`/`edit`/`bash`/`grep`/`find`/`ls` 及 `!command`，转发进 VM
- 生命周期：VM 池管理——预热、按需分配、复用、空闲回收、状态迁移
- 隔离强度：**硬件级**，逃逸需攻破 VMM
- 依赖：QEMU，Node ≥ 23.6.0

#### 方案二：dsh 本机 sandbox（DeepSeek Harness 子系统）

不启动虚拟机，在工具 spawn 的 **argv 层**做包裹。Extension 在 `tool_call` 拦截点拿到原始 argv，用 `LocalSandboxProvider.confine(argv, policy)` 在原始 argv 前加一层"runner + profile flags + `--` 分隔符"，再 spawn 受限 argv。runner 是宿主操作系统的本机沙箱后端，进程级做文件效应隔离。

- runner 按平台选：
  - Linux：`bwrap`（bubblewrap）→ `Landlock`（内核 5.13+ syscall，兜底）
  - macOS：`Seatbelt`（`sandbox-exec`，系统自带）
  - Windows：Windows ACL（restricted token + capability SID）
- 隔离强度：**进程级**，与宿主共享内核，文件系统可见性受 profile 控制——read-only 物理删不掉，workspace-write 只写指定目录
- 状态：**无状态**，confine 是纯函数 `argv → 受限 argv`
- 依赖：npm 包 1.6 MB（MIT）

### 1.2 两种方案对比

| 维度 | Gondolin microVM（方案一） | dsh 本机 sandbox（方案二） |
|---|---|---|
| 隔离粒度 | VM 级，独立内核 | 进程级，文件效应 |
| 隔离强度 | 硬件级（防恶意逃逸最强） | 进程级（共享内核，文件级硬隔离） |
| 防误删 | ✅ read-only 物理删不掉 | ✅ read-only 物理删不掉 |
| 防恶意逃逸 | ✅ 独立内核，逃逸需攻破 VMM | ❌ 共享宿主内核，非文件效应逃逸不在职责内 |
| 网络/进程可见性隔离 | ✅ VM 内看不见宿主网络/进程 | ❌ SandboxMode 明确不管 |
| 后端 | QEMU microVM | bwrap/Landlock/Seatbelt/Windows ACL |
| License | — | MIT（全开源） |
| 依赖成本 | QEMU + VM 池管理 + 状态迁移代码 | npm 包 1.6 MB |
| 实现工作量 | 高（VM 池调度/复用/迁移/挂载） | 低（argv 包裹，~200 行 Extension） |
| 状态 | 有状态（VM 实例需管理） | 无状态（纯函数 argv 包裹） |
| 冷启动 | 有（VM 启动开销，需预热池） | 无（spawn 前多一层 argv 包裹） |
| 平台兼容 | 需 QEMU 支持 | 按平台选后端，dsh 团队持续维护 |

两种方案**防误删能力等价**（read-only 都物理删不掉），差异在防恶意逃逸（Gondolin 强）与实现代价（dsh 轻一个量级）。

### 1.3 tianwen-ai 隔离能力需求

从工具构成和风险性质推导沙箱需具备的能力：

| 能力需求 | 来源 | 是否必需 |
|---|---|---|
| 防误删/误操作 | L0/L1 级风险：bash 删错文件、write 写错路径 | 必需 |
| 路径白名单（fs 工具） | read/write/edit 只能写会话 workspace | 必需 |
| 跨会话隔离 | Pooled 部署多会话共享宿主 | 必需 |
| 低冷启动 | 无状态水平扩展自洽 | 必需 |
| 复用现有基础设施 | SSO/WS/Langfuse 直连宿主进程 | 必需 |
| 防恶意逃逸 | Agent 跑不可信代码逃逸宿主 | 不需要 |
| 网络/进程可见性隔离 | Agent 工具访问宿主网络/进程 | 不需要 |

**关键判断**：tianwen-ai 的全部业务工具（6 工具域）是 HTTP API 调用，SCQL/FL 任务在 tianwen-server/SecretPad 侧执行，Agent 层不跑外部不可信代码。风险性质是**误操作（accidental）**，不是恶意逃逸。防恶意逃逸（Gondolin 的强项）不是需求，防误删（两方案等价）才是。

### 1.4 选型结论

**选 dsh 本机 sandbox（方案二），弃 Gondolin microVM（方案一）。**

1. 风险模型匹配：需防误删不需防逃逸，两方案防误删等价，Gondolin 强项用不上
2. 代价低一个量级：1.6 MB + ~200 行 vs QEMU + VM 池 + 状态迁移；无状态 vs 有状态；零冷启动 vs VM 启动开销
3. 基础设施复用：argv 层包裹，Pi 进程留宿主直连 SSO/WS/Langfuse
4. 持续工程复用：dsh 团队维护四平台后端兼容性
5. Pooled 部署自洽：无状态 argv 包裹天然适配无状态水平扩展

**决策边界**（满足任一条件重新评估升级回 microVM）：
1. Agent 工具扩展到本地执行不可信代码（如跨机构 L3 场景 Agent 侧直接执行机构侧 SQL/脚本）
2. 合规要求物理内核级隔离（审计/安全等保）
3. Agent 侧需网络/进程可见性隔离而不仅是文件效应

当前工具构成（6 工具域 HTTP 封装 + 5 个 Pi 内置文件/命令工具）均不触发。

## 二、项目架构

### 2.1 模块组织

```
src/extensions/tianwen-sandbox/
└── index.ts          # 沙箱 Extension + BashOperations 覆盖 + 路径白名单
```

一个文件承载全部沙箱职责，随代码库维护，与 `tianwen-hitl`/`tianwen-tool-domains` 一同在 `session_start` 前经 `extensionFactories` 载入。

### 2.2 依赖

```
@deepseek-ai/dsh-sandbox          0.0.1-rc.1   # 抽象 seam + SandboxProvider + writableRoots
@deepseek-ai/dsh-sandbox-local    0.0.1-rc.1   # LocalSandboxProvider（平台选择器 + 探测）
@deepseek-ai/dsh-sandbox-policy   0.0.1-rc.1   # per-call policy 解析
@deepseek-ai/node-addon-landlock-run 0.1.1    # Linux Landlock 原生模块（platform-gated）
@deepseek-ai/cordis               4.0.1        # 轻量 IoC 壳（new Context()，不启动插件树）
# 运行时传递依赖：dsh-llm, dsh-timeout, dsh-invariants, dsh-session,
#   dsh-sandbox-windows-acl, schemastery, cosmokit, @standard-schema/spec
```

总安装体积 1.6 MB，全部 MIT。`.npmrc` 配 `legacy-peer-deps=true`（`dsh-type-meta` peer-only 未发布，不影响运行时）。Dockerfile 装 `bubblewrap` 系统包。

### 2.3 dsh sandbox 架构（引用方）

```
ctx.sandbox  ← SandboxProvider seam（抽象接口）
     │
     ├─ SandboxMode（per-call policy）: read-only | workspace-write | danger-full-access
     │
     └─ LocalSandboxProvider（平台 runner 选择器 + 探测）
            ├─ Linux: bwrap → Landlock（逐级探测，首个可用胜出）
            ├─ Darwin: Seatbelt（sandbox-exec）
            └─ Win32: Windows ACL（restricted token + capability SID）
```

## 三、关键流程

### 3.1 沙箱化 bash 执行流程

```
模型调用 bash 工具（command: "ls -la"）
        │
        ▼
customTools 同名 'bash' ToolDefinition 覆盖内置 bash
        │
        ▼
createSandboxedBashOperations(wsRoot).exec(command, ...)
        │
        ├─ confine(['bash','-c',command], policy)
        │     → [runner, ...profile, '--', '/bin/sh', '-c', command]
        │
        ├─ spawn(confined.argv)  ← 内核级硬隔离生效
        │
        ├─ stdout/stderr 流式回传 onData
        ├─ timeout / abort 处理（复刻 createLocalBashOperations 语义）
        │
        ▼
返回 { exitCode }
```

### 3.2 read/write/edit 软校验流程

```
模型调用 read/write/edit（path: "/etc/passwd"）
        │
        ▼
tianwen-sandbox Extension 的 tool_call 监听
        │
        ├─ isWithinWorkspace(path, wsPath)?
        │     ├─ 是 → 放行（进程内 node:fs 执行）
        │     └─ 否 → 记录日志
        │           ├─ ENFORCE=true → return { block: true, reason }  ← 生产硬约束
        │           └─ ENFORCE=false → 放行（开发期）
        │
        ▼
进程内 node:fs 执行（包不了 argv，软校验）
```

### 3.3 fail-closed 流程

```
confine() 探测后端
        │
        ├─ 后端可用 → 返回受限 argv
        │
        └─ 后端不可用（bwrap userns 禁 + Landlock 内核 <5.13）
              │
              ▼
         抛 SandboxUnavailableError
              │
              ▼
         bash 工具返回 error（exit 127 + 错误回传）
         不退回无隔离执行原 argv
```

### 3.4 软硬分工流程

```
工具调用请求
    │
    ├─ tianwen-hitl（软拦截）—— 管"要不要执行"
    │   · L0 只读：放行，不确认
    │   · L1 可逆写：放行，必须告知用户
    │   · L2 不可逆写：return { block: true } → 用户确认 → 放行
    │   · L3 跨机构/高敏：return { block: true } + 操作计划 → 用户确认 → 放行
    │
    └─ tianwen-sandbox（硬隔离）—— 管"放行后物理上能做什么"
        · bash：confine 包 argv → 内核级，read-only 物理删不掉
        · read/write/edit：路径白名单 → 软校验，只允许 workspace 子树
```

不重叠：hitl 管"风险确认"（确认了也不一定能删——sandbox read-only 下物理删不掉）；sandbox 管"物理边界"（即使没确认也限制在 workspace 内）。两个 Extension 都监听 `tool_call`，但前者执行前判定风险可能 block，后者执行时包裹 argv，触发时机不同不冲突。

## 四、数据结构

### 4.1 核心类型

```ts
// 沙箱模式（per-call policy）
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

// 每次工具调用的隔离策略
interface SandboxPolicy {
  mode: SandboxMode
  workspaceRoot: string  // 会话 workspace 路径
  sessionId?: string
}

// SandboxProvider seam
interface SandboxProvider {
  confine(argv: string[], policy: SandboxPolicy): { argv: string[] }  // 返回就绪 argv
}

// 沙箱化 BashOperations 覆盖点
interface BashOperations {
  exec: (command: string, cwd: string,
    opts: { onData, signal, timeout, env }
  ) => Promise<{ exitCode: number }>
}

// Pi 的 customTools 同名覆盖机制
interface ToolDefinition {
  name: string  // 'bash' 同名覆盖内置
  // ...
}
```

### 4.2 三模式 × 四后端 profile 生成

| 模式 | 可写根 | bwrap | Landlock | Seatbelt | Windows ACL |
|---|---|---|---|---|---|
| read-only | `[]` | `--ro-bind / / --dev /dev --proc /proc --die-with-parent` | `--ro /` | `(deny file-write*)` | restricting list 无 capability SID |
| workspace-write | `[workspaceRoot, /tmp, os.tmpdir()]` | 上述 + `--tmpfs /tmp --bind <root> <root>` | `+ --rw /dev/null --rw /tmp --rw <root>` | `+ (allow file-write* (subpath <root>))` | workspace+temp 各得 capability-SID Allow ACE |
| danger-full-access | 不进 sandbox provider | 直接 spawn 原始 argv | 同左 | 同左 | 同左 |

可写根唯一来源 `writableRoots(policy)`：read-only → `[]`；workspace-write → `[workspaceRoot, /tmp, os.tmpdir()]`（canonical 去重，macOS `/tmp`=`/private/tmp` 合并）。所有后端用同一推导，保证跨后端语义一致。

### 4.3 后端选择与探测

| 平台 | runner 链 | 选择逻辑 |
|---|---|---|
| Linux | `[bwrap, landlock]` | 两候选，按序功能探测，bwrap 优先，Landlock 兜底 |
| macOS | `[seatbelt]` | 单候选，不探测 |
| Windows | `[windows-acl]` | 单候选（IDC 不跑 Windows，实际不用） |

探测即执行：真正跑一次 `true` 在受限 profile 里，exit 0 才算可用。Landlock probe 在短命进程里真建最大 ruleset 并 `restrict_self`。探测结果 provider 生命周期内一次缓存。bwrap 不可用是常态（企业 Linux 常禁 `kernel.unprivileged_userns_clone=0`），自动降 Landlock 兜底。

### 4.4 denial 签名按后端方言匹配

每个 runner 有自己的拒绝方言：bwrap→`read-only file system`、Landlock→`permission denied`、Seatbelt→`operation not permitted`、Windows ACL→`access is denied`。消费者只匹配当前后端方言，不用并集。runner 失败（runner 起不来）与 denial（沙箱正常拦下命令）分开分类：先检 runner 失败签名 + 退出码门，再检 denial。

## 五、数据架构

### 5.1 workspace 目录组织

```
{EFS 根}/
└── {user_id}/
    └── {session_id}/       # SandboxMode.workspace-write 的可写根
        └── ...             # read/write/edit/bash 产出文件
```

- `workspaceRoot = {EFS 根}/{user_id}/{session_id}/`，会话级隔离
- EFS 同时承载会话 jsonl（事实源）和 sandbox workspace
- sandbox 无状态，不持有跨请求状态，会话不需记录任何 sandbox 后端信息

### 5.2 policy 推导

`SandboxMode` 按 SessionHandle 推导：

- 只读诊断命令（诊断域 `diag_*` 本地执行、`wb_get_task_result` 本地预览）→ `read-only`，宿主根只读挂载
- 需写文件工具（`write`/`edit`/`bash` 产出文件）→ `workspace-write`，目录外不可写
- `danger-full-access`：当前不启用，保留为 RD 高危场景出口，需 HITL L3 显式确认

当前实现全走 workspace-write（diag_* 未挂 sandbox policy 声明）；read-only 分支已就绪，待工具声明 `riskSandboxMode` 后按工具名启用。

## 六、系统接口

### 6.1 customTools 注入接口

`createAgentSession` 的 `customTools: ToolDefinition[]` 按名覆盖 `_baseToolDefinitions`（`agent-session.js` `definitionRegistry.set(name, ...)`）。注入同名 `'bash'` ToolDefinition 替换内置 bash：

```ts
const customTools = [
  createBashToolDefinition(cwd, {
    operations: createSandboxedBashOperations(wsRoot),  // override exec
  }),
  ...buildBusinessTools(...),
]
```

### 6.2 BashOperations.exec 覆盖

在 override 的 `exec` 里 spawn 受限 argv，复刻 `createLocalBashOperations` 的流式输出/超时/中止语义：

```ts
export function createSandboxedBashOperations(wsRoot: string): BashOperations {
  const sb = getSandbox()  // LocalSandboxProvider 单例
  return {
    exec: async (command, cwd, { onData, signal, timeout, env: spawnEnv }) => {
      const confined = sb.confine(['bash', '-c', command],
        { mode: 'workspace-write', workspaceRoot: wsRoot })
      const child = spawn(confined.argv[0], confined.argv.slice(1), {
        cwd, detached: ..., stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', onData); child.stderr.on('data', onData)
      // timeout / abort 处理同 local bash
      const exitCode = await new Promise(r => child.on('exit', r))
      return { exitCode }
    },
  }
}
```

### 6.3 各工具接入方式

| 工具 | 执行方式 | 接入 seam | 隔离强度 |
|---|---|---|---|
| `bash` | spawn shell | `customTools` 同名覆盖 + `BashOperations.exec` override | 内核级硬隔离 |
| `read`/`write`/`edit` | 进程内 `node:fs` | `tianwen-sandbox` Extension `tool_call` 监听 + 路径白名单 | 软校验 |
| `user_bash`(!command) | spawn shell（经 BashSpawnHook） | `BashSpawnHook` 软约束记录 | 软约束 |

### 6.4 接入 seam 的源码依据

fork 核查发现：`createAgentSession` 不直接暴露 `BashToolOptions.spawnHook`/`operations`；`BashSpawnHook` 只改 command 字符串不能替换 argv；正确路径是 `customTools: [createBashToolDefinition(cwd, {operations})]` 同名覆盖，在 `operations.exec` 里自己 spawn `confine(['bash','-c',cmd],policy).argv`。

### 6.5 路径白名单强制开关

read/write/edit 的路径白名单软校验有强制开关（`TIANWEN_SANDBOX_ENFORCE`）：
- 生产 `true`：路径越界 `return { block: true, reason }`
- 开发 `false`：仅 `console.log` 记录，避免读写 test/fixtures 被拦

运行时读 env（`shouldEnforceFsWhitelist()`），Dockerfile 默认 `ENV TIANWEN_SANDBOX_ENFORCE=true`。

## 七、非功能性需求

### 7.1 安全设计

**隔离强度诚实区分**：sandbox 硬隔离只在 spawn 边界生效。

- `bash` 是 spawn shell → override `operations.exec` 能包 argv → **内核级硬隔离**（read-only 物理删不掉，workspace-write 限目录）
- `read`/`write`/`edit` 是进程内 `node:fs` API，不 spawn → 包不了 argv → 走**路径白名单软校验**

软校验不是内核级，理论上可被绕过。但 read/write/edit 只接受显式 `path` 参数，模型无法构造逃逸 argv，软校验够用。两类工具隔离强度不同是诚实的设计取舍，不是实现缺陷。

**user_bash 限制**：`!command` 走 `BashSpawnHook`，只能改 command 字符串不能替换 argv。当前做软约束记录，argv 层包裹待 Pi 暴露 seam。生产环境 user_bash 防误删依赖运维侧 shell wrapper 或 Pi 后续暴露 `user_bash operations` seam。

### 7.2 可靠性（fail-closed）

dsh sandbox 规定 "Silent unconfined passthrough is never legal"——后端不可用抛 `SandboxUnavailableError`，绝不静默放行原 argv。tianwen-ai 沿用：后端不可用 → bash 工具拒执行（exit 127 + 错误回传），不退回无隔离执行。

### 7.3 故障模式

| 故障 | 触发条件 | 行为 | 运维应对 |
|---|---|---|---|
| sandbox 后端不可用 | bwrap 因 `unprivileged_userns_clone=0` 不可用且 Landlock 内核 <5.13 | bash 工具返回 `error: sandbox_unavailable`，fail-closed 不放行原 argv | 部署期核实宿主机内核版本与 userns 设置；macOS 开发机走 Seatbelt 兜底 |
| registerTool 覆盖内置工具接口稳定性 | Pi 版本升级 | 工具路由 extension 可能失效 | 依赖升级时回归验证工具路由 |

## 八、硬件需求

### 8.1 系统依赖

- **Linux**：`bubblewrap` 系统包（bwrap 后端依赖）；`node-addon-landlock-run` 原生二进制（Landlock 后端，dsh 自研 C11 模块，npm 已 platform-gate linux-x64/arm64，需编译分发）
- **macOS**：`sandbox-exec`（Seatbelt 后端，系统自带，Apple 标记 deprecated 但仍随系统分发）
- **EFS**：共享存储，承载 workspace，挂载点需读写权限

### 8.2 运维前置确认项

生产部署前运维必须确认：

1. bwrap 可用性（`sysctl kernel.unprivileged_userns_clone`，`ls -l $(which bwrap)` 查 setuid 位）或 Landlock 编译分发就绪
2. workspace 路径（EFS 挂载点）的读写权限
3. `/tmp` 与 `os.tmpdir()` 在生产容器内的可写性

未确认则 sandbox fail-closed，所有 bash 工具拒执行——Agent 运维排查能力降级但不数据泄露。

## 九、实施计划

### 9.1 已完成

- `tianwen-sandbox` Extension 实现（confine + 路径白名单 + spawnHook 骨架）
- bash 硬隔离接通验证（macOS Seatbelt：echo 跑通 exit 0，写 /etc 被拒 permission denied）
- read/write/edit 路径白名单 ENFORCE 开关
- Dockerfile + `.npmrc legacy-peer-deps` + bubblewrap 系统包
- 15 个 sandbox 测试（含真实 spawn）全绿

### 9.2 待完成

| 项 | 性质 | 依赖 |
|---|---|---|
| Linux 部署验证 bwrap/Landlock | 运维 | 美团生产服务器内核版本 + userns 设置 |
| user_bash argv 层覆盖 | Pi 暴露 seam | 等待 pi-coding-agent 后续版本 |
| diag_* 工具声明 riskSandboxMode → read-only | 设计声明 | 诊断域工具明确只读语义 |

## 十、与主文档关系

本文档是沙箱隔离的**唯一权威设计**，吸收原概要设计 5.4a 节与详细设计第三章沙箱部分全部内容。主文档改为概述并引用本文档：概要 5.4a 节概述问题、选型、接入；详细设计第三章概述无状态前提与接入 seam；组件表、基础设施层、风险表、会话元数据、扩展表均引用本文档。
