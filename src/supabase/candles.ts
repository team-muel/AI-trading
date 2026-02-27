import { supabase } from "./client";
import { config } from "../config";

export async function fetchRecentCandles(limit: number) {
  const { data, error } = await supabase
    .from("candles")
    .select("ts, open, close, volume")
    .eq("exchange", config.exchange)
    .eq("symbol", config.symbol)
    .eq("timeframe", config.timeframe)
    .order("ts", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data ?? []).map((r) => ({
    ts: r.ts as string,
    open: Number(r.open),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

export async function fetchLatestCandleTs() {
  const { data, error } = await supabase
    .from("candles")
    .select("ts")
    .eq("exchange", config.exchange)
    .eq("symbol", config.symbol)
    .eq("timeframe", config.timeframe)
    .order("ts", { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0]?.ts as string | undefined;
}
