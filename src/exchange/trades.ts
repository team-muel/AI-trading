import { makeBinance } from "./binance";
import { toBinanceSymbol } from "./symbol";

export type ExchangeTradeTick = {
  tradeId?: string;
  tsMs: number;
  price: number;
  amount: number;
};

export async function fetchTradesSince(params: {
  symbol: string;
  sinceMs: number;
  futures: boolean;
  limit: number;
  maxPages: number;
}) {
  const ex: any = makeBinance();
  await ex.loadMarkets();

  const apiSymbol = toBinanceSymbol(params.symbol, params.futures);
  let since = params.sinceMs;
  let lastTradeId: number | null = null;
  let pages = 0;
  const all: ExchangeTradeTick[] = [];
  const dedup = new Map<string, ExchangeTradeTick>();

  while (pages < params.maxPages) {
    pages += 1;

    const fetchParams: Record<string, string> | undefined =
      lastTradeId !== null ? { fromId: String(lastTradeId + 1) } : undefined;
    const rows: any[] = await ex.fetchTrades(
      apiSymbol,
      Math.max(0, since - 1000),
      params.limit,
      fetchParams
    );
    if (!rows || rows.length === 0) break;

    for (const r of rows as any[]) {
      const tradeIdRaw: unknown = (r as any)?.id;
      const tradeId: string | undefined = tradeIdRaw != null ? String(tradeIdRaw) : undefined;
      const tsMs = Number((r as any)?.timestamp ?? 0);
      const price = Number((r as any)?.price);
      const amount = Number((r as any)?.amount ?? 0);

      if (!Number.isFinite(tsMs) || !Number.isFinite(price) || !Number.isFinite(amount)) {
        continue;
      }
      if (tsMs < since) continue;

      const key = tradeId ?? `${tsMs}:${price}:${amount}`;
      if (!dedup.has(key)) {
        const row = { tradeId, tsMs, price, amount };
        dedup.set(key, row);
        all.push(row);
      }

      if (tradeId) {
        const n: number = Number(tradeId);
        if (Number.isFinite(n)) {
          lastTradeId = lastTradeId === null ? n : Math.max(lastTradeId, n);
        }
      }
    }

    const lastTs = Number((rows[rows.length - 1] as any)?.timestamp ?? 0);
    if (!Number.isFinite(lastTs) || lastTs <= 0) break;

    since = lastTs + 1;

    if (rows.length < params.limit) break;
  }

  all.sort((a, b) => a.tsMs - b.tsMs);
  return all;
}
