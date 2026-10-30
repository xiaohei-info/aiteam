// 办公室效果图（议题 9）。坐标为地图 1× 像素，物件 x/y 为中心点，员工 x/y 为脚下。
const A = 'assets/'
const img = (name, x, y, w, h, rot = 0, z = 1, extra = '') =>
  `<img class="it" src="${A}${name}.png" style="left:${x - w / 2}px;top:${y - h / 2}px;width:${w}px;height:${h}px;transform:rotate(${rot}deg);z-index:${z};${extra}">`
const floor = (kind, x, y, w, h) => `<div class="floor ${kind}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`
const wall = (x, y, w, h) => `<div class="wall" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:20"></div>`
const glass = (x, y, w) => `<div class="glass" style="left:${x}px;top:${y}px;width:${w}px;z-index:21"></div>`
const label = (x, y, text, z = 40) => `<div class="tag-label" style="left:${x}px;top:${y}px;z-index:${z}">${text}</div>`
const emote = (x, y, text, z = 41) => `<div class="emote" style="left:${x}px;top:${y}px;z-index:${z}">${text}</div>`
const ROT = { back: 0, right: 90, front: 180, left: 270 }
const arrow = (x, y, facing, z = 39) => `<div class="face-arrow" style="left:${x - 7}px;top:${y - 12}px;transform:rotate(${ROT[facing]}deg) translateY(-26px);z-index:${z}"></div>`

const PALETTES = [
  { shirt: '#3a6ed8', hair: '#3b2a20' }, { shirt: '#d0573f', hair: '#1f1f24' }, { shirt: '#2e9e5b', hair: '#6b4426' },
  { shirt: '#8b4fd1', hair: '#2b2018' }, { shirt: '#d4af37', hair: '#4a3020' }, { shirt: '#3d8fa8', hair: '#151518' },
]
function emp(x, y, facing, p = 0, { sit = false, z = 10 } = {}) {
  const c = PALETTES[p % PALETTES.length]
  const skin = '#f6d3b5'
  const legs = sit ? '' : `<rect x="12.5" y="47" width="6" height="12" rx="3" fill="#2b2b34"/><rect x="21.5" y="47" width="6" height="12" rx="3" fill="#2b2b34"/>`
  const body = `<rect x="8" y="29" width="24" height="23" rx="9" fill="${c.shirt}"/><rect x="8" y="29" width="24" height="23" rx="9" fill="url(#shade)" opacity=".25"/>`
  const head = `<circle cx="20" cy="18" r="13.5" fill="${skin}"/>`
  let hair = ''
  if (facing === 'front') hair = `<path d="M6.5 17 Q7 4 20 4 Q33 4 33.5 17 Q28 10 20 11 Q12 10 6.5 17Z" fill="${c.hair}"/><circle cx="15" cy="20" r="1.7" fill="#222"/><circle cx="25" cy="20" r="1.7" fill="#222"/><path d="M17.5 25 Q20 27 22.5 25" stroke="#c0705a" stroke-width="1.3" fill="none"/>`
  if (facing === 'back') hair = `<circle cx="20" cy="17.5" r="14" fill="${c.hair}"/><path d="M11 11 Q20 6 29 11" stroke="rgba(255,255,255,.18)" stroke-width="2" fill="none"/>`
  if (facing === 'left') hair = `<path d="M10 17 Q10 4 22 4 Q35 5 34 19 Q34 27 29 30 Q30 18 22 14 Q15 12 10 17Z" fill="${c.hair}"/><circle cx="11.5" cy="20" r="1.7" fill="#222"/>`
  if (facing === 'right') hair = `<path d="M30 17 Q30 4 18 4 Q5 5 6 19 Q6 27 11 30 Q10 18 18 14 Q25 12 30 17Z" fill="${c.hair}"/><circle cx="28.5" cy="20" r="1.7" fill="#222"/>`
  const shadow = `<ellipse cx="20" cy="59" rx="13" ry="3.5" fill="rgba(0,0,0,.18)"/>`
  return `<svg class="emp ${sit ? 'sit' : ''}" viewBox="0 0 40 64" style="left:${x}px;top:${y}px;z-index:${z}"><defs><linearGradient id="shade" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient></defs>${sit ? '' : shadow}${legs}${body}${head}${hair}</svg>`
}

// 门：hinge 为门轴坐标，angle 0 = 关闭（沿墙），90 = 打开
function doorLeaf(hx, hy, len, angle, dir = 1, z = 30) {
  return `<div style="position:absolute;left:${hx}px;top:${hy - 3}px;width:${len}px;height:7px;transform-origin:0 50%;transform:rotate(${dir * angle}deg);background:linear-gradient(180deg,#c49a6c,#9a7048);border-radius:2px;box-shadow:0 2px 3px rgba(0,0,0,.25);z-index:${z}"></div>
          <div style="position:absolute;left:${hx - 4}px;top:${hy - 4}px;width:8px;height:8px;border-radius:50%;background:#6f6a60;z-index:${z + 1}"></div>`
}

// ─────────────── 09a 休息点：姿势与朝向 ───────────────
function lounge() {
  const s = []
  s.push(floor('oak', 0, 0, 760, 250), floor('mineral', 0, 250, 760, 130), floor('carpet', 0, 380, 760, 380))
  s.push(wall(0, 0, 760, 14), wall(0, 0, 14, 760), wall(746, 0, 14, 760), wall(0, 746, 760, 14))
  s.push(wall(14, 236, 270, 14), wall(400, 236, 346, 14))
  // 茶水间
  s.push(img('coffee-counter-top', 300, 44, 168, 72, 180, 2), img('water-dispenser-top', 470, 46, 56, 56, 0, 2), img('plant-fern-top', 60, 60, 56, 56, 0, 3), img('plant-top', 700, 60, 56, 56, 0, 3))
  s.push(emp(280, 130, 'back', 0), arrow(280, 130, 'back'), emote(298, 50, '☕', 41), label(280, 140, 'lean · 面向咖啡机'))
  s.push(emp(560, 150, 'left', 3), arrow(560, 150, 'left'), label(560, 160, 'stand · 面向饮水机（自动）'))
  // 过道：两人相遇面对面
  s.push(emp(320, 340, 'right', 1), arrow(320, 340, 'right'), emp(392, 340, 'left', 2), arrow(392, 340, 'left'), emote(356, 268, '👋 打招呼'), label(356, 350, 'stand · 有同伴时面对面'))
  // 休息区
  s.push(img('rug-round-top', 380, 560, 200, 200, 0, 1), img('coffee-table-top', 380, 556, 84, 84, 0, 2))
  s.push(emp(345, 652, 'back', 4, { sit: true, z: 8 }), emp(415, 652, 'back', 5, { sit: true, z: 8 }))
  s.push(img('sofa-top', 380, 692, 216, 108, 180, 9))
  s.push(arrow(345, 612, 'back', 39), arrow(415, 612, 'back', 39), label(380, 734, 'sit · 背对镜头面向茶几，沙发靠背遮住下半身'))
  s.push(emote(345, 562, '😄', 41))
  s.push(img('armchair-top', 222, 560, 92, 92, 270, 7), emp(228, 584, 'right', 2, { sit: true, z: 9 }), arrow(240, 572, 'right', 39), label(212, 616, 'sit · 扶手椅侧向'))
  s.push(img('armchair-top', 540, 560, 92, 92, 90, 9), label(540, 616, '空位 · 容量 1'))
  s.push(img('floor-lamp-top', 650, 440, 40, 40, 0, 3), img('plant-top', 60, 440, 56, 56, 0, 3), img('plant-fern-top', 690, 690, 56, 56, 0, 3))
  s.push(label(90, 214, '茶水间'), label(70, 356, '过道'), label(80, 720, '休息区（新增）'))
  return `<div class="scene" style="left:24px;top:20px;width:760px;height:760px">${s.join('')}</div>`
}

const inspector = `
<aside style="position:absolute;right:24px;top:20px;width:448px;height:760px" class="card">
  <div class="card-h" style="font-size:15px">活动点属性<span class="grow"></span><small>编辑器 · 选中「休息区 · 沙发左」</small></div>
  <div class="field"><span>名称</span><div class="input" style="color:var(--text-primary)">休息区 · 沙发左</div></div>
  <div class="field"><span>类型</span><div class="row" style="gap:6px"><span class="chip">茶水间</span><span class="chip">过道</span><span class="chip">会议</span><span class="chip on">休息区</span><span class="chip">自定义</span></div></div>
  <div class="field"><span>朝向</span><div class="row" style="gap:6px"><span class="chip on">↑ 背对镜头</span><span class="chip">↓ 正面</span><span class="chip">← 左</span><span class="chip">→ 右</span><span class="chip">自动</span></div></div>
  <div class="field"><span>姿势</span><div class="seg-tabs"><span class="on">坐</span><span>站</span><span>倚靠</span></div></div>
  <div class="field"><span>面向目标</span><div class="row"><div class="input grow" style="color:var(--text-primary)">茶几（coffee-table-01）</div><span class="xs gold">在画布上点选</span></div></div>
  <div class="field"><span>容量</span><div class="input" style="width:80px;color:var(--text-primary)">1</div></div>
  <div class="field"><span>停留</span><div class="row small"><div class="input" style="width:64px;color:var(--text-primary)">20</div>–<div class="input" style="width:64px;color:var(--text-primary)">40</div><span class="muted">秒</span></div></div>
  <div style="border-top:1px solid var(--border);margin:6px 0 10px"></div>
  <div class="card-h">坐姿怎么表现（方案 A：家具遮挡）</div>
  <div class="small sec" style="line-height:21px">没有坐姿动画时，沿用工位椅的做法：<b>挡在员工前方的家具画在员工上面</b>。<br>· 背对镜头坐沙发 → 沙发靠背遮住下半身<br>· 会议桌北侧（面向镜头）→ 会议桌遮住下半身<br>· 会议桌南侧（背对镜头）→ 椅背遮住下半身<br>· 员工整体下移 6px，看起来陷进座位</div>
  <div class="card-h" style="margin-top:12px">各类活动点默认行为</div>
  <table style="width:100%;border-collapse:collapse;font-size:12px" class="sec">
    <tr class="muted"><td style="padding:3px 0">活动点</td><td>姿势</td><td>朝向</td><td>表情</td></tr>
    <tr><td style="padding:3px 0">咖啡机</td><td>倚靠</td><td>面向咖啡机</td><td>☕ just-right</td></tr>
    <tr><td style="padding:3px 0">沙发 / 扶手椅</td><td>坐</td><td>面向茶几</td><td>偶尔 laugh</td></tr>
    <tr><td style="padding:3px 0">窗边 / 绿植</td><td>站</td><td>面向目标</td><td>偶尔 thinking</td></tr>
    <tr><td style="padding:3px 0">过道</td><td>站</td><td>有同伴面对面</td><td>wave 一次</td></tr>
  </table>
  <div class="xs muted" style="margin-top:10px">粉色箭头 = 朝向，只在编辑器里显示，运行时不显示。</div>
</aside>`

addBoard('09a', '议题 9 · 休息点姿势与朝向', '活动点增加朝向、姿势、容量、面向目标；到达后不再背对目标物；新增休息区', lounge() + inspector)

// ─────────────── 09b 开会状态三阶段 ───────────────
function meetingRoom(ox, stage) {
  const s = []
  const W = 392, H = 330
  s.push(floor('oak', 0, 0, W, H - 70), floor('mineral', 0, H - 70, W, 70))
  s.push(glass(0, 0, W), wall(0, 0, 12, H - 70), wall(W - 12, 0, 12, H - 70), wall(12, H - 82, 140, 12), wall(240, H - 82, W - 252, 12))
  const tx = W / 2, ty = 128
  s.push(img('meeting-table-top', tx, ty, 224, 104, 0, 12))
  const seats = [[tx - 60, ty - 82, 0], [tx + 60, ty - 82, 0], [tx - 60, ty + 84, 180], [tx + 60, ty + 84, 180]]
  seats.forEach(([x, y, r]) => s.push(img('chair-top', x, y, 56, 60, r, r ? 14 : 4)))
  const north = (x, p, face = 'front', z = 8) => emp(x, ty - 44, face, p, { sit: true, z })
  // 南侧员工离镜头更近：画在会议桌之上、椅背之下，由椅背遮住下半身
  const south = (x, p, face = 'back') => emp(x, ty + 82, face, p, { sit: true, z: 13 })
  // 门洞在 x 152..240，门轴在左侧
  if (stage === 'gather') {
    s.push(north(tx - 60, 0), north(tx + 60, 1))
    s.push(doorLeaf(152, H - 76, 86, 90, -1, 30))
    s.push(emp(196, H - 30, 'back', 2), emp(300, H - 12, 'left', 3))
    s.push(`<div class="path" style="left:196px;top:${H - 40}px;width:60px;transform:rotate(-90deg)"></div>`)
    s.push(`<div class="room-badge" style="left:${W / 2}px;top:-30px;z-index:50"><i style="background:#f39c12"></i>召集中 <span class="num">2/4</span> · Q4 复盘群</div>`)
  }
  if (stage === 'live') {
    s.push(`<div class="meeting-veil" style="left:12px;top:8px;width:${W - 24}px;height:${H - 90}px;z-index:22"></div>`)
    s.push(north(tx - 60, 0, 'front'), north(tx + 60, 1, 'left'), south(tx - 60, 2, 'right'), south(tx + 60, 3, 'back'))
    s.push(emote(tx - 60, ty - 118, '💬 发言中'), emote(tx + 60, ty + 24, '…'))
    s.push(arrow(tx + 60, ty - 70, 'left'), arrow(tx - 60, ty + 72, 'right'))
    s.push(doorLeaf(152, H - 76, 86, 0, 1, 30), `<div class="door-dot" style="left:226px;top:${H - 90}px;z-index:31"></div>`)
    s.push(`<div class="room-badge" style="left:${W / 2}px;top:-30px;z-index:50"><i style="background:#e74c3c"></i>会议中 · Q4 复盘群 · <span class="num">03:12</span></div>`)
  }
  if (stage === 'end') {
    s.push(north(tx - 60, 0))
    s.push(doorLeaf(152, H - 76, 86, 90, -1, 30))
    s.push(emp(196, H - 52, 'front', 1), emp(270, H - 18, 'right', 2), emp(340, H - 14, 'right', 3))
    s.push(`<div class="room-badge" style="left:${W / 2}px;top:-30px;z-index:50;opacity:.75"><i style="background:#6b6b73"></i>已结束 · 用时 14 分钟</div>`)
  }
  return `<div class="scene" style="left:${ox}px;top:96px;width:${W}px;height:${H}px;overflow:visible">${s.join('')}</div>`
}

const meetingNotes = `
<div style="position:absolute;left:24px;top:470px;width:1232px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px">
  <div class="card small sec" style="line-height:21px"><b class="gold">召集中</b><br>群聊里同时 ≥3 位员工协作 → 成员起身走向会议室；已到的人入座面向桌子。门打开。徽标显示已到人数。</div>
  <div class="card small sec" style="line-height:21px"><b class="gold">会议中</b><br>全员入座 → 门关闭并亮红点；房间加淡金色遮罩；<b>正在回复</b>的员工播放 talking 动作并显示「发言中」，<b>被 @ 正在思考</b>的显示「…」；其他人转向发言人。徽标计时。</div>
  <div class="card small sec" style="line-height:21px"><b class="gold">散会</b><br>所有 @ 结束并等待 lingerMs 后 → 徽标显示用时，1 秒后淡出；成员依次走回工位；最后一人离开后门自动关闭。</div>
</div>
<div style="position:absolute;left:24px;top:640px;width:1232px;display:grid;grid-template-columns:1.2fr 1fr;gap:20px">
  <div class="card"><div class="card-h">办公室活动记录<span class="grow"></span><small>底部面板新增会议条目</small></div>
    <div class="small sec num" style="line-height:24px">10:21　会议室 A：Q4 复盘群开会（4 人）<br>10:35　会议室 A：散会，用时 14 分钟<br><span class="muted">10:40　会议室均在使用中：采购群在小李工位旁临时讨论（3 人）</span></div></div>
  <div class="card"><div class="card-h">徽标交互</div><div class="small sec" style="line-height:22px">点击徽标 → 打开对应群聊<br>悬停 → 成员头像列表 + 会议主题<br><span class="warnc">前置：应用里的 meetingsEnabled 当前是关闭的，需先确认原因再打开</span></div></div>
</div>`

addBoard('09b', '议题 9 · 开会状态三阶段', '召集中 → 会议中（关门、红点、发言人）→ 散会；复用现有会议站位逻辑', `
  <div class="stage-title" style="left:24px;top:28px">① 召集中<small>门开 · 黄点</small></div>
  <div class="stage-title" style="left:444px;top:28px">② 会议中<small>门关 · 红点 · 计时</small></div>
  <div class="stage-title" style="left:864px;top:28px">③ 散会<small>门开 · 徽标淡出</small></div>
  ${meetingRoom(24, 'gather')}${meetingRoom(444, 'live')}${meetingRoom(864, 'end')}${meetingNotes}`)

// ─────────────── 09c 开关门 ───────────────
function doorTile(ox, title, sub, angle, opts = {}) {
  const s = []
  s.push(floor('oak', 0, 0, 220, 110), floor('mineral', 0, 110, 220, 110))
  s.push(wall(0, 104, 66, 12), wall(154, 104, 66, 12))
  s.push(doorLeaf(66, 110, 86, angle, -1, 30))
  if (opts.dot) s.push(`<div class="door-dot" style="left:140px;top:90px;z-index:31"></div>`)
  if (opts.walker) s.push(emp(110, opts.walker, 'back', 1, { z: 20 }))
  if (opts.queue) s.push(emp(176, 196, 'left', 2, { z: 20 }), emote(176, 120, '⏳ 排队'))
  if (opts.zone) s.push(`<div style="position:absolute;left:62px;top:62px;width:96px;height:96px;border-radius:50%;border:1.5px dashed rgba(212,175,55,.9);z-index:25"></div>`)
  return `<div class="stage-title" style="left:${ox}px;top:40px">${title}<small>${sub}</small></div><div class="scene" style="left:${ox}px;top:72px;width:220px;height:220px">${s.join('')}</div>`
}

addBoard('09c', '议题 9 · 开关门', '门扇与门洞分离，绕门轴旋转；自动门、会议中、厕所有人三类状态', `
  ${doorTile(24, '① 关闭', '默认', 0)}
  ${doorTile(274, '② 有人靠近', '48px 内 · 160ms 打开', 90, { walker: 200, zone: true })}
  ${doorTile(524, '③ 通过后', '离开 1.2s 后 · 200ms 关闭', 40, { walker: 60 })}
  ${doorTile(774, '④ 会议中', '保持关闭 · 红点', 0, { dot: true })}
  ${doorTile(1024, '⑤ 厕所有人', '关闭 · 红点 · 排队', 0, { dot: true, queue: true })}
  <div style="position:absolute;left:24px;top:330px;width:1232px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px">
    <div class="card"><div class="card-h">门的数据</div><pre class="small sec num" style="margin:0;line-height:20px">door: {
  roomId: 'meeting-a',
  orientation: 'up',
  hinge: 'start',     // 门轴在哪侧
  mode: 'auto'        // auto | open | closed
}</pre></div>
    <div class="card"><div class="card-h">寻路规则</div><div class="small sec" style="line-height:22px">auto：不阻挡寻路，靠近自动打开<br>会议中 / 有人：对非相关员工视为阻挡<br>常闭（closed）：等同于墙<br>常开（open）：等同于现状</div></div>
    <div class="card"><div class="card-h">需要新做的素材</div><div class="small sec" style="line-height:22px">door-leaf-{up,down,left,right}.png<br>· 宽度 = 门洞，厚 6–8px，俯视轻立体<br>· 与门洞分离，墙面保持连续无缝<br>· 现有 07-closed-door.png 是正视角，不能用<br><span class="muted">减少动态效果时：不旋转，直接切换开 / 关贴图</span></div></div>
  </div>
  <div style="position:absolute;left:24px;top:560px;width:1232px" class="card">
    <div class="card-h">时间轴（auto 门）</div>
    <div style="position:relative;height:70px;margin-top:6px">
      <div style="position:absolute;left:0;right:0;top:30px;height:2px;background:var(--surface-4)"></div>
      ${[['0s', '员工进入 48px 范围', 6], ['0.16s', '门开到 90°', 22], ['≈1.0s', '员工穿过门洞', 42], ['+1.2s', '最后一人离开后开始关门', 68], ['+1.4s', '门关闭', 90]].map(([t, d, p]) => `<div style="position:absolute;left:${p}%;top:22px;transform:translateX(-50%);text-align:center;width:180px"><div style="width:14px;height:14px;border-radius:50%;background:var(--brand);margin:1px auto 6px"></div><div class="num gold xs">${t}</div><div class="xs sec">${d}</div></div>`).join('')}
    </div>
  </div>`)
