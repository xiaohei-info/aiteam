# 工位设计总结（office-map 工位规范 v1）

本文把编辑器里最终确认的工位画法、坐标与状态规则整理成一份可复刻的规范。所有尺寸都是 **1× 逻辑像素**，不是建筑尺寸。前端（AITeam）按本文复刻即可得到与编辑工具 1:1 的效果。

数据来源：`examples/office-10-person.json`（`office-map/v1.1`，由 `src/office-layout.js` 生成）。

## 1. 工位由四个独立图元组成

| 组成 | 素材 | 基准尺寸 | 说明 |
| --- | --- | --- | --- |
| 工位桌 | `assets/styles/topdown-soft/desk-workstation-top.png`（Sketch `Office v2 / desk-workstation-top`） | 144 × 76 | 俯视轻立体，**桌面不含显示器**；占地 `footprints: [{x:0,y:0,width:144,height:72}]`，阻挡行走 |
| 电脑 | `assets/aifred/office/office_computer_bg.png`（AIFred 原图） | 贴图基准 82.5 × 55；**图元默认放大 1.25× = 103.125 × 68.75** | 自带显示器+键盘，透明边很大；`screen: {x:13.7,y:3.8,width:55.1,height:35.4}`（贴图 1× 坐标，放大后屏幕 68.9 × 44.2）；不阻挡行走，`zIndex: 6` |
| 办公椅 | `assets/aifred/office/chair.png`（AIFred 原图） | 桌宽 × 0.58 = 83.52 × 86.69（高 = 宽 × 492/474） | 不阻挡行走，`zIndex: 12` |
| 员工 | `assets/aifred/characters/chibi-stickers`（Spine，9 皮肤） | Spine 缩放 k（见 §3） | 不是地图元素，而是 `seats[].employee` 配置 |

桌面与电脑**必须是两个元素**：桌子只画顶面，显示器单独摆放，所以俯视时屏幕不会被员工遮挡，也能单独改屏幕内容和位置。

## 2. 局部锚点（相对桌子的归一化坐标）

`elementPoint(desk, offset, {width:1,height:1})` 的语义：
`x = desk.x + (offset.x - 0.5) × desk.width`，`y = desk.y + (offset.y - 0.5) × desk.height`（再叠加桌子的旋转）。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `seatOffset` | `{x: 0.18, y: 1.19}` | 员工锚点（Spine 原点/脚下），在桌子左侧、略低于桌面下沿 |
| `chairOffset` | `{x: 0.14, y: 1.14}` | 椅子中心，在员工身后、往电脑对面偏左 |
| `computerOffset` | `{x: 0.75, y: 0.27}` | 电脑中心，落在桌面右侧且不越出桌沿；放大后底边（键盘）仍贴在原位置，只向桌后方长高 |
| `approachOffset` | `{x: 0.5, y: 1.7}` | 寻路接近点（桌子正前方），不是画面锚点 |

绑定关系：桌面移动/缩放/旋转时，椅子与电脑按上面的归一化坐标一起跟随（椅宽 = 桌宽 × 0.58、椅高按原比例；电脑保持自身尺寸）。复制工位会复制椅子与电脑；删除桌子只清除该座位记录，不会自动删掉椅子/电脑图元。

## 3. 员工（Spine）

- 皮肤：`misaki / erikari / nate / harri / luke / soeren / mario / sinisa / spineboy`，按工位序号用 AIFred 的稳定哈希函数分配（`pickEmployeeSkin`）。
- 缩放：`k = 0.32 × (0.58 × 1.1 × deskWidth / 200)`；桌宽 144 时 `k = 0.1470`，员工整体约 75–82px 高、头宽约 37px。
- 朝向：`front / back / left / right`，**工位默认 `back`（背对镜头，只看到后脑，不用正脸）**。这里的 left/right 是屏幕左右；资源动画名按角色自身左右命名、与屏幕相反，所以 `employeeAnimation()` 会把 `left` 映射到 `*-right` 动画（反之亦然）。
- 动画：`movement/idle-{facing}`、`emotes/thinking`、`emotes/wave`（挥手/说话）、`movement/trot-{facing}`（走动，仅预览/移动表现，不改变配置坐标）。
- 位置：Spine 原点直接放在 `seat.x / seat.y`，不做额外偏移；编辑器里用 128×192 的离屏 tile 合成，等价于「原点 = 锚点」。
- 头顶姓名标签：`seat.y - 118 × deskWidth / 144`，内容为 `工位标签 · 员工名`。

## 4. 层序（从小到大绘制）

| zIndex | 内容 |
| --- | --- |
| -100 | 地面（`floor-carpet / floor-oak / floor-mineral`，按 128×128 原尺寸平铺） |
| 0 | 工位桌、会议桌、沙发、柜子等家具 |
| `desk.zIndex + 2` | 该工位的员工 |
| 6 | 电脑（含 `glyph` 屏幕内容，绘制在员工之上） |
| 12 | 办公椅（绘制在员工之上，遮住下半身、露出整个头） |
| 20 | 实体墙 |
| 21 | 玻璃隔断 |
| 25 | 墙角 / T 型接头 |
| 30 | 门 |

## 5. 屏幕内容（`screen` 元数据）

- 电脑图元带 `screen: {x, y, width, height}`（相对图元左上角的贴图 1× 局部坐标，共 55.1 × 35.4）。**放大上限 ≈ 1.25×**：屏幕要落在「员工右缘（桌左 + 71.9）」与「桌右缘（桌左 + 144）」之间，可用宽约 72；1.3× 起会贴到员工或伸出桌沿。元素被缩放时，屏幕矩形按 `element.width / asset.width`、`element.height / asset.height` 同步缩放。
- 编辑器按员工动画状态给屏幕配色，并用同一矩形绘制「状态条 + 代码行 + 侧边指示块」：

| 员工状态 | 颜色 |
| --- | --- |
| 待机 idle | `#4ade80`（绿） |
| 思考 thinking | `#38bdf8`（蓝） |
| 挥手/说话 talking | `#fbbf24`（黄） |

- 屏幕底色 `#0f172a`，内容区渐变 `#1e293b → #0f172a`，文字行 `#5eead4` / `#8fb3ad`。前端可以沿用这套配色，也可以把 `screenContent` 换成真实任务标题/进度。

## 6. 工位阵列与环境

- 工位间距 192px（桌宽 144 + 通道 48），两排各 5 个：第一排 `y = 700`，第二排 `y = 876`；第一列 `x = 96`。
- 10 人样板共 **135 个组件**：10 工位桌 + 10 电脑 + 10 办公椅 + 14 会议椅 + 3 会议桌 + 31 件绿植与摆件 + 墙/玻璃/门/设施/公共家具。
- 房间：会议室 A/B/C（4/6/4 座）、茶水间、厕所、独立工位区；入口在下方（`door-open-up`，已打开）。
- 地图 1600 × 1200，无整张办公室底图；`layout.entrance = (764, 1184)`，`layout.spawnPoint = (944, 1072)`。

## 7. 复刻检查清单

- [ ] 桌面与电脑分开渲染，电脑在桌子右侧，屏幕区域完整露出。
- [ ] 员工锚点用 `seatOffset`、椅子用 `chairOffset`、电脑用 `computerOffset`，桌动则三者跟随。
- [ ] 默认朝向 `back`，只看到后脑；椅子在员工之上，遮下半身、露出整个头。
- [ ] 地面按原尺寸平铺；墙厚固定（16px / 玻璃 8px）；打开门洞可通行。
- [ ] 屏幕内容画在 `screen` 矩形内，颜色随后台状态变化。
- [ ] 层序与 §4 一致，姓名标签在员工上方。
