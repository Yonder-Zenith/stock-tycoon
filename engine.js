/* A股大亨 · 纯前端引擎
 * 没有服务器：行情用 JSONP 直连腾讯/东方财富，存档放 localStorage。
 * 对上层 app.js 完全透明 —— 拦截 /api/* 的 fetch，返回和 Python 版一致的结构。
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------- 常量 */
  const INITIAL_CASH = 1000000;
  const SEASON_TARGET = 1500000;
  const COMMISSION_RATE = 0.00025;
  const MIN_COMMISSION = 5;
  const STAMP_TAX_RATE = 0.0005;
  const TRANSFER_FEE_RATE = 0.00001;
  const LOT = 100;
  const MAX_EQUITY = 3000;
  const MAX_TRADES = 400;
  const QUOTE_TTL = 6000;

  const K_STATE = "tycoon.state.v1";
  const K_WATCH = "tycoon.watch.v1";
  const K_UNI = "tycoon.universe.v1";

  const DEFAULT_WATCHLIST = [
    "sh600519", "sz000858", "sh601318", "sz300750", "sh600036", "sz002594",
    "sh601899", "sh688981", "sz300059", "sh600900", "sh601012", "sz000001",
  ];

  const SEED_INFO = {
    sh600519: "贵州茅台", sz000858: "五粮液", sh601318: "中国平安", sz300750: "宁德时代",
    sh600036: "招商银行", sz002594: "比亚迪", sh601899: "紫金矿业", sh688981: "中芯国际",
    sz300059: "东方财富", sh600900: "长江电力", sh601012: "隆基绿能", sz000001: "平安银行",
    sh600030: "中信证券", sh601888: "中国中免", sz002415: "海康威视", sh600887: "伊利股份",
    sh601166: "兴业银行", sz000333: "美的集团", sh600276: "恒瑞医药", sh601398: "工商银行",
    sh600000: "浦发银行", sz300124: "汇川技术", sh603259: "药明康德", sz002230: "科大讯飞",
  };

  const SEED_PRICE = {
    sh600519: 1439, sz000858: 128, sh601318: 58, sz300750: 265, sh600036: 46, sz002594: 108,
    sh601899: 24, sh688981: 96, sz300059: 25, sh600900: 29, sh601012: 18, sz000001: 11.6,
    sh600030: 26, sh601888: 68, sz002415: 30, sh600887: 28, sh601166: 22, sz000333: 76,
    sh600276: 52, sh601398: 7.2, sh600000: 10, sz300124: 62, sh603259: 70, sz002230: 52,
  };

  const INDICES = [
    ["sh000001", "上证指数"],
    ["sz399001", "深证成指"],
    ["sz399006", "创业板指"],
  ];

  const QFIELDS = "f2,f3,f4,f5,f6,f8,f12,f13,f14,f15,f16,f17,f18,f124";

  /* ------------------------------------------------------------- 存储 */
  const LS = (function () {
    try {
      localStorage.setItem("__t", "1");
      localStorage.removeItem("__t");
      return localStorage;
    } catch (e) {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    }
  })();

  function readJSON(key, fallback) {
    try {
      const raw = LS.getItem(key);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      LS.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 配额满了就算了 */
    }
  }

  /* ------------------------------------------------------------- 工具 */
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const money = (n) => Math.round((Number(n) || 0) * 100 + 1e-6) / 100;
  const num = (n) => {
    const v = Number(n);
    return Number.isFinite(v) ? v : 0;
  };
  const pad = (n) => String(n).padStart(2, "0");
  function fmtDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function fmtTime(d) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function nowISO() {
    return `${fmtDate(new Date())} ${fmtTime(new Date())}`;
  }
  function today() {
    return fmtDate(new Date());
  }
  function marketStatus() {
    const now = new Date();
    const hm = now.getHours() * 100 + now.getMinutes();
    let status;
    if (now.getDay() === 0 || now.getDay() === 6) status = "休市";
    else if (hm >= 915 && hm < 925) status = "集合竞价";
    else if (hm >= 925 && hm < 930) status = "待开盘";
    else if (hm >= 930 && hm <= 1130) status = "交易中";
    else if (hm > 1130 && hm < 1300) status = "午间休市";
    else if (hm >= 1300 && hm <= 1500) status = "交易中";
    else if (hm > 1500) status = "已收盘";
    else status = "盘前";
    return { status, time: fmtTime(now), date: fmtDate(now), open: status === "交易中" };
  }

  /* ------------------------------------------------------------- 状态 */
  function newState() {
    return {
      version: 1,
      createdAt: nowISO(),
      initialCash: INITIAL_CASH,
      cash: INITIAL_CASH,
      positions: {},
      trades: [],
      equity: [{ t: nowISO(), total: INITIAL_CASH, cash: INITIAL_CASH }],
      achievements: {},
      stats: { trades: 0, wins: 0, losses: 0, bestTrade: 0, tradeCount: 0 },
      lastSettleDate: "",
      day: { date: "", startTotal: INITIAL_CASH },
      season: { days: 0, target: SEASON_TARGET, startedAt: today() },
    };
  }

  function normalize(s) {
    const base = newState();
    if (!s || typeof s !== "object") return base;
    Object.keys(base).forEach((k) => {
      if (s[k] === undefined) s[k] = base[k];
    });
    if (typeof s.positions !== "object" || !s.positions) s.positions = {};
    Object.keys(s.positions).forEach((code) => {
      const p = s.positions[code] || {};
      p.qty = num(p.qty);
      p.available = num(p.available);
      p.cost = num(p.cost);
      p.name = p.name || nameOf(code);
      p.openDate = p.openDate || today();
      if (p.qty <= 0) delete s.positions[code];
      else s.positions[code] = p;
    });
    if (!Array.isArray(s.trades)) s.trades = [];
    if (!Array.isArray(s.equity) || !s.equity.length) s.equity = base.equity;
    if (!s.stats) s.stats = base.stats;
    if (!s.achievements) s.achievements = {};
    if (!s.day) s.day = { date: "", startTotal: INITIAL_CASH };
    if (!s.season) s.season = { days: 0, target: SEASON_TARGET, startedAt: today() };
    return s;
  }

  let state = normalize(readJSON(K_STATE, null));
  let watchlist = readJSON(K_WATCH, null);
  if (!Array.isArray(watchlist) || !watchlist.length) watchlist = DEFAULT_WATCHLIST.slice();

  function saveState() {
    writeJSON(K_STATE, state);
  }
  function saveWatch() {
    writeJSON(K_WATCH, watchlist);
  }

  /* ------------------------------------------------------------- 股票池 */
  const universe = { items: Object.assign({}, SEED_INFO), ts: 0, loading: false };

  function nameOf(code) {
    return universe.items[code] || SEED_INFO[code] || code;
  }

  function loadUniverseCache() {
    const cached = readJSON(K_UNI, null);
    if (cached && cached.items && typeof cached.items === "object") {
      Object.assign(universe.items, cached.items);
      universe.ts = Number(cached.ts) || 0;
    }
  }

  let universePromise = null;

  const UNI_TPL =
    "https://push2.eastmoney.com/api/qt/clist/get?pn=%d&pz=100&po=0&np=1&fltt=2&invt=2" +
    "&fid=f12&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f13,f14";

  function universePage(pn) {
    return jsonp(UNI_TPL.replace("%d", pn), 12000).then((d) => ({
      rows: (d && d.data && d.data.diff) || [],
      total: Number(d && d.data && d.data.total) || 0,
    }));
  }

  function refreshUniverse() {
    if (universePromise) return universePromise;
    if (Date.now() - universe.ts < 12 * 3600 * 1000 && Object.keys(universe.items).length > 1000) {
      return Promise.resolve(universe.items);
    }
    universe.loading = true;
    universePromise = (async () => {
      const first = await universePage(1);
      const rows = first.rows.slice();
      const pages = Math.max(1, Math.ceil(first.total / 100));
      const queue = [];
      for (let p = 2; p <= pages; p++) queue.push(p);
      const workers = [];
      for (let i = 0; i < 8; i++) {
        workers.push((async () => {
          while (queue.length) {
            const pn = queue.shift();
            try {
              const d = await universePage(pn);
              Array.prototype.push.apply(rows, d.rows);
            } catch (e) {
              /* 单页失败不影响整体 */
            }
          }
        })());
      }
      await Promise.all(workers);

      const items = {};
      rows.forEach((r) => {
        const code = String(r.f12 || "");
        const nm = String(r.f14 || "").trim();
        if (code.length !== 6 || !nm) return;
        if (!/^(60|68|00|30|001|002|003)/.test(code)) return;
        items[(r.f13 === 1 ? "sh" : "sz") + code] = nm;
      });
      if (Object.keys(items).length > 1000) {
        Object.assign(universe.items, items);
        universe.ts = Date.now();
        writeJSON(K_UNI, { ts: universe.ts, items });
      }
      return universe.items;
    })()
      .catch(() => universe.items)
      .then((items) => {
        universe.loading = false;
        universePromise = null;
        return items;
      });
    return universePromise;
  }

  function searchUniverse(q, limit) {
    q = String(q || "").trim().toLowerCase();
    if (!q) return [];
    const exact = [], prefix = [], fuzzy = [];
    Object.keys(universe.items).forEach((code) => {
      const name = universe.items[code];
      const bare = code.slice(2);
      if (code === q || bare === q) exact.push([code, name]);
      else if (bare.indexOf(q) === 0 || name.toLowerCase().indexOf(q) === 0) prefix.push([code, name]);
      else if (bare.indexOf(q) > -1 || name.toLowerCase().indexOf(q) > -1) fuzzy.push([code, name]);
    });
    return exact.concat(prefix, fuzzy).slice(0, limit || 20).map(([code, name]) => ({ code, name }));
  }

  /* ------------------------------------------------------------- JSONP */
  let cbSeq = 0;

  function loadScript(src, charset, timeout) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      if (charset) s.charset = charset;
      let settled = false;
      const timer = setTimeout(() => finish(new Error("script timeout")), timeout || 15000);
      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        s.onload = s.onerror = null;
        try { s.remove(); } catch (e) { /* ignore */ }
        err ? reject(err) : resolve();
      }
      s.onload = () => finish(null);
      s.onerror = () => finish(new Error("script error"));
      document.head.appendChild(s);
    });
  }

  function jsonp(url, timeout) {
    return new Promise((resolve, reject) => {
      const name = "__ty" + Date.now().toString(36) + (++cbSeq);
      let done = false;
      const timer = setTimeout(() => finish(new Error("jsonp timeout")), timeout || 9000);
      function finish(err, data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { delete window[name]; } catch (e) { window[name] = undefined; }
        err ? reject(err) : resolve(data);
      }
      window[name] = (data) => finish(null, data);
      loadScript(url + "&cb=" + name, null, timeout || 9000).catch((e) => finish(e));
    });
  }

  function jsonpVar(url, varName, timeout) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(new Error("jsonp timeout")), timeout || 9000);
      function finish(err, data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        let v;
        try { v = window[varName]; } catch (e) { v = undefined; }
        try { delete window[varName]; } catch (e) { window[varName] = undefined; }
        err ? reject(err) : resolve(data !== undefined ? data : v);
      }
      loadScript(url)
        .then(() => finish(null, undefined))
        .catch((e) => finish(e));
    });
  }

  /* ------------------------------------------------------------- 行情 */
  const quotes = new Map();
  let feed = { source: "live", error: "", lastFetch: "" };
  let offlineMode = false;

  const secid = (code) => (code.slice(0, 2) === "sh" ? "1." : "0.") + code.slice(2);

  function limitOf(code, name, prev) {
    if (!prev) return { up: 0, down: 0 };
    const bare = code.slice(2);
    let ratio = 0.1;
    if (/ST|退/i.test(name || "")) ratio = 0.05;
    else if (/^(30|68)/.test(bare)) ratio = 0.2;
    else if (/^(8|4|92)/.test(bare)) ratio = 0.3;
    return { up: round2(prev * (1 + ratio)), down: round2(prev * (1 - ratio)) };
  }

  function toQuote(code, row) {
    const prev = num(row.f18) || num(row.f2) || 0;
    const price = num(row.f2) || prev;
    const stamp = num(row.f124) * 1000 || Date.now();
    const d = new Date(stamp);
    const name = row.f14 || nameOf(code);
    const lim = limitOf(code, name, prev);
    return {
      code,
      name,
      price,
      prevClose: prev,
      open: num(row.f17) || prev,
      high: num(row.f15) || price,
      low: num(row.f16) || price,
      pct: row.f3 === undefined ? (prev ? round2((price / prev - 1) * 100) : 0) : round2(row.f3),
      change: row.f4 === undefined ? round2(price - prev) : round2(row.f4),
      volume: num(row.f5),
      amount: num(row.f6),
      turnover: num(row.f8),
      limitUp: lim.up,
      limitDown: lim.down,
      date: fmtDate(d),
      time: fmtTime(d),
      ts: Date.now(),
      source: "live",
      stale: false,
    };
  }

  async function fetchQuotesEM(codes) {
    const url =
      "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2" +
      "&secids=" + codes.map(secid).join(",") + "&fields=" + QFIELDS;
    const data = await jsonp(url);
    const rows = (data && data.data && data.data.diff) || [];
    if (!rows.length) throw new Error("empty quotes");
    rows.forEach((row) => {
      const code = (row.f13 === 1 ? "sh" : "sz") + row.f12;
      if (codes.indexOf(code) > -1) quotes.set(code, toQuote(code, row));
    });
  }

  async function fetchQuotesTencent(codes) {
    const url = "https://qt.gtimg.cn/q=" + codes.join(",");
    await loadScript(url, "gbk");
    let got = 0;
    codes.forEach((code) => {
      let raw;
      try { raw = window["v_" + code]; } catch (e) { raw = null; }
      if (!raw) return;
      const f = String(raw).split("~");
      if (f.length < 49) return;
      const prev = num(f[4]), price = num(f[3]) || prev;
      if (!prev) return;
      const stamped = f[30] && f[30].length >= 14
        ? `${f[30].slice(0, 4)}-${f[30].slice(4, 6)}-${f[30].slice(6, 8)}`
        : today();
      const time = f[30] && f[30].length >= 14 ? `${f[30].slice(8, 10)}:${f[30].slice(10, 12)}:${f[30].slice(12, 14)}` : "";
      const lim = limitOf(code, nameOf(code), prev);
      quotes.set(code, {
        code,
        name: nameOf(code),
        price,
        prevClose: prev,
        open: num(f[5]) || prev,
        high: num(f[33]) || price,
        low: num(f[34]) || price,
        pct: round2(f[32]),
        change: round2(f[31]),
        volume: num(f[6]),
        amount: num(f[37]),
        turnover: num(f[38]),
        limitUp: num(f[47]) || lim.up,
        limitDown: num(f[48]) || lim.down,
        date: stamped,
        time,
        ts: Date.now(),
        source: "live",
        stale: false,
      });
      got++;
    });
    if (!got) throw new Error("tencent parse failed");
  }

  function simulateQuotes(codes) {
    const now = new Date();
    codes.forEach((code) => {
      const prevHit = quotes.get(code);
      const base = (prevHit && prevHit.prevClose) || SEED_PRICE[code] || 20;
      const last = (prevHit && prevHit.price) || base;
      const price = Math.max(0.5, Math.min(round2(base * 1.1), round2(last * (1 + (Math.random() - 0.5) * 0.012))));
      const lim = limitOf(code, nameOf(code), base);
      quotes.set(code, {
        code,
        name: nameOf(code),
        price,
        prevClose: base,
        open: base,
        high: Math.max(price, base),
        low: Math.min(price, base),
        pct: round2((price / base - 1) * 100),
        change: round2(price - base),
        volume: 0,
        amount: 0,
        turnover: 0,
        limitUp: lim.up,
        limitDown: lim.down,
        date: fmtDate(now),
        time: fmtTime(now),
        ts: Date.now(),
        source: "sim",
        stale: true,
      });
    });
  }

  async function ensureQuotes(codes, force) {
    const now = Date.now();
    const need = [];
    codes.forEach((c) => {
      if (!c) return;
      if (need.indexOf(c) > -1) return;
      const q = quotes.get(c);
      if (force || !q || now - q.ts > QUOTE_TTL) need.push(c);
    });
    if (!need.length) return;
    if (offlineMode) {
      simulateQuotes(need);
      return;
    }
    try {
      await fetchQuotesEM(need);
      feed.source = "live";
      feed.error = "";
      feed.lastFetch = fmtTime(new Date());
    } catch (e1) {
      try {
        await fetchQuotesTencent(need);
        feed.source = "live";
        feed.error = "";
        feed.lastFetch = fmtTime(new Date());
      } catch (e2) {
        feed.source = "sim";
        feed.error = String((e2 && e2.message) || e2 || e1);
        simulateQuotes(need);
      }
    }
    // 个别缺失的补模拟，避免界面出现空白
    need.forEach((c) => {
      const q = quotes.get(c);
      if (!q || now - q.ts > QUOTE_TTL) simulateQuotes([c]);
    });
  }

  function quotePayload(q) {
    return {
      code: q.code,
      name: q.name || nameOf(q.code),
      price: q.price,
      pct: q.pct,
      change: q.change,
      prevClose: q.prevClose,
      open: q.open,
      high: q.high,
      low: q.low,
      limitUp: q.limitUp,
      limitDown: q.limitDown,
      amount: q.amount,
      turnover: q.turnover,
      date: q.date,
      time: q.time,
      stale: !!q.stale,
    };
  }

  function tradingDate(codes) {
    let best = "";
    codes.forEach((c) => {
      const q = quotes.get(c);
      if (q && q.date && q.date > best) best = q.date;
    });
    return best || today();
  }

  /* ------------------------------------------------------------- 分时 */
  async function getMinute(code) {
    const varName = "__min" + code;
    const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}&_var=${varName}`;
    const data = await jsonpVar(url, varName);
    const node = data && data.data && data.data[code];
    const rows = (node && node.data && node.data.data) || [];
    const points = [];
    rows.forEach((row) => {
      const parts = String(row).split(" ");
      if (parts.length < 2) return;
      const p = num(parts[1]);
      if (!p) return;
      points.push({ t: parts[0].slice(0, 2) + ":" + parts[0].slice(2, 4), p });
    });
    const q = quotes.get(code) || {};
    return {
      code,
      points,
      prevClose: q.prevClose || 0,
      date: q.date || "",
      name: q.name || nameOf(code),
      price: q.price || 0,
    };
  }

  /* ------------------------------------------------------------- 估值 */
  function settleIfNeeded(date) {
    if (!date) return;
    const last = state.lastSettleDate || "";
    if (last && date <= last) return;
    if (last) {
      Object.keys(state.positions).forEach((c) => {
        state.positions[c].available = state.positions[c].qty;
      });
      state.season.days = (state.season.days || 0) + 1;
    }
    state.lastSettleDate = date;
    if (!state.day || state.day.date !== date) {
      state.day = { date, startTotal: state._lastTotal || state.initialCash };
    }
    saveState();
  }

  function holdingDays(p) {
    const start = new Date((p.openDate || today()) + "T00:00:00");
    const diff = Math.floor((new Date(today() + "T00:00:00") - start) / 86400000);
    return Math.max(1, diff + 1);
  }

  function snapshotEquity(total) {
    const eq = state.equity;
    const now = Date.now();
    let lastTs = 0;
    if (eq.length) {
      const t = new Date(String(eq[eq.length - 1].t).replace(" ", "T")).getTime();
      lastTs = Number.isFinite(t) ? t : 0;
    }
    const prevTotal = eq.length ? num(eq[eq.length - 1].total) : 0;
    if (!eq.length || now - lastTs >= 30000 || Math.abs(prevTotal - total) >= Math.max(50, total * 0.002)) {
      const stamp = nowISO();
      if (eq.length && eq[eq.length - 1].t.slice(0, 16) === stamp.slice(0, 16)) {
        eq[eq.length - 1] = { t: stamp, total, cash: money(state.cash) };
      } else {
        eq.push({ t: stamp, total, cash: money(state.cash) });
      }
      if (eq.length > MAX_EQUITY) eq.splice(0, eq.length - MAX_EQUITY);
    }
  }

  async function buildPayload() {
    const codes = Object.keys(state.positions).concat(watchlist).concat(INDICES.map((i) => i[0]));
    await ensureQuotes(codes);
    const date = tradingDate(codes);
    settleIfNeeded(date);

    let marketValue = 0;
    const positions = [];
    Object.keys(state.positions).forEach((code) => {
      const p = state.positions[code];
      const q = quotes.get(code) || {};
      const price = num(q.price) || (p.qty ? p.cost / p.qty : 0);
      const value = money(price * p.qty);
      const pnl = money(value - p.cost);
      p.lastPrice = price;
      marketValue += value;
      positions.push({
        code,
        name: p.name || nameOf(code),
        qty: p.qty,
        available: p.available,
        cost: money(p.cost),
        costPrice: p.qty ? Math.round((p.cost / p.qty) * 1000) / 1000 : 0,
        price,
        value,
        pnl,
        pnlPct: p.cost ? round2((pnl / p.cost) * 100) : 0,
        pct: q.pct || 0,
        openDate: p.openDate || "",
        days: holdingDays(p),
      });
    });
    positions.sort((a, b) => b.value - a.value);

    const total = money(state.cash + marketValue);
    state._lastTotal = total;
    if (!state.day || !state.day.date) {
      state.day = { date: date, startTotal: total };
    }
    snapshotEquity(total);
    checkAchievements(total, positions);

    const dayProfit = money(total - num(state.day.startTotal));
    const idx = INDICES.map(([code, label]) => {
      const q = quotes.get(code) || {};
      return { code, name: label, price: q.price || 0, pct: q.pct || 0, change: q.change || 0 };
    });

    const watch = [];
    watchlist.forEach((code) => {
      const q = quotes.get(code);
      if (q) watch.push(quotePayload(q));
    });

    state.trades = state.trades.slice(-MAX_TRADES);
    saveState();

    return {
      account: {
        cash: money(state.cash),
        marketValue: money(marketValue),
        total,
        initialCash: state.initialCash,
        profit: money(total - state.initialCash),
        profitPct: round2((total / state.initialCash - 1) * 100),
        dayProfit,
        dayProfitPct: state.day.startTotal ? round2((dayProfit / state.day.startTotal) * 100) : 0,
        rank: rankOf(total).name,
        rankIcon: rankOf(total).icon,
        createdAt: state.createdAt,
      },
      positions,
      trades: state.trades.slice(-60).reverse(),
      equity: state.equity.slice(-400),
      achievements: achievementPayload(),
      stats: state.stats,
      season: {
        days: state.season.days || 0,
        target: state.season.target || SEASON_TARGET,
        progress: Math.min(1, total / (state.season.target || SEASON_TARGET)),
      },
      watchlist: watch,
      indices: idx,
      market: marketStatus(),
      feed: {
        source: feed.source,
        error: feed.error,
        tradingDate: date,
        lastFetch: feed.lastFetch,
        serverTime: nowISO(),
      },
    };
  }

  /* ------------------------------------------------------------- 交易 */
  function calcFees(side, amount) {
    const commission = Math.max(MIN_COMMISSION, amount * COMMISSION_RATE);
    const transfer = amount * TRANSFER_FEE_RATE;
    const stamp = side === "sell" ? amount * STAMP_TAX_RATE : 0;
    return money(commission + transfer + stamp);
  }

  async function trade(code, side, qty) {
    side = String(side || "").toLowerCase();
    qty = Math.floor(num(qty));
    if (side !== "buy" && side !== "sell") return { ok: false, message: "方向错误" };
    if (!code) return { ok: false, message: "请选择股票" };
    if (qty <= 0) return { ok: false, message: "数量必须大于 0" };
    if (qty % LOT !== 0) return { ok: false, message: "A股必须按 100 股整数倍交易" };

    await ensureQuotes([code]);
    const q = quotes.get(code);
    if (!q || !q.price) return { ok: false, message: "拿不到该股票行情" };

    const price = q.price;
    const amount = money(price * qty);
    const fees = calcFees(side, amount);
    const name = q.name || nameOf(code);
    let tradeRec;
    let msg;

    if (side === "buy") {
      if (amount + fees > state.cash + 0.001) {
        return { ok: false, message: `现金不足，需要 ¥${(amount + fees).toFixed(2)}` };
      }
      state.cash = money(state.cash - amount - fees);
      const p = state.positions[code] || { qty: 0, available: 0, cost: 0, name, openDate: today() };
      p.qty += qty;
      p.cost = money(p.cost + amount + fees);
      p.name = name;
      state.positions[code] = p;
      const limitNote = q.limitUp && price >= q.limitUp - 0.001 ? "（涨停价买入）" : "";
      tradeRec = {
        id: "T" + Date.now(), time: nowISO(), code, name, side, qty, price,
        amount, fees, pnl: 0, pct: q.pct || 0, cash: state.cash,
      };
      msg = `买入 ${name} ${qty} 股 @ ¥${price.toFixed(2)}${limitNote}`;
    } else {
      const p = state.positions[code];
      if (!p || p.qty < qty) return { ok: false, message: "持仓不足" };
      if (p.available < qty) {
        return {
          ok: false,
          message: `T+1 限制：可卖仅 ${p.available} 股，今日买入的 ${p.qty - p.available} 股需下一交易日才能卖出`,
        };
      }
      const proceeds = money(amount - fees);
      const costOut = money(p.cost * qty / p.qty);
      const pnl = money(proceeds - costOut);
      state.cash = money(state.cash + proceeds);
      p.qty -= qty;
      p.available -= qty;
      p.cost = money(p.cost - costOut);
      if (p.qty <= 0) delete state.positions[code];
      state.stats.trades += 1;
      if (pnl >= 0) state.stats.wins += 1;
      else state.stats.losses += 1;
      state.stats.bestTrade = Math.max(num(state.stats.bestTrade), pnl);
      tradeRec = {
        id: "T" + Date.now(), time: nowISO(), code, name, side, qty, price,
        amount, fees, pnl, pct: q.pct || 0, cash: state.cash,
      };
      msg = `卖出 ${name} ${qty} 股 @ ¥${price.toFixed(2)}，${pnl >= 0 ? "盈利" : "亏损"} ¥${Math.abs(pnl).toFixed(2)}`;
    }

    state.trades.push(tradeRec);
    state.trades = state.trades.slice(-MAX_TRADES);
    state.stats.tradeCount = (state.stats.tradeCount || 0) + 1;
    saveState();
    return { ok: true, message: msg, trade: tradeRec };
  }

  /* ------------------------------------------------------------- 成就 */
  const ACHIEVEMENTS = [
    { id: "first_trade", icon: "🎬", name: "第一滴血", desc: "完成第一笔交易" },
    { id: "five_stocks", icon: "🧺", name: "五谷丰登", desc: "同时持有 5 只不同股票" },
    { id: "limit_up", icon: "🚀", name: "涨停狙击", desc: "持有当日涨停的股票" },
    { id: "chase", icon: "🔥", name: "追高勇士", desc: "买入当日涨幅超过 7% 的股票" },
    { id: "dip", icon: "🩸", name: "抄底大师", desc: "买入当日跌幅超过 7% 的股票" },
    { id: "profit", icon: "💰", name: "扭亏为盈", desc: "总资产超过初始资金" },
    { id: "plus10", icon: "📈", name: "小目标", desc: "总资产达到 110 万" },
    { id: "plus50", icon: "🏆", name: "半程牛人", desc: "总资产达到 150 万（赛季目标）" },
    { id: "double", icon: "👑", name: "翻倍股神", desc: "总资产达到 200 万" },
    { id: "twenty", icon: "🧾", name: "交易老手", desc: "累计成交 20 笔" },
    { id: "long_hold", icon: "🪨", name: "长线持有", desc: "同一只股票持有满 5 天" },
    { id: "big_win", icon: "🦈", name: "大鲨鱼", desc: "单笔卖出盈利超过 5 万" },
    { id: "cut_loss", icon: "🔪", name: "断臂求生", desc: "亏损卖出一次" },
  ];

  function checkAchievements(total, positions) {
    const st = state.achievements;
    const stats = state.stats;
    const limitUp = Object.keys(state.positions).some((code) => {
      const q = quotes.get(code);
      return q && q.limitUp && q.price >= q.limitUp - 0.001;
    });
    const chase = state.trades.some((t) => t.side === "buy" && num(t.pct) >= 7);
    const dip = state.trades.some((t) => t.side === "buy" && num(t.pct) <= -7);
    const longHold = Object.keys(state.positions).some((c) => holdingDays(state.positions[c]) >= 5);
    const cutLoss = state.trades.some((t) => t.side === "sell" && num(t.pnl) < 0);
    const bigWin = state.trades.some((t) => t.side === "sell" && num(t.pnl) >= 50000);

    const checks = {
      first_trade: num(stats.tradeCount) >= 1,
      five_stocks: Object.keys(state.positions).length >= 5,
      limit_up: limitUp,
      chase,
      dip,
      profit: total > state.initialCash + 0.01,
      plus10: total >= state.initialCash * 1.1,
      plus50: total >= SEASON_TARGET,
      double: total >= state.initialCash * 2,
      twenty: num(stats.tradeCount) >= 20,
      long_hold: longHold,
      big_win: bigWin,
      cut_loss: cutLoss,
    };
    let changed = false;
    Object.keys(checks).forEach((id) => {
      if (checks[id] && !st[id]) {
        st[id] = nowISO();
        changed = true;
      }
    });
    if (changed) saveState();
  }

  function achievementPayload() {
    return ACHIEVEMENTS.map((a) => ({
      id: a.id, icon: a.icon, name: a.name, desc: a.desc,
      unlocked: !!state.achievements[a.id],
      at: state.achievements[a.id] || "",
    }));
  }

  function rankOf(total) {
    const r = total / Math.max(1, state.initialCash);
    if (r >= 2) return { name: "股神", icon: "👑" };
    if (r >= 1.5) return { name: "牛散", icon: "🏆" };
    if (r >= 1.2) return { name: "游资", icon: "🐋" };
    if (r >= 1) return { name: "老股民", icon: "📈" };
    if (r >= 0.9) return { name: "散户", icon: "🧑‍💼" };
    return { name: "韭菜", icon: "🥬" };
  }

  /* ------------------------------------------------------------- 路由 */
  async function handle(path, init) {
    const qIndex = path.indexOf("?");
    const route = qIndex > -1 ? path.slice(0, qIndex) : path;
    const params = new URLSearchParams(qIndex > -1 ? path.slice(qIndex + 1) : "");
    let body = {};
    try {
      body = init && init.body ? JSON.parse(init.body) : {};
    } catch (e) {
      body = {};
    }

    if (route === "/api/state") return buildPayload();

    if (route === "/api/trade") {
      return trade(String(body.code || ""), String(body.side || ""), body.qty);
    }

    if (route === "/api/watch") {
      const code = String(body.code || "").trim();
      const action = String(body.action || "add");
      if (!code) return { ok: false, message: "缺少代码" };
      if (action === "add" && watchlist.indexOf(code) === -1) watchlist.unshift(code);
      if (action === "remove") watchlist = watchlist.filter((c) => c !== code);
      watchlist = watchlist.slice(0, 40);
      saveWatch();
      return { ok: true, watchlist };
    }

    if (route === "/api/reset") {
      state = newState();
      saveState();
      return { ok: true };
    }

    if (route === "/api/search") {
      const q = params.get("q") || "";
      if (Object.keys(universe.items).length < 1000) {
        await Promise.race([refreshUniverse(), new Promise((r) => setTimeout(r, 2500))]);
      }
      return { results: searchUniverse(q, 20) };
    }

    if (route === "/api/quotes") {
      const codes = (params.get("codes") || "").split(",").filter(Boolean);
      if (!codes.length) return { quotes: [] };
      await ensureQuotes(codes);
      return { quotes: codes.map((c) => quotes.get(c)).filter(Boolean).map(quotePayload) };
    }

    if (route === "/api/minute") {
      const code = params.get("code") || "";
      if (!code) return { error: "missing code" };
      try {
        return await getMinute(code);
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    }

    return { error: "not found" };
  }

  /* ------------------------------------------------------------- fetch 劫持 */
  const nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("/api/") === 0) {
      return handle(url, init).then(
        (data) => new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
        (err) => new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        })
      );
    }
    if (nativeFetch) return nativeFetch(input, init);
    return Promise.reject(new Error("fetch unavailable"));
  };

  /* ------------------------------------------------------------- 启动 */
  loadUniverseCache();
  if (Date.now() - universe.ts > 12 * 3600 * 1000) {
    setTimeout(() => refreshUniverse(), 600);
  }

  window.TYCOON_ENGINE = {
    handle,
    isLocal: true,
    // 调试/自测用
    debug: {
      setQuotes(list) {
        (list || []).forEach((q) => {
          quotes.set(q.code, Object.assign({
            ts: Date.now(), source: "live", stale: false,
            date: today(), time: fmtTime(new Date()),
          }, q));
        });
      },
      getState: () => state,
      getQuotes: () => quotes,
      reset() { state = newState(); saveState(); },
      resetAll() {
        state = newState();
        quotes.clear();
        saveState();
        writeJSON(K_WATCH, DEFAULT_WATCHLIST.slice());
      },
      setOffline(v) { offlineMode = !!v; },
    },
  };
})();
