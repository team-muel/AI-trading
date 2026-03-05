// src/supabase/trades.ts
import { supabase } from "./client";
import { config } from "../config";

export type TradeStatus = "open" | "closed" | "canceled" | "error";
export type TradeSide = "long" | "short";

export async function insertTrade(row: {
  symbol: string;
  side: TradeSide;
  entryTs: string;
  entryPrice: number;
  qty: number;
  tpPrice?: number;
  slPrice?: number;
  status?: TradeStatus;
  orderIds?: any; // { entryId, tpId, slId, ... }
  meta?: any;     // { dryRun: true, signal: "...", error: "...", ... }
}) {
  const { error } = await supabase.from("trades").insert({
    exchange: config.exchange,
    symbol: row.symbol,
    timeframe: config.timeframe,
    side: row.side,
    entry_ts: row.entryTs,
    entry_price: row.entryPrice,
    qty: row.qty,
    tp_price: row.tpPrice ?? null,
    sl_price: row.slPrice ?? null,
    status: row.status ?? "open",
    exchange_order_ids: row.orderIds ?? null,
    meta: row.meta ?? null,
    updated_at: new Date().toISOString(),
  });

  if (error) throw error;
}
