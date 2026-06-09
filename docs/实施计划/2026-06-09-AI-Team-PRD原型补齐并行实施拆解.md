# AI Team PRD 原型补齐并行实施拆解

> 目标：在 **不推翻主分支现有代码** 的前提下，按 `docs/实施计划` 的验收矩阵与规格包，补齐 `docs/需求文档` 中 PRD 与前端产品原型的真实交付。
>
> 核心约束：
> 1. 前端页面结构、信息层级、主 CTA、关键交互以 PRD HTML 原型为准。
> 2. 共享文件必须单 owner，避免多 lane 冲突。
> 3. `B03` 与 `P10` 在门禁关闭前，不允许直接宣称功能完成。
> 4. 本文档只做实施拆解，不替代矩阵与规格包本身。

---

## 1. 现状判断

【核心判断】
✅ 值得做：这次的真问题不是“再补几个接口”，而是“把当前偏 dashboard / 占位 / 管理壳的页面，重做到 PRD 原型要求的产品表达”。

【关键洞察】
- 数据结构：多数域对象和北向 API 已经存在，真正短板集中在页面结构、交互路径、状态表达和少量聚合字段。
- 复杂度：最大复杂度来自共享前端骨架文件，而不是单页实现本身；必须先拆共享 owner。
- 风险点：如果多个 lane 同时修改 `app/static/aiteam/page-shell.js`、`app/static/aiteam/styles.css`、`app/static/aiteam/api-client.js`，冲突和回归会急剧上升。

## 2. 证据驱动的主分支差异

### 2.1 前台重灾区

- `P02`：当前 [app/static/aiteam/pages/app-workbench.js](/Volumes/SSD1T/code/ai/aiteam/app/static/aiteam/pages/app-workbench.js:1) 仍是卡片式聚合页；而 PRD 明确要求左图标栏 + 左员工列表 + 右主工作区空态/私聊承接。[docs/需求文档/AI-Team-PRD-v2.html](/Volumes/SSD1T/code/ai/aiteam/docs/需求文档/AI-Team-PRD-v2.html:343)
- `P06`：当前 [app/static/aiteam/pages/app-group.js](/Volumes/SSD1T/code/ai/aiteam/app/static/aiteam/pages/app-group.js:1) 已有 timeline/task tree，但仍需补齐 PRD 中的新建群聊、群头像拼图、成员增删、解散群聊、群设置主表达。[docs/需求文档/AI-Team-PRD-v2.html](/Volumes/SSD1T/code/ai/aiteam/docs/需求文档/AI-Team-PRD-v2.html:783)
- `P09`：当前正式页 [app/static/aiteam/pages/office.js](/Volumes/SSD1T/code/ai/aiteam/app/static/aiteam/pages/office.js:1) 还是统计卡 + 工位卡 + 活动流 dashboard；PRD 要的是等距办公室画布、任务气泡、点击工位详情、全屏/实时变化。[docs/需求文档/AI-Team-PRD-v2.html](/Volumes/SSD1T/code/ai/aiteam/docs/需求文档/AI-Team-PRD-v2.html:971)

### 2.2 企业后台重灾区

- `B02`：当前 [admin-skills.js](/Volumes/SSD1T/code/ai/aiteam/app/static/aiteam/pages/admin-skills.js:1) 已有双栏基础，但更新/卸载/安装授权仍大量降级提示，距离 PRD 完整卡片交互还有差距。[docs/需求文档/AI-Team-PRD-v2.html](/Volumes/SSD1T/code/ai/aiteam/docs/需求文档/AI-Team-PRD-v2.html:1191)
- `B04/B09`：当前费用页/充值页已分离，但仍需按 PRD 补齐时间切换、排行展开、套餐/自定义金额/支付方式/余额预警等表达。[docs/需求文档/AI-Team-PRD-v2.html](/Volumes/SSD1T/code/ai/aiteam/docs/需求文档/AI-Team-PRD-v2.html:1239) [docs/需求文档/AI-Team-PRD-v2.html](/Volumes/SSD1T/code/ai/aiteam/docs/需求文档/AI-Team-PRD-v2.html:1578)
- `B07`：PRD 要求员工选择器、记忆卡片、行内编辑、标签筛选、批量删除与注入痕迹；当前页面需要对照收口。[docs/需求文档/AI-Team-PRD-v2.html](/Volumes/SSD1T/code/ai/aiteam/docs/需求文档/AI-Team-PRD-v2.html:1490)
- `B08`：当前 [admin-settings.js](/Volumes/SSD1T/code/ai/aiteam/app/static/aiteam/pages/admin-settings.js:1) 仍偏元信息卡片，缺 Logo 上传、子管理员权限控制、帮助反馈与版本管理主表达。[docs/需求文档/AI-Team-PRD-v2.html](/Volumes/SSD1T/code/ai/aiteam/docs/需求文档/AI-Team-PRD-v2.html:1539)
- `B03`：当前导航无独立企业后台人才市场页；矩阵与规格包也仍处于门禁态。

### 2.3 系统后台重灾区

- `S01`：当前 [system-accounts.js](/Volumes/SSD1T/code/ai/aiteam/app/static/aiteam/pages/system-accounts.js:1) 只有简单表格 + prompt/confirm 式操作，离 PRD 的统计卡、筛选、详情抽屉、导出仍有明显差距。[docs/需求文档/AI-Team-PRD-v2.html](/Volumes/SSD1T/code/ai/aiteam/docs/需求文档/AI-Team-PRD-v2.html:1632)
- `S02/S03/S04`：已有最小 CRUD/汇总壳，但仍需补产品表达层和跨端联动验收。

## 3. 最大并行化原则

### 3.1 单 owner 共享文件

以下文件一次只允许一个 lane 修改：

- `app/static/aiteam/page-shell.js`
- `app/static/aiteam/styles.css`
- `app/static/aiteam/api-client.js`
- `app/static/aiteam/state-helpers.js`
- `app/team_panel/api_team/router_team.py`
- `app/team_panel/api_team/router_enterprise_admin.py`
- `app/team_panel/api_team/router_system_admin.py`
- `app/team_panel/application/queries/*.py` 中被多个页面共享的聚合服务

### 3.2 可独立并行的页面域

下列 lane 可以最大化并行，只要遵守共享文件单 owner：

- `lane-shell-foundation`
- `lane-p02-workbench`
- `lane-p06-group`
- `lane-p07-org`
- `lane-p08-knowledge`
- `lane-p09-office`
- `lane-b02-skills`
- `lane-b04-b09-billing`
- `lane-b05-connectors`
- `lane-b06-solution-apply`
- `lane-b07-memories`
- `lane-b08-settings`
- `lane-s01-accounts`
- `lane-s02-s03-platform-content`
- `lane-s04-finance`
- `lane-gates-b03-p10`

## 4. 并行实施波次

### Wave 0：门禁与共享骨架

目标：让后续并行开发不互相踩。

- `lane-gates-b03-p10`
  - 产物：补充验收文档，明确 B03/P10 当前允许开哪类卡、禁止开哪类卡。
  - 不碰产品代码。
- `lane-shell-foundation`
  - 目标：锁定导航、样式变量、通用布局骨架、共享测试基线。
  - 文件范围：
    - `app/static/aiteam/page-shell.js`
    - `app/static/aiteam/styles.css`
    - 必要时新增 `app/static/aiteam/pages/_shared-*.js`
  - 原则：只做骨架，不吞掉业务页面实现。

### Wave 1：前台主产品表达

目标：先完成最影响“看起来像不像 PRD 产品”的三块页面。

- `lane-p02-workbench`
  - 覆盖：`P02-F01/F02/F03`
  - 文件：
    - `app/static/aiteam/pages/app-workbench.js`
    - `app/tests/aiteam/layer4_frontend_bff/test_aiteam_app_pages.py`
    - `app/tests/aiteam/layer4_frontend_bff/test_empty_error_permission_states.py`
  - 结果：工作台从卡片聚合页升级为 PRD 双栏主工作区。
- `lane-p06-group`
  - 覆盖：`P06-F01/F02/F03/F04`
  - 文件：
    - `app/static/aiteam/pages/app-group.js`
    - `app/tests/aiteam/layer4_frontend_bff/test_group_page_reconnect_recovery.py`
    - `app/tests/aiteam/layer5_flows/test_group_conversation_flow.py`
  - 结果：群聊完成页面结构与群治理表达。
- `lane-p09-office`
  - 覆盖：`P09-F01/F02/F03/F04/F05`
  - 文件：
    - `app/static/aiteam/pages/office.js`
    - `app/static/aiteam/pages/office-scene.js`
    - `app/tests/aiteam/layer4_frontend_bff/test_office_page.py`
  - 结果：`office.js` 正式承接 PRD 等距办公室表达；`office-scene.js` 只做可复用渲染层，不再是孤立预览稿。

### Wave 2：后台治理闭环

目标：把已有后台壳页推进到 PRD 可演示状态。

- `lane-b02-skills`
  - 覆盖：`B02-F01/F02`
  - 文件：`admin-skills.js`、相关 Team Panel skills contracts/tests
- `lane-b04-b09-billing`
  - 覆盖：`B04-F01/F02`、`B09-F01/F03/F04/F05`
  - 文件：`admin-billing.js`、`admin-recharge.js`、账本/充值接口与测试
- `lane-b05-connectors`
  - 覆盖：`B05-F01/F02`
  - 文件：`admin-connectors.js`、connector detail/update/test/grant 契约与测试
- `lane-b06-solution-apply`
  - 覆盖：`B06-F01/F02`
  - 文件：`admin-solutions.js`、apply/rollback 相关 Team Panel 服务与测试
- `lane-b07-memories`
  - 覆盖：`B07-F01/F02`
  - 文件：`admin-memories.js`、记忆审计/注入痕迹查询
- `lane-b08-settings`
  - 覆盖：`B08-F01/F02`
  - 文件：`admin-settings.js`、settings/invites/help-feedback 接口与测试

### Wave 3：系统后台治理

目标：把系统后台从最小运维壳补到 PRD 可验收层。

- `lane-s01-accounts`
  - 覆盖：`S01-F01/F02`
  - 文件：`system-accounts.js`、系统账号查询/详情/actions 契约与测试
- `lane-s02-s03-platform-content`
  - 覆盖：`S02-F01/F02`、`S03-F01/F02`
  - 文件：`system-templates.js`、`system-solutions.js`、相关消费链路联调测试
- `lane-s04-finance`
  - 覆盖：`S04-F01/F02`
  - 文件：`system-finance.js`、平台级财务聚合服务与权限测试

### Wave 4：门禁项收口

目标：处理现在不能直接编码完成的两项。

- `B03`
  - 若裁决为“恢复独立后台”：新增独立路由、页面、企业侧模板消费能力。
  - 若裁决为“合并后等价覆盖”：必须提交逐项映射证据，不允许口头 close。
- `P10`
  - 先按补充文档完成页面/API/状态拆分。
  - 再做 Loop 产品入口、启停、最近结果、结果回流与异常恢复。

## 5. 推荐任务创建顺序

1. `lane-gates-b03-p10`
2. `lane-shell-foundation`
3. `lane-p02-workbench` + `lane-p06-group` + `lane-p09-office`
4. `lane-b04-b09-billing` + `lane-b05-connectors` + `lane-b07-memories`
5. `lane-b02-skills` + `lane-b06-solution-apply` + `lane-b08-settings`
6. `lane-s01-accounts` + `lane-s02-s03-platform-content` + `lane-s04-finance`
7. `B03/P10` 正式实现 lane

## 6. 每个 lane 的完成定义

一个 lane 只有同时满足以下条件才允许结束：

- 对应 `spec_id` 的开发范围完成。
- 页面结构与主要交互通过 PRD 对照。
- 对应自动化测试补齐并通过。
- 至少有一份页面级截图/录屏证据。
- 没有再修改其他 lane 的共享文件，或已通过共享 owner 合并。

## 7. 验证清单

### 自动化

- `cd /Volumes/SSD1T/code/ai/aiteam/app && ./.venv/bin/pytest tests/aiteam/layer4_frontend_bff -q`
- `cd /Volumes/SSD1T/code/ai/aiteam/app && ./.venv/bin/pytest tests/aiteam/layer2_team_panel -q`
- `cd /Volumes/SSD1T/code/ai/aiteam/app && ./.venv/bin/pytest tests/aiteam/layer5_flows -q`
- `cd /Volumes/SSD1T/code/ai/aiteam/app && node static/aiteam/pages/*.test.js`

### 页面验收

- P02：空态 / 有员工态 / 搜索 / 右键菜单 / 跳转
- P06：新建群聊 / @mention / 成员变更 / 任务树 / 恢复
- P09：工位动效 / 任务气泡 / 全屏 / 点击详情 / 实时刷新
- B04/B09：时间切换 / 明细展开 / 导出 / 套餐 / 支付反馈 / 余额刷新 / 预警
- S01：筛选 / 详情 / `/actions` 写入口 / 导出

## 8. 推进结论

【核心判断】
✅ 这份拆解推完，才有机会达到“按 PRD 原型交付”的状态；按旧口径那套只看 API/测试的做法，不足以完成这次目标。

【技术方案】
1. 先补文档门禁，尤其是 `B03/P10`。
2. 再锁共享文件 owner。
3. 然后三条前台主表达 lane 优先并行。
4. 后台/系统页按域拆分并行推进。
5. 最后统一做矩阵升级，不再用 closeout 叙事代替验收。
