import { config } from "../config";
import { placeEntryWithTpSl } from "../exchange/orders";
import { hasOpenPosition } from "../exchange/position";
import { insertTrade } from "../supabase/trades";

type Side = "long" | "short";

type Bar = {
  startMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  buyVol: number;
  sellVol: number;
};

function floorToTf(ms: number, tfMin: number) {
  const unit = tfMin * 60_000;
  return Math.floor(ms / unit) * unit;
}

export class TickCvdEngine {
  private tfMin = Number(process.env.TICK_TIMEFRAME_MIN ?? 30);
  private len = Number(process.env.TICK_CVD_LEN ?? config.cvdLen);
  private deltaCoef = config.deltaCoef;

  private orderPct = Number(process.env.BT_ORDER_PCT ?? 10);
  private cooldownMs = Number(process.env.TICK_COOLDOWN_MS ?? 15000);

  private state: Record<
    string,
    {
      bar: Bar | null;
      cvdClosed: number; // 누적 델타(닫힌 봉들)
      cvdSeries: number[]; // 마지막 몇 개만
      lastSignalAt: number; // ms
    }
  > = {};

  constructor() {
    for (const s of config.symbols) {
      this.state[s] = { bar: null, cvdClosed: 0, cvdSeries: [], lastSignalAt: 0 };
    }
  }

  private computeQty(price: number) {
    const equityBase = config.equitySplit
      ? config.initialCapital / config.symbols.length
      : config.initialCapital;

    const notional = equityBase * (this.orderPct / 100) * config.leverage;
    return notional / price;
  }

  private smaLast(series: number[], len: number): number | null {
    if (series.length < len) return null;
    const s = series.slice(-len).reduce((a, x) => a + x, 0);
    return s / len;
  }

  private crossedOver(prevA: number, prevB: number, curA: number, curB: number) {
    return prevA <= prevB && curA > curB;
  }
  private crossedUnder(prevA: number, prevB: number, curA: number, curB: number) {
    return prevA >= prevB && curA < curB;
  }

  private closePrevBar(sym: string) {
    const st = this.state[sym];
    if (!st.bar) return;

    const delta = (st.bar.buyVol - st.bar.sellVol) * this.deltaCoef;
    st.cvdClosed += delta;

    st.cvdSeries.push(st.cvdClosed);
    // 메모리 제한
    const keep = this.len + 5;
    if (st.cvdSeries.length > keep) st.cvdSeries.splice(0, st.cvdSeries.length - keep);
  }

  private startNewBar(sym: string, startMs: number, price: number, qty: number, isBuyAgg: boolean) {
    const st = this.state[sym];
    st.bar = {
      startMs,
      open: price,
      high: price,
      low: price,
      close: price,
      vol: qty,
      buyVol: isBuyAgg ? qty : 0,
      sellVol: isBuyAgg ? 0 : qty,
    };
  }

  private updateBar(sym: string, tradeTimeMs: number, price: number, qty: number, isBuyAgg: boolean) {
    const st = this.state[sym];
    const startMs = floorToTf(tradeTimeMs, this.tfMin);

    if (!st.bar || st.bar.startMs !== startMs) {
      if (st.bar) this.closePrevBar(sym);
      this.startNewBar(sym, startMs, price, qty, isBuyAgg);
      return;
    }

    const b = st.bar;
    b.high = Math.max(b.high, price);
    b.low = Math.min(b.low, price);
    b.close = price;
    b.vol += qty;
    if (isBuyAgg) b.buyVol += qty;
    else b.sellVol += qty;
  }

  async onAggTrade(symbol: string, tradeTimeMs: number, price: number, qty: number, buyerIsMaker: boolean) {
    const st = this.state[symbol];
    if (!st) return;

    const now = Date.now();
    // 폭주 방지(너무 자주 신호/주문 찍히는 것 방지)
    if (now - st.lastSignalAt < this.cooldownMs) {
      // 그래도 바 업데이트는 해야 함
    }

    // buyerIsMaker=true => sell aggressor
    const isBuyAgg = !buyerIsMaker;

    // 1) 진행 중 30m 봉 업데이트
    this.updateBar(symbol, tradeTimeMs, price, qty, isBuyAgg);

    if (!st.bar) return;

    // 2) “틱마다” 현재 CVD 계산(닫힌 봉 + 진행 봉 delta)
    if (st.cvdSeries.length < this.len + 2) return;

    const formingDelta = (st.bar.buyVol - st.bar.sellVol) * this.deltaCoef;
    const curCvd = st.cvdClosed + formingDelta;

    const prevCvd = st.cvdSeries[st.cvdSeries.length - 1];
    const prevMa = this.smaLast(st.cvdSeries, this.len);
    if (prevMa === null) return;

    // current MA는 "series + curCvd"로 근사
    const curSeries = st.cvdSeries.concat([curCvd]);
    const curMa = this.smaLast(curSeries, this.len);
    if (curMa === null) return;

    const longCond = this.crossedOver(prevCvd, prevMa, curCvd, curMa);
    const shortCond = this.crossedUnder(prevCvd, prevMa, curCvd, curMa);
    if (!(longCond || shortCond)) return;

    // 쿨다운 체크(신호 폭주 방지)
    if (now - st.lastSignalAt < this.cooldownMs) return;
    st.lastSignalAt = now;

    const side: Side = longCond ? "long" : "short";

    // 안전: 포지션 있으면 일단 스킵(피라미딩은 나중에 확장)
    if (await hasOpenPosition(symbol)) {
      console.log(`[tick] ${symbol} signal(${side}) but position open → skip`);
      return;
    }

    const entryPrice = price; // 틱 체결가 근사
    const orderQty = this.computeQty(entryPrice);

    const tpPrice =
      side === "long"
        ? entryPrice * (1 + config.tpPct / 100)
        : entryPrice * (1 - config.tpPct / 100);
    const slPrice =
      side === "long"
        ? entryPrice * (1 - config.slPct / 100)
        : entryPrice * (1 + config.slPct / 100);

    console.log(`[tick] ${symbol} ${side} signal @${entryPrice} qty=${orderQty} dryRun=${config.dryRun}`);

    // 3) 기록(검증/실주문 모두)
    await insertTrade({
      symbol,
      side,
      entryTs: new Date(tradeTimeMs).toISOString(),
      entryPrice,
      qty: orderQty,
      tpPrice,
      slPrice,
      status: "open",
      meta: {
        kind: "tick_signal",
        dryRun: config.dryRun,
        tfMin: this.tfMin,
        cvdLen: this.len,
      },
    });

    // 4) 주문
    try {
      const res = await placeEntryWithTpSl({
        symbol,
        side,
        qty: orderQty,
        entryPrice,
        tpPrice,
        slPrice,
      });

      if (!res?.dryRun) {
        await insertTrade({
          symbol,
          side,
          entryTs: new Date(tradeTimeMs).toISOString(),
          entryPrice,
          qty: orderQty,
          tpPrice,
          slPrice,
          status: "open",
          orderIds: {
            entryId: res?.entry?.id ?? null,
            tpId: res?.tp?.id ?? null,
            slId: res?.sl?.id ?? null,
          },
          meta: { kind: "tick_order_placed", dryRun: false },
        });
      }
    } catch (e: any) {
      await insertTrade({
        symbol,
        side,
        entryTs: new Date(tradeTimeMs).toISOString(),
        entryPrice,
        qty: orderQty,
        tpPrice,
        slPrice,
        status: "error",
        meta: { kind: "tick_order_failed", error: e?.message ?? String(e) },
      });
      console.error(`[tick] order error ${symbol}:`, e?.message ?? e);
    }
  }
}
