# AIFred工位与员工资源复用

记录日期：2026-10-01。用户要求：办公室地图编辑方案保留，但**工位和员工采用AIFred前端已有资源，编辑器内也播放员工动画**。

## 1. 资源来源与边界

AIFred前端位于同级 `AITeam/`。本轮不修改其源码或原资源，也不连接后端、真实员工账号、头像或实时工作状态。

| 对象 | AIFred原文件 | 编辑器快照 |
| --- | --- | --- |
| 桌子 | `AITeam/public/assets/office/desk.png` | `assets/aifred/office/desk.png` |
| 椅子 | `AITeam/public/assets/office/chair.png` | `assets/aifred/office/chair.png` |
| 电脑 | `AITeam/public/assets/office/office_computer_bg.png` | `assets/aifred/office/office_computer_bg.png` |
| Spine员工 | `AITeam/public/assets/characters/chibi-stickers/` | `assets/aifred/characters/chibi-stickers/` |

共同步15个原文件：3个工位PNG、Spine骨架JSON、atlas及10个atlas页面PNG。`assets/aifred/manifest.json`记录来源、文件大小和SHA-256；不是重新绘制角色或从整张atlas直接截一块当员工。快照避免独立编辑器在运行时依赖同级前端目录，需主动同步才能更新。

配置参考：`AITeam/src/config/office/characters.ts`；组合锚点与比例参考 `AITeam/src/scene/office/DeskChairEntity.ts`；员工缩放和动画映射参考 `SpineCharacter.ts`。没有把整个React/Tauri前端搬入编辑器。

## 2. 工位组合

- 原桌920×582、原椅474×492，桌显示宽144px，按原比例得到高约91.10px。
- 椅宽为桌宽的0.58，保持原椅宽高比。
- 桌锚点Y为0.62，椅锚点Y为0.36；员工原点与共用座位锚点对齐。
- 员工采用AIFred的 `0.32 × (椅宽 × 1.1 / 200)` 骨架缩放逻辑。
- 基本顺序是桌 → 员工 → 椅，椅背遮挡部分员工；墙、门、工具叠加按编辑器原图层顺序保留。
- 电脑原PNG作为可选独立图元提供。原桌贴图已有显示器，样板不另加一台造成重复；未接入屏幕GIF状态。
- 样板双排各5工位，两排都使用原桌贴图原方向；员工默认背面待机。**不得为了俯视一致性重新绘制或拉扁用户指定的原资源。**
- 墙/地/门、会议室桌椅、茶水/卫生设施仍采用俯视轻立体设计。只有常驻工位与员工是现有AIFred视角的明确复用例外。

桌的碰撞采用编辑器的局部矩形适配，不按透明外框或高耸显示器阻挡。这里的占地是软件适配数据，不是宣称AIFred前端已有同一套碰撞或建筑测量值。

## 3. 角色与交互

现有皮肤：`misaki`、`erikari`、`nate`、`harri`、`luke`、`soeren`、`mario`、`sinisa`、`spineboy`。默认按AIFred相同的稳定索引函数分配；10人可重复使用9款皮肤，不新造第10款。

- 朝向：`front/back/left/right`，可在工位属性中选择；**工位默认 `back`（背对镜头，只看到后脑，不用正脸）**。
- 待机：`movement/idle-{facing}`。
- 思考：`emotes/thinking`。
- 挥手/说话预览：`emotes/wave`，不是语音驱动口型。
- 原地走动预览：`movement/trot-{facing}`，不改变员工位置，不替代寻路。

**朝向的 left/right 指屏幕左右，但资源里的动画名是按角色自身左右命名的（角色正面朝镜头），两者相反**：名为 `idle-left` / `trot-left` 的动画在屏幕上其实朝右。所以 `employeeAnimation()` 把屏幕朝向 `left` 映射到名字为 `right` 的动画（反之亦然），保证选择了「向左」时人物动作与朝左一致；前端 `AITeam/src/config/office/characters.ts` 的 `idleAnimByFacing` / `trotAnimByFacing` 做同一层对调。改回同名映射会让员工左右移动时身体动作与运动方向相反。

选中工位桌后，右侧可以编辑演示姓名、皮肤、朝向、动画、显示状态。顶部「动画」复选框暂停/继续所有员工动画，暂停不删除员工。姓名仅用于预览，不代表身份绑定。

左侧所有风格库都附加3个AIFred工位图元；默认俯视库52款加这3款，共55个可选项。放置「俯视工位桌」（`desk-workstation-top`）会同时建立 AIFred 办公椅、桌面右侧的 AIFred 电脑图元和演示员工。当前10人样板为135个组件：10工位桌、10 AIFred电脑、10原椅、14会议椅、31件绿植与摆件及其余房间组件；员工是工位配置而不是额外障碍元素。

示例工位通过 `chairOffset` 绑定椅子、通过 `computerOffset` 绑定电脑，移动/旋转/缩放桌时两者及员工锚点跟随。椅图元仍可选中，但绑定椅的中心/角度/尺寸由桌计算；需要独立摆椅时在JSON移除 `chairOffset`。复制工位继承员工配置并复制椅子与电脑；删除桌会清除对应座位，已有椅/电脑图元仍保留，可单独删除。

**默认座位布局：工位桌与电脑是两个独立图元，员工坐在桌子左侧（`seatOffset` = `0.18, 1.19`），电脑用 AIFred 原电脑图（`office_computer_bg.png`，贴图基准 82.5×55，默认放大 1.25× 到 103.125×68.75）摆在桌面右侧（`computerOffset` = `0.75, 0.27`，底边/键盘位置不变，只向桌后方长高），员工默认背对镜头（`facing: back`，只看到后脑，不用正脸）。** 桌子本身不含显示器，所以屏幕可以在俯视下完整露出、不被员工头部或身躯遮挡。员工整体下移到桌面内，**整个头都露在椅子以上**；椅子（`chairOffset` = `0.14, 1.14`）停在人身后、往电脑对面偏左一点，遮住下半身。屏幕内容绘制在电脑图元自带的 `screen` 矩形内（AIFred 电脑的屏幕区为 `13.7, 3.8, 55.1, 35.4`），随员工动画变色（待机绿、思考蓝、挥手黄）；后续可在这个矩形里接真实工作内容与状态。

现有浏览器草稿不会被自动改成新资源。刷新后点击「10 人样例」加载更新的配置，替换前先导出需要保留的草稿。

### 行走时膝盖要朝行进方向（不改走路动画）

原骨架的 `left` / `right` 是按角色自身左右命名的：名为 `trot-left` 的动画在屏幕上朝右走。编辑器 `employeeAnimation` 与前端 `trotAnimByFacing` 都做了这层对调，在这个映射下**原骨架的走路动画本身就是对的**：身体朝行进方向，两条腿的膝盖都朝行进方向弯。

曾经另外给 `trot-left` / `trot-right` 加过「小腿旋转取反 + 删除 IK `bendPositive`」的补丁。它和朝向对调修的是同一个问题，两者叠加后膝盖反而朝身后弯（反关节），已删除。现在走路动画与原骨架逐字节一致，**不要再对走路动画做取反类补丁**。

渲染用的派生文件 `chibi-stickers-walk.json`（沿用历史文件名）= 原骨架 + 工作打字动画 `emotes/typing`，由 `npm run office:anim` 生成，`npm run sync:aifred-frontend` 会一并同步给前端。测试会：

- 校验派生文件 ≡ 原骨架 + 打字动画，其它内容逐字节一致；
- 用 `spine-core` 逐帧计算骨骼世界坐标，确认屏幕左右走路时脸朝行进方向，膝盖到「髋—脚」连线的偏移在所有帧都朝前。旧补丁在这项检查里有 22–30/40 帧膝盖朝后，会直接失败。

行走时腿骨是否真的在动，可用预览页核对：走动中 `leg-target-*`（IK 目标）与蹼骨世界坐标持续变化，动画时间轴逐帧推进。

## 4. 配置契约

继续使用 `office-map/v1.1`，桌椅/电脑为普通图片元素。在 `seats` 中新增可选绑定：

```json
{
  "id":"seat-01", "name":"工位01", "deskElementId":"desk-01",
  "chairElementId":"chair-01", "computerElementId":"computer-01", "x":168, "y":704.48,
  "facing":"back", "seatOffset":{"x":0.18,"y":1.19},
  "chairOffset":{"x":0.14,"y":1.14},
  "computerOffset":{"x":0.75,"y":0.27},
  "employee":{
    "resourceId":"aifred-chibi-stickers", "skin":"misaki",
    "animation":"idle", "enabled":true, "name":"员工01"
  }
}
```

上面坐标为示意；精确椅偏移按原图比例计算，详见 [样板JSON](../examples/office-10-person.json)和 `src/aifred-resources.js`。

- `employee`可选；旧地图没有此字段时，不会凭空增加员工。
- 同一桌只能绑定一个座位，资源ID、皮肤、动画、布尔状态和姓名均验证；不允许导入任意远程骨架URL。
- 配置保留员工选择的显式朝向，不再由桌的旋转强制覆盖。
- JSON和IndexedDB保留员工皮肤/朝向/状态，内嵌导出仍内嵌桌椅等PNG。
- **员工骨架、atlas和运行时不内嵌进单个地图JSON。** 动画绑定引用本编辑器已安装的 `assets/aifred/` 资源。要在另一台电脑播放动画，应携带此项目/运行时与员工资源，并安装依赖；单个JSON不足以让任意旧渲染器播放Spine。

## 5. 安装、构建与同步

独立编辑器不再是零依赖：采用与AIFred本机安装版本一致的Pixi `8.20.1`、Spine Pixi运行时 `4.2.120`，esbuild `0.25.12`用于本地打包。

```sh
cd office-map-edit-tool
npm install
npm start
```

`npm start` / `npm run dev`会先本地构建 `assets/runtime/employees.js`，不使用CDN。生成目录已忽略，不作为手写源维护。仅更新员工源模块而服务已启动时，运行 `npm run build:employees` 后刷新页面。

```sh
npm run sync:aifred       # 从同级AITeam重新同步原资源与hash
npm run generate:example  # 重建工位/房间样板
npm run build:employees   # 打包运行模块并保留Spine许可证
npm test
```

员工通过离屏WebGL渲染，再合成到原Canvas编辑画布中，不是始终浮在最上层的覆盖画布。隐藏页面不推进预览；同时动画预览上限64个，超出时状态栏提示。需要浏览器支持WebGL；加载失败会提示原因，其他地图编辑仍可使用，但不能把无员工动画降级视为验收成功。

## 6. 验证与许可

`tests/aifred-assets.test.mjs`检查15文件快照hash、9皮肤和动画名、绑定验证、JSON往返、椅跟随及重复绑定拒绝。原地图/占地/门洞/路径测试继续执行。真实浏览器还需确认员工帧推进、暂停、皮肤/朝向/状态编辑、导出/导入/草稿恢复及最终截图，单看骨架加载成功不足以证明动画可用。

2026-10-01接入验收：`npm test` **34/34通过**；最终真实浏览器测试通过，验证10个原Spine角色实际改变画布像素、暂停时像素稳定、皮肤/朝向/状态编辑、员工JSON/草稿恢复、新增工位自动绑定、复制/撤销，以及原地图操作与五房间测路。整体与员工属性截图已审阅，首排标签重叠已消除。测试用Chrome已显式停止，用户浏览器草稿未被清理。

历史失败仅为 `200 × 0.58` 浮点结果与116的严格相等比较；比例断言已用1e-9容差修正，不改变产品计算或占地。主动LSP探测未报告错误但无法全量确认clean；安装时npm audit报告0漏洞，不等于完整安全/许可审计。

Spine是带专用许可证的运行时，不能视为普通MIT依赖。构建文件保留原版权/许可证头，并生成 `assets/runtime/SPINE-LICENSE.txt`。项目使用和再分发需符合Spine Editor/Spine Runtimes许可及原美术资源授权；本次复用与技术检查不等于已经审查或授予这些许可。
