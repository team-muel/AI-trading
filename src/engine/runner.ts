// src/engine/runner.ts
import { config } from "../config";
import { fetchRecentCandles } from "../supabase/candles";
import { getLastProcessedTs, setLastProcessedTs } from "../supabase/botState";
import { computeCVDSeries, sma } from "../strategy/cvd";
import { crossedOver, crossedUnder } from "../strategy/signals";
import { sizeByExposure } from "../strategy/sizing";
import { placeEntryWithTpSl } from "../exchange/orders";
import { hasOpenPosition } from "../exchange/position";
import { fetchTradesSince } from "../exchange/trades";
import { insertTrade } from "../supabase/trades";

type TickBar = {
  startMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type SymbolRuntimeState = {
  cvdClosed: number[];
  cvdAccClosed: number;
  currentBar: TickBar | null;
  lastProcessedTradeMs: number;
  lastSignalKey?: string;
};

const runtime = new Map<string, SymbolRuntimeState>();

function timeframeToMs(tf: string): number {
  const m = tf.match(/^(\d+)([mhdw])$/i);
  if (!m) throw new Error(`Unsupported timeframe: ${tf}`);

  const n = Number(m[1]);
  const u = m[2].toLowerCase();

  const unitMs =
    u === "m"
      ? 60_000
      : u === "h"
      ? 3_600_000
      : u === "d"
      ? 86_400_000
      : u === "w"
      ? 604_800_000
      : 0;

  return n * unitMs;
}

function floorToTf(ms: number, tfMs: number) {
  return Math.floor(ms / tfMs) * tfMs;
}

function buildSignalFromState(state: SymbolRuntimeState) {
  if (!state.currentBar) return { longCond: false, shortCond: false };

  const curDelta =
    (state.currentBar.close - state.currentBar.open) *
    state.currentBar.volume *
    config.deltaCoef;
  const curCvd = state.cvdAccClosed + curDelta;

  const series = [...state.cvdClosed, curCvd];
  if (series.length < config.cvdLen + 2) {
    return { longCond: false, shortCond: false };
  }

  const ma = sma(series, config.cvdLen);
  const i = series.length - 1;
  const prev = i - 1;

  if (!Number.isFinite(ma[prev]) || !Number.isFinite(ma[i])) {
    return { longCond: false, shortCond: false };
  }

  const longCond = crossedOver(series[prev], ma[prev], series[i], ma[i]);
  const shortCond = crossedUnder(series[prev], ma[prev], series[i], ma[i]);

  return { longCond, shortCond };
}

function finalizeCurrentBar(state: SymbolRuntimeState) {
  if (!state.currentBar) return;

  const delta =
    (state.currentBar.close - state.currentBar.open) *
    state.currentBar.volume *
    config.deltaCoef;

  state.cvdAccClosed += delta;
  state.cvdClosed.push(state.cvdAccClosed);

  if (state.cvdClosed.length > config.candleLookback) {
    state.cvdClosed.splice(0, state.cvdClosed.length - config.candleLookback);
  }
}

function newBarFromTick(tsMs: number, price: number, amount: number, tfMs: number): TickBar {
  return {
    startMs: floorToTf(tsMs, tfMs),
    open: price,
    high: price,
    low: price,
    close: price,
    volume: amount,
  };
}

async function getOrInitState(symbol: string, tfMs: number): Promise<SymbolRuntimeState | null> {
  const existing = runtime.get(symbol);
  if (existing) return existing;

  const candles = await fetchRecentCandles(symbol, config.candleLookback);
  if (candles.length < config.cvdLen + 2) {
    return null;
  }

  const cvdClosed = computeCVDSeries(candles, config.deltaCoef);
  const cvdAccClosed = cvdClosed[cvdClosed.length - 1] ?? 0;

  const lastTs = await getLastProcessedTs(symbol);
  const savedMs = lastTs ? new Date(lastTs).getTime() : Number.NaN;
  const nowBarStart = floorToTf(Date.now(), tfMs);

  const lastProcessedTradeMs = Number.isFinite(savedMs)
    ? Math.max(savedMs, nowBarStart - 1)
    : nowBarStart - 1;

  const state: SymbolRuntimeState = {
    cvdClosed,
    cvdAccClosed,
    currentBar: null,
    lastProcessedTradeMs,
  };

  runtime.set(symbol, state);
  return state;
}

async function runSymbolOnce(symbol: string, tfMs: number) {
  const state = await getOrInitState(symbol, tfMs);
  if (!state) return;

  const tickFetchLimit = Number(process.env.TICK_FETCH_LIMIT ?? 1000);
  const tickMaxPages = Number(process.env.TICK_MAX_PAGES ?? 3);

  const ticks = await fetchTradesSince({
    symbol,
    sinceMs: state.lastProcessedTradeMs + 1,
    futures: config.binanceFutures,
    limit: tickFetchLimit,
    maxPages: tickMaxPages,
  });

  if (ticks.length === 0) return;

  let openPos = await hasOpenPosition(symbol);

  for (const t of ticks) {
    if (!state.currentBar) {
      state.currentBar = newBarFromTick(t.tsMs, t.price, t.amount, tfMs);
    } else {
      const startMs = floorToTf(t.tsMs, tfMs);
      if (startMs !== state.currentBar.startMs) {
        finalizeCurrentBar(state);
        state.currentBar = newBarFromTick(t.tsMs, t.price, t.amount, tfMs);
        state.lastSignalKey = undefined;
      } else {
        state.currentBar.high = Math.max(state.currentBar.high, t.price);
        state.currentBar.low = Math.min(state.currentBar.low, t.price);
        state.currentBar.close = t.price;
        state.currentBar.volume += t.amount;
      }
    }

    const { longCond, shortCond } = buildSignalFromState(state);
    if (!(longCond || shortCond)) {
      state.lastProcessedTradeMs = t.tsMs;
      continue;
    }

    const side = longCond ? "long" : "short";
    const signalKey = `${state.currentBar.startMs}:${side}`;
    if (state.lastSignalKey === signalKey) {
      state.lastProcessedTradeMs = t.tsMs;
      continue;
    }
    state.lastSignalKey = signalKey;

    // Refresh position state at signal time to avoid stale openPos decisions.
    openPos = await hasOpenPosition(symbol);

    if (openPos) {
      console.log(`[bot] ${symbol} ${side} signal but position already open -> skip`);
      state.lastProcessedTradeMs = t.tsMs;
      continue;
    }

    const equityBase = config.equitySplit
      ? config.initialCapital / config.symbols.length
      : config.initialCapital;

    const { qty } = sizeByExposure({
      equity: equityBase,
      riskPct: config.riskPct,
      leverage: config.leverage,
      price: t.price,
    });

    const tpPrice = longCond
      ? t.price * (1 + config.tpPct / 100)
      : t.price * (1 - config.tpPct / 100);
    const slPrice = longCond
      ? t.price * (1 - config.slPct / 100)
      : t.price * (1 + config.slPct / 100);

    const entryTs = new Date(t.tsMs).toISOString();

    await insertTrade({
      symbol,
      side,
      entryTs,
      entryPrice: t.price,
      qty,
      tpPrice,
      slPrice,
      status: "open",
      meta: {
        kind: "signal",
        dryRun: config.dryRun,
        source: "tick-formed-bar",
        params: {
          timeframe: config.timeframe,
          cvdLen: config.cvdLen,
          deltaCoef: config.deltaCoef,
          tpPct: config.tpPct,
          slPct: config.slPct,
          leverage: config.leverage,
          equitySplit: config.equitySplit,
        },
      },
    });

    try {
      const res = await placeEntryWithTpSl({
        symbol,
        side,
        qty,
        entryPrice: t.price,
        tpPrice,
        slPrice,
      });

      if (!res?.dryRun) {
        openPos = true;

        const orderIds = {
          entryId: res?.entry?.id ?? null,
          tpId: res?.tp?.id ?? null,
          slId: res?.sl?.id ?? null,
          ocoId: (res as any)?.oco?.orderListId ?? null,
        };

        await insertTrade({
          symbol,
          side,
          entryTs,
          entryPrice: t.price,
          qty,
          tpPrice,
          slPrice,
          status: "open",
          orderIds,
          meta: {
            kind: "order_placed",
            dryRun: false,
            source: "tick-formed-bar",
          },
        });
      }
    } catch (e: any) {
      await insertTrade({
        symbol,
        side,
        entryTs,
        entryPrice: t.price,
        qty,
        tpPrice,
        slPrice,
        status: "error",
        meta: {
          kind: "order_failed",
          dryRun: config.dryRun,
          source: "tick-formed-bar",
          error: e?.message ?? String(e),
        },
      });

      console.error(`[bot] ${symbol} order error:`, e?.message ?? e);
    }

    state.lastProcessedTradeMs = t.tsMs;
  }

  await setLastProcessedTs(symbol, new Date(state.lastProcessedTradeMs).toISOString());
}

export async function runOnce() {
  const tfMs = timeframeToMs(config.timeframe);

  for (const symbol of config.symbols) {
    try {
      await runSymbolOnce(symbol, tfMs);
    } catch (e: any) {
      console.error(`[bot] ${symbol} error:`, e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
