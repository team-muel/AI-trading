import "dotenv/config";

function must(k: string) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

export const config = {
  // Supabase
  supabaseUrl: must("SUPABASE_URL"),
  supabaseServiceRoleKey: must("SUPABASE_SERVICE_ROLE_KEY"),

  // Trading
  exchange: process.env.EXCHANGE ?? "binance",
  symbol: process.env.SYMBOL ?? "BTC/USDT",
  timeframe: process.env.TIMEFRAME ?? "30m",

  // Strategy params
  cvdLen: Number(process.env.CVD_LEN ?? 19),
  deltaCoef: Number(process.env.DELTA_COEF ?? 1.0),
  riskPct: Number(process.env.RISK_PCT ?? 2.0),
  tpPct: Number(process.env.TP_PCT ?? 4.0),
  slPct: Number(process.env.SL_PCT ?? 2.0),
  leverage: Number(process.env.LEVERAGE ?? 20),

  // Exchange
  binanceApiKey: must("BINANCE_API_KEY"),
  binanceApiSecret: must("BINANCE_API_SECRET"),
  binanceFutures: (process.env.BINANCE_FUTURES ?? "true") === "true",

  // Runner
  pollSeconds: Number(process.env.POLL_SECONDS ?? 20),
  candleLookback: Number(process.env.CANDLE_LOOKBACK ?? 400),

  // Safety
  dryRun: (process.env.DRY_RUN ?? "true") === "true",

  // Backtest-ish equity seed (추후 거래소 잔고 연동 가능)
  initialCapital: 3000,
};
