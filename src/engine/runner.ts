import { config } from "../config";
import { fetchLatestCandleTs, fetchRecentCandles } from "../supabase/candles";
import { getLastProcessedTs, setLastProcessedTs } from "../supabase/botState";
import { computeCVDSeries, sma } from "../strategy/cvd";
import { crossedOver, crossedUnder } from "../strategy/signals";
import { sizeByExposure } from "../strategy/sizing";
import { placeEntryWithTpSl } from "../exchange/orders";

export async function runOnce() {
  const latestTs = await fetchLatestCandleTs();
  if (!latestTs) return;

  const lastTs = await getLastProcessedTs();
  if (lastTs && latestTs <= lastTs) return; // nothing new

  const candles = await fetchRecentCandles(config.candleLookback);
  if (candles.length < config.cvdLen + 2) return;

  const cvd = computeCVDSeries(candles, config.deltaCoef);
  const cvdMa = sma(cvd, config.cvdLen);

  const i = candles.length - 1; // latest candle
  const prev = i - 1;

  // 봉 마감 기준 신호
  const longCond =
    Number.isFinite(cvdMa[prev]) &&
    crossedOver(cvd[prev], cvdMa[prev], cvd[i], cvdMa[i]);

  const shortCond =
    Number.isFinite(cvdMa[prev]) &&
    crossedUnder(cvd[prev], cvdMa[prev], cvd[i], cvdMa[i]);

  const price = candles[i].close;

  // equity는 일단 config에서 “가상 equity”로 시작하거나,
  // 선물 계정 잔고를 조회해서 equity로 쓰도록 확장 가능.
  const equity = config.initialCapital;

  const { qty } = sizeByExposure({
    equity,
    riskPct: config.riskPct,
    leverage: config.leverage,
    price,
  });

  if (longCond || shortCond) {
    const side = longCond ? "long" : "short";
    const tpPrice = longCond ? price * (1 + config.tpPct / 100) : price * (1 - config.tpPct / 100);
    const slPrice = longCond ? price * (1 - config.slPct / 100) : price * (1 + config.slPct / 100);

    await placeEntryWithTpSl({
      side,
      qty,
      entryPrice: price,
      tpPrice,
      slPrice,
    });
  }

  // 최신 봉을 처리했다고 기록 (중복 실행 방지)
  await setLastProcessedTs(latestTs);
}
