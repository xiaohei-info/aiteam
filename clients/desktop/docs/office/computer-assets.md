# 办公室电脑资源待办事项

## 概述
已在办公室详情中添加电脑图层，图层顺序为：**桌子 - 电脑 - 人 - 椅子**

电脑分为**两层纹理**：
1. **电脑底图**（静态PNG）：显示器外框 + 底座
2. **屏幕内容**（4个GIF）：叠加在底图上，显示不同工作状态

## 需要准备的资源文件

### 1. 电脑底图（静态PNG）
**路径**: `/public/assets/office/office_computer_bg.png`
**内容**: 显示器外框 + 底座，**屏幕区域透明或留白**
**要求**:
- 俯视 3/4 视角（与桌椅风格一致）
- 台式机显示器 + 底座
- 透明背景 PNG 格式
- 建议尺寸: 400x300 像素左右
- 屏幕区域需要透明或纯色留白，用于叠加屏幕内容gif

### 2. 屏幕内容 GIF（4个）
所有 GIF 需要透明背景，尺寸建议 **320x180 像素左右**

#### 日常办公状态
**路径**: `/public/assets/office/screen-working.gif`
**内容**: 办公软件界面、文档编辑等动画

#### 浏览文件状态
**路径**: `/public/assets/office/screen-browsing.gif`
**内容**: 文件夹浏览、文件列表滚动等动画

#### 写代码状态
**路径**: `/public/assets/office/screen-coding.gif`
**内容**: 代码编辑器界面、代码滚动、语法高亮等动画

#### 休息状态
**路径**: `/public/assets/office/screen-idle.gif`
**内容**: 屏保动画、待机画面等

## 代码实现位置

### 已修改的文件
1. **src/scene/office/loadOfficeAssets.ts**
   - 加载 `computer.png` 作为电脑底图
   - 导出 `getComputerPngTexture()` 方法

2. **src/scene/office/DeskChairEntity.ts**
   - 电脑为 Container，包含两层：
     - `computerBase`: 电脑底图（显示器外框）
     - `computerScreen`: 屏幕内容gif
   - `setComputerScreenStatus()` 方法切换屏幕内容

3. **src/scene/office/OfficeScene.ts**
   - 在工位创建时传入电脑底图纹理
   - 默认初始化为 'working' 状态
   - `setComputerScreenStatus()` 公共方法切换状态

## 使用示例

```typescript
// 在办公室场景中切换某个员工的电脑屏幕状态
officeScene.setComputerScreenStatus(agentId, 'coding')

// 可用的状态：
// - 'working': 日常办公
// - 'browsing': 浏览文件
// - 'coding': 写代码
// - 'idle': 休息
```

## 调整说明

### 电脑底图尺寸
修改 `src/scene/office/DeskChairEntity.ts` 第15行：
```typescript
const COMPUTER_PNG_SIZE = { w: 实际宽度, h: 实际高度 }
```

### 屏幕内容尺寸
修改 `src/scene/office/DeskChairEntity.ts` 第16行：
```typescript
const SCREEN_SIZE = { w: 实际宽度, h: 实际高度 }
```

### 电脑相对桌子的大小
修改 `src/scene/office/DeskChairEntity.ts` 第25行：
```typescript
const COMPUTER_TO_DESK_RATIO = 0.75 // 电脑占桌子宽度的比例
```

### 屏幕在电脑底图上的位置
修改 `src/scene/office/DeskChairEntity.ts` 第113行：
```typescript
this.computerScreen.position.set(0, -COMPUTER_PNG_SIZE.h * 0.15 * computerScale)
// 调整这个系数来改变屏幕的垂直位置
```

### 电脑在桌面上的位置
修改 `src/scene/office/DeskChairEntity.ts` 第124行：
```typescript
this.computer.position.set(0, -chairHeightPx * 0.5) // 调整这个系数
```

## 制作建议
1. **电脑底图**：只包含显示器外框和底座，屏幕区域透明
2. **屏幕内容gif**：只包含屏幕内的内容，有简单的循环动画
3. 保持俯视 3/4 视角，与桌椅风格一致
4. 使用透明背景，便于叠加
5. gif 文件大小控制在 500KB 以内
