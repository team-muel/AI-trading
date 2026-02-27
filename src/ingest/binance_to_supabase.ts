// src/ingest/binance_to_supabase.ts
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
const LOOKBACK = Number(process.env.INGEST_LOOKBACK ?? 1000);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function timeframeToMs(tf: string): number {
  // ccxt timeframes: "30m", "1h", ...
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
  ts: string; // ISO string
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

function makeExchange() {
  if (EXCHANGE !== "binance") throw new Error(`Only binance supported now: ${EXCHANGE}`);
  const ex: any = new ccxt.binance({
    enableRateLimit: true,
    // OHLCV fetch는 보통 키 없이도 가능하지만,
    // 제한/안정성을 위해 키를 넣어두는 걸 권장
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_API_SECRET,
    options: {
      defaultType: (process.env.BINANCE_FUTURES ?? "true") === "true" ? "future" : "spot",
    },
  });
  return ex;
}

function dropUnclosed(ohlcv: ccxt.OHLCV[], tfMs: number): ccxt.OHLCV[] {
  if (ohlcv.length === 0) return ohlcv;
  // 안전하게 마지막 캔들은 미완성일 수 있으니 제거
  // (30m 봉이 완전히 닫히기 전에 데이터가 바뀔 수 있음)
  return ohlcv.slice(0, -1);
}

async function upsertCandles(rows: CandleRow[]) {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from("candles")
    .upsert(rows, { onConflict: "exchange,symbol,timeframe,ts" });
  if (error) throw error;
}

async function ingestSymbol(ex: any, symbol: string) {
  const tfMs = timeframeToMs(TIMEFRAME);

  // DB에 마지막으로 저장된 ts를 기준으로 이후 데이터만 가져오기
  const latestMs = await getLatestTsFromDB(symbol);

  // ccxt since는 ms epoch (UTC)
  // - DB에 없다면: LOOKBACK 개만큼 과거부터
  // - DB에 있다면: 마지막 ts 이후부터
  const since = latestMs ? latestMs : Date.now() - tfMs * LOOKBACK;

  // Binance는 limit 제한이 있으니 넉넉히 1000
  const limit = 1000;

  const ohlcvRaw: ccxt.OHLCV[] = await ex.fetchOHLCV(symbol, TIMEFRAME, since, limit);

  const ohlcv = dropUnclosed(ohlcvRaw, tfMs);

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

  const first = rows[0]?.ts;
  const last = rows[rows.length - 1]?.ts;

  console.log(
    `[ingest] ${symbol} fetched=${ohlcvRaw.length} inserted=${rows.length}` +
      (first && last ? ` range=${first} → ${last}` : "")
  );
}

async function main() {
  console.log("[ingest] start", {
    exchange: EXCHANGE,
    timeframe: TIMEFRAME,
    symbols: SYMBOLS,
    pollSeconds: POLL_SECONDS,
    lookback: LOOKBACK,
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
      // 심볼 사이 짧은 딜레이 (레이트리밋 완화)
      await new Promise((r) => setTimeout(r, 250));
    }

    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  }
}

main().catch((e) => {
  console.error("[ingest] fatal:", e?.message ?? e);
  process.exit(1);
});
