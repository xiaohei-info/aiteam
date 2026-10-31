// 界面效果图（议题 1–8）。每张画板 1280×800，用 addBoard 注册，粉色编号为标注。
const root = document.getElementById('boards')

function addBoard(id, title, desc, html) {
  const wrap = document.createElement('div')
  wrap.className = 'board-wrap'
  wrap.dataset.board = id
  wrap.innerHTML = `<div class="board-label"><b>${id}</b><strong>${title}</strong><span>${desc}</span></div><div class="board">${html}</div>`
  root.appendChild(wrap)
}

const anno = (n, text, style) => `<div class="anno" style="${style}"><b>${n}</b><span>${text}</span></div>`
const ring = (style) => `<div class="callout-ring" style="${style}"></div>`

function nav(active) {
  const items = ['chat', 'group', 'talent', 'knowledge', 'workbench', 'org', 'office']
  return `<aside class="nav"><i class="logo"></i>${items.map(k => `<i class="${k === active ? 'on' : ''}"></i>`).join('')}</aside>`
}

function convs(activeIndex = 0, group = false) {
  const list = group
    ? [['Q4 复盘群', '小策：已汇总三份渠道数据…', 'av'], ['采购流程梳理', '小李：审批节点已确认', 'av b'], ['周会纪要', '小王：本周待办 5 项', 'av g']]
    : [['小策 · 数据分析', '复盘报告已生成，请查看…', 'av'], ['小李 · 行政助理', '采购审批需要先抄送财务', 'av b'], ['小王 · 市场', '好的，我来整理竞品', 'av g'], ['小赵 · 法务', '合同第 7 条建议修改', 'av r'], ['小周 · 研发', '接口文档已更新', 'av p']]
  return `<section class="convs"><div class="search">搜索会话</div>${list.map(([t, s, c], i) => `<div class="conv ${i === activeIndex ? 'on' : ''}"><span class="${c}">${group ? t.slice(0, 1) : t.slice(1, 2)}</span><div class="meta"><b>${t}</b><small>${s}</small></div></div>`).join('')}</section>`
}

function chatHead(title, sub, extra = '') {
  return `<header class="chat-head"><span class="av">${title.startsWith('小') ? title.slice(1, 2) : title.slice(0, 2)}</span><div><div class="title">${title}</div><div class="sub">${sub}</div></div><div class="grow"></div>${extra}<span class="icon-btn">⌕</span><span class="icon-btn">⋯</span></header>`
}

const composer = `<div class="composer"><span class="grow">给小策发消息，@ 提及员工，/ 使用技能</span><span class="send"></span></div>`

// ───────────────────────── 1. 问题已解决 / 未解决 ─────────────────────────
const permPill = `<span class="pill ghost">🛡 只读 · 2 个目录 ▾</span>`
const ctxSeg = (noActive = false) => `<div class="seg" role="group"><span class="yes">✓ 问题已解决</span><span class="no ${noActive ? 'active' : ''}">↻ 问题未解决</span></div>`

addBoard('01a', '议题 1 · 双按钮与结果分隔线', '右上角分段按钮：左「问题已解决」主操作，右「问题未解决」次操作；分隔线记录结果和记忆状态；生成文档时提示可存为解决方案', `
<div class="app">${nav('chat')}${convs(0)}
<main class="main">
  ${chatHead('小策 · 数据分析', '就绪 · 上下文 38% · 本段 12.4K Token')}
  <div class="status-line">${permPill}<span class="grow"></span>${ctxSeg()}</div>
  <div class="msgs">
    <div class="msg me"><div class="bubble">帮我把上周的投放数据做个初步汇总。</div></div>
    <div class="msg"><span class="av s">策</span><div class="bubble">已汇总，搜索渠道 ROI 最高（2.8），信息流最低（0.9）。</div></div>
    <div class="divider">— 新上下文 · <span class="okc">✓ 已解决</span> · 记忆已保存 —<span class="edit">修改评估</span></div>
    <div class="msg me"><div class="bubble">基于 Q4 全部渠道数据写一份复盘报告，给出 Q1 预算建议。</div></div>
    <div class="msg"><span class="av s">策</span><div class="bubble">复盘报告已完成，包含 5 个渠道的 ROI 对比、问题归因和 Q1 预算分配建议。<br><span class="file-chip">📄 Q4渠道复盘报告.md <em>12 KB</em></span> <span class="file-chip">📊 渠道数据.csv <em>3 KB</em></span></div></div>
  </div>
  ${composer}
  <div class="divider" style="position:absolute;left:50%;transform:translateX(-50%);top:470px">— 新上下文 · <span class="okc">✓ 已解决</span> · 记忆已保存 —</div>
  <div class="toast" style="top:520px">✓ 已记为已解决，已开启新上下文 <span class="btn gold" style="height:26px;padding:0 10px">存为解决方案</span><a>撤销</a></div>
</main></div>
${ring('right:12px;top:58px;width:250px;height:40px')}
${anno(1, '分段按钮替代原「开启新上下文」：一次点击 = 结束本段 + 记录结果', 'right:270px;top:66px')}
${ring('left:636px;top:235px;width:318px;height:38px')}
${anno(2, '历史分隔线带结果：已解决绿色、未解决橙色；悬停出现「修改评估」（7 天内）', 'left:340px;top:238px')}
${ring('left:600px;top:460px;width:424px;height:108px')}
${anno(3, '点「问题已解决」后：末尾出现新分隔线；本段有文档时提示里多「存为解决方案」→ 议题 8；撤销只撤评估，不撤重置', 'left:1032px;top:470px;max-width:236px')}
`)

addBoard('01b', '议题 1 · 「问题未解决」浮层', '原因可选、可跳过；也可以保留为待跟进事项', `
<div class="app">${nav('chat')}${convs(1)}
<main class="main">
  ${chatHead('小李 · 行政助理', '就绪 · 上下文 21%')}
  <div class="status-line">${permPill}<span class="grow"></span>${ctxSeg(true)}</div>
  <div class="msgs">
    <div class="msg me"><div class="bubble">帮我查一下差旅报销超标后的审批人是谁。</div></div>
    <div class="msg"><span class="av s b">李</span><div class="bubble">根据现有资料，差旅报销由部门负责人审批。但没有找到「超标」情况的单独规定，建议咨询财务。</div></div>
    <div class="msg me"><div class="bubble">制度里应该有，再找找？</div></div>
    <div class="msg"><span class="av s b">李</span><div class="bubble">我检索了已授权的 2 个目录和企业知识库，仍未找到相关条款。</div></div>
  </div>
  ${composer}
  <div class="popover" style="right:20px;top:104px;width:340px">
    <h4>这段对话哪里没解决？<span class="muted small">（可跳过）</span></h4>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 12px">
      <span class="chip">答非所问</span><span class="chip on">信息不够</span><span class="chip">执行失败</span><span class="chip">结果不对</span><span class="chip">太慢</span><span class="chip">其他</span>
    </div>
    <div class="input" style="height:56px">备注（选填）：制度文件可能没上传到知识库</div>
    <div class="row small" style="margin:10px 0 14px"><span class="check on"></span><span class="sec">保留为待跟进事项</span></div>
    <div class="row" style="justify-content:flex-end"><span class="btn text">跳过</span><span class="btn primary">记为未解决并开启</span></div>
  </div>
</main></div>
${anno(1, '只有「未解决」才弹浮层；「已解决」一键完成', 'right:380px;top:66px')}
${anno(2, '原因标签会写入记忆元数据和员工统计，人才市场展示「常见未解决原因」', 'left:390px;top:238px;max-width:460px')}
${anno(3, '跳过 = 只记未解决，不填原因', 'right:380px;top:330px')}
`)

// ───────────────────────── 1c/1d. 修改评估（两种形态） ─────────────────────────
// 实现采用了方案 B（回复结束后输入框上方的「解决了吗」提示条），这里按实际界面画，不再有右上角分段按钮。
const outcomePrompt = `<div class="outcome-bar"><b>这个问题解决了吗？</b><span class="ob ok">✓ 已解决</span><span class="ob">↻ 未解决</span><span class="muted xs grow">选择后将开启新上下文，历史消息保留</span><span class="muted">×</span></div>`

const editFields = `
  <div class="eo-choice">
    <div class="eo-opt"><i class="okc">✓</i><div><b>已解决</b><small>问题得到满足</small></div></div>
    <div class="eo-opt on warn"><i class="warnc">↻</i><div><b>未解决</b><small>记录原因，帮员工改进</small></div></div>
  </div>
  <div class="small sec" style="margin:12px 0 6px">哪里没解决？<span class="muted">（可多选，可不填）</span></div>
  <div style="display:flex;flex-wrap:wrap;gap:6px">
    <span class="chip">答非所问</span><span class="chip on">信息不够</span><span class="chip">执行失败</span><span class="chip on">结果不对</span><span class="chip">太慢</span><span class="chip">其他</span>
  </div>
  <div class="input" style="height:52px;margin-top:10px;color:var(--text-secondary)">缺少华东区数据，ROI 口径和财务对不上<span class="eo-count">22/500</span></div>
  <div class="row small" style="margin-top:10px"><span class="check on"></span><span class="sec">保留为待跟进事项</span><span class="grow"></span></div>`

addBoard('01c', '议题 1 · 修改评估（方案 A：分隔线锚定浮层）', '在消息流里就地修改：被评估的那段消息用金色竖线标出，浮层从分隔线下方展开，不遮挡上下文', `
<div class="app">${nav('chat')}${convs(0)}
<main class="main">
  ${chatHead('小策 · 数据分析', '就绪 · 上下文 12% · 本段 3.1K Token')}
  <div class="msgs">
    <div class="eo-range">
      <div class="msg me"><div class="bubble">帮我把上周的投放数据做个初步汇总。</div></div>
      <div class="msg"><span class="av s">策</span><div class="bubble">已汇总，搜索渠道 ROI 最高（2.8），信息流最低（0.9）。<br><span class="file-chip">📊 投放汇总.csv <em>3 KB</em></span></div></div>
      <span class="eo-range-label">本段 · 10/28 14:02–14:35 · 6 条消息</span>
    </div>
    <div class="divider eo-active">— 新上下文 · <span class="okc">✓ 已解决</span> · 记忆已保存 —<span class="eo-edit-on">修改评估</span></div>
    <div class="msg me" style="opacity:.4"><div class="bubble">基于 Q4 全部渠道数据写一份复盘报告。</div></div>
  </div>
  ${outcomePrompt}
  ${composer}
  <div class="popover eo-pop" style="left:50%;transform:translateX(-50%);top:300px;width:380px">
    <div class="eo-arrow"></div>
    <div class="row"><h4 class="grow" style="margin:0">修改这段对话的评估</h4><span class="muted">×</span></div>
    <div class="xs muted" style="margin:2px 0 12px">原评估：<span class="okc">✓ 已解决</span> · 10/28 14:35</div>
    ${editFields}
    <div class="eo-foot">
      <span class="btn text eo-undo">撤销评估</span><span class="grow"></span>
      <span class="btn">取消</span><span class="btn primary">保存</span>
    </div>
    <div class="xs muted" style="margin-top:8px">只改评估，新上下文保持开启 · 还可修改 5 天</div>
  </div>
</main></div>
${anno(1, '被评估的那段消息用金色竖线和时间范围标出，用户知道改的是哪段', 'left:556px;top:234px;max-width:420px')}
${anno(2, '正在修改的分隔线保持高亮；「修改评估」7 天内悬停出现，键盘聚焦也出现', 'left:990px;top:262px;max-width:270px')}
${anno(3, '两个结果做成选项卡：已解决绿、未解决橙，和分隔线配色一致；选「未解决」才展开原因', 'left:1000px;top:400px;max-width:260px')}
${anno(4, '撤销评估放左侧、弱化，和保存分开，避免误点；文案说明只改评估不撤重置', 'left:1000px;top:590px;max-width:260px')}
`)

addBoard('01d', '议题 1 · 修改评估（方案 B：居中对话框 + 段落摘要）', '沿用应用现有对话框，补上段落摘要卡和结果选项卡；信息更完整，但会遮住消息', `
<div class="app">${nav('chat')}${convs(0)}
<main class="main">
  ${chatHead('小策 · 数据分析', '就绪 · 上下文 12% · 本段 3.1K Token')}
  <div class="msgs">
    <div class="msg me"><div class="bubble">帮我把上周的投放数据做个初步汇总。</div></div>
    <div class="msg"><span class="av s">策</span><div class="bubble">已汇总，搜索渠道 ROI 最高（2.8），信息流最低（0.9）。</div></div>
    <div class="divider">— 新上下文 · <span class="okc">✓ 已解决</span> · 记忆已保存 —</div>
    <div class="msg me"><div class="bubble">基于 Q4 全部渠道数据写一份复盘报告。</div></div>
  </div>
  ${outcomePrompt}
  ${composer}
</main></div>
<div class="overlay"></div>
<div class="modal" style="width:500px;top:52%">
  <div class="row" style="align-items:flex-start;margin-bottom:14px">
    <span class="eo-icon">✎</span>
    <div class="grow"><h3 style="margin:0">修改评估</h3><div class="xs muted">只改这段对话的结果，新上下文保持开启 · 还可修改 5 天</div></div>
    <span class="muted">×</span>
  </div>
  <div class="eo-summary">
    <div class="row xs muted"><span>10/28 14:02–14:35 · 6 条消息 · 1 个文件 · 记忆已保存</span><span class="grow"></span><span>原评估 <span class="okc">✓ 已解决</span></span></div>
    <div class="small" style="margin-top:6px">“帮我把上周的投放数据做个初步汇总。”</div>
  </div>
  ${editFields}
  <div class="eo-foot" style="margin-top:16px">
    <span class="btn text eo-undo">撤销评估</span><span class="grow"></span>
    <span class="eo-cancel">取消</span><span class="eo-save">✓ 保存修改</span>
  </div>
</div>
${anno(1, '段落摘要：时间、消息数、文件、记忆状态和第一句提问，说明改的是哪段', 'left:24px;top:250px;max-width:300px')}
${anno(2, '结果选项卡和原因字段与方案 A 相同', 'left:24px;top:380px;max-width:300px')}
${anno(3, '代价：对话框盖住了消息，看不到这段内容本身', 'left:960px;top:200px;max-width:280px')}
`)

// ───────────────────────── 2. 权限合并入口 ─────────────────────────
addBoard('02', '议题 2 · 权限入口合并（方案 A）', '一个按钮汇总状态；面板内分为「本会话权限」「员工可检索的目录」「系统层」三段，设置本身不合并', `
<div class="app">${nav('chat')}${convs(1)}
<main class="main">
  ${chatHead('小李 · 行政助理', '就绪 · 上下文 21%')}
  <div class="status-line"><span class="pill">🛡 只读 · 2 个目录 ▴</span><span class="grow"></span>${ctxSeg()}</div>
  <div class="msgs" style="opacity:.35">
    <div class="msg me"><div class="bubble">把这份报销制度和去年的版本做个对比。</div></div>
    <div class="msg"><span class="av s b">李</span><div class="bubble">好的，我在「制度文件」目录里找到了两个版本……</div></div>
  </div>
  ${composer}
  <div class="popover" style="left:20px;top:100px;width:430px;padding:0">
    <div style="padding:14px 16px 10px"><div class="small muted" style="margin-bottom:8px">本会话的权限</div>
      <div class="row" style="align-items:flex-start;margin-bottom:10px"><span class="radio on"></span><div class="grow"><b style="font-weight:500">只读</b><div class="small muted">员工只能读取工作区内的文件</div></div></div>
      <div class="row" style="align-items:flex-start"><span class="radio"></span><div class="grow"><b style="font-weight:500">完全访问 <span class="chip warn" style="height:18px;font-size:11px">风险较高</span></b><div class="small muted">执行本机命令、读写任意位置、访问网络 · 仅对本会话生效，需逐项确认</div></div></div>
    </div>
    <div style="border-top:1px solid var(--border);padding:12px 16px 10px">
      <div class="row small muted" style="margin-bottom:8px"><span class="grow">员工可检索的目录（对「小李」生效）</span><span>2 / 3 已开启</span></div>
      <div class="row" style="padding:6px 0"><span>📂</span><div class="grow"><div class="small">制度文件</div><div class="xs muted num">~/Documents/公司制度</div></div><span class="switch on"></span></div>
      <div class="row" style="padding:6px 0"><span>📂</span><div class="grow"><div class="small">报销单据</div><div class="xs muted num">~/Desktop/报销</div></div><span class="switch on"></span></div>
      <div class="row" style="padding:6px 0"><span>📁</span><div class="grow"><div class="small">周报</div><div class="xs muted num">~/Desktop/周报</div></div><span class="switch"></span></div>
      <div class="row" style="margin-top:6px"><span class="btn gold" style="height:28px">＋ 添加目录</span><span class="xs muted grow">命中的片段会随消息发给模型 · 群聊暂不支持</span></div>
    </div>
    <div style="border-top:1px solid var(--border);padding:10px 16px;background:var(--warning-bg);border-radius:0 0 16px 16px" class="row small"><span class="warnc">⚠</span><span class="grow sec">系统层：AIFred 未获得「完全磁盘访问权限」，桌面、文稿可能被系统拦截</span><span class="gold">打开系统设置</span></div>
  </div>
</main></div>
${anno(1, '原来的「允许完全访问」开关 + 「授权目录」按钮 → 合并成一个入口，按钮文字汇总两项状态', 'left:470px;top:66px')}
${anno(2, '两个设置仍然独立：关掉完全访问不影响目录，反之亦然', 'left:780px;top:150px')}
${anno(3, '选择「完全访问」仍走现有三项勾选确认弹窗', 'left:780px;top:210px')}
${anno(4, '系统层只在检测到未授权时出现，三层权限放在一处说明', 'left:780px;top:480px')}
`)

// ───────────────────────── 3. 员工详情用量 ─────────────────────────
function agentPanel(inner, title = '员工详情') {
  return `<aside class="panel"><div class="panel-head"><span class="t">${title}</span><span class="icon-btn">✕</span></div><div class="panel-body">${inner}</div></aside>`
}
const chatBg = `<main class="main">${chatHead('小策 · 数据分析', '就绪 · 上下文 38%')}<div class="status-line">${permPill}<span class="grow"></span>${ctxSeg()}</div><div class="msgs" style="opacity:.5"><div class="msg me"><div class="bubble">基于 Q4 全部渠道数据写一份复盘报告。</div></div><div class="msg"><span class="av s">策</span><div class="bubble">复盘报告已完成……</div></div></div>${composer}</main>`

addBoard('03', '议题 3 · 员工详情增加用量', '身份卡片下方新增用量卡片：今日 / 近 7 天 / 全部；费用按定价状态显示；口径常驻说明', `
<div class="app with-panel">${nav('chat')}${convs(0)}${chatBg}
${agentPanel(`
  <div class="card row" style="gap:12px"><span class="av" style="width:48px;height:48px;font-size:18px">策</span><div class="grow"><b>小策</b><div class="small muted">数据分析 · Doubao-Seed-1.6</div></div></div>
  <div class="card gold">
    <div class="card-h">用量<span class="grow"></span><span class="seg-tabs"><span class="on">今日</span><span>近 7 天</span><span>全部</span></span></div>
    <div class="stats4">
      <div class="stat"><strong>128.4K</strong><span>Token</span></div>
      <div class="stat"><strong>≥$0.40</strong><span>费用</span></div>
      <div class="stat"><strong>23</strong><span>执行</span></div>
      <div class="stat"><strong>91%</strong><span>成功率</span></div>
    </div>
    <div class="xs muted" style="margin-top:8px">输入 96.0K · 输出 30.0K · 缓存 2.4K　·　3 次执行未定价</div>
    <div class="row" style="margin-top:10px;gap:10px"><div class="spark" style="width:120px"><i style="height:40%"></i><i style="height:55%"></i><i style="height:30%"></i><i style="height:70%"></i><i style="height:45%"></i><i style="height:85%"></i><i class="today" style="height:100%"></i></div><span class="xs muted">近 7 天趋势（第二阶段）</span></div>
    <div class="row small" style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)"><span class="sec">解决率</span><b class="okc num">82%</b><span class="xs muted grow">17 段已评估</span><span class="xs muted">最近 14:32</span></div>
    <div class="xs muted" style="margin-top:6px">ⓘ 仅统计你在这台设备上的使用 · 按小时汇总 · USD</div>
  </div>
  <div class="card"><div class="card-h">岗位描述</div><div class="small sec">负责数据整理、渠道分析与复盘报告，擅长把零散数据整理成可执行结论。</div></div>
  <div class="card"><div class="card-h">记忆摘要<span class="grow"></span><small class="gold">查看全部 42 条 →</small></div><div class="small sec">用户偏好周报用表格形式，按项目分组；Q4 复盘关注 ROI。</div></div>
`)}
</div>
${anno(1, '三档时间切换，切换时才请求，结果缓存 60 秒', 'left:330px;top:250px')}
${anno(2, '定价不全显示「≥」并说明几次未定价；全部未定价显示「—」', 'left:330px;top:310px')}
${anno(3, '解决率来自议题 1；已评估 < 10 段显示「样本不足」', 'left:330px;top:390px')}
${anno(4, '口径说明常驻，避免被当成企业账单', 'left:330px;top:450px')}
`)

// ───────────────────────── 4. 员工记忆 ─────────────────────────
const mem = (text, cat, stars, src, time, outcome = '', mine = true) => `
  <div class="card" style="padding:10px 12px">
    <div class="small" style="line-height:19px">${text}</div>
    <div class="row xs muted" style="margin-top:6px;flex-wrap:wrap;gap:6px"><span class="chip" style="height:18px;font-size:11px">${cat}</span><span class="gold">${'★'.repeat(stars)}<span style="color:var(--surface-4)">${'★'.repeat(4 - stars)}</span></span>${outcome}<span>来自「<span class="sec" style="text-decoration:underline">${src}</span>」</span><span>${time}</span><span class="grow"></span>${mine ? '<span>⋯</span>' : ''}</div>
  </div>`

addBoard('04', '议题 4 · 员工记忆二级视图', '从员工详情「查看全部」滑入；普通成员只看自己对话产生的记忆，其他成员贡献的只显示数量', `
<div class="app with-panel">${nav('chat')}${convs(0)}${chatBg}
<aside class="panel"><div class="panel-head"><span class="icon-btn">‹</span><span class="t">小策的记忆</span><span class="pill ghost" style="height:24px">只看我的 ▾</span></div>
<div class="panel-body" style="gap:8px">
  <div class="row small"><b class="num gold">42</b><span class="sec">条</span><span class="muted">· 本周新增 6 · 最近被用到 今天 10:21</span></div>
  <div class="input">⌕ 搜索记忆</div>
  <div class="row" style="gap:5px;flex-wrap:wrap"><span class="chip on">全部</span><span class="chip">事实</span><span class="chip">偏好</span><span class="chip">经验</span><span class="chip ok">已解决</span><span class="chip warn">未解决</span></div>
  <div class="xs muted" style="margin-top:2px">今天</div>
  ${mem('用户偏好周报用表格形式，按项目分组，结论放最前面。', '偏好', 3, '周报整理', '10:21 被用到')}
  ${mem('Q4 复盘以 ROI 为主指标，信息流渠道需要单独说明转化周期。', '经验', 4, 'Q4 复盘', '09:40', '<span class="chip ok" style="height:18px;font-size:11px">✓ 已解决</span>')}
  <div class="xs muted">本周</div>
  ${mem('采购审批流程：先抄送财务，再提交总监；超过 5 万需要 CEO 签字。', '事实', 2, '采购流程', '10/27', '<span class="chip warn" style="height:18px;font-size:11px">↻ 未解决</span>')}
  <div class="card" style="padding:9px 12px;border-style:dashed;text-align:center" class="xs"><span class="xs muted">另有 32 条来自其他同事的对话，仅管理员可见</span></div>
</div></aside>
</div>
<div class="popover" style="right:24px;top:470px;width:176px;padding:6px">
  <div class="small" style="padding:6px 10px;border-radius:6px;background:var(--surface-3)">删除这条记忆</div>
  <div class="small muted" style="padding:6px 10px">编辑（管理员）</div>
  <div class="small muted" style="padding:6px 10px">标记失效（管理员）</div>
</div>
${anno(1, '与「自动化任务」二级视图同一形态；修掉现在跳 /memory 的死链', 'left:330px;top:250px')}
${anno(2, '分类按服务端 category 原值；「已解决/未解决」来自议题 1 写入的标签', 'left:330px;top:330px')}
${anno(3, '来源对话可点击，跳到那次「新上下文」分隔线', 'left:330px;top:410px')}
${anno(4, '记忆是同一员工所有成员共享的：普通成员看不到别人贡献的内容，只看到数量', 'left:330px;top:490px')}
${anno(5, '普通成员只能删除自己贡献的；编辑和标记失效只给管理员', 'left:330px;top:570px')}
`)

// ───────────────────────── 5. 群聊用量 ─────────────────────────
const memberRow = (name, cls, pct, tok, cost, lead = false, removed = false) => `
  <div class="row small" style="height:30px"><span class="${cls} s" style="width:20px;height:20px;font-size:10px">${name.slice(-1)}</span><span style="width:76px;white-space:nowrap">${name}${lead ? ' <span class="chip on" style="height:16px;font-size:10px;padding:0 5px">主持人</span>' : ''}${removed ? ' <span class="xs muted">已移出</span>' : ''}</span><div class="bar grow"><i class="${lead ? 'lead' : ''}" style="width:${pct}%"></i></div><span class="num xs" style="width:38px;text-align:right">${tok}</span><span class="num xs muted" style="width:40px;text-align:right">${cost}</span></div>`

addBoard('05', '议题 5 · 群聊详情增加用量', '复用员工详情的用量组件；多一个按成员拆分，主持人高亮；移出的成员仍计入', `
<div class="app with-panel">${nav('group')}${convs(0, true)}
<main class="main">${chatHead('Q4 复盘群', '5 位成员 · 主持人 小策')}<div class="status-line">${permPill}<span class="grow"></span>${ctxSeg()}</div><div class="msgs" style="opacity:.5"><div class="msg me"><div class="bubble">@小策 组织大家把 Q4 各渠道复盘一下。</div></div><div class="msg"><span class="av s">策</span><div class="bubble">好的，@小王 负责投放数据，@小赵 负责合同条款……</div></div></div>${composer}</main>
${agentPanel(`
  <div class="card row" style="gap:12px"><span class="av" style="width:44px;height:44px">Q4</span><div class="grow"><b>Q4 复盘群</b><div class="small muted">自选成员群 · 5 位成员</div></div></div>
  <div class="card gold">
    <div class="card-h">群聊用量<span class="grow"></span><span class="seg-tabs"><span>今日</span><span class="on">全部</span></span></div>
    <div class="stats4">
      <div class="stat"><strong>342.1K</strong><span>Token</span></div>
      <div class="stat"><strong>$1.08</strong><span>费用</span></div>
      <div class="stat"><strong>41</strong><span>员工执行</span></div>
      <div class="stat dim"><strong>4/5</strong><span>参与员工</span></div>
    </div>
    <div class="xs muted" style="margin:10px 0 4px">按成员</div>
    ${memberRow('小策', 'av', 100, '148K', '$0.46', true)}
    ${memberRow('小王', 'av g', 59, '88K', '$0.27')}
    ${memberRow('小赵', 'av r', 41, '61K', '$0.19')}
    ${memberRow('小孙', 'av p', 30, '45K', '$0.16', false, true)}
    <div class="row small" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)"><span class="sec">本群已评估 9 段</span><span class="grow"></span><span class="okc">解决 7 段</span></div>
    <div class="xs muted" style="margin-top:6px">ⓘ 一条群消息可能触发多位员工各执行一次 · 仅统计本设备</div>
  </div>
  <div class="card"><div class="card-h">群成员 · 5<span class="grow"></span><small class="gold">管理成员</small></div><div class="small muted">小策（主持人）、小王、小赵、小李、小周</div></div>
`, '详情')}
</div>
${anno(1, '「员工执行」不是消息数：悬停说明「你发了 N 条消息，触发 41 次员工执行」', 'left:330px;top:260px')}
${anno(2, '按 Token 从高到低；点击某行打开该员工详情', 'left:330px;top:340px')}
${anno(3, '被移出的成员历史用量仍计入', 'left:330px;top:420px')}
${anno(4, '推荐后端给 usage/statistics 加 conversation_id + group_by=employee；过渡期前端汇总工作记录', 'left:330px;top:500px')}
`)

// ───────────────────────── 6. 知识来源 ─────────────────────────
const srcCard = (icon, title, tag, desc, extra, cls = '') => `
  <article class="card ${cls}" style="flex:1;padding:16px;display:flex;flex-direction:column;gap:8px">
    <div class="row"><span style="font-size:18px">${icon}</span><b style="font-size:15px">${title}</b>${tag}</div>
    <div class="small sec">${desc}</div>${extra}
  </article>`

addBoard('06', '议题 6 · 知识来源按归属划分（方案 A）', '企业知识库 / 个人知识库 / 本机目录；部署位置是企业知识库的只读属性', `
<div class="app">${nav('knowledge')}
<section style="grid-column:2 / span 2" class="page">
  <div class="page-h"><h2>知识库</h2><span class="grow"></span><div class="input" style="width:240px">⌕ 搜索知识库与文档</div></div>
  <div class="row" style="gap:12px;align-items:stretch">
    ${srcCard('🏢', '企业知识库', '<span class="chip" style="height:20px;font-size:11px">部署：企业内网 NAS</span><span class="chip ok" style="height:20px;font-size:11px">已连接</span>', '企业所有，按岗位权限可读。由管理员在管理后台配置，<b>无需你填写地址</b>。', '<div class="row xs muted"><span>6 个空间 · 1,284 份文档</span><span class="grow"></span><span class="gold">浏览</span></div>', 'gold')}
    ${srcCard('🗄️', '个人知识库', '<span class="chip" style="height:20px;font-size:11px">已连接 2 个服务</span>', '你自己的 NAS 或自建服务，<b>仅本人可见</b>，可授权给你的 AI 员工。', '<div class="row xs"><span class="muted">家里 NAS · 3 个库</span><span class="grow"></span><span class="btn gold" style="height:26px">＋ 添加个人知识库服务</span></div>')}
    ${srcCard('💻', '本机目录', '<span class="chip" style="height:20px;font-size:11px">3 个目录</span>', '这台电脑上的文件夹，<b>不上传</b>，员工只检索命中的片段。', '<div class="row xs muted"><span>与聊天里的「权限 → 目录」是同一份</span><span class="grow"></span><span class="gold">管理</span></div>')}
  </div>
  <div class="card" style="background:var(--warning-bg);border-color:rgba(243,156,18,.35)"><div class="row small"><span class="warnc">⚠</span><span class="grow sec">「家里 NAS」上的「销售资料」标为<b>企业级</b>，但存放在个人服务上。个人服务只建议保存私人资料，企业资料请由管理员迁移到企业知识库。</span><span class="gold">了解迁移</span></div></div>
  <div class="row" style="gap:12px;align-items:stretch;flex:1">
    <div class="card" style="flex:1.2"><div class="card-h">归属 × 部署</div>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <tr class="muted"><td style="padding:6px 0"></td><td>谁能看</td><td>谁配置</td><td>可能的部署位置</td></tr>
        <tr style="border-top:1px solid var(--border)"><td style="padding:8px 0" class="gold">企业知识库</td><td>按岗位权限</td><td>企业管理员</td><td>Manager 托管 / 企业内网 NAS</td></tr>
        <tr style="border-top:1px solid var(--border)"><td style="padding:8px 0">个人知识库</td><td>仅本人</td><td>本人</td><td>个人 NAS / 自建服务</td></tr>
        <tr style="border-top:1px solid var(--border)"><td style="padding:8px 0">本机目录</td><td>仅本人</td><td>本人</td><td>这台电脑</td></tr>
      </table></div>
    <div class="card" style="flex:1"><div class="card-h">员工能用哪些知识</div>
      <div class="small sec" style="line-height:24px">企业知识库：按员工模板和岗位绑定，管理员授权<br>个人知识库：默认不能用，在员工详情里授权<br>本机目录：默认不能用，按员工打开开关<br><span class="muted xs">三类命中的片段都会随消息发给模型</span></div></div>
  </div>
</section></div>
${ring('left:212px;top:86px;width:134px;height:28px')}${ring('left:672px;top:158px;width:178px;height:36px')}${ring('left:866px;top:66px;width:392px;height:146px')}${ring('left:82px;top:216px;width:1176px;height:56px')}
${anno(1, '「企业内网 NAS」只是企业知识库的部署属性，客户端不保存企业 NAS 令牌', 'left:110px;top:520px;max-width:520px')}
${anno(2, '原「NAS 知识库」改名为个人知识库；个人服务上只能新建私人知识库', 'left:110px;top:570px;max-width:520px')}
${anno(3, '原「本地文档」+「授权目录」合并为本机目录', 'left:110px;top:620px;max-width:520px')}
${anno(4, '已有的企业级 / 团队级库放在个人服务上时给出迁移提示', 'left:110px;top:670px;max-width:520px')}
`)

// ───────────────────────── 7. 人才市场 ─────────────────────────
const outIcons = (list) => list.map(x => `<span title="${x}" class="xs" style="width:22px;height:22px;border-radius:6px;background:var(--surface-3);display:inline-grid;place-items:center">${x}</span>`).join('')
const talent = (name, cls, cat, tagline, tags, outs, metrics, state) => `
  <article class="card" style="padding:14px;display:flex;flex-direction:column;gap:8px;height:228px">
    <div class="row"><span class="${cls}" style="width:40px;height:40px">${name.slice(1, 2)}</span><div class="grow"><b>${name}</b><div class="xs muted">${cat}</div></div>${state}</div>
    <div class="small sec" style="height:38px;overflow:hidden">${tagline}</div>
    <div class="row" style="gap:5px">${tags.map(t => `<span class="chip" style="height:20px;font-size:11px">${t}</span>`).join('')}<span class="grow"></span>${outIcons(outs)}</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:auto">${metrics.map(([k, v, c]) => `<div class="stat" style="padding:6px 4px"><strong style="font-size:14px;${c ? `color:var(${c})` : ''}">${v}</strong><span>${k}</span></div>`).join('')}</div>
  </article>`

addBoard('07', '议题 7 · 人才市场字段细化', '卡片：一句话定位 + 能力标签 + 产出类型 + 最多 3 项指标；详情：概览 / 能力 / 接入要求 / 数据与成本', `
<div class="app">${nav('talent')}
<section style="grid-column:2 / span 2;display:grid;grid-template-columns:1fr 430px;height:100%">
  <div class="page">
    <div class="page-h"><h2>人才市场</h2><span class="grow"></span><div class="input" style="width:220px">⌕ 搜索人才</div></div>
    <div class="row" style="gap:6px;flex-wrap:wrap"><span class="chip on">全部</span><span class="chip">数据分析</span><span class="chip">行政</span><span class="chip">法务</span><span class="muted xs" style="margin:0 6px">|</span><span class="chip">产出：文档</span><span class="chip">产出：表格</span><span class="chip">无需外部系统</span><span class="grow"></span><span class="xs muted">排序：解决率最高 ▾</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      ${talent('小策', 'av', '数据分析', '把零散的业务数据整理成可执行结论，擅长渠道复盘与预算建议。', ['复盘', 'ROI', '+2'], ['📄', '📊'], [['解决率', '86%', '--success'], ['招募', '312'], ['计价', '¥0.2/次']], '<span class="chip ok" style="height:20px;font-size:11px">已招募</span>')}
      ${talent('小赵', 'av r', '法务', '审阅合同条款，标出风险点并给出修改建议与依据。', ['合同', '合规'], ['📄'], [['解决率', '74%'], ['招募', '128'], ['计价', '按 Token']], '<span class="btn gold" style="height:26px;font-size:12px">招募</span>')}
      ${talent('小王', 'av g', '市场', '竞品追踪与投放分析，自动生成周报。需要接入广告平台。', ['竞品', '投放'], ['📄', '📊', '🔌'], [['招募', '96'], ['技能', '6 项'], ['模型', 'DeepSeek']], '<span class="btn gold" style="height:26px;font-size:12px">招募</span>')}
      ${talent('小周', 'av p', '研发', '根据需求编写与维护接口文档，检查前后端字段一致性。', ['接口', '文档'], ['📄', '💻'], [['解决率', '58%', '--warning'], ['招募', '44'], ['计价', '¥0.5/次']], '<span class="btn gold" style="height:26px;font-size:12px">招募</span>')}
    </div>
  </div>
  <aside class="panel">
    <div class="panel-head"><span class="av">策</span><div style="flex:1"><b>小策</b><div class="xs muted">数据分析 · v1.4 · 10/21 更新</div></div><span class="icon-btn">✕</span></div>
    <div class="tabs" style="padding:0 12px"><span class="on">概览</span><span>能力</span><span>接入要求</span><span>数据与成本</span></div>
    <div class="panel-body">
      <div class="card"><div class="card-h">适合</div><div class="small sec" style="line-height:22px">· 渠道 / 活动复盘　· 周报月报汇总<br>· 预算拆分建议　　· 表格清洗与对账</div>
        <div class="card-h" style="margin-top:10px">不适合</div><div class="small sec">· 实时数据监控（无数据源接入）</div></div>
      <div class="card"><div class="card-h">示例问题<small>· 点击直接带入对话</small></div>
        <div style="display:flex;flex-direction:column;gap:6px"><span class="chip on" style="height:26px">把这份投放表按渠道算 ROI 并排序</span><span class="chip" style="height:26px">对比本月和上月的销售数据，找出异常</span><span class="chip" style="height:26px">根据 Q4 复盘给出 Q1 预算建议</span></div></div>
      <div class="card"><div class="card-h">示例产出</div><div class="row small"><span>📄</span><span class="grow">Q4 渠道复盘报告（示例）</span><span class="gold xs">预览</span></div><div class="row small" style="margin-top:6px"><span>📊</span><span class="grow">预算拆分表（示例）</span><span class="gold xs">预览</span></div></div>
      <div class="card"><div class="card-h">接入要求</div><div class="small okc">✓ 无需额外外部系统</div><div class="small sec" style="margin-top:4px">建议提供：渠道投放数据、历史预算表</div><div class="small sec">权限：不需要完全访问</div></div>
    </div>
  </aside>
</section></div>
${ring('left:96px;top:262px;width:358px;height:70px')}${ring('left:380px;top:216px;width:60px;height:32px')}${ring('left:858px;top:100px;width:416px;height:168px')}
${anno(1, '卡片固定 3 格指标，按「解决率 → 招募 → 计价 → 技能 → 模型」取前 3 个有数据的', 'left:100px;top:610px;max-width:520px')}
${anno(2, '产出类型图标：文档 / 表格 / 代码 / 外部系统', 'left:100px;top:660px;max-width:520px')}
${anno(3, '去掉开发期文案和空区块；没有数据的整块隐藏', 'left:100px;top:710px;max-width:520px')}
`)

// ───────────────────────── 8. 工作台 ─────────────────────────
const cand = (title, src, files, task, on = false, marked = '') => `
  <article class="card ${on ? 'gold' : ''}" style="padding:12px 14px">
    <div class="row"><b class="grow">📄 ${title}</b><span class="xs muted">${src}</span></div>
    <div class="xs sec" style="margin:4px 0 2px">${files}</div>
    <div class="xs muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">需求：${task}</div>
    <div class="row" style="margin-top:8px">${marked}<span class="grow"></span><span class="btn text" style="height:26px;font-size:12px">不是方案</span><span class="btn gold" style="height:26px;font-size:12px">✓ 设为解决方案</span></div>
  </article>`

addBoard('08a', '议题 8 · 工作台「待确认」与设为解决方案', '有文档输出的对话都进入待确认；用户确认后进入解决方案库，否认的进入已忽略', `
<div class="app">${nav('workbench')}
<section style="grid-column:2 / span 2" class="page">
  <div class="page-h"><h2>工作台</h2><span class="grow"></span><div class="input" style="width:220px">⌕ 搜索</div><span class="pill ghost">员工：全部 ▾</span><span class="pill ghost">来源：全部 ▾</span></div>
  <div class="tabs"><span class="on">待确认<em>12</em></span><span>解决方案<em>34</em></span><span>已忽略<em>8</em></span><span class="grow" style="flex:1;border:0"></span><span class="xs muted" style="border:0">☐ 多选</span></div>
  <div style="display:grid;grid-template-columns:420px 1fr;gap:14px;flex:1;min-height:0">
    <div style="display:flex;flex-direction:column;gap:10px">
      ${cand('Q4 渠道复盘方案', 'Fred · 小策 · 今天', '2 份文件：Q4渠道复盘报告.md、渠道数据.csv', '基于 Q4 全部渠道数据写一份复盘报告，给出 Q1 预算建议', true, '<span class="xs okc">✓ 对话中已标记为已解决</span>')}
      ${cand('登录接口改造计划', 'Claude Code · 昨天', '1 份文件：plans/login-refactor.md', '把登录流程改成 passkey 优先，先出个计划')}
      ${cand('commit-message.txt', 'Codex · 10/27', '1 份文件：/tmp/commit-message.txt', '帮我写提交说明')}
      <div class="xs muted" style="text-align:center">更早的候选（30 天前）· 4 ▾</div>
    </div>
    <div class="card" style="display:flex;flex-direction:column;gap:8px;opacity:.6"><div class="row"><span class="chip on">Q4渠道复盘报告.md</span><span class="chip">渠道数据.csv</span><span class="grow"></span><span class="seg-tabs"><span class="on">预览</span><span>源码</span></span></div><div class="small sec" style="line-height:22px"><b style="font-size:16px;color:var(--text-primary)">Q4 渠道复盘报告</b><br>一、总体结论：搜索渠道 ROI 2.8，为全渠道最高……<br>二、问题归因：信息流渠道转化周期长……</div></div>
  </div>
</section></div>
<div class="overlay"></div>
<div class="modal">
  <h3>设为解决方案</h3>
  <div class="field"><span>名称</span><div class="input" style="color:var(--text-primary)">Q4 渠道复盘方案</div></div>
  <div class="field"><span>一句话说明</span><div class="row"><div class="input grow" style="color:var(--text-primary)">复盘各渠道 ROI，给出 Q1 预算建议</div><span class="xs gold" style="white-space:nowrap">让员工概括</span></div></div>
  <div class="field" style="align-items:start"><span>交付文件</span><div class="small" style="line-height:26px"><span class="check on"></span> Q4渠道复盘报告.md　<span class="check on"></span> 渠道数据.csv　<span class="check"></span> 草稿.md</div></div>
  <div class="field"><span>标签</span><div class="row" style="gap:6px"><span class="chip on">#复盘</span><span class="chip on">#渠道</span><span class="chip">＋</span></div></div>
  <div class="xs muted" style="margin:4px 0 14px">文本类文件会保存一份快照；原文件之后变化时会提示「原文件已更新」。</div>
  <div class="row" style="justify-content:flex-end"><span class="btn">取消</span><span class="btn primary">加入解决方案</span></div>
</div>
${anno(1, '对话里点过「问题已解决」的候选会带上标记（议题 1 衔接）', 'left:100px;top:150px')}
${anno(2, '/tmp 下的误报：一键「不是方案」，也建议同步收紧判定规则', 'left:100px;top:420px')}
${anno(3, '默认全选交付文件，可去掉草稿', 'left:930px;top:300px')}
`)

const sol = (title, desc, tags, who, from) => `
  <article class="card" style="padding:14px;position:relative;overflow:hidden;display:flex;flex-direction:column;gap:6px;height:168px">
    <i style="position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--brand-gradient)"></i>
    <b>${title}</b><div class="small sec" style="height:38px;overflow:hidden">${desc}</div>
    <div class="row" style="gap:5px">${tags.map(t => `<span class="chip" style="height:20px;font-size:11px">#${t}</span>`).join('')}</div>
    <div class="row xs muted" style="margin-top:auto"><span>${who}</span><span class="grow"></span>${from}</div>
  </article>`

addBoard('08b', '议题 8 · 解决方案库', '已确认的解决方案以库的形式展示，可按员工、来源、标签筛选', `
<div class="app">${nav('workbench')}
<section style="grid-column:2 / span 2" class="page">
  <div class="page-h"><h2>工作台</h2><span class="grow"></span><div class="input" style="width:220px">⌕ 搜索解决方案</div><span class="pill ghost">员工：全部 ▾</span><span class="pill ghost">标签：全部 ▾</span></div>
  <div class="tabs"><span>待确认<em>11</em></span><span class="on">解决方案<em>35</em></span><span>已忽略<em>8</em></span></div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
    ${sol('Q4 渠道复盘方案', '复盘各渠道 ROI，给出 Q1 预算建议', ['复盘', '渠道'], '小策 · 2 份文件 · 10/29', '<span class="okc">✓ 对话中已解决</span>')}
    ${sol('采购审批流程梳理', '梳理采购审批节点与金额阈值，附流程图', ['流程'], '小李 · 1 份文件 · 10/21', '<span>Fred</span>')}
    ${sol('登录改造计划', 'passkey 优先的登录流程改造步骤与风险', ['研发', '计划'], 'Claude Code · 1 份文件 · 10/28', '<span>本机来源</span>')}
    ${sol('合同风险清单', '标准采购合同 12 处风险条款及修改建议', ['法务'], '小赵 · 1 份文件 · 10/18', '<span class="warnc">原文件已更新</span>')}
    ${sol('竞品周报模板', '每周竞品动态汇总模板与数据口径', ['市场', '模板'], '小王 · 2 份文件 · 10/15', '<span>Fred</span>')}
    ${sol('接口字段对照表', '前后端字段命名与类型对照，含 23 个接口', ['研发'], '小周 · 1 份文件 · 10/12', '<span>Fred</span>')}
  </div>
</section></div>
${ring('left:84px;top:126px;width:14px;height:176px')}
${anno(1, '左侧金色竖条 = 已确认；点开后右侧预览，多「编辑信息」「移出解决方案」', 'left:100px;top:520px;max-width:520px')}
${anno(2, '有快照：原文件变化时提示，仍可查看确认时的版本', 'left:100px;top:570px;max-width:520px')}${ring('left:380px;top:440px;width:84px;height:30px')}
`)
