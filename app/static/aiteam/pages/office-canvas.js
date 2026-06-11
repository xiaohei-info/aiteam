window.aiteam = window.aiteam || {};

(function (ns) {
  ns.officeCanvas = ns.officeCanvas || {};

  var PALETTE = [
    { color: '#2563EB', color2: '#0EA5E9', accent: '#2F81F7', sc: '#1a3050' },
    { color: '#7C3AED', color2: '#BC8CFF', accent: '#8B5CF6', sc: '#251840' },
    { color: '#10B981', color2: '#34D399', accent: '#3FB950', sc: '#0d3020' },
    { color: '#EC4899', color2: '#F472B6', accent: '#F472B6', sc: '#1f1418' },
    { color: '#0891B2', color2: '#06B6D4', accent: '#39C5CF', sc: '#0a2830' },
    { color: '#059669', color2: '#10B981', accent: '#10B981', sc: '#0a3020' }
  ];

  function normStatus(s) {
    var v = String(s == null ? '' : s).toLowerCase();
    if (v === 'working' || v === 'running' || v === 'busy' || v === 'streaming' || v === 'active') return 'working';
    if (v === 'offline' || v === 'paused') return 'offline';
    return 'idle';
  }

  function presenceObj(seat) {
    return seat && seat.presence && typeof seat.presence === 'object' ? seat.presence : {};
  }

  function rawPresence(seat) {
    var p = seat && seat.presence;
    if (p && typeof p === 'object') return p.state;
    return p != null ? p : (seat && seat.status);
  }

  ns.officeCanvas.mapSeatsToAgents = function (seats) {
    return (seats || []).map(function (seat, i) {
      var p = presenceObj(seat);
      var pal = PALETTE[i % PALETTE.length];
      var status = normStatus(rawPresence(seat));
      var st = status === 'working' ? 'WORKING...' : (status === 'offline' ? 'OFFLINE' : 'READY');
      return {
        id: seat.employee_id || ('seat' + i),
        name: seat.display_name || seat.employee_id || '员工',
        role: seat.role_name || '数字员工',
        status: status,
        prog: status === 'working' ? 0.5 : (status === 'idle' ? 1.0 : 0),
        cur: p.current_task || seat.current_task || '等待任务',
        conversation_id: p.conversation_id || seat.conversation_id || '',
        color: pal.color,
        color2: pal.color2,
        accent: pal.accent,
        sc: pal.sc,
        col: 4 + (i % 2) * 6,
        row: 2 + Math.floor(i / 2) * 4,
        dir: (i % 2) ? -1 : 1,
        st: st
      };
    });
  };

  // mount(canvasEl, wrapEl, tooltipRefs, agents, onClickAgent)
  // Ports prototype isometric office canvas; globals → closure state; LOBBY_AGENTS → agents.
  ns.officeCanvas.mount = function (lCanvas, wrap, tooltipRefs, agents, onClickAgent) {
    if (!lCanvas || typeof lCanvas.getContext !== 'function') return null;
    var lCtx = lCanvas.getContext('2d');
    var TW = 64, TH = 32;
    var lobbyAnimTime = 0, lobbyScale = 1, lobbyOffX = 0, lobbyOffY = 0;
    var lobbyDragging = false, lobbyDragSX = 0, lobbyDragSY = 0, lobbyDragOX = 0, lobbyDragOY = 0;
    var lobbyHover = null;
    var rafId = null, running = true;
    agents = agents || [];
    tooltipRefs = tooltipRefs || {};
    var tt = tooltipRefs.tooltip || null;

    function lobbyIso(c, r) {
      var cx = lCanvas.width / 2 + lobbyOffX + lobbyDragOX;
      var cy = lCanvas.height * 0.28 + lobbyOffY + lobbyDragOY;
      return { x: cx + (c - r) * TW * lobbyScale, y: cy + (c + r) * TH * lobbyScale };
    }

    function drawFloorTile(c, r, color) {
      var p = lobbyIso(c, r), w = TW * lobbyScale, h = TH * lobbyScale;
      lCtx.beginPath(); lCtx.moveTo(p.x, p.y); lCtx.lineTo(p.x + w, p.y + h); lCtx.lineTo(p.x, p.y + h * 2); lCtx.lineTo(p.x - w, p.y + h); lCtx.closePath();
      lCtx.fillStyle = color; lCtx.fill();
      lCtx.strokeStyle = 'rgba(40,48,58,0.5)'; lCtx.lineWidth = 0.5; lCtx.stroke();
    }

    function drawHorse(x, y, a, s) {
      lCtx.save(); lCtx.translate(x, y);
      if (a.dir === -1) lCtx.scale(-1, 1);
      var sz = s * lobbyScale;
      lCtx.beginPath();
      lCtx.ellipse(0, sz * 2, sz * 7, sz * 4, 0, 0, Math.PI * 2);
      lCtx.fillStyle = a.color + '35'; lCtx.fill();
      lCtx.strokeStyle = a.accent; lCtx.lineWidth = 1.5; lCtx.stroke();
      lCtx.beginPath(); lCtx.moveTo(sz * 5, -sz * 2); lCtx.quadraticCurveTo(sz * 10, -sz * 12, sz * 8, -sz * 16); lCtx.lineTo(sz * 4, -sz * 14); lCtx.lineTo(sz * 3, -sz * 6);
      lCtx.closePath();
      lCtx.fillStyle = a.color + '30'; lCtx.fill();
      lCtx.strokeStyle = a.accent; lCtx.lineWidth = 1.5; lCtx.stroke();
      lCtx.beginPath(); lCtx.moveTo(sz * 6, -sz * 14); lCtx.quadraticCurveTo(sz * 12, -sz * 18, sz * 12, -sz * 10); lCtx.lineTo(sz * 6, -sz * 10);
      lCtx.closePath();
      lCtx.fillStyle = a.color + '45'; lCtx.fill();
      lCtx.strokeStyle = a.accent; lCtx.lineWidth = 1.5; lCtx.stroke();
      lCtx.beginPath();
      for (var i = 0; i < 5; i++) {
        lCtx.moveTo(sz * (6 - i * 0.5), -sz * (13 - i * 1.2));
        lCtx.quadraticCurveTo(sz * (8 - i * 0.5), -sz * (15 - i * 1.2), sz * (7 - i * 0.5), -sz * (11 - i * 1.2));
      }
      lCtx.strokeStyle = a.accent; lCtx.lineWidth = 1.2; lCtx.stroke();
      lCtx.beginPath(); lCtx.arc(sz * 9, -sz * 13, sz * 1.8, 0, Math.PI * 2);
      lCtx.fillStyle = a.accent; lCtx.fill();
      if (a.status === 'working') { lCtx.shadowColor = a.accent; lCtx.shadowBlur = 6 * lobbyScale; lCtx.fill(); lCtx.shadowBlur = 0; }
      lCtx.strokeStyle = a.accent; lCtx.lineWidth = 1.2;
      var legs = [-5, -2, 2, 5];
      for (var li = 0; li < legs.length; li++) {
        var lx = legs[li];
        lCtx.beginPath(); lCtx.moveTo(sz * lx, sz * 4); lCtx.lineTo(sz * (lx * 0.8), sz * 12); lCtx.stroke();
      }
      lCtx.font = '700 ' + Math.max(10, sz * 2) + 'px -apple-system,sans-serif';
      lCtx.textAlign = 'center';
      lCtx.fillStyle = a.status === 'offline' ? '#656D76' : '#E6EDF3';
      lCtx.fillText(a.name, 0, sz * 16);
      var sd = a.status === 'working' ? a.accent : (a.status === 'idle' ? '#3FB950' : '#656D76');
      lCtx.beginPath(); lCtx.arc(0, sz * 20, sz * 1.5, 0, Math.PI * 2);
      lCtx.fillStyle = sd; lCtx.fill();
      if (a.status === 'working') { lCtx.shadowColor = sd; lCtx.shadowBlur = 4 * lobbyScale; lCtx.fill(); lCtx.shadowBlur = 0; }
      lCtx.restore();
    }

    function drawOfficeChair(x, y, a, s) {
      var cw = 18 * s, ch = 14 * s;
      lCtx.beginPath(); lCtx.moveTo(x, y + ch); lCtx.lineTo(x + cw * 0.3, y + ch + 6 * s); lCtx.lineTo(x - cw * 0.3, y + ch + 6 * s); lCtx.closePath();
      lCtx.fillStyle = '#2d333b'; lCtx.fill();
      lCtx.beginPath(); lCtx.moveTo(x - cw * 0.5, y + ch * 0.5); lCtx.lineTo(x + cw * 0.5, y + ch * 0.5); lCtx.lineTo(x + cw * 0.4, y + ch); lCtx.lineTo(x - cw * 0.4, y + ch); lCtx.closePath();
      lCtx.fillStyle = '#3d444e'; lCtx.fill(); lCtx.strokeStyle = '#505a66'; lCtx.lineWidth = 0.5; lCtx.stroke();
      lCtx.beginPath(); lCtx.moveTo(x - cw * 0.4, y + ch * 0.5); lCtx.lineTo(x - cw * 0.35, y - ch * 0.3); lCtx.lineTo(x + cw * 0.35, y - ch * 0.3); lCtx.lineTo(x + cw * 0.4, y + ch * 0.5); lCtx.closePath();
      lCtx.fillStyle = '#4a5568'; lCtx.fill(); lCtx.stroke();
    }

    function drawPremiumDesk(col, row, a) {
      var p = lobbyIso(col, row), s = lobbyScale;
      var dw = TW * s * 2.4, dh = TH * s * 2.4, dd = 10 * s;
      lCtx.beginPath(); lCtx.moveTo(p.x - dw * 0.3, p.y + dh * 0.5); lCtx.lineTo(p.x + dw * 0.3, p.y + dh * 0.5); lCtx.lineTo(p.x + dw * 0.5, p.y + dh * 0.9); lCtx.lineTo(p.x - dw * 0.5, p.y + dh * 0.9); lCtx.closePath();
      lCtx.fillStyle = 'rgba(0,0,0,0.4)'; lCtx.fill();
      lCtx.beginPath(); lCtx.moveTo(p.x - dw * 0.5, p.y); lCtx.lineTo(p.x + dw * 0.15, p.y - dh * 0.3); lCtx.lineTo(p.x + dw * 0.5, p.y); lCtx.lineTo(p.x, p.y + dh * 0.3); lCtx.closePath();
      var dg = lCtx.createLinearGradient(p.x, p.y - dh * 0.3, p.x, p.y + dh * 0.3);
      dg.addColorStop(0, '#3a4450'); dg.addColorStop(0.5, '#2d3540'); dg.addColorStop(1, '#1e2530');
      lCtx.fillStyle = dg; lCtx.fill();
      lCtx.strokeStyle = '#4a5568'; lCtx.lineWidth = 0.8; lCtx.stroke();
      lCtx.beginPath(); lCtx.moveTo(p.x - dw * 0.5, p.y); lCtx.lineTo(p.x, p.y + dh * 0.3); lCtx.lineTo(p.x, p.y + dh * 0.3 + dd); lCtx.lineTo(p.x - dw * 0.5, p.y + dd); lCtx.closePath();
      lCtx.fillStyle = '#1c2330'; lCtx.fill(); lCtx.strokeStyle = '#303848'; lCtx.stroke();
      lCtx.beginPath(); lCtx.moveTo(p.x, p.y + dh * 0.3); lCtx.lineTo(p.x + dw * 0.5, p.y); lCtx.lineTo(p.x + dw * 0.5, p.y + dd); lCtx.lineTo(p.x, p.y + dh * 0.3 + dd); lCtx.closePath();
      lCtx.fillStyle = '#162030'; lCtx.fill(); lCtx.stroke();
      var mx = a.dir === 1 ? p.x - dw * 0.12 : p.x + dw * 0.12, my = p.y - dh * 0.12;
      var mw = dw * 0.42, mh = dh * 0.32;
      lCtx.beginPath(); lCtx.moveTo(mx, my + mh); lCtx.lineTo(mx + 4 * s, my + mh + 10 * s); lCtx.lineTo(mx - 4 * s, my + mh + 10 * s); lCtx.closePath();
      lCtx.fillStyle = '#555e6b'; lCtx.fill();
      lCtx.beginPath(); lCtx.moveTo(mx - mw * 0.5 - 2 * s, my - 2 * s); lCtx.lineTo(mx + mw * 0.5 + 2 * s, my - 2 * s); lCtx.lineTo(mx + mw * 0.5 + 2 * s, my + mh + 2 * s); lCtx.lineTo(mx - mw * 0.5 - 2 * s, my + mh + 2 * s); lCtx.closePath();
      lCtx.fillStyle = '#1a1a2e'; lCtx.fill();
      lCtx.beginPath(); lCtx.moveTo(mx - mw * 0.5, my); lCtx.lineTo(mx + mw * 0.5, my); lCtx.lineTo(mx + mw * 0.5, my + mh); lCtx.lineTo(mx - mw * 0.5, my + mh); lCtx.closePath();
      lCtx.fillStyle = a.sc; lCtx.fill();
      var sg = lCtx.createRadialGradient(mx, my + mh * 0.25, 0, mx, my + mh * 0.25, mw * 0.8);
      sg.addColorStop(0, a.accent + '30'); sg.addColorStop(1, 'transparent');
      lCtx.fillStyle = sg; lCtx.fill();
      lCtx.fillStyle = a.accent + 'aa'; lCtx.font = '700 ' + Math.max(11, s * 13) + "px 'SF Mono',monospace"; lCtx.textAlign = 'center';
      lCtx.fillText(a.st, mx, my + mh * 0.55);
      if (a.status === 'working') {
        var bw = mw * 0.75, bh = 4 * s, bx = mx - bw * 0.5, by = my + mh * 0.75;
        lCtx.fillStyle = '#0a0a14'; lCtx.fillRect(bx, by, bw, bh);
        lCtx.fillStyle = a.accent; lCtx.fillRect(bx, by, bw * a.prog, bh);
      }
      var kx = a.dir === 1 ? p.x - dw * 0.3 : p.x + dw * 0.1, ky = p.y + dh * 0.1;
      lCtx.beginPath(); lCtx.moveTo(kx, ky); lCtx.lineTo(kx + dw * 0.22, ky - dh * 0.08); lCtx.lineTo(kx + dw * 0.28, ky + dh * 0.03); lCtx.lineTo(kx + dw * 0.06, ky + dh * 0.11); lCtx.closePath();
      lCtx.fillStyle = '#4a5568'; lCtx.fill();
      var chx = a.dir === 1 ? p.x - dw * 0.7 : p.x + dw * 0.5, chy = p.y + dh * 0.05;
      drawOfficeChair(chx, chy, a, s);
      var hx = a.dir === 1 ? p.x - dw * 0.65 : p.x + dw * 0.45, hy = p.y - dh * 0.15;
      drawHorse(hx, hy, a, 7.5);
    }

    function drawLobbyScene() {
      for (var r = 0; r < 10; r++) {
        for (var c = 0; c < 16; c++) {
          var hasDesk = agents.some(function (a) { return a.col === c && a.row === r; });
          var clr = hasDesk ? '#1a2435' : ((c + r) % 2 === 0 ? '#131e2a' : '#101820');
          drawFloorTile(c, r, clr);
        }
      }
      var bl = lobbyIso(0, 0), br = lobbyIso(15, 0), wh = 120 * lobbyScale;
      lCtx.beginPath(); lCtx.moveTo(bl.x, bl.y); lCtx.lineTo(br.x + TW * lobbyScale, br.y); lCtx.lineTo(br.x + TW * lobbyScale, br.y - wh); lCtx.lineTo(bl.x, bl.y - wh); lCtx.closePath();
      var wg = lCtx.createLinearGradient(0, bl.y - wh, 0, bl.y);
      wg.addColorStop(0, '#0a1628'); wg.addColorStop(0.5, '#0d1a30'); wg.addColorStop(1, '#111d35');
      lCtx.fillStyle = wg; lCtx.fill(); lCtx.strokeStyle = '#1e2d45'; lCtx.lineWidth = 1; lCtx.stroke();
      var winY = bl.y - wh * 0.92, winH = wh * 0.65;
      for (var wi = 0; wi < 4; wi++) {
        var wx = bl.x + TW * lobbyScale * (2 + wi * 3.5), ww = TW * lobbyScale * 2.8;
        lCtx.fillStyle = '#0a1a30'; lCtx.fillRect(wx, winY, ww, winH);
        var wg2 = lCtx.createLinearGradient(0, winY, 0, winY + winH);
        wg2.addColorStop(0, '#0d1425'); wg2.addColorStop(0.3, '#151f40'); wg2.addColorStop(0.7, '#1a3055'); wg2.addColorStop(1, '#203860');
        lCtx.fillStyle = wg2; lCtx.fillRect(wx + 4 * lobbyScale, winY + 4 * lobbyScale, ww - 8 * lobbyScale, winH - 8 * lobbyScale);
        lCtx.fillStyle = '#060d18';
        lCtx.fillRect(wx + 6 * lobbyScale, winY + winH * 0.35, ww * 0.15, winH * 0.65);
        lCtx.fillRect(wx + ww * 0.2, winY + winH * 0.5, ww * 0.12, winH * 0.5);
        lCtx.fillRect(wx + ww * 0.38, winY + winH * 0.25, ww * 0.18, winH * 0.75);
        lCtx.fillRect(wx + ww * 0.6, winY + winH * 0.45, ww * 0.1, winH * 0.55);
        lCtx.fillRect(wx + ww * 0.75, winY + winH * 0.3, ww * 0.14, winH * 0.7);
        for (var lci = 0; lci < 12; lci++) {
          var clx = wx + ww * 0.12 + Math.random() * ww * 0.76, cly = winY + winH * 0.4 + Math.random() * winH * 0.5;
          lCtx.beginPath(); lCtx.arc(clx, cly, 1.5 * lobbyScale, 0, Math.PI * 2);
          lCtx.fillStyle = 'rgba(255,220,120,' + (0.2 + Math.random() * 0.3) + ')'; lCtx.fill();
        }
        lCtx.strokeStyle = '#152540'; lCtx.lineWidth = 3 * lobbyScale;
        lCtx.strokeRect(wx, winY, ww, winH);
        lCtx.beginPath(); lCtx.moveTo(wx + ww * 0.5, winY); lCtx.lineTo(wx + ww * 0.5, winY + winH); lCtx.stroke();
      }
      lCtx.fillStyle = '#1a2c45'; lCtx.fillRect(bl.x, bl.y - wh + winH + 10 * lobbyScale, br.x - bl.x + TW * lobbyScale, wh - winH - 10 * lobbyScale);
      for (var ci = 2; ci < 14; ci += 3) {
        var clp = lobbyIso(ci, 0);
        lCtx.beginPath(); lCtx.ellipse(clp.x, clp.y - wh - 15 * lobbyScale, 20 * lobbyScale, 6 * lobbyScale, 0, 0, Math.PI * 2);
        lCtx.fillStyle = 'rgba(60,80,120,0.15)'; lCtx.fill();
        lCtx.beginPath(); lCtx.ellipse(clp.x, clp.y - wh - 15 * lobbyScale, 6 * lobbyScale, 2 * lobbyScale, 0, 0, Math.PI * 2);
        lCtx.fillStyle = 'rgba(180,200,255,0.4)'; lCtx.fill();
      }
      var lw1 = lobbyIso(0, 0), lw2 = lobbyIso(0, 9);
      lCtx.beginPath(); lCtx.moveTo(lw1.x, lw1.y); lCtx.lineTo(lw2.x - TW * lobbyScale, lw2.y + TH * lobbyScale); lCtx.lineTo(lw2.x - TW * lobbyScale, lw2.y + TH * lobbyScale - wh); lCtx.lineTo(lw1.x, lw1.y - wh); lCtx.closePath();
      lCtx.fillStyle = '#0c1525'; lCtx.fill(); lCtx.strokeStyle = '#162030'; lCtx.stroke();
      var plants = [{ c: 0, r: 3 }, { c: 0, r: 7 }, { c: 15, r: 3 }];
      for (var pi = 0; pi < plants.length; pi++) {
        var pp = lobbyIso(plants[pi].c, plants[pi].r);
        lCtx.beginPath(); lCtx.moveTo(pp.x - 6 * lobbyScale, pp.y + 6 * lobbyScale); lCtx.lineTo(pp.x + 6 * lobbyScale, pp.y + 6 * lobbyScale); lCtx.lineTo(pp.x + 8 * lobbyScale, pp.y + 14 * lobbyScale); lCtx.lineTo(pp.x - 8 * lobbyScale, pp.y + 14 * lobbyScale); lCtx.closePath();
        lCtx.fillStyle = '#4a3520'; lCtx.fill(); lCtx.strokeStyle = '#5a4530'; lCtx.stroke();
        lCtx.beginPath(); lCtx.arc(pp.x, pp.y + 2 * lobbyScale, 10 * lobbyScale, 0, Math.PI * 2);
        lCtx.fillStyle = 'rgba(63,185,80,0.5)'; lCtx.fill();
        lCtx.beginPath(); lCtx.arc(pp.x + 3 * lobbyScale, pp.y - 2 * lobbyScale, 6 * lobbyScale, 0, Math.PI * 2);
        lCtx.fillStyle = 'rgba(63,185,80,0.6)'; lCtx.fill();
      }
      var sorted = agents.slice().sort(function (a, b) { return a.row - b.row; });
      for (var si = 0; si < sorted.length; si++) drawPremiumDesk(sorted[si].col, sorted[si].row, sorted[si]);
      if (lobbyHover) {
        var hp = lobbyIso(lobbyHover.col, lobbyHover.row);
        lCtx.beginPath(); lCtx.arc(hp.x, hp.y + TH * lobbyScale * 0.5, 40 * lobbyScale, 0, Math.PI * 2);
        lCtx.strokeStyle = lobbyHover.accent; lCtx.lineWidth = 2; lCtx.setLineDash([4, 4]); lCtx.stroke(); lCtx.setLineDash([]);
      }
    }

    function lobbyAnimate() {
      if (!running) return;
      lobbyAnimTime += 0.016;
      if (!lCtx) return;
      lCtx.clearRect(0, 0, lCanvas.width, lCanvas.height);
      var bg = lCtx.createLinearGradient(0, 0, 0, lCanvas.height);
      bg.addColorStop(0, '#080d15'); bg.addColorStop(0.6, '#0d1520'); bg.addColorStop(1, '#0d1117');
      lCtx.fillStyle = bg; lCtx.fillRect(0, 0, lCanvas.width, lCanvas.height);
      drawLobbyScene();
      for (var i = 0; i < 10; i++) {
        lCtx.beginPath(); lCtx.arc(lCanvas.width * 0.3 + Math.sin(lobbyAnimTime * 0.4 + i) * 120, lCanvas.height * 0.15 + Math.cos(lobbyAnimTime * 0.25 + i * 0.7) * 60, 1.5, 0, Math.PI * 2);
        lCtx.fillStyle = 'rgba(47,129,247,' + (0.08 + Math.sin(lobbyAnimTime + i) * 0.04) + ')'; lCtx.fill();
      }
      for (var ai = 0; ai < agents.length; ai++) {
        var a = agents[ai];
        if (a.status === 'working') { var dots = new Array((Math.floor(lobbyAnimTime * 2.5) % 4) + 1).join('.'); a.st = a.st.replace(/\.*$/, '') + dots; }
      }
      rafId = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(lobbyAnimate) : null;
    }

    function lobbyResize() {
      if (!wrap || !lCanvas) return;
      lCanvas.width = wrap.clientWidth || 800;
      lCanvas.height = wrap.clientHeight || 480;
      // 初始视角：把 16×10 地板的几何中心对到画布中心（中心格 c=7.5, r=4.5）。
      lobbyOffX = -(7.5 - 4.5) * TW * lobbyScale;
      lobbyOffY = lCanvas.height * 0.5 - lCanvas.height * 0.28 - (7.5 + 4.5) * TH * lobbyScale;
    }

    function setTooltipText(ref, value) {
      if (ref && 'textContent' in ref) ref.textContent = value;
    }

    lobbyResize();
    var onWinResize = function () { lobbyResize(); };
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', onWinResize);

    lCanvas.addEventListener('mousedown', function (e) { lobbyDragging = true; lobbyDragSX = e.clientX; lobbyDragSY = e.clientY; });
    lCanvas.addEventListener('mousemove', function (e) {
      var rect = lCanvas.getBoundingClientRect ? lCanvas.getBoundingClientRect() : { left: 0, top: 0 };
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (lobbyDragging) { lobbyDragOX = e.clientX - lobbyDragSX; lobbyDragOY = e.clientY - lobbyDragSY; }
      var found = null;
      for (var i = 0; i < agents.length; i++) {
        var p = lobbyIso(agents[i].col, agents[i].row);
        if (Math.sqrt(Math.pow(mx - p.x, 2) + Math.pow(my - (p.y + TH * lobbyScale * 0.3), 2)) < 50 * lobbyScale) { found = agents[i]; break; }
      }
      lobbyHover = found;
      lCanvas.style.cursor = found ? 'pointer' : (lobbyDragging ? 'grabbing' : 'grab');
      if (tt) {
        if (found) {
          setTooltipText(tooltipRefs.avatar, '🐴');
          if (tooltipRefs.avatar && tooltipRefs.avatar.style) tooltipRefs.avatar.style.background = 'linear-gradient(135deg,' + found.color + ',' + found.color2 + ')';
          setTooltipText(tooltipRefs.name, found.name);
          setTooltipText(tooltipRefs.role, found.role);
          setTooltipText(tooltipRefs.task, found.cur);
          setTooltipText(tooltipRefs.status, found.status === 'working' ? '忙碌' : (found.status === 'offline' ? '离线' : '空闲'));
          if (tt.style) { tt.style.left = (e.clientX + 20) + 'px'; tt.style.top = (e.clientY - 20) + 'px'; }
          if (tt.classList) tt.classList.add('is-show');
        } else if (tt.classList) {
          tt.classList.remove('is-show');
        }
      }
    });
    lCanvas.addEventListener('mouseup', function () { if (lobbyDragging) { lobbyOffX += lobbyDragOX; lobbyOffY += lobbyDragOY; lobbyDragOX = 0; lobbyDragOY = 0; } lobbyDragging = false; });
    lCanvas.addEventListener('mouseleave', function () { lobbyDragging = false; if (tt && tt.classList) tt.classList.remove('is-show'); });
    lCanvas.addEventListener('click', function () { if (lobbyHover && typeof onClickAgent === 'function') onClickAgent(lobbyHover); });
    lCanvas.addEventListener('wheel', function (e) { if (e.preventDefault) e.preventDefault(); lobbyScale = Math.max(0.5, Math.min(2.2, lobbyScale * (e.deltaY > 0 ? 0.92 : 1.08))); });

    lobbyAnimate();

    return {
      destroy: function () {
        running = false;
        if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
        if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('resize', onWinResize);
      },
      setAgents: function (next) { agents = next || []; }
    };
  };
}(window.aiteam));
