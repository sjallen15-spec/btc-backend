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

// ═══════════════════════════════════════════════════════════════
// TELEGRAM CONFIG — fill these in
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════════════════════════
async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { signal: controller.signal });
    return r;
  } finally {
    clearTimeout(id);
  }
}

async function getLivePrice() {
  try {
    const r = await fetchWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    const data = await r.json();
    if (data?.bitcoin?.usd) return data.bitcoin.usd;
  } catch {}
  try {
    const r = await fetchWithTimeout("https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD");
    const data = await r.json();
    if (data?.USD) return data.USD;
  } catch {}
  try {
    const r = await fetchWithTimeout("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    const data = await r.json();
    if (data?.data?.amount) return parseFloat(data.data.amount);
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

async function getCandles(limit = 100, interval = "15m") {
  // interval: "1m" = 1-minute candles, "15m" = 15-minute aggregated
  const aggregate = interval === "1m" ? 1 : 15;
  const r = await fetchWithTimeout(
    `https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=${limit}&aggregate=${aggregate}`
  );
  const data = await r.json();
  if (!data.Data?.Data || !Array.isArray(data.Data.Data)) throw new Error("Bad candle data");
  return data.Data.Data.map(c => ({
    time:      c.time * 1000,
    open:      c.open,
    high:      c.high,
    low:       c.low,
    close:     c.close,
    volume:    c.volumefrom,
    closeTime: (c.time + (aggregate * 60)) * 1000,
  }));
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL ENGINE (mirrors frontend logic)
// ═══════════════════════════════════════════════════════════════
function emaArr(prices, p) {
  const k = 2/(p+1); const out = [prices[0]];
  for (let i = 1; i < prices.length; i++) out.push(prices[i]*k + out[i-1]*(1-k));
  return out;
}

function calcMACD(prices) {
  if (prices.length < 26) return { macd:0, signal:0, hist:0, histPrev:0 };
  const e12 = emaArr(prices,12), e26 = emaArr(prices,26);
  const line = e12.map((v,i) => v - e26[i]);
  const sig = emaArr(line, 9);
  const n = line.length - 1;
  return { macd:line[n], signal:sig[n], hist:line[n]-sig[n], histPrev: n>0?line[n-1]-sig[n-1]:0 };
}

function calcATR(candles) {
  if (candles.length < 2) return { current:0, avg:0 };
  const trs = candles.slice(1).map((c,i) => Math.max(c.high-c.low, Math.abs(c.high-candles[i].close), Math.abs(c.low-candles[i].close)));
  const sl = trs.slice(-20);
  return { current: trs[trs.length-1]||0, avg: sl.reduce((a,b)=>a+b,0)/(sl.length||1) };
}

function calcStructure(candles) {
  if (candles.length < 20) return { trend:"CHOP", swingHigh:0, swingLow:0, prevSwingHigh:0 };
  const s = candles.slice(-20);
  const closes = s.map(c => c.close);
  const q1avg = closes.slice(0,5).reduce((a,b)=>a+b,0)/5;
  const q2avg = closes.slice(5,10).reduce((a,b)=>a+b,0)/5;
  const q3avg = closes.slice(10,15).reduce((a,b)=>a+b,0)/5;
  const q4avg = closes.slice(15,20).reduce((a,b)=>a+b,0)/5;
  const ema10arr = emaArr(closes, 10);
  const emaSlope = ema10arr[ema10arr.length-1] - ema10arr[ema10arr.length-5];
  const emaSlopePct = emaSlope / ema10arr[ema10arr.length-5] * 100;
  const risingQuarters = q2avg>q1avg && q3avg>q2avg && q4avg>q3avg;
  const fallingQuarters = q2avg<q1avg && q3avg<q2avg && q4avg<q3avg;
  let trend = "CHOP";
  if (risingQuarters && emaSlopePct > 0.05) trend = "UP";
  else if (fallingQuarters && emaSlopePct < -0.05) trend = "DOWN";
  else if (emaSlopePct > 0.15) trend = "UP";
  else if (emaSlopePct < -0.15) trend = "DOWN";
  return {
    trend,
    swingHigh: Math.max(...candles.slice(-10).map(c=>c.high)),
    swingLow:  Math.min(...candles.slice(-10).map(c=>c.low)),
    prevSwingHigh: Math.max(...candles.slice(-20,-10).map(c=>c.high))
  };
}

function calcMomentum(candles) {
  if (candles.length < 7) return { sameDir:false, expanding:false, dir:"UP" };
  const n = candles.length-1, a = candles[n], b = candles[n-1];
  const d1 = a.close >= a.open ? "UP" : "DOWN";
  const d2 = b.close >= b.open ? "UP" : "DOWN";
  return { sameDir: d1===d2, expanding: Math.abs(a.close-a.open) > candles.slice(-6,-1).reduce((s,c)=>s+Math.abs(c.close-c.open),0)/5, dir: d1 };
}

function runEngine(candles, betPrice, livePrice) {
  const closes = candles.map(c => c.close);
  const e50arr = emaArr(closes, 50), e50 = e50arr[e50arr.length-1];
  const m = calcMACD(closes), at = calcATR(candles), mom = calcMomentum(candles), st = calcStructure(candles);

  let score = 0; const reasoning = [];
  livePrice > e50 ? (score++, reasoning.push("Price above EMA50")) : reasoning.push("Price below EMA50");
  m.macd > 0 ? (score++, reasoning.push("MACD above zero")) : reasoning.push("MACD below zero");
  mom.sameDir && (score++, reasoning.push("Candles same direction"));
  mom.expanding && (score++, reasoning.push("Candle body expanding"));
  at.current > at.avg && (score++, reasoning.push("ATR above average"));
  Math.abs(candles[candles.length-1].close - candles[candles.length-1].open) >
    candles.slice(-6,-1).reduce((s,c)=>s+Math.abs(c.close-c.open),0)/5 && (score++, reasoning.push("Body above average"));
  ((m.macd>m.signal&&mom.dir==="UP")||(m.macd<m.signal&&mom.dir==="DOWN")) && (score++, reasoning.push("MACD aligned"));
  Math.abs(m.hist) > Math.abs(m.histPrev) && (score++, reasoning.push("MACD histogram expanding"));

  const bv   = [m.macd>0, mom.dir==="UP",  st.trend==="UP",  livePrice>e50].filter(Boolean).length;
  const bvD  = [m.macd<0, mom.dir==="DOWN", st.trend==="DOWN", livePrice<e50].filter(Boolean).length;
  const rawDir = bv>=3?"UP":bvD>=3?"DOWN":bv>=2&&bvD===0?"UP":bvD>=2&&bv===0?"DOWN":"MIXED";

  // ── OPTIMIZED RULES v4 ──
  let signal = "NO BET", confidence = "LOW";
  // DOWN signals
  if (score >= 7 && bvD >= 2) { signal = "DOWN"; confidence = "HIGH"; }
  else if ((score === 5 || score === 6) && bvD >= 2) { signal = "DOWN"; confidence = "MEDIUM"; }
  else if (score === 4 && bvD >= 2 && rawDir === "DOWN") { signal = "DOWN"; confidence = "MEDIUM"; }
  // UP signals (re-enabled - score 5: 91% UP, score 6: 100% UP)
  if (signal === "NO BET" && score >= 6 && bv >= 2 && rawDir === "UP") { signal = "UP"; confidence = "HIGH"; }
  else if (signal === "NO BET" && score === 5 && bv >= 2 && rawDir === "UP") { signal = "UP"; confidence = "MEDIUM"; }
  else if (signal === "NO BET" && score === 4 && bv >= 2 && rawDir === "UP" && st.trend === "UP") { signal = "UP"; confidence = "MEDIUM"; }

  return { signal, confidence, score, trend: st.trend, reasoning };
}

// ═══════════════════════════════════════════════════════════════
// 15-MINUTE SCHEDULER
// ═══════════════════════════════════════════════════════════════
const MS15 = 15 * 60 * 1000;
function msUntilNextBoundary() {
  const now = Date.now();
  return MS15 - (now % MS15);
}

let lastSignal = "NO BET";
let lastScore = 0;

async function runSignalAndNotify() {
  console.log(`[${new Date().toISOString()}] Running signal check...`);
  try {
    const [livePrice, candles] = await Promise.all([getLivePrice(), getCandles(100)]);
    const betPrice = candles[candles.length-1].open;
    const sig = runEngine(candles, betPrice, livePrice);

    console.log(`Signal: ${sig.signal} | Score: ${sig.score} | Confidence: ${sig.confidence} | Last: ${lastSignal}`);

    const signalChanged = sig.signal !== lastSignal;
    const scoreChanged  = sig.score !== lastScore && sig.signal !== "NO BET";

    if (sig.signal !== "NO BET" && sig.score >= TG_MIN_SCORE && (signalChanged || scoreChanged)) {
      const arrow = sig.signal === "UP" ? "🟢" : "🔴";
      const changeNote = signalChanged && lastSignal !== "NO BET"
        ? `\n⚠️ _Changed from ${lastSignal} → ${sig.signal}_` : "";
      const msg = `${arrow} *BTC SIGNAL: ${sig.signal}*${changeNote}\n\n` +
        `Score: ${sig.score}/8 | Confidence: ${sig.confidence}\n` +
        `Trend: ${sig.trend}\n` +
        `Live Price: $${livePrice.toLocaleString()}\n` +
        `Bet Price: $${betPrice.toLocaleString()}\n\n` +
        `${sig.reasoning.slice(0,3).join("\n")}\n\n` +
        `_NOT FINANCIAL ADVICE_`;
      await sendTelegram(msg);
      console.log("Telegram alert sent!");
    }

    lastSignal = sig.signal;
    lastScore  = sig.score;
  } catch(e) {
    console.error("Signal check failed:", e.message);
  }
}

// Check every minute — notify whenever signal or score changes
setInterval(runSignalAndNotify, 60000);

// Run once on startup
setTimeout(runSignalAndNotify, 3000);

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════
app.get("/healthz", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.get("/api/price", async (req, res) => {
  try {
    const price = await getLivePrice();
    res.json({ price, time: Date.now() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/candles", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 2016);
  const interval = req.query.interval || "15m";
  try {
    const candles = await getCandles(limit, interval);
    res.json(candles);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/btc", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1500);
  try {
    const [livePrice, candles] = await Promise.all([getLivePrice(), getCandles(limit)]);
    const current = candles[candles.length-1];
    const betPrice = current.open;
    current.close = livePrice;
    current.high  = Math.max(current.high, livePrice);
    current.low   = Math.min(current.low, livePrice);
    res.json({
      price: livePrice, betPrice,
      priceVsBet: livePrice - betPrice,
      priceVsBetPct: ((livePrice - betPrice) / betPrice) * 100,
      candleOpenTime: current.time,
      candleCloseTime: current.closeTime,
      msUntilClose: Math.max(0, current.closeTime - Date.now()),
      candles, source: "cryptocompare", serverTime: Date.now(),
    });
  } catch(e) {
    console.error("/api/btc error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/signal", async (req, res) => {
  try {
    const [livePrice, candles] = await Promise.all([getLivePrice(), getCandles(100)]);
    const betPrice = candles[candles.length-1].open;
    const sig = runEngine(candles, betPrice, livePrice);
    res.json({ ...sig, livePrice, betPrice, time: Date.now() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`BTC backend running on port ${PORT}`));
