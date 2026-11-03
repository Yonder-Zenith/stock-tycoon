/* A股大亨 —— 前端逻辑（原生 JS，无构建） */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const APP = {
    data: null,
    quotes: new Map(),
    selected: localStorage.getItem("tycoon.selected") || "sh600519",
    side: "buy",
    minute: null,
    minuteCode: "",
    minuteAt: 0,
    knownAchievements: new Set(),
    busy: false,
    feedWarned: false,
    polling: null,
  };

  /* --------------------------------------------------------------- 工具 */
  const fmt = (n, d = 2) =>
    (Number(n) || 0).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
  const money = (n) => "¥" + fmt(n);
  const signed = (n) => (n > 0 ? "+" : "") + fmt(n);
  const pctText = (n) => (n > 0 ? "+" : "") + fmt(n, 2) + "%";
  const dirClass = (n) => (n > 0.0001 ? "up" : n < -0.0001 ? "down" : "flat");
  const dirBg = (n) => (n > 0.0001 ? "up-bg" : n < -0.0001 ? "down-bg" : "flat-bg");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
    let body = null;
    try { body = await res.json(); } catch (e) { body = { error: "bad json" }; }
    if (!res.ok && body && body.ok !== false) throw new Error(body.error || ("HTTP " + res.status));
    return body;
  }

  function toast(title, msg, kind = "ok", ttl = 3600) {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.innerHTML = `<b>${esc(title)}</b>${msg ? `<span>${esc(msg)}</span>` : ""}`;
    $("#toasts").appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .3s, transform .3s";
      el.style.opacity = "0";
      el.style.transform = "translateX(20px)";
      setTimeout(() => el.remove(), 320);
    }, ttl);
  }

  /* --------------------------------------------------------------- 弹窗 */
  let modalOk = null;
  function modal({ icon = "📈", title, html, okText = "确定", cancelText = "取消", hideCancel = false, onOk }) {
    $("#modalIcon").textContent = icon;
    $("#modalTitle").textContent = title;
    $("#modalText").innerHTML = html;
    $("#modalOk").textContent = okText;
    $("#modalCancel").textContent = cancelText;
    $("#modalCancel").classList.toggle("hidden", hideCancel);
    modalOk = onOk || null;
    $("#modal").classList.remove("hidden");
  }
  function closeModal() { $("#modal").classList.add("hidden"); modalOk = null; }

  $("#modalOk").addEventListener("click", () => { const fn = modalOk; closeModal(); if (fn) fn(); });
  $("#modalCancel").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

  /* --------------------------------------------------------------- 绘图 */
  function canvasCtx(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.floor(rect.width));
    const h = Math.max(10, Math.floor(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function drawMinute() {
    const canvas = $("#minuteChart");
    const { ctx, w, h } = canvasCtx(canvas);
    const m = APP.minute;
    const padL = 6, padR = 54, padT = 10, padB = 18;
    const iw = w - padL - padR;
    const ih = h - padT - padB;

    if (!m || !m.points || m.points.length < 2) {
      $("#chartEmpty").style.display = "grid";
      $("#chartEmpty").textContent = m ? "暂无分时数据（未开盘或停牌）" : "选择左侧股票查看分时";
      return;
    }
    $("#chartEmpty").style.display = "none";

    const pts = m.points;
    const prev = Number(m.prevClose) || pts[0].p;
    let min = Math.min(prev, ...pts.map((p) => p.p));
    let max = Math.max(prev, ...pts.map((p) => p.p));
    if (max - min < prev * 0.002) { max += prev * 0.002; min -= prev * 0.002; }
    const pad = (max - min) * 0.12;
    min -= pad; max += pad;

    // 交易分钟序号：09:30=0，11:30=120，13:00=120，15:00=240
    const ord = (t) => {
      const [hh, mm] = String(t).split(":").map(Number);
      const v = hh * 60 + (mm || 0);
      if (v <= 11 * 60 + 30) return v - (9 * 60 + 30);
      if (v < 13 * 60) return 120;
      return 120 + (v - 13 * 60);
    };
    const clampOrd = (t) => Math.max(0, Math.min(240, ord(t)));

    const y = (v) => padT + ih - ((v - min) / (max - min)) * ih;
    const x = (i) => padL + (clampOrd(pts[i].t) / 240) * iw;

    // 网格
    ctx.strokeStyle = "rgba(255,255,255,.055)";
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "#4d5a72";
    ctx.textAlign = "left";
    for (let i = 0; i <= 4; i++) {
      const v = min + ((max - min) * i) / 4;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + iw, yy); ctx.stroke();
      ctx.fillText(v.toFixed(2), padL + iw + 6, yy + 3);
    }

    // 昨收线
    const yPrev = y(prev);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(240,185,11,.4)";
    ctx.beginPath(); ctx.moveTo(padL, yPrev); ctx.lineTo(padL + iw, yPrev); ctx.stroke();
    ctx.restore();

    // 涨跌分色：以昨收为界
    const last = pts[pts.length - 1].p;
    const main = last >= prev ? "#ff5c5c" : "#17d1a0";
    const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
    grad.addColorStop(0, last >= prev ? "rgba(255,92,92,.30)" : "rgba(23,209,160,.30)");
    grad.addColorStop(1, "rgba(10,14,22,0)");

    ctx.beginPath();
    ctx.moveTo(x(0), y(pts[0].p));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(x(i), y(pts[i].p));
    ctx.lineTo(padL + iw, padT + ih);
    ctx.lineTo(padL, padT + ih);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x(0), y(pts[0].p));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(x(i), y(pts[i].p));
    ctx.strokeStyle = main;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.stroke();

    // 端点
    const lx = x(pts.length - 1), ly = y(last);
    ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fillStyle = main; ctx.fill();
    ctx.beginPath(); ctx.arc(lx, ly, 6, 0, Math.PI * 2);
    ctx.fillStyle = last >= prev ? "rgba(255,92,92,.22)" : "rgba(23,209,160,.22)"; ctx.fill();

    // 时间轴
    ctx.fillStyle = "#4d5a72";
    ctx.textAlign = "center";
    [["09:30", 0], ["10:30", 60], ["11:30/13:00", 120], ["14:00", 180], ["15:00", 240]].forEach(([label, o]) => {
      ctx.fillText(label, padL + (o / 240) * iw, h - 4);
    });
  }

  function drawEquity() {
    const canvas = $("#equityChart");
    const { ctx, w, h } = canvasCtx(canvas);
    const eq = (APP.data && APP.data.equity) || [];
    const padL = 4, padR = 46, padT = 8, padB = 12;
    const iw = w - padL - padR, ih = h - padT - padB;
    const base = (APP.data && APP.data.account.initialCash) || 1000000;

    let pts = eq.map((e) => Number(e.total) || base);
    if (pts.length < 2) pts = [base, pts[0] || base];
    let min = Math.min(...pts, base), max = Math.max(...pts, base);
    if (max - min < base * 0.01) { max += base * 0.005; min -= base * 0.005; }
    const pad = (max - min) * 0.15;
    min -= pad; max += pad;

    const y = (v) => padT + ih - ((v - min) / (max - min)) * ih;
    const x = (i) => padL + (i / (pts.length - 1)) * iw;

    ctx.strokeStyle = "rgba(255,255,255,.05)";
    ctx.font = "9.5px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "#4d5a72";
    ctx.textAlign = "left";
    for (let i = 0; i <= 2; i++) {
      const yy = Math.round(padT + (ih * i) / 2) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + iw, yy); ctx.stroke();
    }
    ctx.fillText((max / 10000).toFixed(0) + "万", padL + iw + 5, padT + 8);
    ctx.fillText(((min + max) / 2 / 10000).toFixed(0) + "万", padL + iw + 5, padT + ih / 2 + 3);
    ctx.fillText((min / 10000).toFixed(0) + "万", padL + iw + 5, padT + ih);

    // 本金线
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(240,185,11,.28)";
    ctx.beginPath(); ctx.moveTo(padL, y(base)); ctx.lineTo(padL + iw, y(base)); ctx.stroke();
    ctx.restore();

    const up = pts[pts.length - 1] >= base;
    const color = up ? "#ff5c5c" : "#17d1a0";
    const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
    grad.addColorStop(0, up ? "rgba(255,92,92,.28)" : "rgba(23,209,160,.28)");
    grad.addColorStop(1, "rgba(10,14,22,0)");

    ctx.beginPath();
    ctx.moveTo(x(0), y(pts[0]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(x(i), y(pts[i]));
    ctx.lineTo(x(pts.length - 1), padT + ih);
    ctx.lineTo(padL, padT + ih);
    ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x(0), y(pts[0]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(x(i), y(pts[i]));
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = "round";
    ctx.stroke();

    const lx = x(pts.length - 1), ly = y(pts[pts.length - 1]);
    ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  }

  /* --------------------------------------------------------------- 渲染 */
  function selectedQuote() {
    return APP.quotes.get(APP.selected) || null;
  }

  function renderHeader(d) {
    const a = d.account;
    $("#totalAsset").textContent = money(a.total);
    const tp = $("#totalProfit");
    tp.textContent = `${signed(a.profit)}  ${pctText(a.profitPct)}`;
    tp.className = "chip " + dirBg(a.profit);

    $("#dayPnl").textContent = signed(a.dayProfit);
    $("#dayPnl").className = dirClass(a.dayProfit);
    $("#marketValue").textContent = money(a.marketValue);
    $("#cash").textContent = money(a.cash);
    $("#rank").textContent = `${a.rankIcon} ${a.rank}`;
    const mb = $("#mbTotal");
    if (mb) mb.textContent = money(a.total);

    const pct = Math.max(0, Math.min(100, d.season.progress * 100));
    $("#seasonBar").style.width = pct.toFixed(1) + "%";
    $("#seasonPct").textContent = pct.toFixed(1) + "%";
    $("#seasonDays").textContent = `第 ${d.season.days} 个交易日`;

    const feed = d.feed;
    const el = $("#feedState");
    if (feed.source === "live") {
      el.textContent = `● 实时 ${feed.lastFetch || ""}`;
      el.className = "feed live";
    } else {
      el.textContent = "● 模拟行情（网络异常）";
      el.className = "feed stale";
      if (!APP.feedWarned) {
        APP.feedWarned = true;
        toast("行情连接异常", "已切换为本地模拟行情，网络恢复后自动切回", "err", 5000);
      }
    }

    const m = d.market;
    $("#clock").textContent = `${m.status} ${m.time}`;
    const eq = d.equity || [];
    if (eq.length > 1) {
      $("#equityRange").textContent = `${eq[0].t.slice(5, 10)} → ${eq[eq.length - 1].t.slice(5, 10)}`;
    }
    document.title = `${money(a.total)} · A股大亨`;
  }

  function renderIndices(d) {
    const box = $("#indices");
    box.innerHTML = d.indices
      .map((i) => `
        <div class="index-item">
          <span>${esc(i.name)}</span>
          <b class="${dirClass(i.pct)}">${i.price ? fmt(i.price, 2) : "--"}</b>
          <i class="${dirClass(i.pct)}">${pctText(i.pct)}</i>
        </div>`)
      .join("");
  }

  function renderWatch(d) {
    const list = $("#watchList");
    const keep = list.scrollTop;
    const rows = (d.watchlist || []).slice().sort((a, b) => (a.code === APP.selected ? -1 : b.code === APP.selected ? 1 : 0));
    if (!rows.length) {
      list.innerHTML = `<div class="empty-tip">还没有自选股<br/>用上方搜索添加</div>`;
      list.scrollTop = keep;
      return;
    }
    list.innerHTML = rows
      .map((q) => `
        <div class="watch-row ${q.code === APP.selected ? "active" : ""}" data-code="${q.code}">
          <div class="wname"><b>${esc(q.name)}</b><span>${q.code.slice(2)}</span></div>
          <div class="wp ${dirClass(q.pct)}">${fmt(q.price)}</div>
          <div class="wc ${dirBg(q.pct)}">${pctText(q.pct)}</div>
        </div>`)
      .join("");

    list.querySelectorAll(".watch-row").forEach((el) => {
      el.addEventListener("click", () => selectStock(el.dataset.code));
    });
    list.scrollTop = keep;
  }

  function renderStock(d) {
    const q = selectedQuote();
    if (!q) {
      $("#stockName").textContent = "--";
      $("#stockCode").textContent = APP.selected.slice(2);
      $("#stockPrice").textContent = "--";
      $("#stockChange").textContent = "--";
      return;
    }
    $("#stockName").textContent = q.name;
    $("#stockCode").textContent = q.code.slice(2);
    const price = $("#stockPrice");
    price.textContent = fmt(q.price);
    price.className = dirClass(q.pct);
    const chg = $("#stockChange");
    chg.textContent = `${signed(q.change)}  ${pctText(q.pct)}`;
    chg.className = "chip " + dirBg(q.pct);
    $("#quoteTime").textContent = q.date ? `${q.date} ${q.time}` : "";
    $("#chartRange").textContent = q.prevClose ? `昨收 ${fmt(q.prevClose)}` : "";
    $("#starBtn").textContent = (d.watchlist || []).some((w) => w.code === APP.selected) ? "★" : "☆";
  }

  function positionOf(code) {
    return (APP.data?.positions || []).find((p) => p.code === code) || null;
  }

  function calcFees(side, amount) {
    const commission = Math.max(5, amount * 0.00025);
    const transfer = amount * 0.00001;
    const stamp = side === "sell" ? amount * 0.0005 : 0;
    return Math.round((commission + transfer + stamp) * 100) / 100;
  }

  function maxQty() {
    const q = selectedQuote();
    if (!q || !q.price) return 0;
    if (APP.side === "buy") {
      const cash = APP.data?.account.cash || 0;
      const per = q.price * 1.0003;
      return Math.max(0, Math.floor(cash / per / 100) * 100);
    }
    const p = positionOf(APP.selected);
    return p ? p.available : 0;
  }

  function renderTrade() {
    const q = selectedQuote();
    const price = q ? q.price : 0;
    const qtyInput = $("#qtyInput");
    const qty = Math.max(0, parseInt(qtyInput.value, 10) || 0);
    const amount = price * qty;
    const fees = qty > 0 ? calcFees(APP.side, amount) : 0;

    $("#tradePrice").textContent = price ? `市价 ¥${fmt(price)}` : "市价 --";
    $("#calcAmount").textContent = money(amount);
    $("#calcFees").textContent = money(fees);

    if (APP.side === "buy") {
      $("#calcAvailLabel").textContent = "可用现金";
      $("#calcAvail").textContent = money(APP.data?.account.cash || 0);
      $("#submitTrade").textContent = `买入 ${q ? q.name : ""}`;
      $("#submitTrade").className = "submit buy";
      $("#tradeTag").textContent = q && q.limitUp && q.price >= q.limitUp - 0.001 ? "涨停" : "";
    } else {
      const p = positionOf(APP.selected);
      $("#calcAvailLabel").textContent = "可卖数量";
      $("#calcAvail").textContent = p ? `${p.available} 股` : "0 股";
      $("#submitTrade").textContent = `卖出 ${q ? q.name : ""}`;
      $("#submitTrade").className = "submit sell";
      $("#tradeTag").textContent = p && p.available === 0 && p.qty > 0 ? "T+1 锁定" : "";
    }

    const disabled = !q || qty <= 0 || qty % 100 !== 0 ||
      (APP.side === "buy" ? amount + fees > (APP.data?.account.cash || 0) : qty > maxQty());
    $("#submitTrade").disabled = disabled;

    $("#tradePrice").className = q ? dirClass(q.pct) : "";
  }

  function renderPositions(d) {
    const box = $("#tabPositions");
    const keep = box.scrollTop;
    if (!d.positions.length) {
      box.innerHTML = `<div class="empty-tip">空仓中<br/>从左侧挑一只股票开始你的第一笔交易</div>`;
      box.scrollTop = keep;
      return;
    }
    box.innerHTML = d.positions
      .map((p) => `
        <div class="pos-card" data-code="${p.code}">
          <div class="pos-top">
            <b>${esc(p.name)}</b>
            <span class="pnl ${dirClass(p.pnl)}">${signed(p.pnl)} (${pctText(p.pnlPct)})</span>
          </div>
          <div class="pos-meta">
            <span>${p.qty}股 · 可卖${p.available}</span>
            <span>成本 ${fmt(p.costPrice)} → 现价 ${fmt(p.price)}</span>
          </div>
          <div class="pos-meta" style="margin-top:3px">
            <span>市值 ${money(p.value)}</span>
            <span class="${dirClass(p.pct)}">今日 ${pctText(p.pct)}</span>
          </div>
        </div>`)
      .join("");
    box.querySelectorAll(".pos-card").forEach((el) => {
      el.addEventListener("click", () => selectStock(el.dataset.code));
    });
    box.scrollTop = keep;
  }

  function renderTrades(d) {
    const box = $("#tabTrades");
    const keep = box.scrollTop;
    if (!d.trades.length) {
      box.innerHTML = `<div class="empty-tip">还没有成交记录</div>`;
      box.scrollTop = keep;
      return;
    }
    box.innerHTML = d.trades
      .map((t) => {
        const isBuy = t.side === "buy";
        return `
        <div class="trade-item">
          <span class="side ${isBuy ? "buy" : "sell"}">${isBuy ? "买" : "卖"}</span>
          <div class="tinfo">
            <b>${esc(t.name)} <span style="color:#74829b">${t.qty}股 @ ${fmt(t.price)}</span></b>
            <span>${t.time.slice(5, 16)} · 手续费 ${fmt(t.fees)}</span>
          </div>
          <div class="tnum ${isBuy ? "" : dirClass(t.pnl)}">
            ${isBuy ? "-" + fmt(t.amount) : (t.pnl >= 0 ? "+" : "") + fmt(t.pnl)}
          </div>
        </div>`;
      })
      .join("");
    box.scrollTop = keep;
  }

  function renderAchievements(d) {
    const box = $("#tabAchievements");
    const keep = box.scrollTop;
    const unlocked = d.achievements.filter((a) => a.unlocked);
    box.innerHTML = `
      <div class="ach-grid">
        ${d.achievements.map((a) => `
          <div class="ach ${a.unlocked ? "on" : ""}" title="${esc(a.desc)}">
            <div class="ai">${a.unlocked ? a.icon : "🔒"}</div>
            <b>${esc(a.name)}</b>
            <span>${esc(a.desc)}</span>
          </div>`).join("")}
      </div>
      <div class="empty-tip" style="padding:14px 4px 4px">
        已解锁 ${unlocked.length} / ${d.achievements.length}
      </div>`;
    box.scrollTop = keep;
  }

  function checkNewAchievements(d) {
    const first = !APP.firstRender;
    d.achievements.forEach((a) => {
      if (a.unlocked && !APP.knownAchievements.has(a.id)) {
        APP.knownAchievements.add(a.id);
        if (!first) toast(`成就解锁 · ${a.name}`, a.desc, "ach", 4200);
      }
      if (a.unlocked) APP.knownAchievements.add(a.id);
    });
    APP.firstRender = true;
  }

  function renderAll(d) {
    APP.data = d;
    (d.watchlist || []).forEach((q) => APP.quotes.set(q.code, q));
    renderHeader(d);
    renderIndices(d);
    renderWatch(d);
    renderStock(d);
    renderTrade();
    renderPositions(d);
    renderTrades(d);
    renderAchievements(d);
    drawEquity();
    checkNewAchievements(d);
  }

  /* --------------------------------------------------------------- 数据 */
  async function loadState() {
    try {
      const d = await api("/api/state");
      renderAll(d);
    } catch (e) {
      $("#feedState").textContent = "● 后端连接失败";
      $("#feedState").className = "feed stale";
    }
  }

  async function loadMinute(force = false) {
    if (!APP.selected) return;
    if (!force && APP.minuteCode === APP.selected && Date.now() - APP.minuteAt < 25000) return;
    try {
      const d = await api("/api/minute?code=" + encodeURIComponent(APP.selected));
      if (d.code !== APP.selected) return;
      APP.minute = d;
      APP.minuteCode = d.code;
      APP.minuteAt = Date.now();
      drawMinute();
    } catch (e) {
      APP.minute = null;
      drawMinute();
    }
  }

  async function selectStock(code) {
    if (!code) return;
    APP.selected = code;
    localStorage.setItem("tycoon.selected", code);
    APP.minute = null;
    APP.minuteCode = "";
    $("#qtyInput").value = 100;
    if (!APP.quotes.has(code)) {
      try {
        const d = await api("/api/quotes?codes=" + encodeURIComponent(code));
        (d.quotes || []).forEach((q) => APP.quotes.set(q.code, q));
      } catch (e) { /* ignore */ }
    }
    if (APP.data) {
      renderStock(APP.data);
      renderWatch(APP.data);
      renderTrade();
    }
    drawMinute();
    loadMinute(true);
    if (window.matchMedia("(max-width: 760px)").matches) {
      document.querySelector(".stock").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* --------------------------------------------------------------- 交易 */
  async function submitTrade() {
    if (APP.busy) return;
    const q = selectedQuote();
    if (!q) return toast("无法下单", "还没有选中股票", "err");
    const qty = parseInt($("#qtyInput").value, 10) || 0;
    if (qty <= 0 || qty % 100 !== 0) return toast("数量不对", "A股按 100 股整数倍交易", "err");

    APP.busy = true;
    $("#submitTrade").disabled = true;
    try {
      const res = await api("/api/trade", {
        method: "POST",
        body: JSON.stringify({ code: APP.selected, side: APP.side, qty }),
      });
      if (res.ok) {
        toast(res.message, res.trade ? `成交价 ¥${fmt(res.trade.price)} · 手续费 ¥${fmt(res.trade.fees)}` : "", "ok");
        $("#qtyInput").value = 100;
        await loadState();
        loadMinute(true);
      } else {
        toast("下单失败", res.message || "未知错误", "err", 4600);
      }
    } catch (e) {
      toast("下单失败", String(e.message || e), "err", 4600);
    } finally {
      APP.busy = false;
      renderTrade();
    }
  }

  /* --------------------------------------------------------------- 搜索 */
  let searchTimer = null;
  function bindSearch() {
    const input = $("#searchInput");
    const box = $("#searchResults");

    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (!q) { box.classList.add("hidden"); return; }
      searchTimer = setTimeout(async () => {
        try {
          const d = await api("/api/search?q=" + encodeURIComponent(q));
          const rows = d.results || [];
          box.innerHTML = rows.length
            ? rows.map((r) => `<button data-code="${r.code}"><span>${esc(r.name)}</span><span class="rc">${r.code.slice(2)}</span></button>`).join("")
            : `<div class="empty">没找到，试试 6 位代码</div>`;
          box.classList.remove("hidden");
          box.querySelectorAll("button[data-code]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const code = btn.dataset.code;
              box.classList.add("hidden");
              input.value = "";
              await api("/api/watch", { method: "POST", body: JSON.stringify({ code, action: "add" }) });
              await loadState();
              selectStock(code);
            });
          });
        } catch (e) {
          box.innerHTML = `<div class="empty">搜索失败</div>`;
          box.classList.remove("hidden");
        }
      }, 200);
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search")) box.classList.add("hidden");
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") box.classList.add("hidden");
    });
  }

  /* --------------------------------------------------------------- 交互绑定 */
  function bindUI() {
    $$(".side-tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        APP.side = btn.dataset.side;
        $$(".side-tabs button").forEach((b) => b.classList.toggle("active", b === btn));
        $("#qtyInput").value = 100;
        renderTrade();
      });
    });

    $$(".quick button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ratio = btn.dataset.ratio;
        const max = maxQty();
        let qty = ratio === "max" ? max : Math.floor((max * parseFloat(ratio)) / 100) * 100;
        $("#qtyInput").value = Math.max(100, qty || 0);
        renderTrade();
      });
    });

    $$(".stepper button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const input = $("#qtyInput");
        const cur = parseInt(input.value, 10) || 0;
        input.value = Math.max(100, cur + parseInt(btn.dataset.step, 10));
        renderTrade();
      });
    });

    $("#qtyInput").addEventListener("input", renderTrade);
    $("#qtyInput").addEventListener("blur", () => {
      const input = $("#qtyInput");
      let v = parseInt(input.value, 10) || 0;
      v = Math.max(0, Math.round(v / 100) * 100);
      input.value = v || 100;
      renderTrade();
    });

    $("#submitTrade").addEventListener("click", submitTrade);

    $$("[data-mobile-side]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const side = btn.dataset.mobileSide;
        APP.side = side;
        $$(".side-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.side === side));
        $("#qtyInput").value = 100;
        renderTrade();
        document.querySelector(".trade").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    $("#starBtn").addEventListener("click", async () => {
      if (!APP.data) return;
      const inList = (APP.data.watchlist || []).some((w) => w.code === APP.selected);
      await api("/api/watch", { method: "POST", body: JSON.stringify({ code: APP.selected, action: inList ? "remove" : "add" }) });
      await loadState();
    });

    $("#refreshBtn").addEventListener("click", async () => {
      await loadState();
      loadMinute(true);
      toast("已刷新", "行情已更新", "ok", 1600);
    });

    $$(".tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
        ["positions", "trades", "achievements"].forEach((k) => {
          $("#tab" + k[0].toUpperCase() + k.slice(1)).classList.toggle("hidden", k !== btn.dataset.tab);
        });
      });
    });

    $("#resetBtn").addEventListener("click", () => {
      modal({
        icon: "🔄",
        title: "重开一局？",
        html: "当前持仓、现金、成交和成就都会被清空，资金恢复为 <b>¥1,000,000</b>。<br/>这个操作不可撤销。",
        okText: "重新开始",
        onOk: async () => {
          await api("/api/reset", { method: "POST", body: "{}" });
          APP.knownAchievements.clear();
          APP.data = null;
          await loadState();
          loadMinute(true);
          toast("新赛季开始", "初始资金 ¥1,000,000，加油", "ok");
        },
      });
    });

    window.addEventListener("resize", () => {
      clearTimeout(window.__rs);
      window.__rs = setTimeout(() => { drawMinute(); drawEquity(); }, 160);
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { loadState(); loadMinute(); }
    });
  }

  /* --------------------------------------------------------------- 启动 */
  function intro() {
    if (localStorage.getItem("tycoon.intro") === "1") return;
    setTimeout(() => {
      modal({
        icon: "📈",
        title: "欢迎来到 A股大亨",
        html: `
          <p style="margin:0 0 8px">你拿到 <b>¥1,000,000</b> 虚拟资金，用<b>真实 A 股行情</b>操盘。</p>
          <p style="margin:0 0 8px">规则和真市场一致：<b>T+1</b>（今天买的明天才能卖）、<b>100 股一手</b>、
          <b>涨跌停</b>、<b>佣金万2.5（最低5元）+ 卖出印花税万5</b>。</p>
          <p style="margin:0">目标：赛季结束时把资产做到 <b>¥1,500,000</b>。行情每 5 秒刷新，随时可以重开。</p>`,
        okText: "开始交易",
        hideCancel: true,
        onOk: () => localStorage.setItem("tycoon.intro", "1"),
      });
    }, 600);
  }

  async function boot() {
    bindUI();
    bindSearch();
    intro();
    await loadState();
    if (APP.data) {
      const exists = (APP.data.watchlist || []).some((w) => w.code === APP.selected);
      if (!exists && APP.data.watchlist?.length) {
        APP.selected = APP.data.watchlist[0].code;
        localStorage.setItem("tycoon.selected", APP.selected);
      }
      renderStock(APP.data);
      renderWatch(APP.data);
      renderTrade();
    }
    await loadMinute(true);
    setInterval(loadState, 5000);
    setInterval(() => { if (!document.hidden) loadMinute(); }, 30000);
    setInterval(() => {
      const d = new Date();
      const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
      if (APP.data) $("#clock").textContent = `${APP.data.market.status} ${t}`;
    }, 1000);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
