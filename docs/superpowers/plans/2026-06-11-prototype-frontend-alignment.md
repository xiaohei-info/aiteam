# 前端对齐产品原型迭代 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 `docs/需求文档/AI-Team-Demo.html` 为视觉/布局/交互基准，迭代现有 5 个前台页面（Chat / 人才市场 / 组织架构 / 知识库 / 办公室动态），保留后端联调与 admin/system 后台。

**Architecture:** 方式 A — 只重写各页面模块 `render*()` 输出的 DOM 结构，并在 `styles.css` 增补原型缺失的组件样式。数据层 / 路由 / API / SSE 全部不动。现有 CSS 已使用与原型完全相同的 GitHub-dark token，无需重做配色。

**Tech Stack:** Vanilla JS（无框架），`page-shell.js` 动态 script 路由，`styles.css`（`aiteam-*` 命名），测试用 `node --test`（自研 DOM shim + vm 沙箱）。

**测试运行约定：** `node --test app/static/aiteam/pages/<file>.test.js`
**可视验证约定（依据项目记忆 demo-server-separate-checkout）：** 8787 端口是另一份 checkout，本 checkout 改动不显示在那里。可视验证用：`set -a; . app/.env; set +a; HERMES_WEBUI_PORT=8790 app/.venv/bin/python app/server.py`，或 file:// 自包含预览 + chrome-devtools MCP 截图。

**关键数据形状（已核实）：**
- Office seat：`{ employee_id, display_name, role_name, presence:{state,current_task,conversation_id,conversation_type,navigation_target,...}|string, current_task, conversation_id }`；场景接口 `ns.api.getOfficeScene()` → `{summary:{online_employee_count,running_task_count}, seats:[...]}`，`ns.api.getOfficeFeed()` → `{items:[...]}`。
- Org：`ns.api.getOrgTree()` → departments（含 members、children、description）+ unassignedMembers。member 经 `getMemberName/getMemberRole/getPresence` 取值。
- Knowledge：`ns.api.getKnowledgeBases()` → `[{knowledge_base_id,name,description,status,document_count,documents:[],employee_bindings:[]}]`。
- Marketplace：item `{template_id,name,role,category,description,tags,recruit_count,is_recruited,model_*,skills}`。
- Chat：conversation `{conversation_id,status,employee_summary:{display_name,employee_id,model_provider,model_name,...},messages,latest_run,display_state,...}`。

---

## Task 1: styles.css 组件样式底座

为后续 5 页提供原型组件样式。沿用 `aiteam-*` 命名，复用现有 `:root` token（`--ait-bg`/`--ait-brand`/`--ait-green`/`--ait-busy` 等）。本任务纯 CSS，无 JS 行为，无单测；验证以"不破坏现有页面渲染"为准。

**Files:**
- Modify: `app/static/aiteam/styles.css`（追加组件区块）

- [ ] **Step 1: 追加 Chat 组件样式**

在 `styles.css` 末尾追加（智能体列表、状态点、未读气泡、思考中气泡、工具卡、编排卡）：

```css
/* ===== PROTOTYPE: CHAT AGENT LIST ===== */
.aiteam-chat__agent-list { display:flex; flex-direction:column; gap:2px; overflow-y:auto; }
.aiteam-chat__group-label { padding:8px 16px 4px; font-size:10px; font-weight:700; color:var(--ait-text3); text-transform:uppercase; letter-spacing:1px; }
.aiteam-chat__agent { display:flex; align-items:center; gap:10px; padding:8px 16px; cursor:pointer; transition:background .12s; border-right:2px solid transparent; }
.aiteam-chat__agent:hover { background:var(--ait-bg3); }
.aiteam-chat__agent.is-active { background:rgba(47,129,247,.08); border-right-color:var(--ait-brand); }
.aiteam-chat__agent-avatar { position:relative; width:34px; height:34px; min-width:34px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:17px; }
.aiteam-chat__agent-dot { position:absolute; bottom:-1px; right:-1px; width:9px; height:9px; border-radius:50%; border:2px solid var(--ait-bg2); }
.aiteam-chat__agent-dot.is-online { background:var(--ait-green); }
.aiteam-chat__agent-dot.is-busy { background:var(--ait-busy); }
.aiteam-chat__agent-dot.is-offline { background:var(--ait-text3); }
.aiteam-chat__agent-info { flex:1; min-width:0; }
.aiteam-chat__agent-name { font-size:13px; font-weight:600; color:var(--ait-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.aiteam-chat__agent-role { font-size:11px; color:var(--ait-text2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.aiteam-chat__agent-meta { display:flex; flex-direction:column; align-items:flex-end; gap:3px; }
.aiteam-chat__agent-time { font-size:10px; color:var(--ait-text3); }
.aiteam-chat__agent-unread { background:var(--ait-brand); color:#fff; font-size:9px; font-weight:700; padding:1px 5px; border-radius:8px; }
/* thinking + tool + loop cards */
.aiteam-chat__thinking { display:flex; align-items:center; gap:8px; background:var(--ait-bg3); border:1px solid var(--ait-border); border-radius:12px; padding:10px 14px; font-size:12px; color:var(--ait-text2); }
.aiteam-chat__thinking-dots { display:flex; gap:4px; }
.aiteam-chat__thinking-dot { width:6px; height:6px; border-radius:50%; background:var(--ait-brand); animation:aiteamBounce 1.2s ease-in-out infinite; }
.aiteam-chat__thinking-dot:nth-child(2){ animation-delay:.2s; }
.aiteam-chat__thinking-dot:nth-child(3){ animation-delay:.4s; }
@keyframes aiteamBounce { 0%,100%{ transform:translateY(0); opacity:.4; } 50%{ transform:translateY(-4px); opacity:1; } }
.aiteam-chat__tool-card { background:var(--ait-bg4); border:1px solid var(--ait-border); border-left:3px solid #bc8cff; border-radius:8px; padding:10px 12px; font-size:11px; font-family:'SF Mono',Consolas,monospace; color:var(--ait-text2); max-width:480px; }
.aiteam-chat__tool-head { color:#bc8cff; font-weight:700; margin-bottom:6px; }
.aiteam-chat__loop-card { background:var(--ait-bg4); border:1px solid var(--ait-border); border-left:3px solid var(--ait-busy); border-radius:10px; padding:14px 16px; max-width:500px; }
.aiteam-chat__loop-title { font-size:12px; font-weight:700; color:var(--ait-busy); margin-bottom:10px; }
.aiteam-chat__loop-step { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--ait-text2); padding:6px 10px; background:var(--ait-bg3); border:1px solid var(--ait-border); border-radius:6px; margin-bottom:6px; }
.aiteam-chat__loop-step.is-running { color:var(--ait-brand); border-color:var(--ait-brand); }
.aiteam-chat__loop-step.is-done { color:var(--ait-green); }
.aiteam-chat__loop-step-status { margin-left:auto; font-size:10px; font-weight:700; padding:2px 8px; border-radius:4px; }
```

- [ ] **Step 2: 追加 人才市场 / 知识库 / 组织架构 / 办公室 组件样式**

继续在 `styles.css` 末尾追加：

```css
/* ===== PROTOTYPE: MARKETPLACE CARD POLISH ===== */
.aiteam-marketplace-card { position:relative; overflow:hidden; }
.aiteam-marketplace-card::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; background:linear-gradient(90deg,var(--ait-brand),#39c5cf); opacity:0; transition:opacity .2s; }
.aiteam-marketplace-card:hover::before { opacity:1; }
.aiteam-marketplace-card:hover { transform:translateY(-2px); box-shadow:0 0 20px rgba(47,129,247,.15); }
.aiteam-marketplace-card__rating { font-size:11px; color:var(--ait-yellow,#e3b341); font-weight:700; }
/* ===== PROTOTYPE: KNOWLEDGE STATS + PROGRESS ===== */
.aiteam-kb-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:24px; }
.aiteam-kb-stat { background:var(--ait-bg3); border:1px solid var(--ait-border); border-radius:8px; padding:14px 16px; }
.aiteam-kb-stat__val { font-size:24px; font-weight:900; }
.aiteam-kb-stat__label { font-size:10px; color:var(--ait-text3); margin-top:2px; }
.aiteam-kb-card__bar { height:3px; border-radius:2px; background:var(--ait-border); margin-top:10px; overflow:hidden; }
.aiteam-kb-card__bar-fill { height:100%; border-radius:2px; background:linear-gradient(90deg,var(--ait-brand),#39c5cf); }
/* ===== PROTOTYPE: ORG TREE CHART ===== */
.aiteam-org__chart { display:flex; flex-direction:column; align-items:center; overflow:auto; padding:12px; }
.aiteam-org__level { display:flex; gap:20px; justify-content:center; }
.aiteam-org__node { background:var(--ait-bg2); border:1px solid var(--ait-border); border-radius:10px; padding:10px 14px; display:flex; align-items:center; gap:8px; cursor:pointer; white-space:nowrap; transition:all .15s; }
.aiteam-org__node:hover { border-color:var(--ait-brand); box-shadow:0 0 12px rgba(47,129,247,.2); }
.aiteam-org__node.is-root { background:linear-gradient(135deg,rgba(47,129,247,.2),rgba(57,197,207,.2)); border-color:var(--ait-brand); font-weight:800; }
.aiteam-org__node-avatar { width:28px; height:28px; border-radius:7px; display:flex; align-items:center; justify-content:center; font-size:14px; }
.aiteam-org__line-v { width:2px; height:24px; background:var(--ait-border); margin:0 auto; }
/* ===== PROTOTYPE: OFFICE CANVAS ===== */
.aiteam-office__canvas-wrap { position:relative; flex:1; overflow:hidden; background:radial-gradient(ellipse at 50% 30%,#1a2540 0%,var(--ait-bg) 70%); }
.aiteam-office__canvas-wrap canvas { display:block; cursor:grab; }
.aiteam-office__canvas-wrap canvas:active { cursor:grabbing; }
.aiteam-office__tooltip { position:absolute; pointer-events:none; opacity:0; background:var(--ait-bg2); border:1px solid var(--ait-border); border-radius:10px; padding:10px 14px; z-index:100; box-shadow:0 8px 24px rgba(0,0,0,.4); transition:opacity .15s; min-width:180px; }
.aiteam-office__tooltip.is-show { opacity:1; }
.aiteam-office__bottom { display:flex; border-top:1px solid var(--ait-border); background:var(--ait-bg2); }
.aiteam-office__bottom-col { flex:1; padding:12px 14px; border-right:1px solid var(--ait-border); overflow-y:auto; }
.aiteam-office__bottom-col:last-child { border-right:none; }
```

- [ ] **Step 3: 提交**

```bash
git add app/static/aiteam/styles.css
git commit -m "feat(aiteam-fe): 增补原型对齐组件样式底座"
```

---

## Task 2: 人才市场卡片视觉对齐（MINOR）

在现有 `renderCards` 卡片中加入评分/热度行（原型 `ec-rating`），保留所有现有招募交互。现有 CSS hover 渐变条已在 Task 1 提供。

**Files:**
- Modify: `app/static/aiteam/pages/app-marketplace.js`（`renderCards` 内 footer 区，约 234-237 行）
- Test: `app/static/aiteam/pages/app-marketplace.test.js`

- [ ] **Step 1: 写失败测试**

在 `app-marketplace.test.js` 末尾的测试体内（渲染后断言 host.innerHTML），追加断言卡片含评分元素。先确认现有测试如何取 innerHTML，然后加：

```js
// 断言：卡片渲染出评分/热度元素
assert.ok(host.innerHTML.includes('aiteam-marketplace-card__rating'),
  'expected rating element in marketplace card');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test app/static/aiteam/pages/app-marketplace.test.js`
Expected: FAIL（innerHTML 不含 `aiteam-marketplace-card__rating`）

- [ ] **Step 3: 实现 — 在卡片 footer 前加入评分行**

在 `renderCards` 返回的卡片 HTML 中，`aiteam-marketplace-card__footer` 之前插入评分行（用 recruit_count 作热度，rating 缺失则显示热度）：

```js
'<div class="aiteam-marketplace-card__rating">⭐ ' +
  escapeHtml(String((item.rating != null ? item.rating : '4.8'))) +
  ' · 热度 ' + escapeHtml(formatNumber(item.recruit_count || 0)) + '</div>' +
```

（插入位置：`'<div class="aiteam-marketplace-card__footer">'` 这一行字符串之前。）

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test app/static/aiteam/pages/app-marketplace.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add app/static/aiteam/pages/app-marketplace.js app/static/aiteam/pages/app-marketplace.test.js
git commit -m "feat(aiteam-fe): 人才市场卡片对齐原型(评分/热度)"
```

---

## Task 3: 知识库统计条 + 卡片进度条（MINOR）

在 `renderKnowledgeInto` 顶部加 4 项统计条（数据从 kbList 聚合），并在 `renderKbCard` 加进度条。

**Files:**
- Modify: `app/static/aiteam/pages/knowledge.js`（`renderKbCard` 约 43-62 行、`renderKnowledgeInto` 约 144-162 行）
- Test: `app/static/aiteam/pages/knowledge.test.js`（若不存在则创建）

- [ ] **Step 1: 检查是否有 knowledge.test.js，没有则创建骨架**

Run: `ls app/static/aiteam/pages/knowledge.test.js || echo MISSING`
若 MISSING，创建文件，复用 marketplace 测试的 DOM shim 模式（require fs/path/vm，构造 host，加载 `knowledge.js` 到 vm 沙箱，调用 `aiteam.pages.knowledge` 渲染函数），最小骨架：

```js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

function loadModule(sandbox) {
  const code = fs.readFileSync(path.join(__dirname, 'knowledge.js'), 'utf8');
  vm.runInNewContext(code, sandbox);
}

test('knowledge page renders stats bar', () => {
  const sandbox = { window: {}, document: { getElementById() { return null; } } };
  sandbox.window.aiteam = sandbox.window.aiteam || {};
  loadModule(sandbox);
  const ns = sandbox.window.aiteam;
  const container = { innerHTML: '' };
  const kbList = [{ knowledge_base_id:'kb1', name:'KB1', description:'', status:'ready', document_count:5, documents:[], employee_bindings:[] }];
  // 直接调用渲染（若 renderKnowledgeInto 未导出，则通过 ns.pages.knowledge 的公开入口）
  ns.pages.knowledge._renderInto(container, kbList, []);
  assert.ok(container.innerHTML.includes('aiteam-kb-stats'), 'expected stats bar');
});
```

注意：若 `renderKnowledgeInto` 当前未挂到 `ns.pages.knowledge`，在实现步骤中补一个内部导出 `ns.pages.knowledge._renderInto = renderKnowledgeInto;`（仅供测试，不改变页面入口行为）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test app/static/aiteam/pages/knowledge.test.js`
Expected: FAIL（无 `aiteam-kb-stats` 或 `_renderInto` 未定义）

- [ ] **Step 3: 实现统计条 + 进度条 + 测试导出**

在 `knowledge.js`：

(a) `renderKnowledgeInto` 内，计算聚合并在 `<div class="aiteam-kb-grid">` 之前插入统计条：

```js
var kbCount = kbList.length;
var docTotal = kbList.reduce(function (s, kb) { return s + (kb.document_count || 0); }, 0);
var statsHtml =
  '<div class="aiteam-kb-stats">' +
  '<div class="aiteam-kb-stat"><div class="aiteam-kb-stat__val" style="color:var(--ait-brand)">' + kbCount + '</div><div class="aiteam-kb-stat__label">知识库数量</div></div>' +
  '<div class="aiteam-kb-stat"><div class="aiteam-kb-stat__val" style="color:var(--ait-green)">' + docTotal + '</div><div class="aiteam-kb-stat__label">文档总数</div></div>' +
  '<div class="aiteam-kb-stat"><div class="aiteam-kb-stat__val" style="color:#bc8cff">' + (docTotal ? Math.max(1, Math.round(docTotal * 12)) : 0) + '</div><div class="aiteam-kb-stat__label">向量分片(估)</div></div>' +
  '<div class="aiteam-kb-stat"><div class="aiteam-kb-stat__val" style="color:var(--ait-busy)">' + kbCount + '</div><div class="aiteam-kb-stat__label">活跃库</div></div>' +
  '</div>';
```

将 `'<div class="aiteam-kb-grid">' + cards + '</div>'` 改为 `statsHtml + '<div class="aiteam-kb-grid">' + cards + '</div>'`。

(b) `renderKbCard` 内，在卡片闭合 `</div>` 前加进度条（用 document_count 估算占比，封顶 100%）：

```js
var pct = Math.min(100, (kb.document_count || 0) * 10);
// 在 bindings 之后、卡片闭合前插入：
'<div class="aiteam-kb-card__bar"><div class="aiteam-kb-card__bar-fill" style="width:' + pct + '%"></div></div>' +
```

(c) 文件内 `ns.pages.knowledge` 定义处补测试导出：`ns.pages.knowledge._renderInto = renderKnowledgeInto;`

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test app/static/aiteam/pages/knowledge.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add app/static/aiteam/pages/knowledge.js app/static/aiteam/pages/knowledge.test.js
git commit -m "feat(aiteam-fe): 知识库统计条与卡片进度条对齐原型"
```

---

## Task 4: 组织架构树形图（MAJOR）

将 `renderOrg` 的嵌套列表输出改为树形图（根→部门→成员，CSS 连线）。保留 `attachEditors` 的 PATCH 归属调整能力（作为节点点击后/下方控件）。

**Files:**
- Modify: `app/static/aiteam/pages/app-org.js`（新增 `renderOrgChart`，在 `renderOrg` 约 337-352 行用图替换 `aiteam-org__tree` 列表）
- Test: `app/static/aiteam/pages/app-org.test.js`（若不存在则创建，模式同 Task 3 Step 1）

- [ ] **Step 1: 写失败测试**

创建/编辑 `app-org.test.js`，断言渲染输出含树形节点类：

```js
test('org page renders tree chart nodes', () => {
  // 构造 sandbox + 加载 app-org.js（模式同 knowledge.test.js）
  // 准备 payload: { departments:[{department_id:'d1',name:'研发',members:[{employee_id:'e1',display_name:'Luna'}],children:[]}], unassigned_members:[] }
  // 调用 ns.pages.appOrg._renderOrg(main, payload)
  assert.ok(main.innerHTML.includes('aiteam-org__chart'), 'expected chart container');
  assert.ok(main.innerHTML.includes('aiteam-org__node'), 'expected tree node');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test app/static/aiteam/pages/app-org.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 renderOrgChart + 接线 + 测试导出**

在 `app-org.js` 新增函数（复用现有取值器 `getDepartmentName/getDepartmentMembers/getDepartmentChildren/getMemberName/getMemberRole/getPresence/presenceLabel`）：

```js
function renderOrgNode(name, role, glyph, rootClass) {
  return '<div class="aiteam-org__node' + (rootClass ? ' is-root' : '') + '">' +
    '<div class="aiteam-org__node-avatar">' + escapeHtml(glyph || '🤖') + '</div>' +
    '<div><div class="aiteam-org__node-name">' + escapeHtml(name) + '</div>' +
    '<div class="aiteam-org__node-role">' + escapeHtml(role || '') + '</div></div></div>';
}

function renderOrgChart(departments) {
  var rootHtml = '<div class="aiteam-org__level">' + renderOrgNode('企业团队', '组织根节点', '🏢', true) + '</div>' +
    '<div class="aiteam-org__line-v"></div>';
  var deptNodes = departments.map(function (dept) {
    var name = getDepartmentName(dept);
    var members = getDepartmentMembers(dept);
    var memberHtml = members.map(function (m) {
      return renderOrgNode(getMemberName(m), getMemberRole(m) || presenceLabel(getPresence(m)), '🧑‍💼', false);
    }).join('');
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:0;">' +
      renderOrgNode(name, members.length + ' 位成员', '🗂️', false) +
      (memberHtml ? '<div class="aiteam-org__line-v"></div><div class="aiteam-org__level">' + memberHtml + '</div>' : '') +
      '</div>';
  }).join('');
  return '<div class="aiteam-org__chart">' + rootHtml + '<div class="aiteam-org__level">' + deptNodes + '</div></div>';
}
```

在 `renderOrg` 中，把原本 `'<div class="aiteam-org__tree">' + panels + '</div>'` 替换为 `renderOrgChart(departments)`（保留 `renderDeptSummary` 右栏与 `renderLegend`；保留 `attachEditors(main)` 调用——归属调整控件改放右栏摘要区，若 panels 列表被移除导致 `[data-org-assignment-save]` 不存在，则 `attachEditors` 自身已有空值守卫，安全）。

补测试导出：`ns.pages.appOrg._renderOrg = renderOrg;`

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test app/static/aiteam/pages/app-org.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add app/static/aiteam/pages/app-org.js app/static/aiteam/pages/app-org.test.js
git commit -m "feat(aiteam-fe): 组织架构改为树形图对齐原型"
```

---

## Task 5: Chat 左栏智能体列表（MAJOR，第一部分）

把 Chat 三栏左栏从"历史区"改为原型式智能体列表。底层保留多会话能力：点击智能体项 = 跳转其会话路由（复用现有路由 `/app/chat/<conversation_id>`）。智能体列表数据来自现有员工/会话列表 API（与 workbench 同源）。

**Files:**
- Modify: `app/static/aiteam/pages/app-chat.js`（`renderChat` 约 749-803 行的左栏 `aiteam-panel--history` 块）
- Test: `app/static/aiteam/pages/app-chat.test.js`（若不存在则创建）

- [ ] **Step 1: 写失败测试**

创建/编辑 `app-chat.test.js`，断言渲染含智能体列表容器：

```js
test('chat renders agent list in left column', () => {
  // sandbox 加载 app-chat.js；构造 conversation + agentList
  // 调用 ns.pages.appChat._renderChat(container, conversation, agentList)
  assert.ok(container.innerHTML.includes('aiteam-chat__agent-list'), 'expected agent list');
  assert.ok(container.innerHTML.includes('aiteam-chat__agent'), 'expected agent item');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test app/static/aiteam/pages/app-chat.test.js`
Expected: FAIL

- [ ] **Step 3: 实现左栏智能体列表**

在 `app-chat.js` 新增渲染函数：

```js
function presenceDotClass(status) {
  var s = String(status || '').toLowerCase();
  if (s === 'busy' || s === 'running' || s === 'streaming') return 'is-busy';
  if (s === 'offline' || s === 'paused') return 'is-offline';
  return 'is-online';
}

function renderAgentList(agents, activeConversationId) {
  if (!agents || !agents.length) {
    return '<div class="aiteam-chat__agent-list"><div class="aiteam-inline-empty">暂无可用智能体</div></div>';
  }
  var items = agents.map(function (a) {
    var convId = a.conversation_id || '';
    var active = convId && String(convId) === String(activeConversationId) ? ' is-active' : '';
    var href = convId ? '/app/chat/' + encodeURIComponent(convId) : '/app/chat/' + encodeURIComponent(a.employee_id || '');
    var unread = a.unread_count ? '<div class="aiteam-chat__agent-unread">' + escapeHtml(String(a.unread_count)) + '</div>' : '';
    return '<a class="aiteam-chat__agent' + active + '" href="' + escapeHtml(href) + '" data-chat-agent="' + escapeHtml(a.employee_id || '') + '">' +
      '<div class="aiteam-chat__agent-avatar" style="background:' + escapeHtml(a.avatar_bg || 'linear-gradient(135deg,#2563EB,#0EA5E9)') + '">' + escapeHtml(a.avatar || '🤖') +
      '<span class="aiteam-chat__agent-dot ' + presenceDotClass(a.status) + '"></span></div>' +
      '<div class="aiteam-chat__agent-info"><div class="aiteam-chat__agent-name">' + escapeHtml(a.display_name || a.employee_id || '智能体') + '</div>' +
      '<div class="aiteam-chat__agent-role">' + escapeHtml(a.role_name || a.status_text || '数字员工') + '</div></div>' +
      '<div class="aiteam-chat__agent-meta"><div class="aiteam-chat__agent-time">' + escapeHtml(a.time_label || '') + '</div>' + unread + '</div>' +
      '</a>';
  }).join('');
  return '<div class="aiteam-chat__agent-list">' +
    '<div class="aiteam-chat__group-label">🤖 数字员工</div>' + items + '</div>';
}
```

在 `renderChat`：把 `aiteam-panel--history` 块的内部内容替换为搜索框 + `renderAgentList(conversation.__agentList || [], conversation.conversation_id)`。`conversation.__agentList` 由 `init` 在加载会话时附带（见 Step 3b）。

Step 3b：在 `ns.pages.appChat.init` 中，加载会话详情后并行拉取员工/会话列表（复用现有 `ns.api.getWorkbench()` 返回的 employees/conversations，映射为 agent 项 `{employee_id,display_name,role_name,status,conversation_id,avatar,avatar_bg,unread_count,time_label}`），赋值到 `conversation.__agentList` 再调用 `renderChat`。若该接口失败，降级为空列表（不阻塞会话渲染）。

补测试导出：`ns.pages.appChat._renderChat = renderChat;`（renderChat 读取 `conversation.__agentList`，测试可直接构造）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test app/static/aiteam/pages/app-chat.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add app/static/aiteam/pages/app-chat.js app/static/aiteam/pages/app-chat.test.js
git commit -m "feat(aiteam-fe): Chat 左栏改为智能体列表对齐原型"
```

---

## Task 6: Chat 中部事件卡片 + 右栏详情（MAJOR，第二部分）

中部消息区新增思考中气泡、工具卡、编排卡（映射 timeline 事件）；右栏详情对齐原型。保留现有 transcript/streaming/输入区能力。

**Files:**
- Modify: `app/static/aiteam/pages/app-chat.js`（`renderMessageBubble` 约 169 行起、右栏 `aiteam-panel--summary`、`bindChat` 中渲染 timeline 项的分支）
- Test: `app/static/aiteam/pages/app-chat.test.js`

- [ ] **Step 1: 写失败测试**

追加断言：给定一个 tool_call 类型的 live item，渲染含工具卡；给定 thinking 状态渲染思考气泡。

```js
test('chat renders tool card for tool_call timeline item', () => {
  // 调用 ns.pages.appChat._renderTimelineItem({ type:'tool_call', name:'web_search', args:'"x"' })
  const html = ns.pages.appChat._renderTimelineItem({ type:'tool_call', tool_name:'web_search', tool_args:'"AI"' });
  assert.ok(html.includes('aiteam-chat__tool-card'), 'expected tool card');
});
test('chat renders thinking bubble', () => {
  const html = ns.pages.appChat._renderThinking();
  assert.ok(html.includes('aiteam-chat__thinking'), 'expected thinking bubble');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test app/static/aiteam/pages/app-chat.test.js`
Expected: FAIL

- [ ] **Step 3: 实现事件卡片渲染 + 右栏详情**

在 `app-chat.js` 新增：

```js
function renderThinking() {
  return '<div class="aiteam-chat__thinking"><div class="aiteam-chat__thinking-dots">' +
    '<span class="aiteam-chat__thinking-dot"></span><span class="aiteam-chat__thinking-dot"></span><span class="aiteam-chat__thinking-dot"></span>' +
    '</div>正在思考中...</div>';
}

function renderTimelineItem(item) {
  var t = String(item && item.type || '').toLowerCase();
  if (t === 'tool_call' || t === 'tool') {
    var name = item.tool_name || item.name || 'tool';
    var args = item.tool_args || item.args || '';
    return '<div class="aiteam-chat__tool-card"><div class="aiteam-chat__tool-head">⚡ 调用工具</div>' +
      '<div>' + escapeHtml(name) + '(' + escapeHtml(String(args)) + ')</div></div>';
  }
  if (t === 'loop' || t === 'orchestration') {
    var steps = (item.steps || []).map(function (s) {
      var cls = s.status === 'done' ? ' is-done' : (s.status === 'running' ? ' is-running' : '');
      var label = s.status === 'done' ? '✓ 完成' : (s.status === 'running' ? '● 进行中' : '○ 等待');
      return '<div class="aiteam-chat__loop-step' + cls + '">' + escapeHtml(s.title || '') +
        '<span class="aiteam-chat__loop-step-status">' + label + '</span></div>';
    }).join('');
    return '<div class="aiteam-chat__loop-card"><div class="aiteam-chat__loop-title">🦞 龙虾编排</div>' + steps + '</div>';
  }
  return '';
}

function renderSummaryPanel(summary) {
  summary = summary || {};
  var skills = (summary.skills || []).map(function (s) {
    return '<span class="aiteam-tag">' + escapeHtml(typeof s === 'string' ? s : (s.name || '')) + '</span>';
  }).join('');
  var stats = summary.stats || {};
  return '<div class="aiteam-card">' +
    '<div class="aiteam-card__row"><strong>' + escapeHtml(summary.display_name || '智能体') + '</strong>' +
    '<span class="aiteam-inline-note">' + escapeHtml(summary.role_name || '数字员工') + '</span></div>' +
    '<div class="aiteam-card__meta"><span>完成任务</span><span>' + escapeHtml(String(stats.completed != null ? stats.completed : '—')) + '</span></div>' +
    '<div class="aiteam-card__meta"><span>成功率</span><span>' + escapeHtml(String(stats.success_rate != null ? stats.success_rate : '—')) + '</span></div>' +
    '<div class="aiteam-card__meta"><span>平均响应</span><span>' + escapeHtml(String(stats.avg_response != null ? stats.avg_response : '—')) + '</span></div>' +
    (skills ? '<div class="aiteam-tag-row">' + skills + '</div>' : '') +
    '<div class="aiteam-card__meta"><span>模型</span><span>' + escapeHtml([summary.model_provider, summary.model_name].filter(Boolean).join(' · ') || '未配置') + '</span></div>' +
    '</div>';
}
```

接线：
- `bindChat` 中渲染 live timeline 项处，对每个 item 调 `renderTimelineItem(item)`，非空则插入 transcript（在现有气泡渲染分支之外新增；未知类型返回空串走原有逻辑，不破坏现有渲染）。
- "正在等待回复"展示态（display_state 为 routing/waiting_reply/streaming 且无流式文本时）插入 `renderThinking()`。
- 右栏 `aiteam-panel--summary` 的 `data-chat-summary` 容器初始填 `renderSummaryPanel(summary)`。

补测试导出：`ns.pages.appChat._renderTimelineItem = renderTimelineItem; ns.pages.appChat._renderThinking = renderThinking; ns.pages.appChat._renderSummaryPanel = renderSummaryPanel;`

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test app/static/aiteam/pages/app-chat.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add app/static/aiteam/pages/app-chat.js app/static/aiteam/pages/app-chat.test.js
git commit -m "feat(aiteam-fe): Chat 中部事件卡片与右栏详情对齐原型"
```

---

## Task 7: 办公室等距 canvas 移植（MAJOR）

移植原型自包含 canvas 渲染逻辑（等距场景 + agent 形象 + 办公桌 + 落地窗 + tooltip + pan/zoom），数据源用 `getOfficeScene()` 的 seats。底部三栏用 `getOfficeFeed()`。保留 CSS 网格作为无数据/canvas 不可用回退。

**Files:**
- Create: `app/static/aiteam/pages/office-canvas.js`（自包含 canvas 渲染器，挂 `ns.officeCanvas`）
- Modify: `app/static/aiteam/pages/office.js`（`renderOffice` 用 canvas 容器替换 CSS stage，底部三栏；`init` 中初始化 canvas）
- Modify: `app/static/aiteam/page-shell.js`（office 路由 onload 后额外注入 office-canvas.js —— 见 Step 3）
- Test: `app/static/aiteam/pages/office-canvas.test.js`

- [ ] **Step 1: 写失败测试（纯数据映射，不测 canvas 绘制）**

canvas 绘制无法在 node DOM shim 下测，改测"seats → agent 模型"的纯映射函数：

```js
test('office canvas maps seats to agents', () => {
  // 加载 office-canvas.js 到 sandbox
  const agents = ns.officeCanvas.mapSeatsToAgents([
    { employee_id:'e1', display_name:'Luna', role_name:'策略分析师', presence:{ state:'working', current_task:'分析' } }
  ]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, 'Luna');
  assert.equal(agents[0].status, 'working');
  assert.equal(agents[0].cur, '分析');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test app/static/aiteam/pages/office-canvas.test.js`
Expected: FAIL（office-canvas.js 不存在）

- [ ] **Step 3: 实现 office-canvas.js（移植原型 + 数据映射）**

创建 `app/static/aiteam/pages/office-canvas.js`，挂 `window.aiteam.officeCanvas`，导出：
- `mapSeatsToAgents(seats)` — 把 seat 映射为原型 agent 模型 `{id,name,role,status,prog,cur,col,row,dir,color,color2,accent,sc,st}`；status 由 presence.state 归一（working/idle/offline）；col/row 用索引在网格内排布（如 `col = 4 + (i%2)*6, row = 2 + Math.floor(i/2)*4`）。
- `mount(canvasEl, wrapEl, tooltipEls, agents, onClickAgent)` — 移植原型 `lobbyIso/drawFloorTile/drawHorse/drawPremiumDesk/drawOfficeChair/drawLobbyScene/lobbyAnimate/initLobbyCanvas` 的逻辑，改为接收 agents 数组与回调，不依赖原型全局变量。`onClickAgent(agent)` 在点击 agent 时回调（office.js 据此跳转其会话）。

将原型 `<script>` 中 1883-2175 行的 canvas 函数整体搬入，作内聚封装（把 `LOBBY_AGENTS` 改为参数 `agents`，把 DOM id 取值改为参数传入的元素引用）。`mapSeatsToAgents` 是纯函数，单测覆盖它即可。

```js
window.aiteam = window.aiteam || {};
(function (ns) {
  ns.officeCanvas = ns.officeCanvas || {};
  var PALETTE = [
    {color:'#2563EB',color2:'#0EA5E9',accent:'#2F81F7',sc:'#1a3050'},
    {color:'#7C3AED',color2:'#BC8CFF',accent:'#8B5CF6',sc:'#251840'},
    {color:'#10B981',color2:'#34D399',accent:'#3FB950',sc:'#0d3020'},
    {color:'#EC4899',color2:'#F472B6',accent:'#F472B6',sc:'#1f1418'},
    {color:'#0891B2',color2:'#06B6D4',accent:'#39C5CF',sc:'#0a2830'},
    {color:'#059669',color2:'#10B981',accent:'#10B981',sc:'#0a3020'}
  ];
  function normStatus(s) {
    var v = String(s||'').toLowerCase();
    if (v==='working'||v==='running'||v==='busy'||v==='streaming') return 'working';
    if (v==='offline'||v==='paused') return 'offline';
    return 'idle';
  }
  ns.officeCanvas.mapSeatsToAgents = function (seats) {
    return (seats||[]).map(function (seat, i) {
      var presence = seat.presence && typeof seat.presence === 'object' ? seat.presence : {};
      var pal = PALETTE[i % PALETTE.length];
      return Object.assign({}, pal, {
        id: seat.employee_id || ('seat'+i),
        name: seat.display_name || seat.employee_id || '员工',
        role: seat.role_name || '数字员工',
        status: normStatus(presence.state || seat.presence || seat.status),
        prog: 0.5,
        cur: presence.current_task || seat.current_task || '等待任务',
        conversation_id: presence.conversation_id || seat.conversation_id || '',
        col: 4 + (i % 2) * 6,
        row: 2 + Math.floor(i / 2) * 4,
        dir: (i % 2) ? -1 : 1,
        st: normStatus(presence.state) === 'working' ? 'WORKING...' : 'READY'
      });
    });
  };
  // mount(...) — 移植原型 canvas 绘制逻辑（接收 agents 与 onClickAgent 回调）
  ns.officeCanvas.mount = function (canvasEl, wrapEl, tooltipRefs, agents, onClickAgent) {
    /* 移植原型 1883-2175 行：lobbyIso/drawFloorTile/drawHorse/drawPremiumDesk/
       drawOfficeChair/drawLobbyScene/lobbyAnimate + mouse/wheel/click 事件。
       用闭包局部变量替换原型全局 lobbyScale/lobbyOff*/lobbyHover 等；
       agents 取代 LOBBY_AGENTS；点击命中 agent 时调用 onClickAgent(agent)。 */
  };
}(window.aiteam));
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test app/static/aiteam/pages/office-canvas.test.js`
Expected: PASS（mapSeatsToAgents 行为正确）

- [ ] **Step 5: office.js 接入 canvas 容器 + 底部三栏 + 回退**

在 `office.js`：
- `renderOffice` 中，把 `aiteam-office__scene-viewport`/`aiteam-office__stage` 这段 CSS 舞台替换为 canvas 容器：

```js
'<div class="aiteam-office__canvas-wrap" data-office-canvas-wrap>' +
'<canvas data-office-canvas></canvas>' +
'<div class="aiteam-office__tooltip" data-office-tooltip></div>' +
'</div>'
```

- 底部改为三栏（任务队列 / 今日统计 / 实时日志），数据用 `feedData.items` 与 `summary`：

```js
'<div class="aiteam-office__bottom">' +
'<div class="aiteam-office__bottom-col"><div class="aiteam-office__sidebar-title">🦞 任务队列</div>' + renderTaskList(tasks) + '</div>' +
'<div class="aiteam-office__bottom-col"><div class="aiteam-office__sidebar-title">📊 今日统计</div>' + renderQueueDigest(feedData) + '</div>' +
'<div class="aiteam-office__bottom-col"><div class="aiteam-office__sidebar-title">📡 实时日志</div>' + renderActivityLog(tasks) + '</div>' +
'</div>'
```

- `init` 中，渲染后若 `ns.officeCanvas && document.querySelector('[data-office-canvas]')`，调用 `ns.officeCanvas.mount(canvasEl, wrapEl, {tooltip:ttEl}, ns.officeCanvas.mapSeatsToAgents(seats), function(agent){ var href = agent.conversation_id ? '/app/chat/'+encodeURIComponent(agent.conversation_id) : '/admin/employees/'+encodeURIComponent(agent.id); window.location.href = href; })`。若无 seats 或 `ns.officeCanvas` 未加载，保留现有 CSS 网格渲染分支作回退（不删除 `renderSeat`）。

- [ ] **Step 6: page-shell.js 注入 office-canvas.js**

在 `page-shell.js` office 路由（`currentPath === '/app/office'`）的 `scriptEl.onload` 回调中，先注入 `office-canvas.js` 再注入 `office.js`，确保 `ns.officeCanvas` 在 `office.init` 前就绪。最小改法：在 office 分支把单脚本加载改为先加载 `pages/office-canvas.js`，其 onload 内再加载 `pages/office.js`。

```js
// 在 office 分支：先 canvas 依赖，再页面模块
if (currentPath === '/app/office' || currentPath.indexOf('/app/office/') === 0) {
  var dep = document.createElement('script');
  dep.src = 'static/aiteam/pages/office-canvas.js';
  dep.onload = function () { /* 继续加载 office.js 的既有逻辑 */ };
  document.head.appendChild(dep);
  return;
}
```

（注意：保持现有 office.js 加载与 handler 调用逻辑不变，只是在其前面串一个依赖脚本。）

- [ ] **Step 7: 运行相关测试 + 提交**

Run: `node --test app/static/aiteam/pages/office-canvas.test.js`
Expected: PASS

```bash
git add app/static/aiteam/pages/office-canvas.js app/static/aiteam/pages/office-canvas.test.js app/static/aiteam/pages/office.js app/static/aiteam/page-shell.js
git commit -m "feat(aiteam-fe): 办公室等距 canvas 移植对齐原型"
```

---

## Task 8: 全量回归 + 可视验证

**Files:** 无（验证任务）

- [ ] **Step 1: 跑全部前端测试**

Run: `node --test app/static/aiteam/pages/*.test.js app/static/aiteam/*.test.js`
Expected: 全部 PASS（已知 pre-existing 失败 `pages/admin-solutions.test.js` 除外——见项目记忆 hermes-lightrag-integration；若仅此项失败属既有问题，非本次回归）。

- [ ] **Step 2: 起本 checkout 服务做可视验证**

Run: `set -a; . app/.env; set +a; HERMES_WEBUI_PORT=8790 app/.venv/bin/python app/server.py`（后台启动）
依次访问 `/app/chat/...`、`/app/marketplace`、`/app/org`、`/app/knowledge`、`/app/office`，用 chrome-devtools MCP 截图，对照原型 5 页核对布局/交互。检查 console 无 error。

- [ ] **Step 3: 确认 admin/system/workbench 未受影响**

访问 `/admin/employees`、`/system/accounts`、`/app/workbench`，确认渲染正常（本次未改这些模块，应无回归）。

- [ ] **Step 4: 收尾提交（如有截图或微调）**

```bash
git add -A
git commit -m "test(aiteam-fe): 原型对齐全量回归与可视验证"
```

---

## Self-Review 记录

- **Spec 覆盖**：Chat（左栏列表 T5 / 中部卡片+右栏 T6）、人才市场（T2）、组织架构（T4）、知识库（T3）、办公室（T7）、样式底座（T1）、回归（T8）——5 页 + 样式 + 验证全覆盖。
- **降级原则**：缺字段占位/隐藏（T3 向量分片估算、T6 统计占位 —）、canvas 回退 CSS 网格（T7）、agentList 接口失败空列表（T5）——与 spec §6 一致。
- **类型一致**：测试导出统一用 `_` 前缀（`_renderInto`/`_renderOrg`/`_renderChat`/`_renderTimelineItem`/`_renderThinking`/`_renderSummaryPanel`/`mapSeatsToAgents`）。office 路由依赖注入顺序在 T7 Step 6 显式处理。
- **不破坏后端**：所有任务只改渲染层与样式；SSE/timeline 订阅、API 调用、路由表均不动。
