import ccxt from "ccxt";
import { config } from "../config";

export function makeBinance() {
  const ex: any = new ccxt.binance({
    apiKey: config.binanceApiKey,
    secret: config.binanceApiSecret,
    enableRateLimit: true,
    options: {
      defaultType: config.binanceFutures ? "future" : "spot",
    },
  });
  return ex;
}
