import { makeBinance } from "../exchange/binance";
import { config } from "../config";
import { toBinanceSymbol } from "../exchange/symbol";

export async function hasOpenPosition(symbol: string): Promise<boolean> {
  if (config.dryRun) return false; // 드라이런에서는 포지션 체크 생략해도 됨(원하면 true로 바꿔도 됨)

  const ex: any = makeBinance();
  await ex.loadMarkets();
  const apiSymbol = toBinanceSymbol(symbol, true);

  // 선물일 때만 의미있음. (현물은 보유=포지션이 아니라 잔고라 별도 로직 필요)
  if (!config.binanceFutures) return false;

  // ccxt 포지션 구조가 거래소/버전에 따라 다를 수 있어서 최대한 방어적으로 처리
  const positions = await ex.fetchPositions([apiSymbol]);
  const marketId = ex.market(apiSymbol)?.id;
  const candidates = new Set([symbol, apiSymbol, marketId].filter(Boolean));
  const p = positions?.find(
    (x: any) => candidates.has(x?.symbol) || candidates.has(x?.info?.symbol)
  );

  const contracts =
    Number(p?.contracts ?? p?.contractSize ?? p?.info?.positionAmt ?? 0);

  // Binance futures info.positionAmt 는 문자열일 수 있음
  const amt = Number(p?.info?.positionAmt ?? contracts ?? 0);

  return Math.abs(amt) > 0;
}
