import { supabase } from "./client";
import { config } from "../config";

export async function getLastProcessedTs(symbol: string): Promise<string | undefined> {
  const { data, error } = await supabase
    .from("bot_state")
    .select("last_ts")
    .eq("exchange", config.exchange)
    .eq("symbol", symbol)
    .eq("timeframe", config.timeframe)
    .limit(1);

  if (error) throw error;
  return (data?.[0]?.last_ts as string | undefined) ?? undefined;
}

export async function setLastProcessedTs(symbol: string, ts: string) {
  const { error } = await supabase.from("bot_state").upsert(
    {
      exchange: config.exchange,
      symbol,
      timeframe: config.timeframe,
      last_ts: ts,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "exchange,symbol,timeframe" }
  );

  if (error) throw error;
}
