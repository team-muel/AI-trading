// src/ingest/binance_to_supabase.ts
console.log("[ingest] file loaded");

import "dotenv/config";
import ccxt from "ccxt";
import { createClient } from "@supabase/supabase-js";
import { toBinanceSymbol } from "../exchange/symbol";

function must(k: string) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

const SUPABASE_URL = must("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = must("SUPABASE_SERVICE_ROLE_KEY");

const EXCHANGE = (process.env.EXCHANGE ?? "binance").toLowerCase();

const SYMBOLS = (process.env.SYMBOLS ?? "BTC/USDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ✅ 여러 타임프레임 지원
const TIMEFRAMES = (process.env.TIMEFRAMES ?? process.env.TIMEFRAME ?? "30m")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const POLL_SECONDS = Number(process.env.INGEST_POLL_SECONDS ?? 30);
const BINANCE_FUTURES = (process.env.BINANCE_FUTURES ?? "true") === "true";
const INGEST_TICKS = (process.env.INGEST_TICKS ?? "true") === "true";
const INGEST_TICK_BACKFILL_MINUTES = Number(process.env.INGEST_TICK_BACKFILL_MINUTES ?? 180);
const INGEST_TICK_LIMIT = Number(process.env.INGEST_TICK_LIMIT ?? 1000);
const INGEST_TICK_MAX_PAGES = Number(process.env.INGEST_TICK_MAX_PAGES ?? 10);

// timeframe별 백필/페이지 제한을 다르게 주기 위한 헬퍼
function getBackfillDays(tf: string) {
  if (tf === "1m") return Number(process.env.BACKFILL_DAYS_1M ?? 30);
  if (tf === "30m") return Number(process.env.BACKFILL_DAYS_30M ?? 365);
  return Number(process.env.BACKFILL_DAYS ?? 60);
}
function getMaxPages(tf: string) {
  if (tf === "1m") return Number(process.env.MAX_PAGES_PER_SYMBOL_1M ?? 200);
  if (tf === "30m") return Number(process.env.MAX_PAGES_PER_SYMBOL_30M ?? 200);
  return Number(process.env.MAX_PAGES_PER_SYMBOL ?? 200);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function timeframeToMs(tf: string): number {
  const m = tf.match(/^(\d+)([mhdw])$/i);
  if (!m) throw new Error(`Unsupported timeframe: ${tf}`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult =
    unit === "m"
      ? 60_000
      : unit === "h"
      ? 3_600_000
      : unit === "d"
      ? 86_400_000
      : unit === "w"
      ? 604_800_000
      : 0;
  return n * mult;
}

type CandleRow = {
  exchange: string;
  symbol: string;
  timeframe: string;
  ts: string; // ISO
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type OHLCV = [number, number, number, number, number, number];

type TradeTickRow = {
  exchange: string;
  symbol: string;
  ts: string;
  exchange_trade_id: string;
  price: number;
  qty: number;
  side: string | null;
};

async function getLatestTsFromDB(symbol: string, timeframe: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("candles")
    .select("ts")
    .eq("exchange", EXCHANGE)
    .eq("symbol", symbol)
    .eq("timeframe", timeframe)
    .order("ts", { ascending: false })
    .limit(1);

  if (error) throw error;
  const ts = data?.[0]?.ts as string | undefined;
  return ts ? new Date(ts).getTime() : null;
}

async function upsertCandles(rows: CandleRow[]) {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from("candles")
    .upsert(rows, { onConflict: "exchange,symbol,timeframe,ts" });
  if (error) throw error;
}

async function getLatestTickTsFromDB(symbol: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("trade_ticks")
    .select("ts")
    .eq("exchange", EXCHANGE)
    .eq("symbol", symbol)
    .order("ts", { ascending: false })
    .limit(1);

  if (error) throw error;
  const ts = data?.[0]?.ts as string | undefined;
  return ts ? new Date(ts).getTime() : null;
}

async function upsertTradeTicks(rows: TradeTickRow[]) {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from("trade_ticks")
    .upsert(rows, { onConflict: "exchange,symbol,exchange_trade_id" });
  if (error) throw error;
}

function makeExchange() {
  if (EXCHANGE !== "binance") throw new Error(`Only binance supported now: ${EXCHANGE}`);
  const ex: any = new ccxt.binance({
    enableRateLimit: true,
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_API_SECRET,
    options: {
      defaultType: BINANCE_FUTURES ? "future" : "spot",
    },
  });
  return ex;
}

function dropUnclosed(ohlcvRaw: OHLCV[]): OHLCV[] {
  if (!ohlcvRaw || ohlcvRaw.length === 0) return [];
  if (ohlcvRaw.length === 1) return [];
  // ✅ 마지막 캔들은 미완성일 수 있으니 제거
  return ohlcvRaw.slice(0, -1);
}

async function ingestSymbolTf(ex: any, symbol: string, timeframe: string) {
  const apiSymbol = toBinanceSymbol(symbol, BINANCE_FUTURES);
  const tfMs = timeframeToMs(timeframe);
  const limit = 1000;

  const backfillDays = getBackfillDays(timeframe);
  const maxPages = getMaxPages(timeframe);

  const latestMs = await getLatestTsFromDB(symbol, timeframe);

  const earliestTarget = Date.now() - backfillDays * 24 * 60 * 60 * 1000;
  let since = latestMs ? latestMs + 1 : earliestTarget;

  let pages = 0;
  let totalInserted = 0;

  while (true) {
    pages += 1;

    const ohlcvRaw: OHLCV[] = await ex.fetchOHLCV(apiSymbol, timeframe, since, limit);
    if (!ohlcvRaw || ohlcvRaw.length === 0) break;

    const ohlcv = dropUnclosed(ohlcvRaw);
    if (ohlcv.length === 0) break;

    const rows: CandleRow[] = ohlcv.map((c) => {
      const [t, o, h, l, cl, v] = c;
      return {
        exchange: EXCHANGE,
        symbol,
        timeframe,
        ts: new Date(t).toISOString(),
        open: Number(o),
        high: Number(h),
        low: Number(l),
        close: Number(cl),
        volume: Number(v),
      };
    });

    await upsertCandles(rows);
    totalInserted += rows.length;

    const first = rows[0]?.ts;
    const last = rows[rows.length - 1]?.ts;

    console.log(
      `[ingest] ${symbol} tf=${timeframe} page=${pages} fetched=${ohlcvRaw.length} inserted=${rows.length}` +
        (first && last ? ` range=${first} → ${last}` : "")
    );

    const lastMs = new Date(last).getTime();
    since = lastMs + 1;

    // 최신에 거의 도달했으면 종료(2개 봉 여유)
    if (since >= Date.now() - tfMs * 2) break;

    // 안전장치
    if (pages >= maxPages) {
      console.log(`[ingest] ${symbol} tf=${timeframe} reached maxPages=${maxPages} (stop paging)`);
      break;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  if (totalInserted === 0) {
    console.log(`[ingest] ${symbol} tf=${timeframe} up-to-date (no new closed candles)`);
  }
}

async function ingestSymbolTicks(ex: any, symbol: string) {
  const apiSymbol = toBinanceSymbol(symbol, BINANCE_FUTURES);
  const latestMs = await getLatestTickTsFromDB(symbol);

  let since = latestMs
    ? Math.max(0, latestMs - 1000)
    : Date.now() - INGEST_TICK_BACKFILL_MINUTES * 60 * 1000;

  let lastTradeId: number | null = null;
  let pages = 0;
  let inserted = 0;

  while (pages < INGEST_TICK_MAX_PAGES) {
    pages += 1;

    const fetchParams: Record<string, string> | undefined =
      lastTradeId !== null ? { fromId: String(lastTradeId + 1) } : undefined;

    const rows: any[] = await ex.fetchTrades(apiSymbol, since, INGEST_TICK_LIMIT, fetchParams);
    if (!rows || rows.length === 0) break;

    const mapped: TradeTickRow[] = [];
    for (const r of rows as any[]) {
      const tsMs = Number((r as any)?.timestamp ?? 0);
      const tradeIdRaw: unknown = (r as any)?.id;
      const tradeId: string | undefined = tradeIdRaw != null ? String(tradeIdRaw) : undefined;
      const price = Number((r as any)?.price);
      const qty = Number((r as any)?.amount ?? 0);
      const sideRaw = (r as any)?.side;
      const side = sideRaw === "buy" || sideRaw === "sell" ? sideRaw : null;

      if (!tradeId) continue;
      if (!Number.isFinite(tsMs) || !Number.isFinite(price) || !Number.isFinite(qty)) continue;

      mapped.push({
        exchange: EXCHANGE,
        symbol,
        ts: new Date(tsMs).toISOString(),
        exchange_trade_id: tradeId,
        price,
        qty,
        side,
      });

      const idNum: number = Number(tradeId);
      if (Number.isFinite(idNum)) {
        lastTradeId = lastTradeId === null ? idNum : Math.max(lastTradeId, idNum);
      }
    }

    await upsertTradeTicks(mapped);
    inserted += mapped.length;

    const lastTs = Number((rows[rows.length - 1] as any)?.timestamp ?? 0);
    if (!Number.isFinite(lastTs) || lastTs <= 0) break;

    since = lastTs + 1;
    if (rows.length < INGEST_TICK_LIMIT) break;

    await new Promise((r) => setTimeout(r, 120));
  }

  if (inserted > 0) {
    console.log(`[ingest] ${symbol} ticks inserted=${inserted} pages=${pages}`);
  }
}

async function main() {
  console.log("[ingest] start", {
    exchange: EXCHANGE,
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES,
    pollSeconds: POLL_SECONDS,
    backfillDays: Object.fromEntries(TIMEFRAMES.map(tf => [tf, getBackfillDays(tf)])),
    maxPages: Object.fromEntries(TIMEFRAMES.map(tf => [tf, getMaxPages(tf)])),
    ingestTicks: INGEST_TICKS,
    ingestTickLimit: INGEST_TICK_LIMIT,
    ingestTickMaxPages: INGEST_TICK_MAX_PAGES,
  });

  const ex = makeExchange();
  await ex.loadMarkets();

  while (true) {
    for (const symbol of SYMBOLS) {
      for (const tf of TIMEFRAMES) {
        try {
          await ingestSymbolTf(ex, symbol, tf);
        } catch (e: any) {
          console.error(`[ingest] ${symbol} tf=${tf} error:`, e?.message ?? e);
        }
        // 레이트리밋 완화
        await new Promise((r) => setTimeout(r, 200));
      }

      if (INGEST_TICKS) {
        try {
          await ingestSymbolTicks(ex, symbol);
        } catch (e: any) {
          console.error(`[ingest] ${symbol} ticks error:`, e?.message ?? e);
        }
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  }
}

main().catch((e) => {
  console.error("[ingest] fatal:", e?.message ?? e);
  process.exit(1);
});
