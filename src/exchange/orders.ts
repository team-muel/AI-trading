// src/exchange/orders.ts
import { config } from "../config";
import { makeBinance } from "./binance";
import { normalizeQty } from "./qty";

export async function placeEntryWithTpSl(params: {
  symbol: string;
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
}) {
  // DRY_RUN이면 주문 안 넣고 결과만 반환
  if (config.dryRun) {
    return { entry: null, tp: null, sl: null, dryRun: true, params };
  }

  const ex: any = makeBinance();
  await ex.loadMarkets();

  // ✅ 바이낸스 수량 규칙(precision) 맞추기
  const qty = await normalizeQty(params.symbol, params.qty);

  const isLong = params.side === "long";
  const entrySide = isLong ? "buy" : "sell";
  const exitSide = isLong ? "sell" : "buy";

  // 1) 진입(시장가)
  const entry = await ex.createOrder(params.symbol, "market", entrySide, qty);

  // 2) 익절/손절(조건 주문)
  // ⚠️ 바이낸스 선물에서는 계정/설정에 따라 주문 타입/파라미터가 다르게 동작할 수 있음
  const tp = await ex.createOrder(
    params.symbol,
    "take_profit_market",
    exitSide,
    qty,
    undefined,
    {
      stopPrice: params.tpPrice,
      reduceOnly: true,
    }
  );

  const sl = await ex.createOrder(
    params.symbol,
    "stop_market",
    exitSide,
    qty,
    undefined,
    {
      stopPrice: params.slPrice,
      reduceOnly: true,
    }
  );

  return { entry, tp, sl, dryRun: false };
}
