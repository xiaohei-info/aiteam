# P09 Office Design

## 目标

在不扩新增北向 API、不引入第二套事件协议的前提下，把 `P09` 办公室动态页收口到更接近 PRD 原型和验收规格的状态，优先补齐“办公室空间浏览表达”与“原型式交互”，并保持现有 `/api/team/office/scene`、`/api/team/office/feed` 合同稳定。

## 边界

- 只覆盖 `P09-F01 ~ P09-F05`。
- 不修改 `P07`、`P08`、`P10` 产品代码。
- 不新增 Team Panel 北向 API。
- 不把办公室页做成第二个工作台；保持只读聚合 + 上下文跳转。

## 当前事实

- 现有实现主入口是 [app/static/aiteam/pages/office.js](/Users/chiangguantik/.codex/worktrees/a3b4/aiteam/app/static/aiteam/pages/office.js)，而不是 preview 用的 `office-scene.js`。
- 现有测试 `app/tests/aiteam/layer2_team_panel/test_team_office_contract.py` 与 `app/tests/aiteam/layer4_frontend_bff/test_office_page.py` 已经覆盖：
  - scene/feed 合同 shape
  - 全屏按钮
  - 按钮式缩放/平移/重置
  - 工位详情与上下文跳转
  - 队列统计与活动日志
- 对照 `docs/需求文档/AI-Team-Office.html`，最明显的差异在：
  - 原型强调 `拖拽平移 · 滚轮缩放`
  - 原型用“办公室场景浏览区 + 底部信息区”的空间表达，而当前实现仍偏卡片栅格

## 方案

### 1. 保持后端合同不变

继续复用：

- `GET /api/team/office/scene`
- `GET /api/team/office/feed`
- `GET /api/team/runs/{run_id}/events`

不新增写接口，不修改 `office_view_service.py` 返回结构，避免破坏当前 layer2 合同和其它消费者。

### 2. 前端只做表达层增强

在 [app/static/aiteam/pages/office.js](/Users/chiangguantik/.codex/worktrees/a3b4/aiteam/app/static/aiteam/pages/office.js) 中补齐：

- 鼠标拖拽平移
- 滚轮缩放
- 更明确的“场景视口”容器语义

现有按钮式放大/缩小/平移/全屏保留，作为键鼠增强之外的显式控制，不破坏既有行为。

### 3. 测试同步

先在 [app/tests/aiteam/layer4_frontend_bff/test_office_page.py](/Users/chiangguantik/.codex/worktrees/a3b4/aiteam/app/tests/aiteam/layer4_frontend_bff/test_office_page.py) 增加失败测试，覆盖：

- wheel 触发缩放
- pointer drag / mouse drag 触发平移

通过后再改实现，确保不是“代码先写、测试补签”。

## 非目标

- 不把办公室页重写成 canvas 渲染引擎
- 不补 `P10`
- 不新增办公室专用 SSE 通道
- 不大改样式系统或全局布局

## 验证

- `pytest app/tests/aiteam/layer2_team_panel/test_team_office_contract.py app/tests/aiteam/layer4_frontend_bff/test_office_page.py -q`
- 若前端测试通过，说明合同未破坏且新增浏览交互可被自动化验证
