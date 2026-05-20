import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

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

app.get("/", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/price", async (req, res) => {
  try {
    const r = await fetchWithTimeout(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    );
    const data = await r.json();
    res.json({ price: data.bitcoin.usd, time: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/candles", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  try {
    const r = await fetchWithTimeout(
      `https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=${limit}&aggregate=15`
    );
    const data = await r.json();
    if (!data.Data?.Data || !Array.isArray(data.Data.Data)) {
      throw new Error("Bad response from CryptoCompare");
    }
    res.json(data.Data.Data.map(parseCandle));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/btc", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  try {
    const [priceRes, candleRes] = await Promise.all([
      fetchWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"),
      fetchWithTimeout(`https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=${limit}&aggregate=15`)
    ]);

    const priceData = await priceRes.json();
    const candleData = await candleRes.json();

    const livePrice = priceData.bitcoin.usd;

    if (!candleData.Data?.Data || !Array.isArray(candleData.Data.Data)) {
      throw new Error("Bad candle data");
    }

    const candles = candleData.Data.Data.map(parseCandle);
    const current = candles[candles.length - 1];
    const betPrice = current.open;

    current.close = livePrice;
    current.high  = Math.max(current.high, livePrice);
    current.low   = Math.min(current.low, livePrice);

    res.json({
      price:           livePrice,
      betPrice,
      priceVsBet:      livePrice - betPrice,
      priceVsBetPct:   ((livePrice - betPrice) / betPrice) * 100,
      candleOpenTime:  current.time,
      candleCloseTime: current.closeTime,
      msUntilClose:    Math.max(0, current.closeTime - Date.now()),
      candles,
      source:          "cryptocompare",
      serverTime:      Date.now(),
    });
  } catch (e) {
    console.error("/btc error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`BTC backend running on port ${PORT}`);
});
 
