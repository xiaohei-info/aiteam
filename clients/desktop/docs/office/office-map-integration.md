# AITeam 办公室页面：地图驱动渲染（office-map/v1.1）

本文说明前端如何 1:1 复刻 `office-map-edit-tool` 的显示效果，以及如何设置电脑屏幕内容、员工状态与移动轨迹。

- 工位画法与坐标规范：见 [工位设计总结](office-workstation-design.md)。
- 地图与素材由单仓内的编辑器导出：`clients/office-map-edit-tool/scripts/sync-to-aifred.mjs`（`npm run sync:aifred-frontend`）。

## 1. 数据与素材位置

| 内容 | 路径 |
| --- | --- |
| 地图配置 | `public/assets/office/map/office-10-person.json` |
| 同步清单（含 SHA256） | `public/assets/office/map/manifest.json` |
| 俯视轻立体素材 | `public/assets/office/topdown/*.png` |
| AIFred 自有素材（椅子/电脑） | `public/assets/office/chair.png`、`office_computer_bg.png` |
| 员工 Spine | `public/assets/characters/chibi-stickers/` |

重新同步（在编辑器目录执行，写入同级的 `clients/desktop/public/assets/office/`）：

```sh
cd clients/office-map-edit-tool
npm run sync:aifred-frontend   # 复制地图 + 用到的俯视 PNG，并写 manifest
```

## 2. 渲染模块

```text
src/scene/office/officeMap/
├── types.ts          # office-map/v1.1 类型
├── geometry.ts       # 元素变换/占地/阻挡/四邻域寻路（从编辑器 model.js 移植）
├── destinations.ts   # 自由活动目的地推导（活动点锚点 / 房间占用过滤，纯函数可单测）
├── loadOfficeMap.ts  # 拉取地图 JSON + 预载贴图
├── MapOfficeScene.ts # Pixi 场景：1:1 复刻渲染 + 状态/屏幕/移动 API
└── preview.ts        # 独立预览页入口（可选）
```

`src/pages/OfficeStatus/OfficeCanvas.tsx` 默认使用 `MapOfficeScene`；地图加载失败时自动回退到旧的 `OfficeScene`（硬编码布局）。传 `mapUrl={null}` 可强制使用旧场景。

渲染顺序与编辑器一致：地面（`TilingSprite` 原生平铺）→ 家具（`zIndex`）→ 员工（`desk.zIndex + 2`）→ 电脑与屏幕内容（`6`）→ 椅子（`12`）→ 墙 `20` / 玻璃 `21` / 接头 `25` / 门 `30` → 姓名标签。

> 员工与家具必须在**同一个** `sortableChildren` 容器里按 `zIndex` 排序。若把员工单独放到另一个层，整层会压在元素之上，椅子（`12`）就盖不住员工（`desk.zIndex + 2`），前后关系会与编辑器不一致；走动时员工临时提到 `zIndex 40` 才会盖过墙与门。员工不做整体半透明，离线只体现在屏幕基调与右侧状态列表。

## 3. 员工填充规则

**员工按真实 agent 填充，没有 agent 的工位留空（只有桌子 / 显示器 / 椅子，不画员工）。**

- `init(host, w, h, agents)` 按顺序（agent i → 第 i 个工位）分配，同时写入 `agentToSeat`，便于用后端 `employee_id` 直接调状态/屏幕接口。
- 有 agent 的工位：Spine 皮肤取地图 `seat.employee.skin`（按工位定位、稳定），标签只显示 `agent.name`（不显示工位编号），显示器屏幕按后端状态出内容，**椅子按原摆放（后撤留出落座空间，挡住员工下半身并露头）**。
- 没有 agent 的工位：不创建 Spine，不画姓名标签；电脑显示器保持**黑屏**（不画任何工作内容）；**椅子往前放（贴近桌沿收拢，呈现整齐的无人空位状态）**。
- 后端 `status`（`working` / `ready` / `offline`）只决定**显示器屏幕基调**（蓝 / 黄 / 红）与右侧列表，不直接改变身体动画；工位默认保持背对镜头的待机姿态。要放表情动画（思考/挥手）请显式调 `setEmployeeStatus`。

## 4. 可编程接口

```ts
import { MapOfficeScene, type ScreenContent, type EmployeeStatus } from '@/scene/office/officeMap/MapOfficeScene'

const scene = new MapOfficeScene({ mapUrl: '/assets/office/map/office-10-person.json' })
await scene.init(host, width, height, agents) // agents: { id, name, status? }[]

// 1) 电脑屏幕里显示什么
scene.setScreenContent('seat-01', {
  tone: 'thinking',            // idle 绿 / thinking 蓝 / talking 黄 / error 红
  title: '整理季度报表',
  lines: ['正在读取 CRM 数据', '生成图表…'],
  progress: 0.62,              // 0–1，画一条进度条
})
// 兼容旧 API：scene.setComputerScreenStatus(agentId, 'working' | 'browsing' | 'coding' | 'idle')

// 2) 员工状态（决定动画）
scene.setEmployeeStatus('seat-01', 'thinking') // idle | thinking | talking | walking | offline
scene.setStatusByAgent(agentId, 'talking')     // 用后端 employee_id 更直接

// 3) 移动轨迹
scene.walkPath('seat-01', [{ x: 200, y: 900 }, { x: 500, y: 1000 }])  // 折线，60 px/s
scene.walkTo('seat-01', { x: 944, y: 1072 })                          // 自动按可行走区域寻路
scene.returnToSeat('seat-01')                                         // 走回自己工位
scene.stopWalking('seat-01')

// 辅助
scene.seatIds            // 工位 id 列表（与地图 seats[].id 一致）
scene.seatPoint('seat-01')
scene.screenToMap(clientX, clientY)

// 4) 闲置员工自动漫步（默认开启，周期 30 秒）
scene.setAutoWander(true)
scene.setWanderInterval(30)        // 秒，最少 5 秒
scene.getWanderDestinations()      // 当前地图里可用的目的地（活动点锚点，带 type/speed/stay/roomId）

// 5) 房间使用状态（会议室预定 / 真实会议中）
scene.setRoomOccupied('room-meeting-b', true)  // 画「使用中」徽标、排除该房间锚点、召回在途员工
scene.occupiedRoomIds                          // 当前占用中的房间 id 列表
scene.setRoomOccupied('room-meeting-b', false) // 解除
```

- 寻路使用与编辑器相同的阻挡多边形与四邻域网格 + 逐段精确检查，`radius` 默认 12px。
- 走动时员工会临时抬到 `zIndex 40`，避免被墙挡住；到达后自动回到 `desk.zIndex + 2` 并恢复 idle。
- 朝向由移动方向决定（`dx` 优先），与 AITeam 既有约定一致。
- `walkTo` / `returnToSeat` 的起点取**角色实时坐标**（`currentPoint`），所以在茶水间/会议室里也能正确寻路回工位，不会瞬间跳回去。
- 目的地的筛选逻辑在 `destinations.ts`（纯函数）：优先用地图 `spots[]`，过滤掉禁用锚点与「使用中」房间里的锚点；没有锚点时回退到按房间与主通道推导。

## 5. 闲置员工自动漫步

**员工处于闲置状态时，每 30 秒会自己移动一下位置**：去茶水间、厕所、会议室、过道，到达后休息 8 秒再走回工位，循环往复。

状态机（每个有 agent 的工位各自独立）：

```text
idle_at_seat --(30s 到)--> walking_to --(到达)--> staying(8s) --(休息完)--> returning --(到工位)--> idle_at_seat
```

- **“闲置”的判定**：agent 状态为 `ready` / `idle` / 未提供，且没有在播 `thinking` / `talking` 表情。`working` 与 `offline` **不溜达**。
- **被派活立即回座**：若员工在溜达途中状态变为 `working` 或被 `setEmployeeStatus('thinking')`，会立即按回座速度走回工位（不会停在走廊）。
- **错峰出发**：初始倒计时按工位序号错开（`(i × 9) % 周期 + 5` 秒），避免所有员工同一秒集体起身。
- **姓名标签随人走**：走动时标签跟着角色移动，回座后回到桌面位置。
- **椅子不动**：员工外出时工位上的椅子保持原摆放（不会被带着走）。

### 自由活动锚点（spots）与房间使用中

目的地来自地图里的 `spots[]`（编辑器可自定义的锚点：名称、类型、坐标、步速、停留时间、启用开关、绑定房间）：

| 锚点类型 | 默认步速 | 说明 |
| --- | --- | --- |
| 厕所 `restroom` | 85 px/s | 最急，快步 |
| 茶水间 `pantry` | 65 px/s | 轻松闲适 |
| 自定义 `custom` | 60 px/s | 编辑器新放锚点的默认值 |
| 会议室 `meeting` | 58 px/s | 标准商务步速 |
| 过道 `corridor` | 45 px/s | 最慢，散步 |
| 回工位 `return` | 60 px/s | 正常回座（非锚点） |

- 锚点自带的 `speed` / `stay` 优先；缺省时按类型取默认值（停留默认 8 秒）。
- `enabled: false` 的锚点不参与。
- **房间「使用中」时员工不会进入**：`rooms[].occupied === true`（或运行时 `setRoomOccupied(roomId, true)`）会同时排除绑定该房间的锚点、以及落脚点落在该房间范围内的锚点；已经在路上或已经进入的员工会立刻按回座速度返回工位。
- 地图没有 `spots`（旧地图）时自动回退到按房间 `approachPoint` + `layout.mainAisle` 推导目的地，行为与之前一致，不会报错。
- 换地图、改锚点、调步速都只改 JSON，前端不需要改动。

```ts
// 运行时接口
scene.getWanderDestinations()          // 当前可用目的地（含 name/type/speed/stay/roomId）
scene.setRoomOccupied(roomId, true)    // 会议室被占用：画红标、排除目的地、召回在途员工
scene.getRoomOccupiedIds?.() ?? scene.occupiedRoomIds  // 当前占用中的房间 id
scene.setAutoWander(false)             // 关掉自动漫步
scene.setWanderInterval(15)            // 改周期（秒）
```

房间「使用中」会在地图上画一个红色「使用中」徽标（`zIndex 26`），与编辑器里的显示一致。

### 走路时的腿部动作

- 行走播放 `movement/trot-<facing>`，**转向时不会退回待机**（`SpineCharacter` 会记住当前运动语义 `motion: idle/walking/thinking/talking`，`setFacing()` 只换动画不换语义）。早期版本转向会重置成 `idle`，而待机动画里没有腿骨轨道，看起来就是「身体在滑行、双脚不动」。
- **左右朝向要映射到名字相反的动画**：chibi-stickers 的 `left/right` 是按角色自身左右命名的（角色正面朝镜头），与屏幕左右相反 —— `idle-left` / `trot-left` 在屏幕上其实朝右。`idleAnimByFacing` / `trotAnimByFacing` 会做这层对调（原工程 `SpineCharacter` 的 `CHIBI_DIR_ANIM` 同样对调）。若直接同名映射，员工左右移动时会「人朝反、位移对」，膝盖也会朝运动反方向弯。
- 左右行走的膝盖方向用派生骨骼修正过：`public/assets/characters/chibi-stickers/chibi-stickers-walk.json`（AIFred 原骨架 + 只改 `movement/trot-left|right` 的最小补丁，原文件保持 byte-exact）。修正后膝盖朝行进方向弯、脚落在膝盖后方，不再是反关节。

## 6. 页面布局

`/office` 采用「左 2/3 地图 + 右 1/3 状态栏」的横向格局（不是上下结构），以保证画面填充：

```text
┌─ Header（办公室动态 / LIVE）────────────────────────────┐
├───────────────────────────┬──────────────────────────┤
│  OfficeCanvas            │  BottomPanels（竖向堆叠）  │
│  （动态地图，flex: 2）    │   员工执行 / 当前场景 /   │
│  地图按容器尺寸等比适配   │   定时会话摘要（可滚动）   │
└───────────────────────────┴──────────────────────────┘
```

- 左栏 `flex: 2`、右栏 `flex: 1`（宽 300–460px，超出滚动）；外层 `overflow: hidden`，页面高度始终填满。
- `BottomPanels` 竖向堆叠放置在右侧栏，同一份源码同时满足 `tests/officeRequestState.test.ts` 的内容断言。

## 7. 本地预览

```sh
cd clients/desktop
npm run office:preview          # 打包预览页并起 http://127.0.0.1:4180
# 打开 http://127.0.0.1:4180/office-map-preview.html
# 加 ?demo=1 可以演示不同状态 / 屏幕内容
```

该预览页只挂载地图场景，用来在浏览器里逐像素核对与编辑工具的一致性（截图对比 `office-map-edit-tool/test-results/aifred-employees-editor.png`）。

- `?agents=N`：只填充前 N 个工位（默认 `0`，即全部空位），用来核对“无员工则留空”。
- `?demo=1`：10 个员工 + 不同状态与屏幕内容。
- `?status=ready`：指定这些员工的后端状态（默认 `ready`，即会满场溜达）。要看“不溜达”的效果用 `?status=working`。
- `?wander_interval=8`：缩短漫步周期便于观察（默认 30 秒）。

## 8. 验证

```sh
cd AITeam
npm test -- tests/officeMapScene.test.ts   # 地图可消费、贴图齐全、工位构成/层序/可达性
npm run typecheck
```

`tests/officeMapScene.test.ts` 直接读取同步过来的地图，断言：桌 144×76、电脑 `screen` 元数据、椅子按桌宽 0.58、员工在桌左且不遮屏幕、层序 `地面<家具<员工<电脑<椅子<墙<门`，以及：

- 入口到 5 个房间与 10 个工位接近点的 12px 净距通路；
- 漫步速度策略 `厕所 > 茶水间 > 会议室 > 过道`；
- 10 个工位到「茶水间 / 厕所 / 会议室 / 过道」四类目的地**双向往返**均可达。

## 9. 已知边界

- 表情动画（`thinking` / `talking`）使用的是正面朝向的 Spine 动画，设置这两种状态会看到正脸；工位默认 `back`（只看到后脑）。
- Spine 骨架/atlas 与地图 JSON 分开携带，跨环境需要同时拷贝 `public/assets/characters` 与 `public/assets/office`。
- 地图里的 `zones` 只用于寻路与语义，前端暂不把禁区可视化出来。
