# AI Team 前端工程规范

`web/` 是 AI Team v1 的三端前端单仓。它不是一个可在运行时切端的“大前端”，而是三个独立构建、独立部署、只访问本端服务的应用。

```text
web/
├── operation/  # 运营端：只访问 Operation Service
├── manager/    # 企业端：只访问 Manager Service
├── agent/      # 用户端：只访问本机 Agent Service
└── shared/     # 无端归属的契约、API 基础设施、页面壳模型与 Astryx 主题
```

根仓库的 `AGENTS.md`、v1 概要设计和端边界是最高口径；本文件只规定前端如何保持这些边界与 UI 工程质量。

## 一、端边界与依赖方向

每个前端只请求同 origin 的本端 API：

| 应用 | 可请求路径 | 禁止事项 |
| --- | --- | --- |
| `operation/` | `/api/operation/*`、`/api/auth/*` | 直连 Manager、Agent 或 runtime |
| `manager/` | `/api/manager/*`、`/api/auth/*` | 持会话、提交执行、直连 Agent runtime |
| `agent/` | `/api/agent/*`、`/api/auth/*` | 改企业主数据、直连第三方控制面 |

`shared/` 只能包含真正跨三端且无业务归属的内容：契约、API client 基类、认证/查询基础设施、i18n、页面壳 view model、时间线 client 与主题。不得把某一端的页面、feature、请求 hook 或状态机搬进 `shared/`。

依赖方向只能是：

```text
operation / manager / agent  ──>  @aiteam/shared  ──>  Astryx / React
```

禁止一个端 import 另一个端的 `src/`；禁止前端绕过本端服务进行跨端请求；禁止通过前端做跨库写入。

## 二、Astryx 是唯一通用 UI 基座

`@astryxdesign/core` 是唯一允许的通用组件系统。页面应组合 Astryx 的 `AppShell`、`SideNav`、`Card`、`Table`、`Dialog`、`AlertDialog`、`Selector`、`Switch`、`TextInput`、`Chat`、`Button` 等组件。

允许：

- 端内 feature 组件：组织数据、调用本端 hook、组合 Astryx 组件；
- 领域专用展示：例如组织图 PNG 导出、终端事件流；
- 浏览器能力的原生元素：隐藏 file input，或受 Astryx `Field` 包装的文件输入；
- 通过 Astryx `Icon` 渲染共享的单色 SVG glyph。

禁止：

- 新建第二套 `Button`、`Modal`、`Drawer`、`Table`、`Form`、`Toast`、`AppShell` 等通用组件；
- 引入或恢复旧 `web/shared/src/ui`、`design-system`、Tailwind 历史 token、legacy CSS；
- 在业务页面用原生 `select`、checkbox、button 替代已有 Astryx 控件；
- 用 emoji 作为产品图标；图标必须是 Astryx 内置 Icon 或 `web/shared/src/theme/` 中的单色 SVG；
- 修改 `node_modules/@astryxdesign/*`。

如果 Astryx 缺少控件，先检查现有 exports、theme override 和组合能力。确认无法覆盖时，先写设计说明与测试，再引入最小新增依赖；不得在 feature 中临时造一套通用实现。

## 三、主题是唯一视觉出口

三端必须通过 `AstryxProviders` 使用 `@aiteam/shared/theme` 导出的 `aiteamStone`。主题文件位于：

```text
web/shared/src/theme/
├── aiteam-stone.ts  # 色彩、字形、字号、圆角、层级和组件 override
├── aiteam-icons.tsx # 仅供 Astryx Icon 使用的共享单色 glyph
└── index.ts
```

所有跨页面一致的颜色、字体、阴影、圆角、组件状态都放在 `aiteamStone` 的 tokens 或 components override 中。业务页面不得写新的全局 CSS、色值、阴影常量或 keyframe。

视觉规则：

- 使用系统字体：macOS 优先 `-apple-system`，中文优先 `PingFang SC`；
- 大标题使用更紧凑的字距与 leading，正文保持稳定可读；
- 表面层级靠轻微阴影、边框和留白表达，不能把每张卡都做成玻璃；
- light/dark 都是正式形态，不能只调浅色页面；
- 主题更新必须同步更新相应视觉快照。

## 四、Apple Design 的克制原则

目标不是套用“苹果风”装饰，而是提升可预测性、理解成本和反馈质量。

- **即时反馈**：按钮、输入、提交、状态变化必须立即有可感知反馈；异步操作要使用现有 loading、Banner、StatusDot 或 Toast 能力。
- **空间一致性**：Popover、Dialog、菜单必须由触发控件附近展开；关闭路径与打开路径保持一致。
- **材料层级**：导航、浮层、输入器可以有更高表面层级；高密度表格和正文区域保持实底与可读性。
- **少而明确的动效**：只使用 Astryx 已有的短时交互反馈。禁止页面转场、无意义循环动画和大面积移动背景。
- **真实手势才用 spring**：拖拽、可调整面板、sheet 等需求出现时，先单独设计并评审；需要速度继承/可中断时才引入 Motion 类库。禁止用 CSS keyframes 伪造物理手势。
- **尊重系统偏好**：所有新增动态必须在 `prefers-reduced-motion: reduce` 下可用；新增透明材质前必须同时定义 reduced-transparency 与高对比行为。

## 五、无障碍与交互要求

- 每页必须有唯一、可见的 H1 和 `main` 地标；
- 控件必须有可访问名称，纯图标 Button 必须提供 `label` / `tooltip`；
- 键盘焦点必须可见，不能以 click-only 交互替代键盘路径；
- 破坏性操作必须使用 `AlertDialog`，并先聚焦取消/最小破坏动作；
- 状态不能只依赖颜色，必须同时有文字、Badge、Banner 或语义；
- 展示态（streaming、waiting reply 等）不得改变持久化主状态口径。

## 六、测试与视觉门禁

从 `web/` 目录执行：

```bash
# shared 必须先 build，端应用通过其 dist exports 解析子路径。
PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 --filter @aiteam/shared build

PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 -r test
PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 -r typecheck
PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 -r build
```

Playwright 使用干净的测试 PostgreSQL（`manager_control_db` 与独立 `operation_control_db`），并覆盖三端真实装配、API contract、Axe、键盘焦点、light/dark/reduced-motion 和视觉快照。CI 的 Linux baseline 使用 `*-linux.png`；macOS baseline 使用 `*-darwin.png`。改变主题、壳、聊天布局、表格或主要交互时，必须更新两套基线并让 `v1-web-ci` 通过。

```bash
PATH=/opt/homebrew/bin:$PATH \
AITEAM_ENV=test \
MANAGER_CREDENTIAL_KEY='vAkjGKeadpMSZuL5h21AanI5tjHmoOh87WNukUbEFhE=' \
APP_RW_PASSWORD=apprwpass \
DB_URL='postgresql://app_rw:apprwpass@127.0.0.1:5433/manager_control_db' \
ADMIN_DB_URL='postgresql://postgres:postgres@127.0.0.1:5433/manager_control_db' \
OPERATION_DB_URL='postgresql://app_rw:apprwpass@127.0.0.1:5433/operation_control_db' \
OPERATION_ADMIN_DB_URL='postgresql://postgres:postgres@127.0.0.1:5433/operation_control_db' \
corepack pnpm@11.4.0 e2e
```

## 七、提交前检查

- 新页面是否落在正确端，并且只调用本端 API？
- 是否优先组合 Astryx，而不是创建可复用 UI 基础设施？
- 视觉变化是否进入共享主题，而不是散落在 feature CSS？
- 交互在键盘、light/dark、reduced-motion 下是否仍可用？
- 是否更新 unit test、Axe/Playwright 和平台对应的视觉快照？
- 是否没有重新引入 legacy UI、跨端请求、runtime 原始对象或旧 API 路径？

