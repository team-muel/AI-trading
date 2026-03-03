// src/backtest/backtest_1y.ts
import "dotenv/config";
import fs from "fs";
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

// Strategy params (same as your bot)
const CVD_LEN = Number(process.env.CVD_LEN ?? 19);
const DELTA_COEF = Number(process.env.DELTA_COEF ?? 1.0);
const TP_PCT = Number(process.env.TP_PCT ?? 4.0);
const SL_PCT = Number(process.env.SL_PCT ?? 2.0);

// Backtest params
const INITIAL_CAPITAL = Number(process.env.INITIAL_CAPITAL ?? 3000);
const EQUITY_SPLIT = (process.env.EQUITY_SPLIT ?? "true") === "true"; // equal split across symbols
const FEE_ROUNDTRIP_PCT = Number(process.env.BT_FEE_ROUNDTRIP_PCT ?? 0.08); // 0.08% round-trip default
const SL_FIRST_IF_BOTH = (process.env.BT_SL_FIRST ?? "true") === "true"; // conservative

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
  ts: string; // ISO (UTC)
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
  pnl: number; // in quote currency
  pnlPct: number; // relative to entry notional
};

// ---------- math ----------
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

// ---------- supabase fetch (paged) ----------
async function fetchCandles1y(symbol: string): Promise<Candle[]> {
  // We must page because 1y of 30m candles ~ 17520 rows/symbol
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

// ---------- backtest core ----------
function runBacktestForSymbol(symbol: string, candles: Candle[], capital: number): {
  trades: Trade[];
  equityCurve: { ts: string; equity: number }[];
  summary: any;
} {
  if (candles.length < CVD_LEN + 5) {
    return {
      trades: [],
      equityCurve: [],
      summary: { symbol, note: "not enough candles" },
    };
  }

  const cvd = computeCvd(candles, DELTA_COEF);
  const cvdMa = sma(cvd, CVD_LEN);

  let equity = capital;
  const equityCurve: { ts: string; equity: number }[] = [];
  const trades: Trade[] = [];

  // position state
  let inPos = false;
  let side: Side = "long";
  let entryPrice = 0;
  let entryTs = "";
  let tp = 0;
  let sl = 0;
  let qty = 0;

  const feeFrac = FEE_ROUNDTRIP_PCT / 100;

  for (let i = 1; i < candles.length - 1; i++) {
    // record equity at candle close timestamp (for curve)
    equityCurve.push({ ts: candles[i].ts, equity });

    // if in position, check TP/SL on current candle
    if (inPos) {
      const c = candles[i];

      const hitTp =
        side === "long" ? c.high >= tp : c.low <= tp;
      const hitSl =
        side === "long" ? c.low <= sl : c.high >= sl;

      let exitPrice = 0;
      let reason: Trade["reason"] | null = null;

      if (hitTp && hitSl) {
        // both hit: conservative rule
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

      if (reason) {
        // PnL
        const pnlRaw =
          side === "long"
            ? (exitPrice - entryPrice) * qty
            : (entryPrice - exitPrice) * qty;

        // fees: round-trip on notional (entryPrice*qty)
        const fee = entryPrice * qty * feeFrac;
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

    // if not in position, evaluate signal at close of candle i
    if (!inPos) {
      if (!Number.isFinite(cvdMa[i - 1]) || !Number.isFinite(cvdMa[i])) continue;

      const longCond = crossedOver(cvd[i - 1], cvdMa[i - 1], cvd[i], cvdMa[i]);
      const shortCond = crossedUnder(cvd[i - 1], cvdMa[i - 1], cvd[i], cvdMa[i]);

      if (longCond || shortCond) {
        // enter on next candle open (i+1)
        const next = candles[i + 1];
        side = longCond ? "long" : "short";
        entryPrice = next.open;
        entryTs = next.ts;

        // position sizing: use "exposure-style" like your bot (equity * riskPct * leverage / price)
        const riskPct = Number(process.env.RISK_PCT ?? 2.0);
        const leverage = Number(process.env.LEVERAGE ?? 20);
        const exposure = equity * (riskPct / 100) * leverage;
        qty = exposure / entryPrice;

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

  // If still in position at end: exit at last close (EOD)
  if (inPos) {
    const last = candles[candles.length - 1];
    const exitPrice = last.close;

    const pnlRaw =
      side === "long"
        ? (exitPrice - entryPrice) * qty
        : (entryPrice - exitPrice) * qty;

    const fee = entryPrice * qty * feeFrac;
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

  // MDD from equityCurve
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
      trades: trades.length,
      wins,
      losses,
      winRatePct: Number(winRate.toFixed(2)),
      totalPnl: Number(totalPnl.toFixed(2)),
      startEquity: capital,
      endEquity: Number(endEquity.toFixed(2)),
      totalReturnPct: Number(totalReturnPct.toFixed(2)),
      maxDrawdownPct: Number((maxDD * 100).toFixed(2)),
    },
  };
}

// ---------- main ----------
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
    initialCapital: INITIAL_CAPITAL,
    equitySplit: EQUITY_SPLIT,
    feeRoundtripPct: FEE_ROUNDTRIP_PCT,
    slFirstIfBoth: SL_FIRST_IF_BOTH,
  });

  const perSymbolCapital = EQUITY_SPLIT
    ? INITIAL_CAPITAL / SYMBOLS.length
    : INITIAL_CAPITAL;

  const allTrades: Trade[] = [];
  const summaries: any[] = [];
  let combinedEndEquity = EQUITY_SPLIT ? 0 : INITIAL_CAPITAL;

  for (const symbol of SYMBOLS) {
    const candles = await fetchCandles1y(symbol);
    console.log(`[backtest] ${symbol} candles=${candles.length}`);

    const { trades, summary } = runBacktestForSymbol(symbol, candles, perSymbolCapital);

    allTrades.push(...trades);
    summaries.push(summary);

    if (EQUITY_SPLIT) {
      combinedEndEquity += summary.endEquity;
    } else {
      // If not splitting, we'd need a true portfolio engine (shared equity).
      // For now, we treat it as single-symbol mode.
      combinedEndEquity = summary.endEquity;
    }
  }

  // Print summaries
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

  // Save CSV
  const outPath = `backtest_trades_${TIMEFRAME}_${new Date().toISOString().slice(0, 10)}.csv`;
  fs.writeFileSync(outPath, toCsv(allTrades), "utf-8");
  console.log(`\n[backtest] saved trades CSV -> ${outPath}`);
}

main().catch((e) => {
  console.error("[backtest] fatal:", e?.message ?? e);
  process.exit(1);
});
