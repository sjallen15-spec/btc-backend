import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const BINANCE = "https://api.binance.com/api/v3";

// ── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ── Live spot price ───────────────────────────────────────────
app.get("/price", async (req, res) => {
  try {
    const r = await fetch(`${BINANCE}/ticker/price?symbol=BTCUSDT`);
    const d = await r.json();
    res.json({ symbol: d.symbol, price: parseFloat(d.price), time: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── OHLCV candles ─────────────────────────────────────────────
app.get("/candles", async (req, res) => {
  const interval = req.query.interval || "15m";
  const limit    = Math.min(parseInt(req.query.limit) || 100, 500);
  try {
    const r = await fetch(`${BINANCE}/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`);
    const raw = await r.json();
    const candles = raw.map(c => ({
      time:   Number(c[0]),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
    res.json(candles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Main combined endpoint ────────────────────────────────────
// Returns:
//   price         — current live spot price
//   betPrice      — open of the current 15m candle (the price you bet against)
//   candleOpenTime — unix ms when the current 15m candle opened
//   candleCloseTime — unix ms when the current 15m candle closes
//   msUntilClose  — milliseconds remaining in this 15m window
//   candles       — historical 15m OHLCV array (most recent last)
//   source        — "binance"
app.get("/btc", async (req, res) => {
  const interval = req.query.interval || "15m";
  const limit    = Math.min(parseInt(req.query.limit) || 100, 500);
  try {
    const [priceRes, candlesRes] = await Promise.all([
      fetch(`${BINANCE}/ticker/price?symbol=BTCUSDT`),
      fetch(`${BINANCE}/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`),
    ]);
    const priceData   = await priceRes.json();
    const candlesData = await candlesRes.json();

    const livePrice = parseFloat(priceData.price);
    const candles = candlesData.map(c => ({
      time:      Number(c[0]),   // candle open timestamp
      open:      parseFloat(c[1]),
      high:      parseFloat(c[2]),
      low:       parseFloat(c[3]),
      close:     parseFloat(c[4]),
      volume:    parseFloat(c[5]),
      closeTime: Number(c[6]),   // candle close timestamp
    }));

    // The LAST candle is the currently-forming candle.
    // Its open price is the exact 15-min boundary price — this is the BET PRICE.
    const currentCandle = candles[candles.length - 1];
    const betPrice      = currentCandle.open;          // price at the 15m mark
    const candleOpenTime  = currentCandle.time;
    const candleCloseTime = currentCandle.closeTime;
    const msUntilClose  = Math.max(0, candleCloseTime - Date.now());

    // Patch last candle's close with the live price so indicators use fresh data
    currentCandle.close = livePrice;
    currentCandle.high  = Math.max(currentCandle.high, livePrice);
    currentCandle.low   = Math.min(currentCandle.low, livePrice);

    res.json({
      price:          livePrice,
      betPrice,
      priceVsBet:     livePrice - betPrice,
      priceVsBetPct:  ((livePrice - betPrice) / betPrice) * 100,
      candleOpenTime,
      candleCloseTime,
      msUntilClose,
      candles,
      source: "binance",
      serverTime: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`BTC backend running on port ${PORT}`);
});