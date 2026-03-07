import { makeBinance } from "./binance";
import { config } from "../config";
import { toBinanceSymbol } from "./symbol";

function getBaseAsset(ex: any, symbol: string): string {
  try {
    const m = ex.market(symbol);
    if (m?.base) return String(m.base);
  } catch {
    // fall back to simple parser
  }

  const pair = symbol.split(":")[0];
  return pair.split("/")[0];
}

export async function hasOpenPosition(symbol: string): Promise<boolean> {
  const snapshot = await getPositionSnapshot(symbol);
  return snapshot.open;
}

export async function getPositionSnapshot(symbol: string): Promise<{
  symbol: string;
  exchangeSymbol: string;
  marketType: "futures" | "spot";
  open: boolean;
  side: "long" | "short" | "flat";
  qty: number;
  entryPrice?: number | null;
  markPrice?: number | null;
  dryRun: boolean;
  raw?: Record<string, unknown> | null;
}> {
  // DRY_RUN에서는 실제 주문/포지션 조회를 하지 않는다.
  if (config.dryRun) {
    return {
      symbol,
      exchangeSymbol: toBinanceSymbol(symbol, config.binanceFutures),
      marketType: config.binanceFutures ? "futures" : "spot",
      open: false,
      side: "flat",
      qty: 0,
      entryPrice: null,
      markPrice: null,
      dryRun: true,
      raw: null,
    };
  }

  const ex: any = makeBinance();
  await ex.loadMarkets();

  if (!config.binanceFutures) {
    const apiSymbol = toBinanceSymbol(symbol, false);
    const base = getBaseAsset(ex, apiSymbol);
    const bal = await ex.fetchBalance();

    const free = Number(bal?.free?.[base] ?? 0);
    const used = Number(bal?.used?.[base] ?? 0);
    const total = Number(
      bal?.total?.[base] ??
        ((Number.isFinite(free) ? free : 0) + (Number.isFinite(used) ? used : 0))
    );

    const qty = Number.isFinite(total) ? total : 0;
    const open = qty > config.binanceSpotMinBaseQty;
    return {
      symbol,
      exchangeSymbol: apiSymbol,
      marketType: "spot",
      open,
      side: open ? "long" : "flat",
      qty,
      entryPrice: null,
      markPrice: null,
      dryRun: false,
      raw: null,
    };
  }

  const apiSymbol = toBinanceSymbol(symbol, true);

  // ccxt/binance futures: info.positionAmt가 있는 경우가 많음
  const positions = await ex.fetchPositions([apiSymbol]);
  const marketId = ex.market(apiSymbol)?.id;
  const candidates = new Set([symbol, apiSymbol, marketId].filter(Boolean));
  const p = positions?.find(
    (x: any) => candidates.has(x?.symbol) || candidates.has(x?.info?.symbol)
  );

  const amt = Number(p?.info?.positionAmt ?? p?.contracts ?? 0);
  const absAmt = Number.isFinite(amt) ? Math.abs(amt) : 0;
  const open = absAmt > 0;
  const entryPrice = Number(p?.info?.entryPrice ?? p?.entryPrice ?? Number.NaN);
  const markPrice = Number(p?.info?.markPrice ?? p?.markPrice ?? Number.NaN);

  return {
    symbol,
    exchangeSymbol: apiSymbol,
    marketType: "futures",
    open,
    side: !open ? "flat" : amt > 0 ? "long" : "short",
    qty: absAmt,
    entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
    markPrice: Number.isFinite(markPrice) ? markPrice : null,
    dryRun: false,
    raw: (p?.info as Record<string, unknown> | undefined) ?? null,
  };
}
