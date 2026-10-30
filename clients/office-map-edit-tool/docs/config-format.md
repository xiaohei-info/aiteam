# office-map/v1.1 配置契约

编辑器新建和新增素材使用 `office-map/v1.1`，兼容导入 `office-map/v1`。旧 v1 的元素仍按整张旋转矩形碰撞；独立地面占地只能写在 v1.1 中，禁止用旧版本号默默改变碰撞语义。AITeam 当前运行场景未接入这两个格式。

根字段：`schema`, `id`, `name`, `coordinateSystem`, `width`, `height`, `gridSize`, `backgroundColor`, `background`, `assets`, `elements`, `zones`。可选：`rooms`, `seats`, `layout`。

坐标系固定为：

```json
{"unit":"px","origin":"top-left","xAxis":"right","yAxis":"down","rotation":"clockwise-degrees"}
```

`background` 默认为 null；非空时是 `{src, opacity, visible}`，绘制范围为整张地图。10人示例不使用办公室底图，全部由独立元素拼装。

## 素材与地面平铺

素材：`{id, name, src, category?, width?, height?, tileable?}`。`src` 仅支持 `assets/` 相对路径或内嵌 PNG / JPEG / WebP data URI。禁止远程 URL、SVG、文件系统路径及 `..` 路径片段。多个元素可共用同一素材。

`tileable: true` 的图像使用 Canvas `createPattern(image, 'repeat')` 在元素局部左上角起铺，保留图片原生像素密度，裁切到元素宽高后整体旋转，不把纹理拉伸到整个房间。俯视库的运行时纹理是128×128的1× PNG；2× PNG和SVG属于设计导出。

## 元素与独立占地

```json
{
  "id":"desk-01", "name":"工位01", "kind":"image", "assetId":"desk-asset",
  "x":400, "y":360, "width":144, "height":80, "rotation":0,
  "opacity":1, "color":"#e7e3db", "zIndex":0,
  "visible":true, "locked":false, "blocksMovement":true,
  "label":"01",
  "geometry": {
    "width":144, "height":80,
    "footprints":[{"x":0,"y":0,"width":144,"height":78}]
  }
}
```

`kind` 为 `image` 或 `rect`。图像必须引用有效 `assetId`，矩形使用 `color`。元素位置是中心点，围绕中心顺时针旋转。`label` 是可选短标签，独立于旋转方向保持正向显示。

可选 `screen: {x, y, width, height}` 同样使用资产左上角原点的 1× 局部坐标，用于声明「可显示内容的屏幕区域」（例如独立电脑图元 `computer-top`），必须完全落在元素尺寸内。编辑器会在这个矩形里绘制工作内容/状态，并在元素缩放时同步缩放；后续消费端可直接复用同一字段在屏幕上渲染真实状态。

`geometry` 可选，使用资产左上角为原点的1×局部坐标，`width` / `height` 是几何的基准尺寸。局部点按 `element.width / geometry.width` 和 `element.height / geometry.height` 缩放，减去元素半宽高，再旋转和平移到世界坐标。

- `footprints`：最多32个、完全位于基准尺寸内的非空矩形。碰撞使用它们的并集。无此字段时仍按整张元素旋转矩形碰撞。
- `connectors`：可选 `left/right/top/bottom` 点，位于素材边界，坐标与占地使用同一空间。启用吸附时，放置/拖动使邻近且朝向相反的连接点精确接触；容差为12屏幕像素。不是持久连接图，不会拖动整组相邻墙。
- `stretchAxis: "x" | "y"`：仅允许延伸墙长，对应短轴尺寸必须等于基准尺寸。属性面板禁用墙厚输入，画布缩放也保留厚度。
- 打开门的占地是两个门框和一个门扇，透明门洞不碰撞。打开/关闭态通过不同素材表示，没有门扇动画或一键状态切换。
- 盆栽默认只阻挡花盆占地。办公椅默认不阻挡行走。

碰撞不依赖图像 alpha、opacity、visible。隐藏不取消碰撞；需要将 `blocksMovement` 设为 false。选择命中和缩放角点使用视觉外框，绿色「占地」叠加显示实际物理矩形。

`locked` 只改变编辑器的选择行为：锁定对象在画布上不可点选、框选或拖动，也不会被框选整组带走；导入导出、碰撞与前端渲染都不受影响。编辑器里可以 ⇧/⌘ 点击加选、在空白处拖动框选多个对象后整组移动。

## 区域

```json
{
  "id":"zone-01", "name":"员工禁入区", "type":"employee-no-entry",
  "points":[{"x":810,"y":35},{"x":1100,"y":35},{"x":1100,"y":265},{"x":810,"y":265}],
  "enabled":true,"visible":true,"locked":false
}
```

区域多边形隐式闭合，至少三个顶点、非零面积、无自交；边界也属于禁区。`walk-blocked` 阻止所有路径，`employee-no-entry` 仅限制员工，`spawn` 只标记候选出生范围，不豁免禁区。隐藏区域继续生效；`enabled: false` 才停用。

## 房间与工位

```json
{
  "rooms": [{
    "id":"room-meeting-a", "name":"会议室 A", "type":"meeting", "capacity":4,
    "bounds":{"x":48,"y":48,"width":432,"height":352},
    "approachPoint":{"x":416,"y":360},
    "occupied": false
  }],
  "seats": [{
    "id":"seat-01", "name":"工位01", "deskElementId":"desk-01",
    "x":400,"y":442,"facing":"back",
    "seatOffset":{"x":0.5,"y":1.525},
    "approachOffset":{"x":0.5,"y":2.3},
    "approachPoint":{"x":400,"y":504}
  }],
  "spots": [{
    "id":"spot-meeting-room-meeting-a", "name":"会议室 A", "kind":"meeting",
    "x":416, "y":360, "speed":58, "stay":8, "enabled":true,
    "roomId":"room-meeting-a"
  }]
}
```

`rooms.type` 为 `meeting/pantry/restroom/work/lounge`。`bounds` 位于地图内，`capacity` 为0–1000整数。房间是描述与标签，不会自动生成墙、限制通行或推断建筑边界；修改墙体后不会自动重建房间元数据，可在 JSON 中更新名称、容量与范围。

工位必须引用现有桌元素，可选 `chairElementId` 引用独立椅图元，可选 `computerElementId` 引用独立电脑图元。`seatOffset` 与 `approachOffset` 是元素局部的归一化坐标，允许位于图片外（各轴 -5 到5）；桌的移动、缩放和旋转会更新工位位置及接近点。`facing` 为 `front/back/left/right`；未绑定动画员工时按桌的最接近90°方向更新，绑定 `employee` 时保留用户显式选择。

可选 `chairOffset` 指定椅中心在桌局部归一化坐标中的位置（各轴-5到5）；存在时桌移动/旋转/缩放会更新椅位置、角度、尺寸（椅宽=桌宽×0.58，高按492/474原比例）。可选 `computerOffset` 用同一规则更新独立电脑图元的位置与角度（尺寸不变；AIFred 电脑默认按贴图基准 82.5×55 放大 1.25×，素材记录 `defaultScale: 1.25`，`asset.width/height` 仍保存贴图基准，`screen` 按 `element.width / asset.width` 换算）。未绑定椅/电脑仍独立编辑。复制已有工位桌会复制其引用的椅子与电脑，删除桌清除对应工位记录，不自动删除原椅/电脑。一个桌不能被多个座位重复引用。

可选 `employee: {resourceId, skin, animation, enabled, name}`：目前仅允许资源ID `aifred-chibi-stickers`、AIFred现有9皮肤，以及 `idle/thinking/talking/walking` 动画状态；`enabled` 为布尔值，演示姓名最大60字符，必须有 `seatOffset`。旧v1不允许员工动画绑定。员工是编辑预览，不新增物理障碍或真实账号。顶部暂停开关只影响播放，不改变配置状态。

角色骨架/atlas不包含在内嵌地图JSON中，需目标编辑器已有同一员工库与已构建Pixi/Spine模块；资源路径固定，不允许JSON任意指定远程角色文件。渲染用骨架是派生文件 `chibi-stickers-walk.json`：原骨架加工作打字动画 `emotes/typing`，走路动画保持原样。原骨架 byte-exact 不变，生成方式见 `npm run office:anim`。详见 [AIFred资源复用](aifred-resources.md)。

`layout` 是示例说明，含风格 ID、常驻人数、入口、出生点和主通道描述，不作为额外碰撞规则。会议室座椅不计入10个常驻工位。

所有素材、元素、区域、房间、工位与活动点 ID 全局唯一。可选元数据不等于员工代理创建、身份分配、门禁、建筑/消防/无障碍合规验证。

## 房间使用状态与自由活动锚点

`rooms[].occupied` 是布尔值（缺省视作 `false`）：标记为 `true` 的房间表示「使用中」，前端渲染会在房间右上角画红色徽标，并且**员工自由活动不会进入该房间**。编辑器「地图设置」面板的房间清单可直接勾选，绑定该房间的活动点属性面板里也有同一个开关。

`spots[]` 是自由活动目的地锚点，前端「闲置员工每 30 秒出门走走」就走向这些点：

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `id` | 唯一，≤120 字符 | 按房间生成时用 `spot-<kind>-<roomId>` 稳定生成 |
| `name` | ≤120 字符 | 显示在编辑器画布与前端标签上 |
| `kind` | `pantry/restroom/meeting/corridor/custom` | 决定默认步速与锚点配色 |
| `x` / `y` | 地图范围内整数 | 锚点坐标，拖动标记即修改 |
| `speed` | 5–300 | 走到该锚点的步速（px/s），缺省用类型默认值 |
| `stay` | 0–600 | 到达后停留秒数，缺省 8 |
| `enabled` | 布尔 | 关掉后员工不会选这个点 |
| `roomId` | 可选，必须引用现有房间 | 绑定后受房间「使用中」联动 |

默认步速（`SPOT_SPEEDS`）：厕所 85 > 茶水间 65 > 自定义 60 > 会议室 58 > 过道 45。编辑器工具栏的「活动点」可点选放置，「地图设置 → 按房间生成活动点」会按 `meeting/pantry/restroom/lounge` 房间补齐锚点（已有绑定的房间跳过，可重复点击）。旧地图没有 `spots` 时前端回退到按房间与主通道推导目的地，不会报错。

## 消费与示例

消费顺序：校验格式 → 载入素材 → 绘制地面/底图 → 按 `zIndex` 绘制元素 → 用 `elementFootprints` 和启用的区域规则构建碰撞 → 分配合法出生点及寻路。角色半径通过障碍距离检查体现。

可复用 `src/model.js` 的 `validateMap`, `elementPoint`, `elementFootprints`, `elementConnectors`, `blockers`, `clearSegment`, `findPath`；它们不依赖 DOM。仅支持旧 v1 的消费端不能直接使用 v1.1 配置，否则打开门可能被错误阻挡。

- 新办公室：[10人 / 3会议室 / 茶水间 / 厕所](../examples/office-10-person.json)。
- 可复现装配：`src/office-layout.js`，运行 `npm run generate:example` 重新生成示例。
- 旧格式兼容示例：[office-map/v1](../examples/office-map.example.json)。
