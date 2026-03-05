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
  // 드라이런에서는 포지션 체크 생략
  if (config.dryRun) return false;

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

    return Number.isFinite(total) && total > config.binanceSpotMinBaseQty;
  }

  const apiSymbol = toBinanceSymbol(symbol, true);

  // ccxt/binance futures: info.positionAmt가 있는 경우가 많음
  const positions = await ex.fetchPositions([apiSymbol]);
  const marketId = ex.market(apiSymbol)?.id;
  const candidates = new Set([symbol, apiSymbol, marketId].filter(Boolean));
  const p = positions?.find(
    (x: any) => candidates.has(x?.symbol) || candidates.has(x?.info?.symbol)
  );

  const amt = Number(p?.info?.positionAmt ?? 0);
  return Number.isFinite(amt) && Math.abs(amt) > 0;
}
