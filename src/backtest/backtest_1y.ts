// src/backtest/backtest_1y.ts
import "dotenv/config";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";

// ---------- env helpers ----------
function must(k: string) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

// ---------- config ----------
const SUPABASE_URL = must("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = must("SUPABASE_SERVICE_ROLE_KEY");

const EXCHANGE = (process.env.EXCHANGE ?? "binance").toLowerCase();
const SYMBOLS = (process.env.SYMBOLS ?? "BTC/USDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ✅ 30m 백테스트 고정
const TIMEFRAME = "30m";

// Strategy params (TradingView 입력값)
const CVD_LEN = Number(process.env.CVD_LEN ?? 19);
const DELTA_COEF = Number(process.env.DELTA_COEF ?? 1.0);
const TP_PCT = Number(process.env.TP_PCT ?? 4.0);
const SL_PCT = Number(process.env.SL_PCT ?? 2.0);
const LEVERAGE = Number(process.env.LEVERAGE ?? 20);

// TV 기본 주문 크기 10% 반영
const ORDER_PCT = Number(process.env.BT_ORDER_PCT ?? 10);

// Portfolio capital
const INITIAL_CAPITAL = Number(process.env.INITIAL_CAPITAL ?? 3000);
const EQUITY_SPLIT = (process.env.EQUITY_SPLIT ?? "true") === "true";

// Fees (Binance basic taker assumption)
const BINANCE_FUTURES = (process.env.BINANCE_FUTURES ?? "true") === "true";
const FEE_PER_SIDE_PCT = BINANCE_FUTURES ? 0.04 : 0.10;
const FEE_ROUNDTRIP_PCT = FEE_PER_SIDE_PCT * 2;

// Backtest assumptions
// - Signal on bar close
// - Entry at NEXT bar open (no look-ahead)
// - TP/SL checked on subsequent bars (intrabar using OHLC)
// - If TP and SL are both touched in same bar: SL first (conservative)
const SL_FIRST_IF_BOTH = (process.env.BT_SL_FIRST ?? "true") === "true";

// 1 year window
const END_MS = Date.now();
const START_MS = END_MS - 365 * 24 * 60 * 60 * 1000;
const START_ISO = new Date(START_MS).toISOString();
const END_ISO = new Date(END_MS).toISOString();

// Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------- types ----------
type Candle = {
  ts: string; // ISO UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Side = "long" | "short";

type Trade = {
  symbol: string;
  side: Side;
  entryTs: string;
  entryPrice: number;
  exitTs: string;
  exitPrice: number;
  reason: "tp" | "sl" | "eod";
  qty: number;
  pnl: number;     // quote currency
  pnlPct: number;  // percent of entry notional (approx)
};

// ---------- indicator helpers ----------
function sma(series: number[], len: number): number[] {
  const out = new Array(series.length).fill(Number.NaN);
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i];
    if (i >= len) sum -= series[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

function computeCvd(candles: Candle[], deltaCoef: number): number[] {
  let acc = 0;
  const cvd: number[] = [];
  for (const c of candles) {
    const delta = (c.close - c.open) * c.volume * deltaCoef;
    acc += delta;
    cvd.push(acc);
  }
  return cvd;
}

function crossedOver(prevA: number, prevB: number, curA: number, curB: number) {
  return prevA <= prevB && curA > curB;
}
function crossedUnder(prevA: number, prevB: number, curA: number, curB: number) {
  return prevA >= prevB && curA < curB;
}

// ---------- Supabase fetch (paged) ----------
// ✅ PostgREST cap 대응: pageSize=1000 고정
async function fetchCandles1y30m(symbol: string): Promise<Candle[]> {
  const pageSize = 1000;
  let lastTs: string | null = null;
  const all: Candle[] = [];

  while (true) {
    let q = supabase
      .from("candles")
      .select("ts, open, high, low, close, volume")
      .eq("exchange", EXCHANGE)
      .eq("symbol", symbol)
      .eq("timeframe", TIMEFRAME)
      .lte("ts", END_ISO)
      .order("ts", { ascending: true })
      .limit(pageSize);

    // Keyset pagination: fetch rows strictly after the last seen timestamp.
    if (lastTs) q = q.gt("ts", lastTs);
    else q = q.gte("ts", START_ISO);

    const { data, error } = await q;

    if (error) throw error;

    const rows = (data ?? []).map((r: any) => ({
      ts: r.ts as string,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));

    all.push(...rows);

    // 마지막 페이지
    if (rows.length < pageSize) break;

    const nextLastTs = rows[rows.length - 1]?.ts ?? null;
    if (!nextLastTs || nextLastTs === lastTs) break;
    lastTs = nextLastTs;
  }

  return all;
}

// ---------- sizing (TV 기본 주문 10% * leverage) ----------
function computeQty(equity: number, entryPrice: number) {
  const notional = equity * (ORDER_PCT / 100) * LEVERAGE;
  return notional / entryPrice;
}

// ---------- backtest for one symbol ----------
function backtestSymbol(symbol: string, candles: Candle[], startEquity: number) {
  const trades: Trade[] = [];
  const equityCurve: { ts: string; equity: number }[] = [];

  // Need enough bars for SMA + signals
  if (candles.length < CVD_LEN + 5) {
    return {
      symbol,
      skipped: true,
      reason: `not enough candles (${candles.length})`,
      trades,
      startEquity,
      endEquity: startEquity,
      totalPnl: 0,
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      winRatePct: 0,
      wins: 0,
      losses: 0,
      count: 0,
    };
  }

  const cvd = computeCvd(candles, DELTA_COEF);
  const cvdMa = sma(cvd, CVD_LEN);

  let equity = startEquity;

  let inPos = false;
  let side: Side = "long";
  let entryPrice = 0;
  let entryTs = "";
  let tp = 0;
  let sl = 0;
  let qty = 0;

  const feeFracRoundtrip = FEE_ROUNDTRIP_PCT / 100;

  // i is signal candle index, entry uses i+1 open
  for (let i = 1; i < candles.length - 1; i++) {
    equityCurve.push({ ts: candles[i].ts, equity });

    const c = candles[i];

    // 1) manage open position (TP/SL on this bar)
    if (inPos) {
      const hitTp = side === "long" ? c.high >= tp : c.low <= tp;
      const hitSl = side === "long" ? c.low <= sl : c.high >= sl;

      let exitPrice: number | null = null;
      let reason: Trade["reason"] | null = null;

      if (hitTp && hitSl) {
        // both hit: choose rule
        if (SL_FIRST_IF_BOTH) {
          exitPrice = sl;
          reason = "sl";
        } else {
          exitPrice = tp;
          reason = "tp";
        }
      } else if (hitSl) {
        exitPrice = sl;
        reason = "sl";
      } else if (hitTp) {
        exitPrice = tp;
        reason = "tp";
      }

      if (reason && exitPrice !== null) {
        const pnlRaw =
          side === "long"
            ? (exitPrice - entryPrice) * qty
            : (entryPrice - exitPrice) * qty;

        // fee approximation: roundtrip on entry notional
        const fee = entryPrice * qty * feeFracRoundtrip;
        const pnl = pnlRaw - fee;

        equity += pnl;

        trades.push({
          symbol,
          side,
          entryTs,
          entryPrice,
          exitTs: c.ts,
          exitPrice,
          reason,
          qty,
          pnl,
          pnlPct: (pnlRaw / (entryPrice * qty)) * 100 - FEE_ROUNDTRIP_PCT,
        });

        inPos = false;
        continue;
      }
    }

    // 2) if flat, evaluate signal at candle close i
    if (!inPos) {
      if (!Number.isFinite(cvdMa[i - 1]) || !Number.isFinite(cvdMa[i])) continue;

      const longCond = crossedOver(cvd[i - 1], cvdMa[i - 1], cvd[i], cvdMa[i]);
      const shortCond = crossedUnder(cvd[i - 1], cvdMa[i - 1], cvd[i], cvdMa[i]);

      if (longCond || shortCond) {
        side = longCond ? "long" : "short";

        // enter next candle open
        const next = candles[i + 1];
        entryPrice = next.open;
        entryTs = next.ts;

        qty = computeQty(equity, entryPrice);

        tp =
          side === "long"
            ? entryPrice * (1 + TP_PCT / 100)
            : entryPrice * (1 - TP_PCT / 100);

        sl =
          side === "long"
            ? entryPrice * (1 - SL_PCT / 100)
            : entryPrice * (1 + SL_PCT / 100);

        inPos = true;
      }
    }
  }

  // EOD close if still open
  if (inPos) {
    const last = candles[candles.length - 1];
    const exitPrice = last.close;

    const pnlRaw =
      side === "long"
        ? (exitPrice - entryPrice) * qty
        : (entryPrice - exitPrice) * qty;

    const fee = entryPrice * qty * feeFracRoundtrip;
    const pnl = pnlRaw - fee;
    equity += pnl;

    trades.push({
      symbol,
      side,
      entryTs,
      entryPrice,
      exitTs: last.ts,
      exitPrice,
      reason: "eod",
      qty,
      pnl,
      pnlPct: (pnlRaw / (entryPrice * qty)) * 100 - FEE_ROUNDTRIP_PCT,
    });
  }

  // summary
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl <= 0).length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;

  // max drawdown from equity curve
  let peak = startEquity;
  let maxDD = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = (peak - p.equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const endEquity = equity;
  const totalReturnPct = ((endEquity - startEquity) / startEquity) * 100;

  return {
    symbol,
    skipped: false,
    reason: null,
    trades,
    startEquity,
    endEquity,
    totalPnl,
    totalReturnPct,
    maxDrawdownPct: maxDD * 100,
    winRatePct: winRate,
    wins,
    losses,
    count: trades.length,
  };
}

// ---------- CSV ----------
function toCsv(trades: Trade[]) {
  const header = [
    "symbol",
    "side",
    "entryTs",
    "entryPrice",
    "exitTs",
    "exitPrice",
    "reason",
    "qty",
    "pnl",
    "pnlPct",
  ].join(",");

  const lines = trades.map((t) =>
    [
      t.symbol,
      t.side,
      t.entryTs,
      t.entryPrice,
      t.exitTs,
      t.exitPrice,
      t.reason,
      t.qty,
      t.pnl,
      t.pnlPct,
    ].join(",")
  );

  return [header, ...lines].join("\n");
}

// ---------- main ----------
async function main() {
  console.log("[backtest-30m-1y] start", {
    exchange: EXCHANGE,
    timeframe: TIMEFRAME,
    window: `${START_ISO} → ${END_ISO}`,
    symbols: SYMBOLS,
    cvdLen: CVD_LEN,
    deltaCoef: DELTA_COEF,
    tpPct: TP_PCT,
    slPct: SL_PCT,
    leverage: LEVERAGE,
    orderPct: ORDER_PCT,
    initialCapital: INITIAL_CAPITAL,
    equitySplit: EQUITY_SPLIT,
    binanceFutures: BINANCE_FUTURES,
    feePerSidePct: FEE_PER_SIDE_PCT,
    feeRoundtripPct: FEE_ROUNDTRIP_PCT,
    slFirstIfBoth: SL_FIRST_IF_BOTH,
  });

  const perSymbolEquity = EQUITY_SPLIT
    ? INITIAL_CAPITAL / SYMBOLS.length
    : INITIAL_CAPITAL;

  const summaries: any[] = [];
  const allTrades: Trade[] = [];

  let combinedEndEquity = EQUITY_SPLIT ? 0 : INITIAL_CAPITAL;

  const fetched = await Promise.all(
    SYMBOLS.map(async (symbol) => {
      const candles = await fetchCandles1y30m(symbol);
      return { symbol, candles };
    })
  );

  for (const { symbol, candles } of fetched) {
    console.log(`[backtest-30m-1y] ${symbol} candles=${candles.length}`);

    const res = backtestSymbol(symbol, candles, perSymbolEquity);
    summaries.push({
      symbol: res.symbol,
      skipped: res.skipped,
      reason: res.reason,
      candles: candles.length,
      trades: res.count,
      winRatePct: Number(res.winRatePct.toFixed(2)),
      totalPnl: Number(res.totalPnl.toFixed(2)),
      startEquity: Number(res.startEquity.toFixed(2)),
      endEquity: Number(res.endEquity.toFixed(2)),
      totalReturnPct: Number(res.totalReturnPct.toFixed(2)),
      maxDrawdownPct: Number(res.maxDrawdownPct.toFixed(2)),
    });

    // ✅ only include valid equities in combined sum
    if (EQUITY_SPLIT) {
      if (Number.isFinite(res.endEquity)) combinedEndEquity += res.endEquity;
    } else {
      if (Number.isFinite(res.endEquity)) combinedEndEquity = res.endEquity;
    }

    allTrades.push(...res.trades);
  }

  console.log("\n[backtest-30m-1y] per-symbol summary");
  for (const s of summaries) console.log(s);

  const totalReturnPct = ((combinedEndEquity - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  console.log("\n[backtest-30m-1y] combined result", {
    startEquity: INITIAL_CAPITAL,
    endEquity: Number(combinedEndEquity.toFixed(2)),
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    trades: allTrades.length,
  });

  const outPath = `backtest_30m_1y_${new Date().toISOString().slice(0, 10)}.csv`;
  fs.writeFileSync(outPath, toCsv(allTrades), "utf-8");
  console.log(`\n[backtest-30m-1y] saved trades CSV -> ${outPath}`);
}

main().catch((e) => {
  console.error("[backtest-30m-1y] fatal:", e?.message ?? e);
  process.exit(1);
});
