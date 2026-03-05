import { supabase } from "./client";
import { config } from "../config";

export async function fetchRecentCandles(symbol: string, limit: number) {
  const { data, error } = await supabase
    .from("candles")
    .select("ts, open, close, volume")
    .eq("exchange", config.exchange)
    .eq("symbol", symbol)
    .eq("timeframe", config.timeframe)
    .order("ts", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const rows = [...(data ?? [])].reverse();

  return rows.map((r) => ({
    ts: r.ts as string,
    open: Number((r as any).open),
    close: Number((r as any).close),
    volume: Number((r as any).volume),
  }));
}

export async function fetchLatestCandleTs(symbol: string) {
  const { data, error } = await supabase
    .from("candles")
    .select("ts")
    .eq("exchange", config.exchange)
    .eq("symbol", symbol)
    .eq("timeframe", config.timeframe)
    .order("ts", { ascending: false })
    .limit(1);

  if (error) throw error;
  return (data?.[0]?.ts as string | undefined) ?? undefined;
}
