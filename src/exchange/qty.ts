import { makeBinance } from "./binance";

export async function normalizeQty(symbol: string, qty: number) {
  const ex: any = makeBinance();
  await ex.loadMarkets();
  return Number(ex.amountToPrecision(symbol, qty));
}
