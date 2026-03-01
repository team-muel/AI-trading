// src/ingest/binance_to_supabase.ts
console.log("[ingest] file loaded");

import "dotenv/config";
import ccxt from "ccxt";
import { createClient } from "@supabase/supabase-js";

function must(k: string) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

const SUPABASE_URL = must("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = must("SUPABASE_SERVICE_ROLE_KEY");

const EXCHANGE = (process.env.EXCHANGE ?? "binance").toLowerCase();
const TIMEFRAME = process.env.TIMEFRAME ?? "30m";
const SYMBOLS = (process.env.SYMBOLS ?? "BTC/USDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const POLL_SECONDS = Number(process.env.INGEST_POLL_SECONDS ?? 30);

// Backfill controls
// - If DB is empty for a symbol, start from (now - BACKFILL_DAYS)
// - Otherwise continue from latest ts in DB
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS ?? 365);
const MAX_PAGES_PER_SYMBOL = Number(process.env.MAX_PAGES_PER_SYMBOL ?? 200); // safety cap

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
  ts: string; // ISO string (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

async function getLatestTsFromDB(symbol: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("candles")
    .select("ts")
    .eq("exchange", EXCHANGE)
    .eq("symbol", symbol)
    .eq("timeframe", TIMEFRAME)
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

function makeExchange() {
  if (EXCHANGE !== "binance") throw new Error(`Only binance supported now: ${EXCHANGE}`);

  // OHLCV fetch는 키 없이도 가능하지만, 제한/안정성 때문에 키 넣는 걸 추천
  const ex: any = new ccxt.binance({
    enableRateLimit: true,
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_API_SECRET,
    options: {
      defaultType: (process.env.BINANCE_FUTURES ?? "true") === "true" ? "future" : "spot",
    },
  });

  return ex;
}

// Safety: drop last candle which can be still forming
function dropUnclosed(ohlcvRaw: ccxt.OHLCV[]): ccxt.OHLCV[] {
  if (!ohlcvRaw || ohlcvRaw.length === 0) return [];
  if (ohlcvRaw.length === 1) return [];
  return ohlcvRaw.slice(0, -1);
}

async function ingestSymbol(ex: any, symbol: string) {
  const tfMs = timeframeToMs(TIMEFRAME);
  const limit = 1000;

  const latestMs = await getLatestTsFromDB(symbol);

  // if empty DB: start from now - BACKFILL_DAYS
  const earliestTarget = Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  let since = latestMs ? latestMs + 1 : earliestTarget;

  let pages = 0;
  let totalInserted = 0;

  while (true) {
    pages += 1;

    const ohlcvRaw: ccxt.OHLCV[] = await ex.fetchOHLCV(symbol, TIMEFRAME, since, limit);

    if (!ohlcvRaw || ohlcvRaw.length === 0) break;

    const ohlcv = dropUnclosed(ohlcvRaw);
    if (ohlcv.length === 0) break;

    const rows: CandleRow[] = ohlcv.map((c) => {
      const [t, o, h, l, cl, v] = c;
      return {
        exchange: EXCHANGE,
        symbol,
        timeframe: TIMEFRAME,
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
      `[ingest] ${symbol} page=${pages} fetched=${ohlcvRaw.length} inserted=${rows.length}` +
        (first && last ? ` range=${first} → ${last}` : "")
    );

    const lastMs = new Date(last).getTime();
    since = lastMs + 1;

    // stop when we're close to "now" (2 candles buffer)
    if (since >= Date.now() - tfMs * 2) break;

    // safety cap to avoid running forever
    if (pages >= MAX_PAGES_PER_SYMBOL) break;

    // rate-limit friendly delay
    await new Promise((r) => setTimeout(r, 250));
  }

  if (totalInserted === 0) {
    console.log(`[ingest] ${symbol} up-to-date (no new closed candles)`);
  }
}

async function main() {
  console.log("[ingest] start", {
    exchange: EXCHANGE,
    timeframe: TIMEFRAME,
    symbols: SYMBOLS,
    pollSeconds: POLL_SECONDS,
    backfillDays: BACKFILL_DAYS,
    maxPagesPerSymbol: MAX_PAGES_PER_SYMBOL,
  });

  console.log("[ingest] env check", {
    supabaseUrlPrefix: process.env.SUPABASE_URL?.slice(0, 24),
    timeframe: process.env.TIMEFRAME,
    symbols: process.env.SYMBOLS,
  });

  const ex = makeExchange();
  await ex.loadMarkets();

  while (true) {
    for (const symbol of SYMBOLS) {
      try {
        await ingestSymbol(ex, symbol);
      } catch (e: any) {
        console.error(`[ingest] ${symbol} error:`, e?.message ?? e);
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  }
}

main().catch((e) => {
  console.error("[ingest] fatal:", e?.message ?? e);
  process.exit(1);
});
