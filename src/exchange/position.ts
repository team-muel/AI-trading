import { makeBinance } from "./binance";
import { config } from "../config";

export async function hasOpenPosition(symbol: string): Promise<boolean> {
  // 드라이런에서는 포지션 체크 생략
  if (config.dryRun) return false;

  // 현물은 "포지션"이 아니라 잔고라서 여기서는 false 처리
  if (!config.binanceFutures) return false;

  const ex: any = makeBinance();
  await ex.loadMarkets();

  // ccxt/binance futures: info.positionAmt가 있는 경우가 많음
  const positions = await ex.fetchPositions([symbol]);
  const p = positions?.find((x: any) => x?.symbol === symbol);

  const amt = Number(p?.info?.positionAmt ?? 0);
  return Number.isFinite(amt) && Math.abs(amt) > 0;
}
