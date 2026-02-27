import { config } from "../config";
import { fetchLatestCandleTs, fetchRecentCandles } from "../supabase/candles";
import { getLastProcessedTs, setLastProcessedTs } from "../supabase/botState";
import { computeCVDSeries, sma } from "../strategy/cvd";
import { crossedOver, crossedUnder } from "../strategy/signals";
import { sizeByExposure } from "../strategy/sizing";
import { placeEntryWithTpSl } from "../exchange/orders";
import { hasOpenPosition } from "../exchange/position";

async function runSymbolOnce(symbol: string) {
  const latestTs = await fetchLatestCandleTs(symbol);
  if (!latestTs) return;

  const lastTs = await getLastProcessedTs(symbol);
  if (lastTs && latestTs <= lastTs) return; // 새 봉 없음

  const candles = await fetchRecentCandles(symbol, config.candleLookback);
  if (candles.length < config.cvdLen + 2) return;

  const cvd = computeCVDSeries(candles, config.deltaCoef);
  const cvdMa = sma(cvd, config.cvdLen);

  const i = candles.length - 1;
  const prev = i - 1;

  const longCond =
    Number.isFinite(cvdMa[prev]) &&
    crossedOver(cvd[prev], cvdMa[prev], cvd[i], cvdMa[i]);

  const shortCond =
    Number.isFinite(cvdMa[prev]) &&
    crossedUnder(cvd[prev], cvdMa[prev], cvd[i], cvdMa[i]);

  const price = candles[i].close;
  const equity = config.initialCapital; // (추후 거래소 잔고로 대체 가능)

  // ✅ 중복 진입 방지: 포지션 있으면 스킵
  if ((longCond || shortCond) && (await hasOpenPosition(symbol))) {
    console.log(`[bot] ${symbol} signal but position already open → skip`);
    await setLastProcessedTs(symbol, latestTs);
    return;
  }

  const { qty } = sizeByExposure({
    equity,
    riskPct: config.riskPct,
    leverage: config.leverage,
    price,
  });

  if (longCond || shortCond) {
    const side = longCond ? "long" : "short";
    const tpPrice = longCond
      ? price * (1 + config.tpPct / 100)
      : price * (1 - config.tpPct / 100);
    const slPrice = longCond
      ? price * (1 - config.slPct / 100)
      : price * (1 + config.slPct / 100);

    console.log(`[bot] ${symbol} ${side} signal @${price} qty=${qty} dryRun=${config.dryRun}`);

    await placeEntryWithTpSl({
  symbol,
  side,
  qty,
  entryPrice: price,
  tpPrice,
  slPrice,
});

  await setLastProcessedTs(symbol, latestTs);
}

export async function runOnce() {
  for (const symbol of config.symbols) {
    try {
      await runSymbolOnce(symbol);
    } catch (e: any) {
      console.error(`[bot] ${symbol} error:`, e?.message ?? e);
    }
    // 레이트리밋 완화
    await new Promise((r) => setTimeout(r, 250));
  }
}
