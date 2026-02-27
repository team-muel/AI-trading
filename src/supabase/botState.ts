import { supabase } from "./client";
import { config } from "../config";

export async function getLastProcessedTs(): Promise<string | undefined> {
  const { data, error } = await supabase
    .from("bot_state")
    .select("last_ts")
    .eq("exchange", config.exchange)
    .eq("symbol", config.symbol)
    .eq("timeframe", config.timeframe)
    .limit(1);

  if (error) throw error;
  return data?.[0]?.last_ts ?? undefined;
}

export async function setLastProcessedTs(ts: string) {
  // upsert
  const { error } = await supabase.from("bot_state").upsert({
    exchange: config.exchange,
    symbol: config.symbol,
    timeframe: config.timeframe,
    last_ts: ts,
    updated_at: new Date().toISOString(),
  }, { onConflict: "exchange,symbol,timeframe" });

  if (error) throw error;
}
