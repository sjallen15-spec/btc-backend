import express from “express”;
import cors from “cors”;
import fetch from “node-fetch”;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Binance US-accessible base — falls back to .us if .com is geo-blocked
const BINANCE_COM = “https://api.binance.com/api/v3”;
const BINANCE_US  = “https://api.binance.us/api/v3”;

// ── Helper: fetch with timeout ────────────────────────────────
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

// ── Helper: try Binance .com then .us ────────────────────────
async function binanceFetch(path) {
// Try .com first
try {
const r = await fetchWithTimeout(`${BINANCE_COM}${path}`);
if (r.ok) {
const data = await r.json();
// Binance returns { code, msg } on errors
if (data.code) throw new Error(`Binance error ${data.code}: ${data.msg}`);
return { data, source: “binance.com” };
}
} catch (e) {
console.warn(`binance.com failed (${e.message}), trying binance.us...`);
}

// Fallback to .us
const r = await fetchWithTimeout(`${BINANCE_US}${path}`);
if (!r.ok) throw new Error(`Both Binance endpoints failed. HTTP ${r.status}`);
const data = await r.json();
if (data.code) throw new Error(`Binance US error ${data.code}: ${data.msg}`);
return { data, source: “binance.us” };
}

// ── Parse raw kline array into candle object ──────────────────
function parseCandle(c) {
return {
time:      Number(c[0]),
open:      parseFloat(c[1]),
high:      parseFloat(c[2]),
low:       parseFloat(c[3]),
close:     parseFloat(c[4]),
volume:    parseFloat(c[5]),
closeTime: Number(c[6]),
};
}

// ── Health check ──────────────────────────────────────────────
app.get(”/”, (req, res) => {
res.json({ status: “ok”, time: new Date().toISOString() });
});

// ── Live spot price ───────────────────────────────────────────
app.get(”/price”, async (req, res) => {
try {
const { data } = await binanceFetch(”/ticker/price?symbol=BTCUSDT”);
res.json({ price: parseFloat(data.price), time: Date.now() });
} catch (e) {
console.error(”/price error:”, e.message);
res.status(500).json({ error: e.message });
}
});

// ── OHLCV candles ─────────────────────────────────────────────
app.get(”/candles”, async (req, res) => {
const interval = req.query.interval || “15m”;
const limit    = Math.min(parseInt(req.query.limit) || 100, 500);
try {
const { data } = await binanceFetch(`/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`);
if (!Array.isArray(data)) throw new Error(`Expected array, got: ${JSON.stringify(data).slice(0,200)}`);
res.json(data.map(parseCandle));
} catch (e) {
console.error(”/candles error:”, e.message);
res.status(500).json({ error: e.message });
}
});

// ── Main combined endpoint ────────────────────────────────────
app.get(”/btc”, async (req, res) => {
const interval = req.query.interval || “15m”;
const limit    = Math.min(parseInt(req.query.limit) || 100, 500);
try {
const [priceResult, candlesResult] = await Promise.all([
binanceFetch(”/ticker/price?symbol=BTCUSDT”),
binanceFetch(`/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`),
]);

```
const priceData   = priceResult.data;
const candlesData = candlesResult.data;
const apiSource   = candlesResult.source;

// Validate — Binance occasionally returns an error object instead of array
if (!Array.isArray(candlesData)) {
  throw new Error(`Candles response is not an array. Got: ${JSON.stringify(candlesData).slice(0, 200)}`);
}
if (candlesData.length === 0) {
  throw new Error("Binance returned 0 candles");
}
if (isNaN(parseFloat(priceData.price))) {
  throw new Error(`Invalid price response: ${JSON.stringify(priceData).slice(0, 200)}`);
}

const livePrice = parseFloat(priceData.price);
const candles   = candlesData.map(parseCandle);

// Last candle = currently-forming candle
// Its OPEN = the exact 15m boundary = the BET PRICE
const current       = candles[candles.length - 1];
const betPrice      = current.open;
const candleOpenTime  = current.time;
const candleCloseTime = current.closeTime;
const msUntilClose    = Math.max(0, candleCloseTime - Date.now());

// Patch current candle with live price
current.close = livePrice;
current.high  = Math.max(current.high, livePrice);
current.low   = Math.min(current.low,  livePrice);

res.json({
  price:         livePrice,
  betPrice,
  priceVsBet:    livePrice - betPrice,
  priceVsBetPct: ((livePrice - betPrice) / betPrice) * 100,
  candleOpenTime,
  candleCloseTime,
  msUntilClose,
  candles,
  source:      apiSource,
  serverTime:  Date.now(),
});
```

} catch (e) {
console.error(”/btc error:”, e.message);
res.status(500).json({ error: e.message });
}
});

app.listen(PORT, () => {
console.log(`BTC backend running on port ${PORT}`);
});