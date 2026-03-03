import "dotenv/config";
import fs from "fs";
import ccxt from "ccxt";
import { createClient } from "@supabase/supabase-js";

function must(k: string) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

const SUPABASE_URL = must("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = must("SUPABASE_SERVICE_ROLE_KEY");
const EXCHANGE = (process.env.EXCHANGE ?? "binance").toLowerCase();

const SYMBOLS = (process.env.SYMBOLS ?? "BTC/USDT").split(",").map(s => s.trim()).filter(Boolean);

// TV 설정 파라미터
const CVD_LEN = Number(process.env.CVD_LEN ?? 19);
const DELTA_COEF = Number(process.env.DELTA_COEF ?? 1.0);
const TP_PCT = Number(process.env.TP_PCT ?? 4.0);
const SL_PCT = Number(process.env.SL_PCT ?? 2.0);
const LEVERAGE = Number(process.env.LEVERAGE ?? 20);

// TV 전략 속성
const ORDER_PCT = Number(process.env.BT_ORDER_PCT ?? 10);     // 기본 주문 크기 10%
const PYRAMIDING = Number(process.env.BT_PYRAMIDING ?? 2);    // 피라미딩 2
const SLIPPAGE_TICKS = Number(process.env.BT_SLIPPAGE_TICKS ?? 2);

// Tick/Signal timeframe
const TICK_TF = process.env.BT_TICK_TIMEFRAME ?? "1m";        // 매틱 근사 (1m)
const SIGNAL_TF = process.env.BT_SIGNAL_TIMEFRAME ?? "30m";   // 신호 계산 기준 (30m)

// 자본
const INITIAL_CAPITAL = Number(process.env.INITIAL_CAPITAL ?? 3000);
const EQUITY_SPLIT = (process.env.EQUITY_SPLIT ?? "true") === "true";

// 수수료: 바이낸스 기본 taker 가정
const BINANCE_FUTURES = (process.env.BINANCE_FUTURES ?? "true") === "true";
const FEE_PER_SIDE_PCT = BINANCE_FUTURES ? 0.04 : 0.10; // futures taker 0.04%, spot taker 0.10%
const FEE_ROUNDTRIP_PCT = FEE_PER_SIDE_PCT * 2;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }});

// 1년
const END_MS = Date.now();
const START_MS = END_MS - 365 * 24 * 60 * 60 * 1000;
const START_ISO = new Date(START_MS).toISOString();
const END_ISO = new Date(END_MS).toISOString();

type Candle = { ts: string; open: number; high: number; low: number; close: number; volume: number; };

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

// 슬리피지(불리하게)
function applySlippage(price: number, side: "long"|"short", isEntry: boolean, tickSize: number) {
  const slip = SLIPPAGE_TICKS * tickSize;
  if (isEntry) return side === "long" ? price + slip : price - slip;
  return side === "long" ? price - slip : price + slip;
}

// 페이징 fetch
async function fetchCandles(symbol: string, timeframe: string): Promise<Candle[]> {
  const pageSize = 5000;
  let from = 0;
  const all: Candle[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("candles")
      .select("ts, open, high, low, close, volume")
      .eq("exchange", EXCHANGE)
      .eq("symbol", symbol)
      .eq("timeframe", timeframe)
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

// tick size
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
  } catch {}
  const p = m?.precision?.price;
  if (typeof p === "number" && Number.isFinite(p)) return 1 / Math.pow(10, p);
  return 0.01;
}

// 30m bar builder (from 1m ticks)
function floorToTf(ms: number, tfMinutes: number) {
  const unit = tfMinutes * 60_000;
  return Math.floor(ms / unit) * unit;
}

type Trade = {
  symbol: string; side: "long"|"short";
  entryTs: string; entryPrice: number;
  exitTs: string; exitPrice: number;
  reason: "tp"|"sl"|"eod";
  qty: number; pnl: number; pnlPct: number;
  entries: number;
};

function computeQtyTv(equity: number, price: number) {
  // TV "기본 주문 크기 10% + 레버리지(시뮬) 20"을 최대한 비슷하게:
  const notional = equity * (ORDER_PCT / 100) * LEVERAGE;
  return notional / price;
}

function backtestTvLike(symbol: string, ticks1m: Candle[], tickSize: number, capital: number) {
  const trades: Trade[] = [];
  let equity = capital;

  // 포지션(평단/총수량/엔트리횟수)
  let inPos = false;
  let side: "long"|"short" = "long";
  let avgEntry = 0;
  let qty = 0;
  let entries = 0;
  let tp = 0;
  let sl = 0;
  let entryTs = "";

  const feeFracRoundtrip = FEE_ROUNDTRIP_PCT / 100;

  // 30m 진행바 생성용
  const tfMinutes = 30;
  let curBarStartMs: number | null = null;
  let curOpen = 0, curHigh = -Infinity, curLow = Infinity, curClose = 0, curVol = 0;

  // CVD는 30m 바 기준으로 누적(진행 중 바도 tick마다 업데이트)
  let cvdAcc = 0;
  const cvdSeries: number[] = [];   // completed bars CVD
  const cvdMaSeries: number[] = []; // completed bars CVD MA

  function recomputeTpSl() {
    tp = side === "long" ? avgEntry * (1 + TP_PCT/100) : avgEntry * (1 - TP_PCT/100);
    sl = side === "long" ? avgEntry * (1 - SL_PCT/100) : avgEntry * (1 + SL_PCT/100);
  }

  // “매 틱마다” 근사: 1m마다 현재 진행 중 30m바의 (open/high/low/close/vol)을 업데이트하고,
  // 그 상태로 delta/CVD를 계산해 crossover를 평가한다.
  for (let i = 0; i < ticks1m.length; i++) {
    const t = ticks1m[i];
    const tMs = new Date(t.ts).getTime();
    const barStartMs = floorToTf(tMs, tfMinutes);

    // 새 30m 바 시작 처리
    if (curBarStartMs === null || barStartMs !== curBarStartMs) {
      // 이전 진행바를 "완성바"로 확정
      if (curBarStartMs !== null) {
        const delta = (curClose - curOpen) * curVol * DELTA_COEF;
        cvdAcc += delta;
        cvdSeries.push(cvdAcc);

        // SMA 갱신
        const maArr = sma(cvdSeries, CVD_LEN);
        cvdMaSeries.length = 0;
        cvdMaSeries.push(...maArr);
      }

      // 새 바 초기화
      curBarStartMs = barStartMs;
      curOpen = t.open;
      curHigh = t.high;
      curLow = t.low;
      curClose = t.close;
      curVol = t.volume;
    } else {
      // 진행바 업데이트
      curHigh = Math.max(curHigh, t.high);
      curLow = Math.min(curLow, t.low);
      curClose = t.close;
      curVol += t.volume;
    }

    // ---- (1) 포지션이면 TP/SL 체크: 1m high/low로 근사 ----
    if (inPos) {
      const hitTp = side === "long" ? t.high >= tp : t.low <= tp;
      const hitSl = side === "long" ? t.low <= sl : t.high >= sl;

      // TV처럼 tick 기반이면 “어느 게 먼저”가 중요한데,
      // 1m OHLC로는 순서를 모름 → 보수적으로 SL 우선(원하면 TP 우선으로 바꿀 수 있음)
      if (hitSl || hitTp) {
        const reason: "sl"|"tp" = hitSl ? "sl" : "tp";
        const rawExit = reason === "sl" ? sl : tp;
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
          exitTs: t.ts,
          exitPrice,
          reason,
          qty,
          pnl,
          pnlPct: (pnlRaw / (avgEntry * qty)) * 100 - FEE_ROUNDTRIP_PCT,
          entries,
        });

        inPos = false; qty = 0; avgEntry = 0; entries = 0; tp = 0; sl = 0; entryTs = "";
        continue;
      }
    }

    // ---- (2) 신호 평가: completed bars + current forming bar CVD를 조합 ----
    // completed bar 개수가 충분해야 MA가 의미 있음
    const completedCount = cvdSeries.length;
    if (completedCount < CVD_LEN + 2) continue;

    // "현재 진행 중 30m 바"의 delta를 tick마다 계산해서, 임시 CVD를 만든다
    const curDelta = (curClose - curOpen) * curVol * DELTA_COEF;
    const curCvd = cvdAcc + curDelta;

    // MA도 "마지막 CVD값을 current CVD로 대체한 것"으로 근사
    // (정확한 tick SMA는 더 복잡하지만 TV 근사엔 충분히 가까워짐)
    const tmpSeries = cvdSeries.slice();
    tmpSeries.push(curCvd);
    const tmpMa = sma(tmpSeries, CVD_LEN);

    const prevIdx = tmpSeries.length - 2;
    const curIdx = tmpSeries.length - 1;

    if (!Number.isFinite(tmpMa[prevIdx]) || !Number.isFinite(tmpMa[curIdx])) continue;

    const longCond = crossedOver(tmpSeries[prevIdx], tmpMa[prevIdx], tmpSeries[curIdx], tmpMa[curIdx]);
    const shortCond = crossedUnder(tmpSeries[prevIdx], tmpMa[prevIdx], tmpSeries[curIdx], tmpMa[curIdx]);

    if (!(longCond || shortCond)) continue;

    const sigSide: "long"|"short" = longCond ? "long" : "short";

    // ---- (3) 진입/피라미딩 ----
    if (!inPos) {
      side = sigSide;
      const rawEntry = t.close; // tick(1m close)에서 체결 근사 (TV 매틱 느낌)
      const entryPrice = applySlippage(rawEntry, side, true, tickSize);

      const q = computeQtyTv(equity, entryPrice);

      inPos = true;
      entryTs = t.ts;
      avgEntry = entryPrice;
      qty = q;
      entries = 1;
      recomputeTpSl();
    } else {
      // 이미 포지션 있는데 같은 방향이면 pyramiding 허용
      if (sigSide !== side) continue;
      if (entries >= PYRAMIDING) continue;

      const rawEntry = t.close;
      const entryPrice = applySlippage(rawEntry, side, true, tickSize);
      const addQty = computeQtyTv(equity, entryPrice);

      const newQty = qty + addQty;
      avgEntry = (avgEntry * qty + entryPrice * addQty) / newQty;
      qty = newQty;
      entries += 1;
      recomputeTpSl();
    }
  }

  // EOD 청산
  if (inPos) {
    const last = ticks1m[ticks1m.length - 1];
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

  return { trades, endEquity: equity };
}

function toCsv(trades: Trade[]) {
  const header = ["symbol","side","entries","entryTs","entryPrice","exitTs","exitPrice","reason","qty","pnl","pnlPct"].join(",");
  const lines = trades.map(t => [t.symbol,t.side,t.entries,t.entryTs,t.entryPrice,t.exitTs,t.exitPrice,t.reason,t.qty,t.pnl,t.pnlPct].join(","));
  return [header, ...lines].join("\n");
}

async function main() {
  console.log("[backtest-tv] start", {
    tickTf: TICK_TF, signalTf: SIGNAL_TF,
    orderPct: ORDER_PCT, pyramiding: PYRAMIDING, slippageTicks: SLIPPAGE_TICKS,
    feePerSidePct: FEE_PER_SIDE_PCT, futures: BINANCE_FUTURES
  });

  if (TICK_TF !== "1m" || SIGNAL_TF !== "30m") {
    console.log("[backtest-tv] note: this script is tuned for tick=1m, signal=30m");
  }

  const ex: any = new ccxt.binance({ enableRateLimit: true });
  await ex.loadMarkets();

  const perSymbolCapital = EQUITY_SPLIT ? INITIAL_CAPITAL / SYMBOLS.length : INITIAL_CAPITAL;

  let combinedEnd = EQUITY_SPLIT ? 0 : INITIAL_CAPITAL;
  const allTrades: Trade[] = [];

  for (const symbol of SYMBOLS) {
    const tickSize = await getTickSize(ex, symbol);
    const ticks = await fetchCandles(symbol, TICK_TF);

    console.log(`[backtest-tv] ${symbol} ticks(${TICK_TF})=${ticks.length} tickSize=${tickSize}`);

    const { trades, endEquity } = backtestTvLike(symbol, ticks, tickSize, perSymbolCapital);
    allTrades.push(...trades);

    if (EQUITY_SPLIT) combinedEnd += endEquity;
    else combinedEnd = endEquity;

    console.log(`[backtest-tv] ${symbol} endEquity=${endEquity.toFixed(2)} trades=${trades.length}`);
  }

  const totalReturnPct = ((combinedEnd - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  console.log("\n[backtest-tv] combined result", {
    startEquity: INITIAL_CAPITAL,
    endEquity: Number(combinedEnd.toFixed(2)),
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    trades: allTrades.length,
  });

  const outPath = `backtest_tv_like_${SIGNAL_TF}_tick_${TICK_TF}_${new Date().toISOString().slice(0,10)}.csv`;
  fs.writeFileSync(outPath, toCsv(allTrades), "utf-8");
  console.log(`[backtest-tv] saved CSV -> ${outPath}`);
}

main().catch((e) => {
  console.error("[backtest-tv] fatal:", e?.message ?? e);
  process.exit(1);
});
