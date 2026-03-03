// src/engine/runner.ts
import { config } from "../config";
import { fetchLatestCandleTs, fetchRecentCandles } from "../supabase/candles";
import { getLastProcessedTs, setLastProcessedTs } from "../supabase/botState";
import { computeCVDSeries, sma } from "../strategy/cvd";
import { crossedOver, crossedUnder } from "../strategy/signals";
import { sizeByExposure } from "../strategy/sizing";
import { placeEntryWithTpSl } from "../exchange/orders";
import { hasOpenPosition } from "../exchange/position";
import { insertTrade } from "../supabase/trades";

async function runSymbolOnce(symbol: string) {
  const latestTs = await fetchLatestCandleTs(symbol);
  if (!latestTs) return;

  const lastTs = await getLastProcessedTs(symbol);
  if (lastTs && latestTs <= lastTs) return;

  const candles = await fetchRecentCandles(symbol, config.candleLookback);
  if (candles.length < config.cvdLen + 2) {
    await setLastProcessedTs(symbol, latestTs);
    return;
  }

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

  if (longCond || shortCond) {
    // 실주문에서만 의미 큰 중복 진입 방지
    if (await hasOpenPosition(symbol)) {
      console.log(`[bot] ${symbol} signal but position already open → skip`);
    } else {
      const equityBase = config.equitySplit
        ? config.initialCapital / config.symbols.length
        : config.initialCapital;

      const { qty } = sizeByExposure({
        equity: equityBase,
        riskPct: config.riskPct,
        leverage: config.leverage,
        price,
      });

      const side = longCond ? "long" : "short";
      const tpPrice = longCond
        ? price * (1 + config.tpPct / 100)
        : price * (1 - config.tpPct / 100);
      const slPrice = longCond
        ? price * (1 - config.slPct / 100)
        : price * (1 + config.slPct / 100);

      console.log(
        `[bot] ${symbol} ${side} signal @${price} qty=${qty} dryRun=${config.dryRun}`
      );

      // ✅ 1) 신호 기록(드라이런/실거래 모두) — 검증용
      await insertTrade({
        symbol,
        side,
        entryTs: latestTs,      // 신호가 확정된 "최신 봉 ts"
        entryPrice: price,
        qty,
        tpPrice,
        slPrice,
        status: "open",
        meta: {
          kind: "signal",
          dryRun: config.dryRun,
          params: {
            cvdLen: config.cvdLen,
            deltaCoef: config.deltaCoef,
            tpPct: config.tpPct,
            slPct: config.slPct,
            leverage: config.leverage,
            equitySplit: config.equitySplit,
          },
        },
      });

      // ✅ 2) 주문 실행(실거래일 때만 실제로 주문) + 주문 결과 기록
      try {
        const res = await placeEntryWithTpSl({
          symbol,
          side,
          qty,
          entryPrice: price,
          tpPrice,
          slPrice,
        });

        // 실거래면 주문ID 기록 row 추가
        if (!res?.dryRun) {
          const orderIds = {
            entryId: res?.entry?.id ?? null,
            tpId: res?.tp?.id ?? null,
            slId: res?.sl?.id ?? null,
          };

          await insertTrade({
            symbol,
            side,
            entryTs: latestTs,
            entryPrice: price,
            qty,
            tpPrice,
            slPrice,
            status: "open",
            orderIds,
            meta: {
              kind: "order_placed",
              dryRun: false,
            },
          });
        }
      } catch (e: any) {
        // 주문 실패 기록
        await insertTrade({
          symbol,
          side,
          entryTs: latestTs,
          entryPrice: price,
          qty,
          tpPrice,
          slPrice,
          status: "error",
          meta: {
            kind: "order_failed",
            dryRun: config.dryRun,
            error: e?.message ?? String(e),
          },
        });

        console.error(`[bot] ${symbol} order error:`, e?.message ?? e);
      }
    }
  }

  // ✅ 신호가 있든 없든 최신 봉 처리 완료로 기록
  await setLastProcessedTs(symbol, latestTs);
}

export async function runOnce() {
  for (const symbol of config.symbols) {
    try {
      await runSymbolOnce(symbol);
    } catch (e: any) {
      console.error(`[bot] ${symbol} error:`, e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
