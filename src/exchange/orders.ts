import { config } from "../config";
import { makeBinance } from "./binance";

export async function placeEntryWithTpSl(params: {
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
}) {
  if (config.dryRun) {
    return { entry: null, tp: null, sl: null, dryRun: true, params };
  }

  const ex = makeBinance();
  await ex.loadMarkets();

  // NOTE: 선물 TP/SL 조건 주문은 심볼/타입/파라미터가 조금 까다로움.
  // 여기서는 "진입(시장가)" + "TP/SL(감시 주문)" 형태로 기본 구조만 제공.
  // 실제 운영 시 reduceOnly / stopPrice / priceProtect / workingType 등 세부 파라미터를 네 계정/마켓에 맞춰 조정해야 함.

  const symbol = config.symbol;
  const isLong = params.side === "long";
  const entrySide = isLong ? "buy" : "sell";

  const entry = await ex.createOrder(symbol, "market", entrySide, params.qty);

  // TP/SL: 거래소 지원 방식에 맞게 조건 주문 생성
  // 아래는 예시 형태(실제 파라미터는 마켓별로 다를 수 있음)
  const exitSide = isLong ? "sell" : "buy";

  const tp = await ex.createOrder(symbol, "take_profit_market", exitSide, params.qty, undefined, {
    stopPrice: params.tpPrice,
    reduceOnly: true,
  });

  const sl = await ex.createOrder(symbol, "stop_market", exitSide, params.qty, undefined, {
    stopPrice: params.slPrice,
    reduceOnly: true,
  });

  return { entry, tp, sl, dryRun: false };
}
