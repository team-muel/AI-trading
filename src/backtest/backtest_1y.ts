// src/backtest/backtest_1y.ts
import "dotenv/config";
import fs from "fs";
import ccxt from "ccxt";
import { createClient } from "@supabase/supabase-js";

// ---------- env ----------
function must(k: string) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

const SUPABASE_URL = must("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = must("SUPABASE_SERVICE_ROLE_KEY");

const EXCHANGE = (process.env.EXCHANGE ?? "binance").toLowerCase();
const TIMEFRAME = process.env.TIMEFRAME ?? "30m";
const SYMBOLS = (process.env.SYMBOLS ?? "BTC/USDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Strategy params
const CVD_LEN = Number(process.env.CVD_LEN ?? 19);
const DELTA_COEF = Number(process.env.DELTA_COEF ?? 1.0);
const RISK_PCT = Number(process.env.RISK_PCT ?? 2.0);
const TP_PCT = Number(process.env.TP_PCT ?? 4.0);
const SL_PCT = Number(process.env.SL_PCT ?? 2.0);
const LEVERAGE = Number(process.env.LEVERAGE ?? 20);

// Backtest params (TV-like)
const INITIAL_CAPITAL = Number(process.env.INITIAL_CAPITAL ?? 3000);
const EQUITY_SPLIT = (process.env.EQUITY_SPLIT ?? "true") === "true";
const SLIPPAGE_TICKS = Number(process.env.BT_SLIPPAGE_TICKS ?? 2);
const PYRAMIDING = Number(process.env.BT_PYRAMIDING ?? 2); // TradingView pyramiding=2

const BINANCE_FUTURES = (process.env.BINANCE_FUTURES ?? "true") === "true";

// Binance basic fee assumptions (VIP0, no discount), taker used for safety
// Futures: 0.04%/side, Spot: 0.10%/side
const FEE_PER_SIDE_PCT = BINANCE_FUTURES ? 0.04 : 0.10;
const FEE_ROUNDTRIP_PCT = FEE_PER_SIDE_PCT * 2;

// 1 year window
const END_MS = Date.now();
const START_MS = END_MS - 365 * 24 * 60 * 60 * 1000;
const START_ISO = new Date(START_MS).toISOString();
const END_ISO = new Date(END_MS).toISOString();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------- types ----------
type Candle = {
  ts: string;
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
  pnl: number;      // quote currency
  pnlPct: number;   // percent of entry notional (approx)
  entries: number;  // pyramiding count used
};

// ---------- helpers ----------
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

// Slippage: adverse movement in price by ticks
function applySlippage(price: number, side: Side, isEntry: boolean, tickSize: number) {
  const slip = SLIPPAGE_TICKS * tickSize;
  // Entry:
  // - long entry worse = higher
  // - short entry worse = lower
  // Exit:
  // - long exit worse = lower
  // - short exit worse = higher
  if (isEntry) {
    return side === "long" ? price + slip : price - slip;
  } else {
    return side === "long" ? price - slip : price + slip;
  }
}

// ---------- supabase fetch (paged) ----------
async function fetchCandles1y(symbol: string): Promise<Candle[]> {
  const pageSize = 5000;
  let from = 0;
  const all: Candle[] = [];

  while (true) {
    const { data, error } = await supabase
      .from("candles")
      .select("ts, open, high, low, close, volume")
      .eq("exchange", EXCHANGE)
      .eq("symbol", symbol)
      .eq("timeframe", TIMEFRAME)
      .gte("ts", START_ISO)
      .lte("ts", END_ISO)
      .order("ts", { ascending: true })
      .range(from, from + pageSize - 1);

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

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

// ---------- tick size via ccxt ----------
function pow10(n: number) {
  return Math.pow(10, n);
}

function inferTickSizeFromPrecision(prec?: number) {
  if (typeof prec !== "number" || !Number.isFinite(prec)) return null;
  return 1 / pow10(prec);
}

function inferTickSizeFromMarketInfo(m: any) {
  // Binance market.info.filters -> PRICE_FILTER.tickSize
  try {
    const filters = m?.info?.filters;
    if (Array.isArray(filters)) {
      const pf = filters.find((x: any) => x?.filterType === "PRICE_FILTER");
      const ts = Number(pf?.tickSize);
      if (Number.isFinite(ts) && ts > 0) return ts;
    }
  } catch {}
  return null;
}

async function getTickSize(ex: any, symbol: string): Promise<number> {
  await ex.loadMarkets();
  const m = ex.market(symbol);
  const fromInfo = inferTickSizeFromMarketInfo(m);
  if (fromInfo) return fromInfo;

  const p = m?.precision?.price;
  const fromPrec = inferTickSizeFromPrecision(p);
  if (fromPrec) return fromPrec;

  // fallback: very rough default
  return 0.01;
}

// ---------- sizing (same as bot: exposure-style) ----------
function computeQty(equity: number, price: number) {
  const exposure = equity * (RISK_PCT / 100) * LEVERAGE;
  return exposure / price;
}

// ---------- backtest core (with pyramiding/slippage/fee) ----------
function runBacktestForSymbol(symbol: string, candles: Candle[], capital: number, tickSize: number) {
  const trades: Trade[] = [];
  const equityCurve: { ts: string; equity: number }[] = [];

  if (candles.length < CVD_LEN + 5) {
    return { trades, equityCurve, summary: { symbol, note: "not enough candles" } };
  }

  const cvd = computeCvd(candles, DELTA_COEF);
  const cvdMa = sma(cvd, CVD_LEN);

  let equity = capital;

  // position (aggregated)
  let inPos = false;
  let side: Side = "long";
  let entryTs = "";
  let avgEntry = 0;      // weighted avg entry
  let qty = 0;           // total qty
  let entries = 0;       // number of pyramid entries used
  let tp = 0;
  let sl = 0;

  const feeFracRoundtrip = FEE_ROUNDTRIP_PCT / 100;

  function recomputeTpSl() {
    tp = side === "long" ? avgEntry * (1 + TP_PCT / 100) : avgEntry * (1 - TP_PCT / 100);
    sl = side === "long" ? avgEntry * (1 - SL_PCT / 100) : avgEntry * (1 + SL_PCT / 100);
  }

  for (let i = 1; i < candles.length - 1; i++) {
    equityCurve.push({ ts: candles[i].ts, equity });

    const c = candles[i];

    // 1) Exit check
    if (inPos) {
      // apply slippage on exit price (adverse)
      // we still use candle high/low to detect hits, but fill at TP/SL adjusted by slippage
      const hitTp = side === "long" ? c.high >= tp : c.low <= tp;
      const hitSl = side === "long" ? c.low <= sl : c.high >= sl;

      let exitPrice: number | null = null;
      let reason: Trade["reason"] | null = null;

      if (hitTp && hitSl) {
        // Conservative: SL first when both
        exitPrice = applySlippage(sl, side, false, tickSize);
        reason = "sl";
      } else if (hitSl) {
        exitPrice = applySlippage(sl, side, false, tickSize);
        reason = "sl";
      } else if (hitTp) {
        exitPrice = applySlippage(tp, side, false, tickSize);
        reason = "tp";
      }

      if (reason && exitPrice !== null) {
        const pnlRaw =
          side === "long"
            ? (exitPrice - avgEntry) * qty
            : (avgEntry - exitPrice) * qty;

        const fee = avgEntry * qty * feeFracRoundtrip; // approx: roundtrip on entry notional
        const pnl = pnlRaw - fee;

        equity += pnl;

        trades.push({
          symbol,
          side,
          entryTs,
          entryPrice: avgEntry,
          exitTs: c.ts,
          exitPrice,
          reason,
          qty,
          pnl,
          pnlPct: (pnlRaw / (avgEntry * qty)) * 100 - FEE_ROUNDTRIP_PCT,
          entries,
        });

        // reset position
        inPos = false;
        qty = 0;
        avgEntry = 0;
        entries = 0;
        tp = 0;
        sl = 0;
      }
    }

    // 2) Signal check (close of candle i)
    if (!Number.isFinite(cvdMa[i - 1]) || !Number.isFinite(cvdMa[i])) continue;

    const longCond = crossedOver(cvd[i - 1], cvdMa[i - 1], cvd[i], cvdMa[i]);
    const shortCond = crossedUnder(cvd[i - 1], cvdMa[i - 1], cvd[i], cvdMa[i]);

    if (!(longCond || shortCond)) continue;

    const next = candles[i + 1];
    const sigSide: Side = longCond ? "long" : "short";

    // TradingView pyramiding: allow up to PYRAMIDING entries in same direction
    if (!inPos) {
      // open new position
      side = sigSide;

      const rawEntry = next.open; // enter next open
      const fillEntry = applySlippage(rawEntry, side, true, tickSize);

      const q = computeQty(equity, fillEntry);

      inPos = true;
      entryTs = next.ts;
      avgEntry = fillEntry;
      qty = q;
      entries = 1;
      recomputeTpSl();
    } else {
      // already in a position
      if (sigSide !== side) {
        // strategy doesn't specify close-on-opposite, so ignore opposite signals
        continue;
      }
      if (entries >= PYRAMIDING) {
        continue;
      }

      // add entry (pyramiding)
      const rawEntry = next.open;
      const fillEntry = applySlippage(rawEntry, side, true, tickSize);

      const addQty = computeQty(equity, fillEntry);

      const newQty = qty + addQty;
      const newAvg = (avgEntry * qty + fillEntry * addQty) / newQty;

      qty = newQty;
      avgEntry = newAvg;
      entries += 1;

      // update TP/SL based on new average entry
      recomputeTpSl();
    }
  }

  // End of data: if still in position, exit at last close (with slippage)
  if (inPos) {
    const last = candles[candles.length - 1];
    const rawExit = last.close;
    const exitPrice = applySlippage(rawExit, side, false, tickSize);

    const pnlRaw =
      side === "long"
        ? (exitPrice - avgEntry) * qty
        : (avgEntry - exitPrice) * qty;

    const fee = avgEntry * qty * feeFracRoundtrip;
    const pnl = pnlRaw - fee;
    equity += pnl;

    trades.push({
      symbol,
      side,
      entryTs,
      entryPrice: avgEntry,
      exitTs: last.ts,
      exitPrice,
      reason: "eod",
      qty,
      pnl,
      pnlPct: (pnlRaw / (avgEntry * qty)) * 100 - FEE_ROUNDTRIP_PCT,
      entries,
    });
  }

  // summary
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl <= 0).length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;

  // MDD from equity curve
  let peak = capital;
  let maxDD = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = (peak - p.equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const endEquity = capital + totalPnl;
  const totalReturnPct = ((endEquity - capital) / capital) * 100;

  return {
    trades,
    equityCurve,
    summary: {
      symbol,
      candles: candles.length,
      trades: trades.length,
      wins,
      losses,
      winRatePct: Number(winRate.toFixed(2)),
      startEquity: Number(capital.toFixed(2)),
      endEquity: Number(endEquity.toFixed(2)),
      totalPnl: Number(totalPnl.toFixed(2)),
      totalReturnPct: Number(totalReturnPct.toFixed(2)),
      maxDrawdownPct: Number((maxDD * 100).toFixed(2)),
      feePerSidePct: FEE_PER_SIDE_PCT,
      slippageTicks: SLIPPAGE_TICKS,
      pyramiding: PYRAMIDING,
      tickSize,
    },
  };
}

// ---------- csv ----------
function toCsv(trades: Trade[]) {
  const header = [
    "symbol",
    "side",
    "entries",
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
      t.entries,
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
  console.log("[backtest] start", {
    exchange: EXCHANGE,
    timeframe: TIMEFRAME,
    symbols: SYMBOLS,
    window: `${START_ISO} → ${END_ISO}`,
    cvdLen: CVD_LEN,
    deltaCoef: DELTA_COEF,
    tpPct: TP_PCT,
    slPct: SL_PCT,
    riskPct: RISK_PCT,
    leverage: LEVERAGE,
    initialCapital: INITIAL_CAPITAL,
    equitySplit: EQUITY_SPLIT,
    feePerSidePct: FEE_PER_SIDE_PCT,
    feeRoundtripPct: FEE_ROUNDTRIP_PCT,
    slippageTicks: SLIPPAGE_TICKS,
    pyramiding: PYRAMIDING,
    futures: BINANCE_FUTURES,
  });

  // ccxt for tickSize
  const ex: any = new ccxt.binance({ enableRateLimit: true });
  await ex.loadMarkets();

  const perSymbolCapital = EQUITY_SPLIT
    ? INITIAL_CAPITAL / SYMBOLS.length
    : INITIAL_CAPITAL;

  const allTrades: Trade[] = [];
  const summaries: any[] = [];
  let combinedEndEquity = EQUITY_SPLIT ? 0 : INITIAL_CAPITAL;

  for (const symbol of SYMBOLS) {
    const tickSize = await getTickSize(ex, symbol);

    const candles = await fetchCandles1y(symbol);
    console.log(`[backtest] ${symbol} candles=${candles.length} tickSize=${tickSize}`);

    const { trades, summary } = runBacktestForSymbol(symbol, candles, perSymbolCapital, tickSize);
    allTrades.push(...trades);
    summaries.push(summary);

    if (EQUITY_SPLIT) combinedEndEquity += summary.endEquity;
    else combinedEndEquity = summary.endEquity;
  }

  console.log("\n[backtest] per-symbol summary");
  for (const s of summaries) console.log(s);

  if (EQUITY_SPLIT) {
    const totalReturnPct = ((combinedEndEquity - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
    console.log("\n[backtest] combined (equal split) result", {
      startEquity: INITIAL_CAPITAL,
      endEquity: Number(combinedEndEquity.toFixed(2)),
      totalReturnPct: Number(totalReturnPct.toFixed(2)),
      trades: allTrades.length,
    });
  } else {
    console.log("\n[backtest] combined result (single-symbol mode)", {
      startEquity: INITIAL_CAPITAL,
      endEquity: Number(combinedEndEquity.toFixed(2)),
      trades: allTrades.length,
    });
  }

  const outPath = `backtest_trades_${TIMEFRAME}_${new Date().toISOString().slice(0, 10)}.csv`;
  fs.writeFileSync(outPath, toCsv(allTrades), "utf-8");
  console.log(`\n[backtest] saved trades CSV -> ${outPath}`);
}

main().catch((e) => {
  console.error("[backtest] fatal:", e?.message ?? e);
  process.exit(1);
});
