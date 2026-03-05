// src/exchange/orders.ts
import { config } from "../config";
import { makeBinance } from "./binance";
import { normalizeQty } from "./qty";
import { toBinanceSymbol } from "./symbol";

function getSpotBaseAsset(ex: any, symbol: string): string {
  try {
    const m = ex.market(symbol);
    if (m?.base) return String(m.base);
  } catch {
    // fallback below
  }

  const pair = symbol.split(":")[0];
  return pair.split("/")[0];
}

async function getSpotBaseAmount(ex: any, symbol: string): Promise<number> {
  const base = getSpotBaseAsset(ex, symbol);
  const bal = await ex.fetchBalance();

  const free = Number(bal?.free?.[base] ?? 0);
  const used = Number(bal?.used?.[base] ?? 0);
  const total = Number(
    bal?.total?.[base] ??
      ((Number.isFinite(free) ? free : 0) + (Number.isFinite(used) ? used : 0))
  );

  return Number.isFinite(total) ? total : 0;
}

async function emergencyFlattenSpot(params: {
  ex: any;
  symbol: string;
  maxRetries: number;
  minBaseQty: number;
}) {
  for (let i = 0; i < params.maxRetries; i++) {
    const remain = await getSpotBaseAmount(params.ex, params.symbol);
    if (remain <= params.minBaseQty) return;

    const sellQty = Number(
      params.ex.amountToPrecision(params.symbol, Math.max(remain * 0.999, params.minBaseQty))
    );
    if (!Number.isFinite(sellQty) || sellQty <= params.minBaseQty) {
      break;
    }

    try {
      await params.ex.createOrder(params.symbol, "market", "sell", sellQty);
    } catch (e: any) {
      console.error("[orders] emergency spot close attempt failed:", e?.message ?? e);
    }
  }

  const remain = await getSpotBaseAmount(params.ex, params.symbol);
  if (remain > params.minBaseQty) {
    throw new Error(`Emergency flatten left residual base asset: ${remain}`);
  }
}

async function emergencyFlattenFutures(params: {
  ex: any;
  symbol: string;
  maxRetries: number;
}) {
  for (let i = 0; i < params.maxRetries; i++) {
    const positions = await params.ex.fetchPositions([params.symbol]);
    const p = positions?.[0];
    const amt = Number(p?.info?.positionAmt ?? p?.contracts ?? 0);

    if (!Number.isFinite(amt) || Math.abs(amt) === 0) return;

    const qty = Math.abs(amt);
    const side = amt > 0 ? "sell" : "buy";
    const positionSide = amt > 0 ? "LONG" : "SHORT";

    const reduceParams: any = { reduceOnly: true };
    if (config.binanceHedgeMode) {
      reduceParams.positionSide = positionSide;
    }

    try {
      await params.ex.createOrder(params.symbol, "market", side, qty, undefined, reduceParams);
    } catch (e: any) {
      console.error("[orders] emergency futures close attempt failed:", e?.message ?? e);
    }
  }

  const finalPos = await params.ex.fetchPositions([params.symbol]);
  const p = finalPos?.[0];
  const amt = Number(p?.info?.positionAmt ?? p?.contracts ?? 0);
  if (Number.isFinite(amt) && Math.abs(amt) > 0) {
    throw new Error(`Emergency futures flatten left residual contracts: ${amt}`);
  }
}

async function placeSpotOco(params: {
  ex: any;
  symbol: string;
  qty: number;
  tpPrice: number;
  slPrice: number;
}) {
  const market = params.ex.market(params.symbol);
  const marketId = market?.id ?? params.symbol.replace("/", "").split(":")[0];

  const quantity = params.ex.amountToPrecision(params.symbol, params.qty);
  const price = params.ex.priceToPrecision(params.symbol, params.tpPrice);
  const stopPrice = params.ex.priceToPrecision(params.symbol, params.slPrice);
  const stopLimitPrice = params.ex.priceToPrecision(params.symbol, params.slPrice * 0.999);

  const payload = {
    symbol: marketId,
    side: "SELL",
    quantity,
    price,
    stopPrice,
    stopLimitPrice,
    stopLimitTimeInForce: "GTC",
  };

  const rawMethods = [
    "privatePostOrderListOco",
    "privatePostOrderOco",
    "sapiPostOrderListOco",
    "sapiPostOrderOco",
  ];

  for (const name of rawMethods) {
    const fn = params.ex[name];
    if (typeof fn === "function") {
      return await fn.call(params.ex, payload);
    }
  }

  throw new Error("OCO endpoint is not available in this ccxt/binance build.");
}

export async function placeEntryWithTpSl(params: {
  symbol: string;
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
}) {
  // DRY_RUN이면 주문 안 넣고 결과만 반환
  if (config.dryRun) {
    return { entry: null, tp: null, sl: null, dryRun: true, params };
  }

  const ex: any = makeBinance();
  await ex.loadMarkets();
  const symbol = toBinanceSymbol(params.symbol, config.binanceFutures);

  // ✅ 바이낸스 수량 규칙(precision) 맞추기
  const qty = await normalizeQty(params.symbol, params.qty, ex);

  const isLong = params.side === "long";
  const entrySide = isLong ? "buy" : "sell";
  const exitSide = isLong ? "sell" : "buy";

  if (config.binanceFutures) {
    const posSide = config.binanceHedgeMode
      ? { positionSide: isLong ? "LONG" : "SHORT" }
      : {};

    // 1) 진입(시장가)
    const entry = await ex.createOrder(symbol, "market", entrySide, qty, undefined, {
      ...posSide,
    });

    // 2) 익절/손절(조건 주문)
    const exitPosSide = config.binanceHedgeMode
      ? { positionSide: isLong ? "LONG" : "SHORT" }
      : {};

    try {
      const tp = await ex.createOrder(
        symbol,
        "take_profit_market",
        exitSide,
        qty,
        undefined,
        {
          stopPrice: params.tpPrice,
          reduceOnly: true,
          ...exitPosSide,
        }
      );

      const sl = await ex.createOrder(
        symbol,
        "stop_market",
        exitSide,
        qty,
        undefined,
        {
          stopPrice: params.slPrice,
          reduceOnly: true,
          ...exitPosSide,
        }
      );

      return { entry, tp, sl, dryRun: false };
    } catch (e: any) {
      try {
        await emergencyFlattenFutures({
          ex,
          symbol,
          maxRetries: Math.max(1, config.binanceFuturesEmergencyRetries),
        });
      } catch (closeErr: any) {
        console.error("[orders] emergency futures close failed:", closeErr?.message ?? closeErr);
      }

      throw new Error(`[orders] futures TP/SL placement failed: ${e?.message ?? e}`);
    }
  }

  // Spot: short is not supported without margin borrowing.
  if (!isLong) {
    throw new Error("Spot mode does not support short entry in this bot. Use futures or long-only logic.");
  }

  const entry = await ex.createOrder(symbol, "market", "buy", qty);
  const filledRaw = Number(entry?.filled ?? qty);
  const filledQty = await normalizeQty(params.symbol, filledRaw > 0 ? filledRaw : qty, ex);

  try {
    const oco = await placeSpotOco({
      ex,
      symbol,
      qty: filledQty,
      tpPrice: params.tpPrice,
      slPrice: params.slPrice,
    });

    return { entry, tp: oco, sl: null, oco, dryRun: false };
  } catch (e: any) {
    // Safety first: if protection order fails, close spot position immediately.
    try {
      await emergencyFlattenSpot({
        ex,
        symbol,
        maxRetries: Math.max(1, config.binanceSpotEmergencyRetries),
        minBaseQty: Math.max(0, config.binanceSpotMinBaseQty),
      });
    } catch (closeErr: any) {
      console.error("[orders] emergency spot close failed:", closeErr?.message ?? closeErr);
    }

    throw new Error(`[orders] spot OCO placement failed: ${e?.message ?? e}`);
  }
}
