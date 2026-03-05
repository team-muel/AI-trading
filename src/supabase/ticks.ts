import { supabase } from "./client";
import { config } from "../config";

export type SupabaseTradeTick = {
  tsMs: number;
  price: number;
  amount: number;
  tradeId: string;
};

export async function fetchTicksSince(params: {
  symbol: string;
  sinceMs: number;
  limit: number;
  maxPages: number;
}) {
  let cursorId = 0;
  let pages = 0;
  const all: SupabaseTradeTick[] = [];
  const startIso = new Date(Math.max(0, params.sinceMs - 1000)).toISOString();

  while (pages < params.maxPages) {
    pages += 1;

    let q = supabase
      .from("trade_ticks")
      .select("id, ts, price, qty, exchange_trade_id")
      .eq("exchange", config.exchange)
      .eq("symbol", params.symbol)
      .gte("ts", startIso)
      .order("id", { ascending: true })
      .limit(params.limit);

    if (cursorId > 0) {
      q = q.gt("id", cursorId);
    }

    const { data, error } = await q;

    if (error) throw error;

    const rows = (data ?? [])
      .map((r: any) => {
        const tsMs = new Date(String(r.ts)).getTime();
        const price = Number(r.price);
        const amount = Number(r.qty);
        const tradeId = String(r.exchange_trade_id ?? "");

        if (!Number.isFinite(tsMs) || !Number.isFinite(price) || !Number.isFinite(amount)) {
          return null;
        }

        return { tsMs, price, amount, tradeId };
      })
      .filter(Boolean) as SupabaseTradeTick[];

    if (rows.length === 0) break;

    all.push(...rows);

    const lastId = Number((data as any[])[(data as any[]).length - 1]?.id ?? 0);
    if (Number.isFinite(lastId) && lastId > 0) {
      cursorId = lastId;
    }

    if (rows.length < params.limit) break;
  }

  const dedup = new Map<string, SupabaseTradeTick>();
  for (const t of all) {
    if (t.tsMs < params.sinceMs) continue;
    dedup.set(t.tradeId || `${t.tsMs}:${t.price}:${t.amount}`, t);
  }

  return [...dedup.values()].sort((a, b) => a.tsMs - b.tsMs);
}
