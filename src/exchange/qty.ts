import { makeBinance } from "./binance";
import { toBinanceSymbol } from "./symbol";
import { config } from "../config";

export async function normalizeQty(symbol: string, qty: number, exArg?: any) {
  const ex: any = exArg ?? makeBinance();
  if (!ex.markets || Object.keys(ex.markets).length === 0) {
    await ex.loadMarkets();
  }

  const apiSymbol = toBinanceSymbol(symbol, config.binanceFutures);
  return Number(ex.amountToPrecision(apiSymbol, qty));
}
