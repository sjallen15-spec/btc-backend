import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ═══════════════════════════════════════════
// TELEGRAM CONFIG
// ═══════════════════════════════════════════
const TG_BOT_TOKEN = "7998975335:AAFptLQvgai5uPvojihTmtqgYdgaozhn5Ug";
const TG_CHAT_ID   = "8632716847";
const TG_MIN_SCORE = 4;

async function sendTelegram(msg) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown" })
    });
  } catch(e) { console.error("Telegram error:", e.message); }
}

// ═══════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════
async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { signal: controller.signal });
    return r;
  } finally { clearTimeout(id); }
}

async function getLivePrice() {
  try {
    const r = await fetchWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    const d = await r.json();
    if (d?.bitcoin?.usd) return d.bitcoin.usd;
  } catch {}
  try {
    const r = await fetchWithTimeout("https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD");
    const d = await r.json();
    if (d?.USD) return d.USD;
  } catch {}
  try {
    const r = await fetchWithTimeout("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    const d = await r.json();
    if (d?.data?.amount) return parseFloat(d.data.amount);
  } catch {}
  throw new Error("All price sources failed");
}

function parseCandle(c) {
  return {
    time:      c.time * 1000,
    open:      c.open,
    high:      c.high,
    low:       c.low,
    close:     c.close,
    volume:    c.volumefrom,
    closeTime: (c.time + 900) * 1000,
  };
}

async function getCandles15m(limit = 100) {
  const r = await fetchWithTimeout(
    `https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=${limit}&aggregate=15`
  );
  const data = await r.json();
  if (!data.Data?.Data || !Array.isArray(data.Data.Data)) throw new Error("Bad candle data");
  return data.Data.Data.map(parseCandle);
}

// ═══════════════════════════════════════════
// INDICATORS
// ═══════════════════════════════════════════
function emaArr(prices, p) {
  const k = 2/(p+1);
  const out = [prices[0]];
  for (let i = 1; i < prices.length; i++) out.push(prices[i]*k + out[i-1]*(1-k));
  return out;
}

function calcMACD(prices) {
  if (prices.length < 26) return { macd:0, signal:0, hist:0, histPrev:0 };
  const e12 = emaArr(prices,12), e26 = emaArr(prices,26);
  const line = e12.map((v,i) => v - e26[i]);
  const sig  = emaArr(line, 9);
  const n = line.length - 1;
  return { macd:line[n], signal:sig[n], hist:line[n]-sig[n], histPrev: n>0?line[n-1]-sig[n-1]:0 };
}

function calcATR(candles) {
  if (candles.length < 2) return { current:0, avg:0 };
  const trs = candles.slice(1).map((c,i) =>
    Math.max(c.high-c.low, Math.abs(c.high-candles[i].close), Math.abs(c.low-candles[i].close))
  );
  const sl = trs.slice(-20);
  return { current: trs[trs.length-1]||0, avg: sl.reduce((a,b)=>a+b,0)/(sl.length||1) };
}

function calcMomentum(candles) {
  if (candles.length < 3) return { sameDir:false, expanding:false, dir:"UP" };
  const n = candles.length-1, a = candles[n], b = candles[n-1];
  const d1 = a.close >= a.open ? "UP" : "DOWN";
  const d2 = b.close >= b.open ? "UP" : "DOWN";
  return {
    sameDir: d1===d2,
    expanding: Math.abs(a.close-a.open) > candles.slice(-6,-1).reduce((s,c)=>s+Math.abs(c.close-c.open),0)/5,
    dir: d1
  };
}

function calcStructure(candles) {
  if (candles.length < 20) return { trend:"CHOP", swingHigh:0, swingLow:0, prevSwingHigh:0 };
  const closes = candles.slice(-20).map(c => c.close);
  const q1 = closes.slice(0,5).reduce((a,b)=>a+b,0)/5;
  const q2 = closes.slice(5,10).reduce((a,b)=>a+b,0)/5;
  const q3 = closes.slice(10,15).reduce((a,b)=>a+b,0)/5;
  const q4 = closes.slice(15,20).reduce((a,b)=>a+b,0)/5;
  const ema10 = emaArr(closes, 10);
  const emaSlope = ema10[ema10.length-1] - ema10[ema10.length-5];
  const emaSlopePct = ema10[ema10.length-5] > 0 ? emaSlope / ema10[ema10.length-5] * 100 : 0;
  const rising  = q2>q1 && q3>q2 && q4>q3;
  const falling = q2<q1 && q3<q2 && q4<q3;
  let trend = "CHOP";
  if      (rising  && emaSlopePct >  0.05) trend = "UP";
  else if (falling && emaSlopePct < -0.05) trend = "DOWN";
  else if (emaSlopePct >  0.15) trend = "UP";
  else if (emaSlopePct < -0.15) trend = "DOWN";
  return {
    trend,
    swingHigh: Math.max(...candles.slice(-10).map(c=>c.high)),
    swingLow:  Math.min(...candles.slice(-10).map(c=>c.low)),
    prevSwingHigh: Math.max(...candles.slice(-20,-10).map(c=>c.high))
  };
}

function calcLocation(candles, st) {
  if (candles.length < 5) return { penalty:0, reason:null };
  const price = candles[candles.length-1].close;
  const range = st.swingHigh - st.swingLow || 1;
  const move = Math.abs(candles.slice(-4)[3].close - candles.slice(-4)[0].open);
  const atrEst = Math.abs(candles[candles.length-1].high - candles[candles.length-1].low);
  if (move > atrEst*2.5) return { penalty:-2, reason:"Overextended" };
  if ((st.swingHigh-price)/range < 0.1) return { penalty:-1, reason:"Near swing high" };
  if ((price-st.swingLow)/range < 0.1)  return { penalty:-1, reason:"Near swing low" };
  return { penalty:0, reason:null };
}

// ═══════════════════════════════════════════
// SIGNAL ENGINE — 15m candles
// ═══════════════════════════════════════════
function runEngine(candles, betPrice, livePrice) {
  const closes = candles.map(c => c.close);
  const e50arr = emaArr(closes, 50);
  const e50    = e50arr[e50arr.length-1];
  const m   = calcMACD(closes);
  const at  = calcATR(candles);
  const mom = calcMomentum(candles);
  const st  = calcStructure(candles);
  const loc = calcLocation(candles, st);

  let score = 0;
  const reasoning = [];

  // Score components
  if (livePrice > e50) { score++; reasoning.push("Price above EMA50"); }
  else                 { reasoning.push("Price below EMA50"); }
  if (m.macd > 0)      { score++; reasoning.push("MACD above zero"); }
  else                 { reasoning.push("MACD below zero"); }
  if (mom.sameDir)     { score++; reasoning.push("Candles same direction"); }
  if (mom.expanding)   { score++; reasoning.push("Candle body expanding"); }
  if (at.current > at.avg) { score++; reasoning.push("ATR above average"); }
  if (Math.abs(candles[candles.length-1].close - candles[candles.length-1].open) >
      candles.slice(-6,-1).reduce((s,c)=>s+Math.abs(c.close-c.open),0)/5) {
    score++; reasoning.push("Body above average");
  }
  if ((m.macd>m.signal&&mom.dir==="UP")||(m.macd<m.signal&&mom.dir==="DOWN")) {
    score++; reasoning.push("MACD aligned with direction");
  }
  if (Math.abs(m.hist) > Math.abs(m.histPrev)) { score++; reasoning.push("MACD histogram expanding"); }
  score += loc.penalty;

  const bv  = [livePrice>e50, mom.dir==="UP",   st.trend==="UP",  m.macd>0].filter(Boolean).length;
  const bvD = [livePrice<e50, mom.dir==="DOWN", st.trend==="DOWN", m.macd<0].filter(Boolean).length;
  const rawDir = bv>=3?"UP":bvD>=3?"DOWN":bv>=2&&bvD===0?"UP":bvD>=2&&bv===0?"DOWN":"MIXED";
  const revBlock = rawDir==="UP" && st.trend==="DOWN" && livePrice<=st.prevSwingHigh;

  // Signal rules — optimized from backtest data
  // All 4 bearish votes + score>=5 = HIGH DOWN (89% accurate)
  // All 4 bearish votes + score>=3 = MEDIUM DOWN (81% accurate)
  // All 4 bullish votes + score>=6 = HIGH UP (67% accurate)
  // All 4 bullish votes + score>=4 = MEDIUM UP
  let signal = "NO BET", confidence = "LOW";

    // ── OPTIMIZED RULES v11 (521 windows) ──
  const atrOk = at.current >= at.avg * 0.9;
  const currentHour = new Date().getHours();
  const deadZone = [0, 12, 15].includes(currentHour);
  if (!revBlock && atrOk && !deadZone) {
    // Block score 4 entirely — 20-46% win rate
    // Block signal+trend alignment (reversal trap)
    if (score === 7 && rawDir === "DOWN" && st.trend !== "DOWN") { signal = "DOWN"; confidence = "MEDIUM"; }
    else if (score === 6 && rawDir === "DOWN" && st.trend !== "DOWN") { signal = "DOWN"; confidence = "HIGH"; }
    else if (score === 5 && rawDir === "DOWN" && st.trend !== "DOWN") { signal = "DOWN"; confidence = "MEDIUM"; }
    else if (score === 7 && rawDir === "UP" && st.trend !== "UP") { signal = "UP"; confidence = "MEDIUM"; }
    else if (score === 6 && rawDir === "UP" && st.trend !== "UP") { signal = "UP"; confidence = "HIGH"; }
    else if (score === 5 && rawDir === "UP" && st.trend !== "UP") { signal = "UP"; confidence = "MEDIUM"; }
  }

  let betSize = 0;
  if (signal !== "NO BET") {
    betSize = confidence === "HIGH" ? 6 : 4;
  }

  return { signal, confidence, score, trend: st.trend, reasoning, bet_size_percent: betSize,
           _bv: bv, _bvD: bvD, _rawDir: rawDir };
}

// ═══════════════════════════════════════════
// 15-MIN SCHEDULER
// ═══════════════════════════════════════════
const MS15 = 15 * 60 * 1000;
let lastSignal = "NO BET";
let lastScore  = 0;

async function runSignalAndNotify() {
  console.log(`[${new Date().toISOString()}] Running signal check...`);
  try {
    const now = Date.now();
    const currentWindowOpen  = Math.floor(now / MS15) * MS15;
    const currentWindowClose = currentWindowOpen + MS15;
    const minsLeft = Math.round((currentWindowClose - now) / 60000);

    const [livePrice, candles] = await Promise.all([getLivePrice(), getCandles15m(100)]);
    candles[candles.length-1].close = livePrice;
    candles[candles.length-1].high  = Math.max(candles[candles.length-1].high, livePrice);
    candles[candles.length-1].low   = Math.min(candles[candles.length-1].low, livePrice);

    const betPrice = candles[candles.length-1].open;
    const sig = runEngine(candles, betPrice, livePrice);

    console.log(`Signal: ${sig.signal} | Score: ${sig.score} | Conf: ${sig.confidence} | bv=${sig._bv} bvD=${sig._bvD} | ${minsLeft}m left`);

    const signalChanged = sig.signal !== lastSignal;
    const scoreChanged  = sig.score  !== lastScore && sig.signal !== "NO BET";

    if (sig.signal !== "NO BET" && sig.score >= TG_MIN_SCORE && (signalChanged || scoreChanged)) {
      const arrow = sig.signal === "UP" ? "🟢" : "🔴";
      const changeNote = signalChanged && lastSignal !== "NO BET"
        ? `\n⚠️ _Changed from ${lastSignal} → ${sig.signal}_` : "";
      const windowOpen  = new Date(currentWindowOpen).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
      const windowClose = new Date(currentWindowClose).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
      const msg = `${arrow} *BTC SIGNAL: ${sig.signal}*${changeNote}\n\n` +
        `Score: ${sig.score}/8 | Confidence: ${sig.confidence}\n` +
        `Trend: ${sig.trend}\n` +
        `Window: ${windowOpen} → ${windowClose} (${minsLeft}m left)\n` +
        `Live Price: $${livePrice.toLocaleString()}\n` +
        `Bet Price: $${betPrice.toLocaleString()}\n\n` +
        `${sig.reasoning.slice(0,3).join("\n")}\n\n` +
        `_NOT FINANCIAL ADVICE_`;
      await sendTelegram(msg);
      console.log("Telegram alert sent!");
    }

    lastSignal = sig.signal;
    lastScore  = sig.score;
  } catch(e) { console.error("Signal check failed:", e.message); }
}

setInterval(runSignalAndNotify, 60000);
setTimeout(runSignalAndNotify, 3000);

// ═══════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════
app.get("/healthz", (req, res) => res.json({ status:"ok", time:new Date().toISOString() }));

app.get("/api/price", async (req, res) => {
  try { const price = await getLivePrice(); res.json({ price, time:Date.now() }); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/candles", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||100, 2000);
  try { res.json(await getCandles15m(limit)); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/btc", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||100, 500);
  try {
    const [livePrice, candles] = await Promise.all([getLivePrice(), getCandles15m(limit)]);
    const current = candles[candles.length-1];
    current.close = livePrice;
    current.high  = Math.max(current.high, livePrice);
    current.low   = Math.min(current.low,  livePrice);
    const betPrice = current.open;
    res.json({
      price: livePrice, betPrice,
      priceVsBet: livePrice - betPrice,
      priceVsBetPct: ((livePrice-betPrice)/betPrice)*100,
      candleOpenTime: current.time,
      candleCloseTime: current.closeTime,
      msUntilClose: Math.max(0, current.closeTime - Date.now()),
      candles, source:"cryptocompare", serverTime:Date.now(),
    });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/signal", async (req, res) => {
  try {
    const [livePrice, candles] = await Promise.all([getLivePrice(), getCandles15m(100)]);
    candles[candles.length-1].close = livePrice;
    const betPrice = candles[candles.length-1].open;
    const sig = runEngine(candles, betPrice, livePrice);
    res.json({ ...sig, livePrice, betPrice, time:Date.now() });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`BTC backend running on port ${PORT}`));
