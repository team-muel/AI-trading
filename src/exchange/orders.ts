import { config } from "../config";
import { makeBinance } from "./binance";

export async function placeEntryWithTpSl(params: {
  symbol: string;              // ✅ 추가
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

  const symbol = params.symbol;
  const isLong = params.side === "long";
  const entrySide = isLong ? "buy" : "sell";

  const entry = await ex.createOrder(symbol, "market", entrySide, params.qty);

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
