> 本目录是 AI Team 单仓里的办公室地图编辑器（`clients/office-map-edit-tool`），2026-10-30 从原 gitee 仓库 `YFXSL/office-map-edit-tool` 迁入（不含历史，基于本地 `eca498a` 加当时未提交的改动，比 gitee `main` 的 `7fdc0e8` 新）。原 gitee 仓库已弃用，只读保留。桌面端 `clients/desktop` 通过 `link:../office-map-edit-tool` 引用本目录，打包时拷进 `dist/office-editor/`。

# Office Map Studio

独立的办公室地图编辑工具。Node.js 20+；员工动画使用本地Pixi/Spine运行时，首次需要安装依赖。

```sh
cd clients/office-map-edit-tool
npm ci
npm start
```

浏览器打开 http://127.0.0.1:4174 。修改端口：`PORT=4175 npm start`。
该工具完全在本机运行，不连接 AITeam 后端，不上传图片或地图数据。

## 设计规范与文档

- [办公室地图设计要点与规范](docs/design-guidelines.md)：当前俯视轻立体方向、52款图元尺寸（含17款扩充的绿植/家具/摆件）、墙门拼接、物理占地、10人样板布局、导入展示及验收要求。
- [素材设计说明与Sketch源位置](assets/styles/topdown-soft/DESIGN.md)。
- [office-map/v1.1 配置契约](docs/config-format.md)。
- [AIFred工位与员工资源复用](docs/aifred-resources.md)：原资源来源、9皮肤/动态预览、锚点、安装构建、配置携带及许可边界。

## 编辑流程

1. 首次打开默认加载「10人工位 + 3会议室 + 茶水间 + 厕所」组件示例，没有整张办公室底图。已有浏览器草稿优先恢复，点击顶栏「10 人样例」可切换（会先确认替换）。「新建地图」仍创建无底图空白画布。
2. 默认素材库为「俯视 · 轻立体」，基础35款地面、四向墙/玻璃、连接件、家具（含工位桌与独立电脑）、门和设施，再加17款扩充的绿植、家具、摆件和打印机（分类：绿植 / 家具 / 摆件 / 设施，`npm run extras:topdown` 生成），加3款AIFred原有桌/椅/电脑，共55个选项；地面按原尺寸平铺。可以切换历史风格，或上传 PNG / JPEG / WebP。
3. 选择元素后拖动移动，拖动角点以中心缩放；右侧精确修改位置、宽高、旋转、透明度、图层与碰撞。墙仅沿长度延伸，不能改变厚度；启用吸附时墙/门端点会精确接触。连接件由用户放置，不会自动生成或整组跟随。
4. 批量编辑：⇧/⌘ 点击在现有选区上加减对象，在空白处按住拖动框选（矩形碰到即选中），⌘ A 全选，拖动任意一个选中对象整组移动，方向键微调（按住 ⇧ 按网格步进）。属性面板会切换成批量面板，可一次复制、删除、锁定或解锁。`locked` 对象不进入画布选区，也不会被框选带走。
5. 上方选择区域类型，使用矩形或多边形工具描绘禁区。多边形点击首点、双击或 Enter 完成，Esc 取消。禁止自交多边形。
6. 使用「测路」，依次点击起点、终点。地图设置中可选择验证对象和角色碰撞半径。
7. 点击「导出 JSON」。默认内嵌所需PNG图片，可携带单个JSON导入继续编辑；员工动画的骨架/atlas和运行时不内嵌，需目标编辑器拥有 `assets/aifred/` 和已构建动画模块。取消内嵌后，请同时携带项目 `assets/` 目录。

## 已配置的10人办公室

- 1600×1200逻辑像素，**10个独立工位**，双排各5桌；工位桌与电脑是两个独立图元（俯视工位桌 + 桌右的显示器），椅子与员工仍用AIFred原椅和现有Spine员工。
- **3个会议室**：4 / 6 / 4座，木地板、独立会议桌与座椅，玻璃面向主通道。
- **1个茶水间**：咖啡机、烧水壶、饮水机、清洗台、储物柜。
- **1间单人厕所**：座便器、洗手台，门向室内打开。
- 6个打开的门（含办公室入口），主通道、工位南北侧走道和入口内侧出生区。
- 共135个独立可编辑组件（10 工位桌 + 10 电脑 + 10 原椅 + 14 会议椅 + 31 件绿植与摆件 + 房间组件）；地面初始锁定（锁定后不会被点选，也不会被框选带走），可在图层列表解锁。房间标签来自JSON `rooms` 元数据，不会随墙体编辑自动推断边界；桌移动更新 `seats` 坐标，示例绑定椅子与电脑跟随；未绑定椅/电脑仍可独立编辑。
- 选中工位桌，可编辑演示姓名、现有9款皮肤、朝向、待机/思考/挥手/原地走动动画；顶部「动画」控制暂停/继续，不连接真实员工账号。

## 同步到 AIFred 前端

```sh
npm run sync:aifred-frontend   # 把样板地图与用到的俯视 PNG 复制到同级 clients/desktop
```

会在 `clients/desktop/public/assets/office/` 下生成 `map/office-10-person.json`、`map/manifest.json`（含来源与 SHA256）与 `topdown/*.png`，供前端办公室页面 1:1 复刻渲染。

- 工位画法与坐标规范：[docs/workstation-design.md](docs/workstation-design.md)
- 前端接入、屏幕内容/状态/移动轨迹 API：[`clients/desktop/docs/office/office-map-integration.md`](../desktop/docs/office/office-map-integration.md)

配置：[examples/office-10-person.json](examples/office-10-person.json)。装配源码：`src/office-layout.js`。运行 `npm run generate:example` 可确定性重建。常驻人数10不包含会议座位；像素布局与寻路演示不代表建筑/消防/无障碍合规。

## 区域语义

| type | 用途 | 员工路径 | 一般移动路径 |
| --- | --- | --- | --- |
| employee-no-entry | 员工禁入区 | 阻止进入及穿越 | 不限制 |
| walk-blocked | 行走禁区，物理障碍 | 阻止进入及穿越 | 阻止进入及穿越 |
| spawn | 员工出生候选区域 | 不改变通行权限 | 不改变通行权限 |

员工指所有员工；第一版没有按员工身份设置白名单。出生区仅是候选范围，消费端仍需检查实际出生点能否通行。

v1.1元素的 `blocksMovement` 优先使用 `geometry.footprints` 局部矩形集合，随尺寸和旋转转换；无独立占地时兼容整张旋转矩形。打开门的透明门洞可以通行，盆栽按花盆而不是叶片阻挡。上方「占地」可查看实际碰撞范围；复杂形状仍可关闭元素碰撞并单独绘制多边形禁区。
隐藏图层 `visible: false` 不会关闭碰撞；区域需设置 `enabled: false` 才会停用规则。`locked` 只影响编辑器交互：锁定对象在画布上不可点选、框选或拖动，导入导出与前端渲染的语义不变；在「图层」面板可以逐个解锁，或一次「解锁全部」。

## 素材与风格库目录

本工具支持**多风格资产分目录管理**，便于设计不同视觉风格的办公室：

```text
assets/
├── styles/
│   ├── styles.json            # 实际供界面读取的总索引，默认topdown-soft
│   ├── topdown-soft/          # 俯视轻立体：52款PNG/@2x/SVG与几何元数据（35款Sketch导出 + 17款代码生成的扩充图元）
│   ├── isometric-3d/          # 现代立体 3D 风格（对标 3D 渲染微透视底图）
│   │   ├── style.json         # 历史3D图元清单（12款含模块墙）
│   │   ├── desk-3d.png        # 3D 办公桌（带立柱、文件柜、直立显示器与接触阴影）
│   │   ├── chair-3d.png       # 3D 办公转椅（五星轮底座与高靠背）
│   │   ├── wall-solid-3d.png  # 3D 实体剖切墙（白色顶面剖切 + 垂直立面 + 踢脚线）
│   │   ├── wall-glass-3d.png  # 3D 玻璃隔断（金属收口轨 + 渐变玻璃反光条）
│   │   ├── water-dispenser-3d.png # 3D 桶装饮水机（高光储水桶 + 接水暗槽）
│   │   ├── coffee-machine-3d.png  # 3D 咖啡吧台与意式机
│   │   ├── sofa-3d.png        # 3D 双人皮质沙发（饱满座垫与靠背扶手）
│   │   ├── plant-large-3d.png # 3D 落地圆盆绿植
│   │   └── meeting-table-3d.png   # 3D 实木会议长桌（实木倒角厚度 + 走线盒）
│   │
│   ├── classic-cutout/        # 经典原图切片风格（28 款原图参考裁切）
│   │   └── style.json
│   │
│   └── flat-blueprint/        # 极简平面图元风格（纯色块与线框）
│       └── style.json
│
├── aifred/                    # AIFred原资源快照 + manifest SHA256来源
├── runtime/                   # 本地生成Pixi/Spine模块和许可文本（不入Git）
├── crops/                     # 历史原图样板切片
├── desk.png / chair.png       # 基础通用图元
└── icon_office_10.png / 50.png # 官方 10人 / 50人 3D 渲染底图
```

### 如何新增一套新风格

如需扩展新风格（如像素风 `pixel-art`、北欧原木风 `scandinavian`、工业风 `industrial` 等）：
1. 在 `assets/styles/` 下新建子目录，如 `assets/styles/pixel-art/`；
2. 放入独立透明背景的 PNG 图元；
3. 在该目录下新建 `style.json` 登记图元：
   ```json
   {
     "id": "pixel-art",
     "name": "复古像素风 (Pixel Art)",
     "elements": [
       { "id": "px-desk", "name": "像素办公桌", "category": "家具", "kind": "image", "src": "assets/styles/pixel-art/desk.png", "width": 64, "height": 48, "blocksMovement": true }
     ]
   }
   ```
4. 在 `assets/styles/styles.json` 中追加 `{ "id":"pixel-art", "name":"复古像素风", "path":"assets/styles/pixel-art/style.json" }`，编辑器会动态读取，刷新后可切换。允许一项 `default: true`。旧原图切片使用 `source` 指向样板清单，其他风格使用 `elements`。

## 坐标与配置

见 [配置说明](docs/config-format.md) 和 [示例配置](examples/office-map.example.json)。
坐标为像素，原点左上，X 向右，Y 向下。元素坐标是中心点，旋转围绕中心顺时针。区域顶点使用地图绝对坐标。
图层 `zIndex` 小的先渲染，区域编辑覆盖层在元素上方。底图拉伸到画布宽高，底图不自动产生碰撞。

新地图使用 `office-map/v1.1`，旧v1配置可导入；新增含占地的素材会升级版本。导出保留平铺、局部占地、连接点和房间/工位元数据，不含选中态、镜头或路径测试结果。消费端必须理解v1.1，不能仍用整张图片矩形去阻挡打开的门。
AITeam 当前 `OfficeScene` 尚未接入此新格式，本次不修改其运行逻辑。此工具输出的是后续接入的配置契约。

## 保存与快捷键

- 编辑后自动保存到当前浏览器、当前端口下的 IndexedDB；重开自动恢复最后的草稿。浏览器清理站点数据会删除草稿，请用导出文件备份。
- 新建或导入会替换当前草稿，需要确认。导入严格校验版本、坐标、素材来源、重复 ID 和区域形状，失败不覆盖现有地图。
- 撤销 / 重做最多保存 60 个快照；拖动一次算一个操作。
- V 选择，H 平移，R 矩形区域，P 多边形区域，T 测路。
- 空格 + 拖动平移，滚轮缩放，方向键微调，Shift + 方向键按网格移动。
- ⌘/Ctrl + Z 撤销，⌘/Ctrl + Shift + Z 重做，⌘/Ctrl + D 复制，Delete 删除，⌘/Ctrl + S 导出。
- 小于 850px 的窗口通过工具栏「属性面板」显示右侧面板；建议在桌面宽屏使用。

## 验证与限制

```sh
npm test
```

测试覆盖 JSON 往返、旧v1兼容、局部占地、打开门洞、旋转连接点、52款资产尺寸/边界与扩充图元可复现性、示例复现与人数/房间计数、员工与屏幕不遮挡、入口到五功能房间及10工位接近点的通路（角色半径12px），以及既有禁区、薄墙和撤销重做。AIFred专项测试覆盖15原文件hash、9皮肤/动画映射、员工绑定验证、椅跟随和JSON往返。

浏览器交互验证使用 `npm run test:browser`（Node22+、先启动服务与独立临时profile的无头Chrome，调试端口9227）。覆盖默认示例、原尺寸平铺、五个房间Worker测路、墙端点吸附/厚度、员工Spine帧推进/暂停/配置、编辑与JSON导出/导入、草稿恢复、1024px布局；截图输出到 `test-results/`。测试会清理测试profile的本站IndexedDB，勿指向日常浏览器profile。
寻路预览使用保守四方向网格搜索，检测实际路径段与多边形距离，防止穿过薄墙；最大按地图长边 160 格采样。非常窄或复杂的可行路径可能因采样分辨率显示不可达，消费端可采用自己的导航算法。
单个上传图片最大 8 MB / 8192px，JSON 最大 40 MB，画布最大 8192 × 8192，每类记录最多 2000 个。
