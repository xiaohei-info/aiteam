# 办公室场景调整指南

## 📍 关键代码位置

### 1. 显示区域调整

**文件**: `src/scene/office/OfficeScene.ts`

**位置**: 第 65-70 行

```typescript
const HALL_AREA = {
  x: 60,      // 开放办公区左上角 X 坐标
  y: 285,     // 开放办公区左上角 Y 坐标
  w: 835,     // 开放办公区宽度
  h: 900,     // 开放办公区高度
}
```

**说明**:
- 单位：像素（相对于 1254x1254 画布）
- 调整 `x`, `y` 可以移动整个办公区的位置
- 调整 `w`, `h` 可以改变办公区的大小
- 所有工位都会在这个矩形区域内自动排列

---

### 2. 员工名片位置调整

**文件**: `src/scene/office/DeskChairEntity.ts`

**位置**: 第 116 行

```typescript
private createNameCard(chairHeight: number): Container {
  const card = new Container()
  const cardY = -chairHeight * 1.2  // 👈 调整这个系数可以改变名片高度
  // ...
}
```

**说明**:
- `cardY = -chairHeight * 1.2`
  - 系数 **1.2** 控制名片距离员工头顶的距离
  - **增大系数**（如 1.5）：名片更高，离员工更远
  - **减小系数**（如 1.0）：名片更低，离员工更近
  - **负号**表示向上移动

---

### 3. 名片样式调整

**文件**: `src/scene/office/DeskChairEntity.ts`

**位置**: 第 119-150 行

```typescript
// 姓名文本样式
const name = new Text({
  text: nameText,
  style: {
    fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
    fontSize: 13,        // 👈 姓名字体大小
    fontWeight: '600',   // 👈 姓名字体粗细
    fill: 0x1a1a1a,     // 👈 姓名颜色（十六进制）
  },
})

// 职位文本样式
const role = new Text({
  text: roleText,
  style: {
    fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
    fontSize: 10,        // 👈 职位字体大小
    fontWeight: '400',   // 👈 职位字体粗细
    fill: 0x666666,     // 👈 职位颜色（灰色）
  },
})

// 名片背景样式
const padding = 8                        // 👈 内边距
bg.roundRect(-cardWidth / 2, 0, cardWidth, cardHeight, 6)  // 👈 圆角半径
bg.fill({ color: 0xffffff, alpha: 0.95 })  // 👈 背景色和透明度
bg.roundRect(-cardWidth / 2, 0, cardWidth, cardHeight, 6)
bg.stroke({ color: 0xe0e0e0, width: 1, alpha: 0.5 })  // 👈 边框颜色和宽度
```

**常用颜色参考**:
- `0x1a1a1a` - 深灰色（接近黑色）
- `0x333333` - 中灰色
- `0x666666` - 浅灰色
- `0xffffff` - 白色
- `0x4a90e2` - 蓝色
- `0xff6b6b` - 红色

---

### 4. 工位布局调整

**文件**: `src/scene/office/OfficeScene.ts`

**位置**: 第 168-209 行

```typescript
private buildLayoutInHall(agentCount: number): SeatLayout {
  // ...
  
  if (total <= 4) {
    // 1-4 人：横向一排
    cols = total  // 👈 修改这里可以改变 1-4 人的排列方式
    rows = 1
  } else if (total <= 8) {
    // 5-8 人：每排 4 人
    cols = 4      // 👈 修改这里可以改变 5-8 人每排的人数
    rows = Math.ceil(total / cols)
  } else if (total <= 12) {
    // 9-12 人：每排 4 人
    cols = 4      // 👈 修改这里可以改变 9-12 人每排的人数
    rows = Math.ceil(total / cols)
  } else {
    // 13+ 人：自动计算
    // ...
  }
}
```

**说明**:
- 可以为不同人数范围设置不同的排列规则
- `cols` = 每排人数
- `rows` = 行数（自动计算）

---

### 5. 桌椅间距调整

**文件**: `src/scene/office/OfficeScene.ts`

**位置**: 第 57-59 行

```typescript
/** 桌子在 cell 里占的宽度比例，其余为工位间通道 */
const DESK_CELL_FILL = 0.62  // 👈 调整这个值可以改变桌子间距
/** 椅子相对桌子的宽度比例 */
const CHAIR_TO_DESK_RATIO = 0.58  // 👈 调整椅子相对桌子的大小
```

**说明**:
- `DESK_CELL_FILL = 0.62` 表示桌子占格子宽度的 62%，剩余 38% 是走道
  - **增大值**（如 0.7）：桌子更大，间距更小，更拥挤
  - **减小值**（如 0.5）：桌子更小，间距更大，更宽敞
- `CHAIR_TO_DESK_RATIO = 0.58` 表示椅子是桌子宽度的 58%

---

### 6. 员工角色大小调整

**文件**: `src/scene/office/DeskChairEntity.ts`

**位置**: 第 62-66 行

```typescript
/** 椅子相对桌子的宽度比例 */
const CHAIR_TO_DESK_RATIO = 0.58
/** 员工相对椅子的宽度比例 */
const CHARACTER_TO_CHAIR_RATIO = 1.1  // 👈 调整员工角色大小
/** 员工 Spine 参考宽度 */
const SPINE_REFERENCE_WIDTH = 200
/** 员工头顶相对椅子中心的上移比例 */
const CHARACTER_HEAD_LIFT_RATIO = 0.55  // 👈 调整员工在椅子上的位置
```

**说明**:
- `CHARACTER_TO_CHAIR_RATIO = 1.1`
  - 值越大，员工角色越大
  - 建议范围：0.8 - 1.5
- `CHARACTER_HEAD_LIFT_RATIO = 0.55`
  - 值越大，员工坐得越高
  - 建议范围：0.4 - 0.7

---

## 🎯 常见调整场景

### 场景 1: 名片太高/太低

**调整**: `DeskChairEntity.ts` 第 116 行
```typescript
const cardY = -chairHeight * 1.2  // 改为 1.0（更低）或 1.5（更高）
```

### 场景 2: 工位太密集/太稀疏

**调整**: `OfficeScene.ts` 第 57 行
```typescript
const DESK_CELL_FILL = 0.62  // 减小（更稀疏）或增大（更密集）
```

### 场景 3: 改变显示区域

**调整**: `OfficeScene.ts` 第 65-70 行
```typescript
const HALL_AREA = {
  x: 60,    // 向右移动：增大值
  y: 285,   // 向下移动：增大值
  w: 835,   // 区域更宽：增大值
  h: 900,   // 区域更高：增大值
}
```

### 场景 4: 改变每排人数

**调整**: `OfficeScene.ts` 第 185 行（5-8人的情况）
```typescript
cols = 4  // 改为 3（每排3人）或 5（每排5人）
```

### 场景 5: 名片字体更大

**调整**: `DeskChairEntity.ts` 第 125 和 137 行
```typescript
fontSize: 13,  // 姓名改为 15 或 16
fontSize: 10,  // 职位改为 12 或 13
```

---

## 📝 修改后的操作

1. 保存文件
2. 重新编译：`npm run build`
3. 重启应用：`pnpm tauri dev`
4. 查看效果

---

## ⚠️ 注意事项

1. **坐标系统**：
   - 原点 (0, 0) 在画布左上角
   - X 轴向右增长，Y 轴向下增长

2. **单位统一**：
   - 所有坐标和尺寸单位都是像素
   - 相对于固定的 1254x1254 画布

3. **比例关系**：
   - 调整一个元素的大小时，考虑其他元素的比例关系
   - 例如：桌子变大时，员工和名片可能也需要相应调整

4. **性能考虑**：
   - 工位数量过多（50+）时，考虑减小角色细节或降低渲染质量

5. **中文字体**：
   - 确保系统中有 PingFang SC 或 Microsoft YaHei 字体
   - 否则名片文字可能显示为默认字体

6. **地图数据 dev 与打包一致**：
   - dev 读取仓库 `public/assets/office/map/`；打包版读取应用数据目录 `office-maps/`，其中的 `office-10-person.json` 启动时会跟随安装包内置地图（即打包时的 `public/` 版本）
   - 内置地图内容变化时会覆盖应用数据目录里的同名文件，旧文件备份为 `office-10-person.json.bak`；内置地图没变时不会动它，所以在打包版编辑器里的修改会保留到下次内置地图变化为止
   - 改完地图后需要重新打包才会带入新版本
