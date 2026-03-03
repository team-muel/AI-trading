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
  // DRY_RUN이면 주문 안 넣음
  if (config.dryRun) {
    return { entry: null, tp: null, sl: null, dryRun: true, params };
  }

  const ex: any = makeBinance();
  await ex.loadMarkets();

  // ✅ 바이낸스 수량 규칙 맞추기
  const qty = await normalizeQty(params.symbol, params.qty);

  const isLong = params.side === "long";
  const entrySide = isLong ? "buy" : "sell";
  const exitSide = isLong ? "sell" : "buy";

  const entry = await ex.createOrder(params.symbol, "market", entrySide, qty);

  // ⚠️ TP/SL 타입은 계정/마켓 설정에 따라 다르게 동작할 수 있음
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
