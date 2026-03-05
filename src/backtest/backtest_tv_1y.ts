import "dotenv/config";
import fs from "fs";
import ccxt from "ccxt";
import { toBinanceSymbol } from "../exchange/symbol";

function must(k: string) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

const EXCHANGE = (process.env.EXCHANGE ?? "binance").toLowerCase();

const SYMBOLS = (process.env.SYMBOLS ?? "BTC/USDT").split(",").map(s => s.trim()).filter(Boolean);

// TV 설정 파라미터
const CVD_LEN = Number(process.env.CVD_LEN ?? 19);
const DELTA_COEF = Number(process.env.DELTA_COEF ?? 1.0);
const TP_PCT = Number(process.env.TP_PCT ?? 4.0);
const SL_PCT = Number(process.env.SL_PCT ?? 2.0);
const LEVERAGE = Number(process.env.LEVERAGE ?? 20);
const LONG_MARGIN_PCT = Number(process.env.BT_MARGIN_LONG_PCT ?? Number.NaN);
const SHORT_MARGIN_PCT = Number(process.env.BT_MARGIN_SHORT_PCT ?? Number.NaN);

// TV 전략 속성
const ORDER_PCT = Number(process.env.BT_ORDER_PCT ?? 10);     // 기본 주문 크기 10%
const PYRAMIDING = Number(process.env.BT_PYRAMIDING ?? 2);    // 피라미딩 2
const SLIPPAGE_TICKS = Number(process.env.BT_SLIPPAGE_TICKS ?? 2);

// Tick/Signal source/timeframe
const TICK_SOURCE = (process.env.BT_TICK_SOURCE ?? "binance_trade").toLowerCase();
const TICK_TF = process.env.BT_TICK_TIMEFRAME ?? "trade";     // trade = raw tick
const SIGNAL_TF = process.env.BT_SIGNAL_TIMEFRAME ?? "30m";   // 신호 계산 기준 (30m)
const TRADE_FETCH_LIMIT = Number(process.env.BT_TRADE_FETCH_LIMIT ?? 1000);
const TRADE_MAX_PAGES = Number(process.env.BT_TRADE_MAX_PAGES ?? 2000);
const LIMIT_VERIFY_TICKS = Number(process.env.BT_LIMIT_VERIFY_TICKS ?? 0);

// 자본
const INITIAL_CAPITAL = Number(process.env.INITIAL_CAPITAL ?? 3000);
const EQUITY_SPLIT = (process.env.EQUITY_SPLIT ?? "true") === "true";

// 수수료: 바이낸스 기본 taker 가정
const BINANCE_FUTURES = (process.env.BINANCE_FUTURES ?? "true") === "true";
const FEE_PER_SIDE_PCT = Number(
  process.env.BT_FEE_PER_SIDE_PCT ?? (BINANCE_FUTURES ? 0.04 : 0.10)
);
const FEE_ROUNDTRIP_PCT = FEE_PER_SIDE_PCT * 2;

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

// Binance trade ticks fetch (paged by since)
async function fetchTradeTicks(ex: any, symbol: string): Promise<Candle[]> {
  let since = START_MS;
  let pages = 0;
  const all: Candle[] = [];

  while (since <= END_MS && pages < TRADE_MAX_PAGES) {
    pages += 1;

    const trades = await ex.fetchTrades(symbol, since, TRADE_FETCH_LIMIT);
    if (!trades || trades.length === 0) break;

    const rows: Candle[] = trades
      .map((t: any) => {
        const tsMs = Number(t?.timestamp ?? 0);
        const price = Number(t?.price);
        const amount = Number(t?.amount ?? 0);

        if (!Number.isFinite(tsMs) || !Number.isFinite(price) || !Number.isFinite(amount)) {
          return null;
        }
        if (tsMs < START_MS || tsMs > END_MS) return null;

        return {
          ts: new Date(tsMs).toISOString(),
          open: price,
          high: price,
          low: price,
          close: price,
          volume: amount,
        };
      })
      .filter(Boolean) as Candle[];

    all.push(...rows);

    const lastTs = Number(trades[trades.length - 1]?.timestamp ?? 0);
    if (!Number.isFinite(lastTs) || lastTs <= 0) break;

    // since is inclusive on many exchanges; +1ms prevents duplicates.
    since = lastTs + 1;

    if (lastTs >= END_MS) break;

    // Light pacing to avoid rate-limit bursts on long windows.
    await new Promise((r) => setTimeout(r, 100));
  }

  if (pages >= TRADE_MAX_PAGES) {
    console.log(
      `[backtest-tv] ${symbol} reached BT_TRADE_MAX_PAGES=${TRADE_MAX_PAGES}, result may be truncated`
    );
  }

  all.sort((a, b) => a.ts.localeCompare(b.ts));
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

function leverageForSide(side: "long" | "short") {
  const marginPct = side === "long" ? LONG_MARGIN_PCT : SHORT_MARGIN_PCT;
  if (Number.isFinite(marginPct) && marginPct > 0) {
    // TradingView margin percent to leverage mapping: 100% => 1x, 5% => 20x
    return 100 / marginPct;
  }
  return LEVERAGE;
}

function computeQtyTv(equity: number, price: number, side: "long" | "short") {
  const effectiveLeverage = leverageForSide(side);
  const notional = equity * (ORDER_PCT / 100) * effectiveLeverage;
  return notional / price;
}

function backtestTvLike(symbol: string, ticks: Candle[], tickSize: number, capital: number) {
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

  // 매 틱마다 현재 진행 중 30m바의 (open/high/low/close/vol)을 업데이트하고,
  // 그 상태로 delta/CVD를 계산해 crossover를 평가한다.
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
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

    // ---- (1) 포지션이면 TP/SL 체크: tick price 기반 근사 ----
    if (inPos) {
      const hitTp = side === "long" ? t.high >= tp : t.low <= tp;
      const hitSl = side === "long" ? t.low <= sl : t.high >= sl;

      // 같은 timestamp 내 TP/SL 동시 충돌은 순서를 알 수 없어 보수적으로 SL 우선 처리
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
      const rawEntry = t.close;
      const entryPrice = applySlippage(rawEntry, side, true, tickSize);

      const q = computeQtyTv(equity, entryPrice, side);

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
      const addQty = computeQtyTv(equity, entryPrice, side);

      const newQty = qty + addQty;
      avgEntry = (avgEntry * qty + entryPrice * addQty) / newQty;
      qty = newQty;
      entries += 1;
      recomputeTpSl();
    }
  }

  // EOD 청산
  if (inPos) {
    const last = ticks[ticks.length - 1];
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
    tickSource: TICK_SOURCE,
    tickTf: TICK_TF,
    signalTf: SIGNAL_TF,
    orderPct: ORDER_PCT, pyramiding: PYRAMIDING, slippageTicks: SLIPPAGE_TICKS,
    feePerSidePct: FEE_PER_SIDE_PCT, futures: BINANCE_FUTURES,
    tradeFetchLimit: TRADE_FETCH_LIMIT,
    tradeMaxPages: TRADE_MAX_PAGES,
    longMarginPct: Number.isFinite(LONG_MARGIN_PCT) ? LONG_MARGIN_PCT : null,
    shortMarginPct: Number.isFinite(SHORT_MARGIN_PCT) ? SHORT_MARGIN_PCT : null,
    limitVerifyTicks: LIMIT_VERIFY_TICKS,
  });

  if (TICK_SOURCE !== "binance_trade") {
    throw new Error(`Unsupported BT_TICK_SOURCE: ${TICK_SOURCE}`);
  }

  if (TICK_TF !== "trade" || SIGNAL_TF !== "30m") {
    console.log("[backtest-tv] note: this script is tuned for tick=trade, signal=30m");
  }

  const ex: any = new ccxt.binance({
    enableRateLimit: true,
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_API_SECRET,
    options: {
      defaultType: BINANCE_FUTURES ? "future" : "spot",
    },
  });
  await ex.loadMarkets();

  const perSymbolCapital = EQUITY_SPLIT ? INITIAL_CAPITAL / SYMBOLS.length : INITIAL_CAPITAL;

  let combinedEnd = EQUITY_SPLIT ? 0 : INITIAL_CAPITAL;
  const allTrades: Trade[] = [];

  for (const symbol of SYMBOLS) {
    const apiSymbol = toBinanceSymbol(symbol, BINANCE_FUTURES);
    const tickSize = await getTickSize(ex, apiSymbol);
    const ticks = await fetchTradeTicks(ex, apiSymbol);

    console.log(`[backtest-tv] ${symbol} ticks(${TICK_SOURCE})=${ticks.length} tickSize=${tickSize}`);

    if (ticks.length === 0) {
      console.log(`[backtest-tv] ${symbol} no trades fetched in window ${START_ISO} -> ${END_ISO}`);
      continue;
    }

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

  const outPath = `backtest_tv_like_${SIGNAL_TF}_tick_trade_${new Date().toISOString().slice(0,10)}.csv`;
  fs.writeFileSync(outPath, toCsv(allTrades), "utf-8");
  console.log(`[backtest-tv] saved CSV -> ${outPath}`);
}

main().catch((e) => {
  console.error("[backtest-tv] fatal:", e?.message ?? e);
  process.exit(1);
});
