import "dotenv/config";
import fs from "fs";
import ccxt from "ccxt";
import { toBinanceSymbol } from "../exchange/symbol";
import { runDuckdbSql, sqlString } from "../tick/duckdb_cli";

const EXCHANGE = (process.env.EXCHANGE ?? "binance").toLowerCase();
const SYMBOLS = (process.env.SYMBOLS ?? "BTC/USDT").split(",").map((s) => s.trim()).filter(Boolean);

const CVD_LEN = Number(process.env.CVD_LEN ?? 19);
const DELTA_COEF = Number(process.env.DELTA_COEF ?? 1.0);
const TP_PCT = Number(process.env.TP_PCT ?? 4.0);
const SL_PCT = Number(process.env.SL_PCT ?? 2.0);
const LEVERAGE = Number(process.env.LEVERAGE ?? 20);

const ORDER_PCT = Number(process.env.BT_ORDER_PCT ?? 10);
const PYRAMIDING = Number(process.env.BT_PYRAMIDING ?? 2);
const SLIPPAGE_TICKS = Number(process.env.BT_SLIPPAGE_TICKS ?? 2);

const INITIAL_CAPITAL = Number(process.env.INITIAL_CAPITAL ?? 3000);
const EQUITY_SPLIT = (process.env.EQUITY_SPLIT ?? "true") === "true";

const BINANCE_FUTURES = (process.env.BINANCE_FUTURES ?? "true") === "true";
const FEE_PER_SIDE_PCT = Number(process.env.BT_FEE_PER_SIDE_PCT ?? (BINANCE_FUTURES ? 0.04 : 0.10));
const FEE_ROUNDTRIP_PCT = FEE_PER_SIDE_PCT * 2;

const END_MS = process.env.BT_END ? new Date(process.env.BT_END).getTime() : Date.now();
const START_MS = process.env.BT_START
  ? new Date(process.env.BT_START).getTime()
  : END_MS - 365 * 24 * 60 * 60 * 1000;

const PARQUET_GLOB = process.env.BT_PARQUET_GLOB ?? "data/parquet/**/*.parquet";
const DUCKDB_FILE = process.env.BT_DUCKDB_FILE ?? "data/backtest.duckdb";
const CHUNK_SIZE = Number(process.env.BT_CHUNK_SIZE ?? 50000);
const MAX_CHUNKS = Number(process.env.BT_MAX_CHUNKS ?? 5000);

// Optional SQL prelude for remote reads (for example: INSTALL httpfs; LOAD httpfs; ...)
const DUCKDB_INIT_SQL = process.env.BT_DUCKDB_INIT_SQL ?? "";

type Tick = { tsMs: number; price: number; amount: number; tradeId: number };
type Side = "long" | "short";

type Trade = {
  symbol: string;
  side: Side;
  entries: number;
  entryTs: string;
  entryPrice: number;
  exitTs: string;
  exitPrice: number;
  reason: "tp" | "sl" | "eod";
  qty: number;
  pnl: number;
  pnlPct: number;
};

function sma(series: number[], len: number) {
  const out = new Array(series.length).fill(Number.NaN);
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i];
    if (i >= len) sum -= series[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

function crossedOver(prevA: number, prevB: number, curA: number, curB: number) {
  return prevA <= prevB && curA > curB;
}

function crossedUnder(prevA: number, prevB: number, curA: number, curB: number) {
  return prevA >= prevB && curA < curB;
}

function floorToTf(ms: number, tfMinutes: number) {
  const unit = tfMinutes * 60_000;
  return Math.floor(ms / unit) * unit;
}

function applySlippage(price: number, side: Side, isEntry: boolean, tickSize: number) {
  const slip = SLIPPAGE_TICKS * tickSize;
  if (isEntry) return side === "long" ? price + slip : price - slip;
  return side === "long" ? price - slip : price + slip;
}

function computeQtyTv(equity: number, price: number) {
  const notional = equity * (ORDER_PCT / 100) * LEVERAGE;
  return notional / price;
}

async function getTickSize(ex: any, symbol: string): Promise<number> {
  await ex.loadMarkets();
  const m = ex.market(symbol);
  try {
    const filters = m?.info?.filters;
    if (Array.isArray(filters)) {
      const pf = filters.find((x: any) => x?.filterType === "PRICE_FILTER");
      const ts = Number(pf?.tickSize);
      if (Number.isFinite(ts) && ts > 0) return ts;
    }
  } catch {
    // ignore
  }

  const p = m?.precision?.price;
  if (typeof p === "number" && Number.isFinite(p)) return 1 / Math.pow(10, p);
  return 0.01;
}

function csvToTicks(csv: string): Tick[] {
  if (!csv.trim()) return [];

  const rows = csv.split(/\r?\n/).filter(Boolean);
  const out: Tick[] = [];

  for (const row of rows) {
    const p = row.split(",");
    if (p.length < 4) continue;

    const tsMs = Number(p[0]);
    const price = Number(p[1]);
    const amount = Number(p[2]);
    const tradeId = Number(p[3]);

    if (!Number.isFinite(tsMs) || !Number.isFinite(price) || !Number.isFinite(amount) || !Number.isFinite(tradeId)) {
      continue;
    }

    out.push({ tsMs, price, amount, tradeId });
  }

  return out;
}

function fetchTickChunk(symbol: string, cursorTsMs: number, cursorTradeId: number) {
  const whereCursor =
    cursorTsMs <= 0
      ? ""
      : `AND (ts_ms > ${cursorTsMs} OR (ts_ms = ${cursorTsMs} AND trade_id > ${cursorTradeId}))`;

  const sql = `
    ${DUCKDB_INIT_SQL}
    COPY (
      SELECT
        ts_ms,
        price,
        qty,
        trade_id
      FROM (
        SELECT
          ts_ms,
          price,
          qty,
          TRY_CAST(exchange_trade_id AS BIGINT) AS trade_id
        FROM read_parquet(${sqlString(PARQUET_GLOB)}, hive_partitioning = 1)
        WHERE exchange = ${sqlString(EXCHANGE)}
          AND symbol = ${sqlString(symbol)}
          AND ts_ms >= ${START_MS}
          AND ts_ms <= ${END_MS}
      ) t
      WHERE trade_id IS NOT NULL
        ${whereCursor}
      ORDER BY ts_ms, trade_id
      LIMIT ${CHUNK_SIZE}
    ) TO STDOUT (FORMAT CSV, HEADER FALSE);
  `;

  const { stdout } = runDuckdbSql({ databasePath: DUCKDB_FILE, sql });
  return csvToTicks(stdout);
}

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

async function runSymbolChunked(symbol: string, tickSize: number, capital: number) {
  const trades: Trade[] = [];
  let equity = capital;
  let chunks = 0;
  let ticksProcessed = 0;

  let cursorTsMs = 0;
  let cursorTradeId = 0;

  let inPos = false;
  let side: Side = "long";
  let avgEntry = 0;
  let qty = 0;
  let entries = 0;
  let tp = 0;
  let sl = 0;
  let entryTs = "";
  let lastTick: Tick | null = null;

  const feeFracRoundtrip = FEE_ROUNDTRIP_PCT / 100;
  const tfMinutes = 30;
  let curBarStartMs: number | null = null;
  let curOpen = 0,
    curClose = 0,
    curVol = 0;

  let cvdAcc = 0;
  const cvdSeries: number[] = [];

  const recomputeTpSl = () => {
    tp = side === "long" ? avgEntry * (1 + TP_PCT / 100) : avgEntry * (1 - TP_PCT / 100);
    sl = side === "long" ? avgEntry * (1 - SL_PCT / 100) : avgEntry * (1 + SL_PCT / 100);
  };

  while (chunks < MAX_CHUNKS) {
    chunks += 1;
    const ticks = fetchTickChunk(symbol, cursorTsMs, cursorTradeId);
    if (ticks.length === 0) break;

    ticksProcessed += ticks.length;
    const last = ticks[ticks.length - 1];
    cursorTsMs = last.tsMs;
    cursorTradeId = last.tradeId;

    for (const t of ticks) {
      lastTick = t;
      const barStartMs = floorToTf(t.tsMs, tfMinutes);

      if (curBarStartMs === null || barStartMs !== curBarStartMs) {
        if (curBarStartMs !== null) {
          const delta = (curClose - curOpen) * curVol * DELTA_COEF;
          cvdAcc += delta;
          cvdSeries.push(cvdAcc);
        }

        curBarStartMs = barStartMs;
        curOpen = t.price;
        curClose = t.price;
        curVol = t.amount;
      } else {
        curClose = t.price;
        curVol += t.amount;
      }

      if (inPos) {
        const hitTp = side === "long" ? t.price >= tp : t.price <= tp;
        const hitSl = side === "long" ? t.price <= sl : t.price >= sl;

        if (hitSl || hitTp) {
          const reason: "sl" | "tp" = hitSl ? "sl" : "tp";
          const rawExit = reason === "sl" ? sl : tp;
          const exitPrice = applySlippage(rawExit, side, false, tickSize);

          const pnlRaw = side === "long" ? (exitPrice - avgEntry) * qty : (avgEntry - exitPrice) * qty;
          const fee = avgEntry * qty * feeFracRoundtrip;
          const pnl = pnlRaw - fee;
          equity += pnl;

          trades.push({
            symbol,
            side,
            entries,
            entryTs,
            entryPrice: avgEntry,
            exitTs: new Date(t.tsMs).toISOString(),
            exitPrice,
            reason,
            qty,
            pnl,
            pnlPct: (pnlRaw / (avgEntry * qty)) * 100 - FEE_ROUNDTRIP_PCT,
          });

          inPos = false;
          qty = 0;
          avgEntry = 0;
          entries = 0;
          tp = 0;
          sl = 0;
          entryTs = "";
          continue;
        }
      }

      if (cvdSeries.length < CVD_LEN + 2) continue;

      const curDelta = (curClose - curOpen) * curVol * DELTA_COEF;
      const curCvd = cvdAcc + curDelta;

      const tmpSeries = cvdSeries.slice();
      tmpSeries.push(curCvd);
      const tmpMa = sma(tmpSeries, CVD_LEN);

      const prevIdx = tmpSeries.length - 2;
      const curIdx = tmpSeries.length - 1;
      if (!Number.isFinite(tmpMa[prevIdx]) || !Number.isFinite(tmpMa[curIdx])) continue;

      const longCond = crossedOver(tmpSeries[prevIdx], tmpMa[prevIdx], tmpSeries[curIdx], tmpMa[curIdx]);
      const shortCond = crossedUnder(tmpSeries[prevIdx], tmpMa[prevIdx], tmpSeries[curIdx], tmpMa[curIdx]);
      if (!(longCond || shortCond)) continue;

      const sigSide: Side = longCond ? "long" : "short";

      if (!inPos) {
        side = sigSide;
        const entryPrice = applySlippage(t.price, side, true, tickSize);
        const q = computeQtyTv(equity, entryPrice);

        inPos = true;
        entryTs = new Date(t.tsMs).toISOString();
        avgEntry = entryPrice;
        qty = q;
        entries = 1;
        recomputeTpSl();
      } else {
        if (sigSide !== side) continue;
        if (entries >= PYRAMIDING) continue;

        const entryPrice = applySlippage(t.price, side, true, tickSize);
        const addQty = computeQtyTv(equity, entryPrice);

        const newQty = qty + addQty;
        avgEntry = (avgEntry * qty + entryPrice * addQty) / newQty;
        qty = newQty;
        entries += 1;
        recomputeTpSl();
      }
    }
  }

  if (inPos && lastTick) {
    const exitPrice = applySlippage(lastTick.price, side, false, tickSize);
    const pnlRaw = side === "long" ? (exitPrice - avgEntry) * qty : (avgEntry - exitPrice) * qty;
    const fee = avgEntry * qty * feeFracRoundtrip;
    const pnl = pnlRaw - fee;
    equity += pnl;

    trades.push({
      symbol,
      side,
      entries,
      entryTs,
      entryPrice: avgEntry,
      exitTs: new Date(lastTick.tsMs).toISOString(),
      exitPrice,
      reason: "eod",
      qty,
      pnl,
      pnlPct: (pnlRaw / (avgEntry * qty)) * 100 - FEE_ROUNDTRIP_PCT,
    });
  }

  return {
    symbol,
    trades,
    endEquity: equity,
    ticksProcessed,
    chunks,
  };
}

async function main() {
  console.log("[backtest-tv-parquet] start", {
    exchange: EXCHANGE,
    symbols: SYMBOLS,
    parquetGlob: PARQUET_GLOB,
    window: `${new Date(START_MS).toISOString()} -> ${new Date(END_MS).toISOString()}`,
    chunkSize: CHUNK_SIZE,
    maxChunks: MAX_CHUNKS,
    futures: BINANCE_FUTURES,
  });

  const ex: any = new ccxt.binance({
    enableRateLimit: true,
    options: { defaultType: BINANCE_FUTURES ? "future" : "spot" },
  });
  await ex.loadMarkets();

  const perSymbolCapital = EQUITY_SPLIT ? INITIAL_CAPITAL / SYMBOLS.length : INITIAL_CAPITAL;

  let combinedEnd = EQUITY_SPLIT ? 0 : INITIAL_CAPITAL;
  const allTrades: Trade[] = [];

  for (const symbol of SYMBOLS) {
    const apiSymbol = toBinanceSymbol(symbol, BINANCE_FUTURES);
    const tickSize = await getTickSize(ex, apiSymbol);

    const res = await runSymbolChunked(symbol, tickSize, perSymbolCapital);
    allTrades.push(...res.trades);

    if (EQUITY_SPLIT) combinedEnd += res.endEquity;
    else combinedEnd = res.endEquity;

    console.log(
      `[backtest-tv-parquet] ${symbol} ticks=${res.ticksProcessed} chunks=${res.chunks} trades=${res.trades.length} endEquity=${res.endEquity.toFixed(2)}`
    );
  }

  const totalReturnPct = ((combinedEnd - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  console.log("[backtest-tv-parquet] combined", {
    startEquity: INITIAL_CAPITAL,
    endEquity: Number(combinedEnd.toFixed(2)),
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    trades: allTrades.length,
  });

  const outPath = `backtest_tv_parquet_30m_${new Date().toISOString().slice(0, 10)}.csv`;
  fs.writeFileSync(outPath, toCsv(allTrades), "utf-8");
  console.log(`[backtest-tv-parquet] saved CSV -> ${outPath}`);
}

main().catch((e) => {
  console.error("[backtest-tv-parquet] fatal:", e?.message ?? e);
  process.exit(1);
});
