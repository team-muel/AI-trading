import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import AdmZip from "adm-zip";
import { createClient } from "@supabase/supabase-js";

function must(k: string) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

const SUPABASE_URL = must("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = must("SUPABASE_SERVICE_ROLE_KEY");
const EXCHANGE = (process.env.EXCHANGE ?? "binance").toLowerCase();
const BINANCE_FUTURES = (process.env.BINANCE_FUTURES ?? "true") === "true";

const SYMBOLS = (process.env.SYMBOLS ?? "BTC/USDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const GRANULARITY = (process.env.AGG_DUMP_GRANULARITY ?? "monthly").toLowerCase(); // monthly | daily
const START = process.env.AGG_DUMP_START ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const END = process.env.AGG_DUMP_END ?? new Date().toISOString().slice(0, 10);
const BATCH_SIZE = Number(process.env.AGG_DUMP_BATCH_SIZE ?? 5000);
const CACHE_DIR = process.env.AGG_DUMP_CACHE_DIR ?? path.join(".cache", "binance-dumps");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type TickRow = {
  exchange: string;
  symbol: string;
  ts: string;
  exchange_trade_id: string;
  price: number;
  qty: number;
  side: "buy" | "sell" | null;
};

function toMarketId(symbol: string) {
  return symbol.replace("/", "").split(":")[0].toUpperCase();
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const EXTRACT_DIR = path.join(CACHE_DIR, "_extracted");

function monthRange(startYmd: string, endYmd: string) {
  const out: string[] = [];
  const s = new Date(`${startYmd}T00:00:00.000Z`);
  const e = new Date(`${endYmd}T00:00:00.000Z`);

  const cur = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1));
  const last = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), 1));

  while (cur <= last) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    out.push(`${y}-${m}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }

  return out;
}

function dayRange(startYmd: string, endYmd: string) {
  const out: string[] = [];
  let cur = new Date(`${startYmd}T00:00:00.000Z`);
  const end = new Date(`${endYmd}T00:00:00.000Z`);

  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }

  return out;
}

function dumpUrl(params: { marketId: string; bucket: string; key: string }) {
  const root = BINANCE_FUTURES ? "futures/um" : "spot";
  // ex) data/futures/um/monthly/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2025-01.zip
  return `https://data.binance.vision/data/${root}/${params.bucket}/aggTrades/${params.marketId}/${params.marketId}-aggTrades-${params.key}.zip`;
}

async function downloadIfMissing(url: string, targetPath: string) {
  if (fs.existsSync(targetPath)) return true;

  const res = await fetch(url);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);

  const arr = await res.arrayBuffer();
  fs.writeFileSync(targetPath, Buffer.from(arr));
  return true;
}

function extractCsv(zipPath: string): string | null {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const csv = entries.find((e) => e.entryName.endsWith(".csv"));
  if (!csv) return null;

  ensureDir(EXTRACT_DIR);

  const outPath = path.join(EXTRACT_DIR, csv.entryName);
  const parentDir = path.dirname(outPath);
  ensureDir(parentDir);

  const needExtract = !fs.existsSync(outPath) || fs.statSync(outPath).size === 0;
  if (needExtract) {
    zip.extractAllTo(EXTRACT_DIR, true);
  }

  return outPath;
}

async function ingestCsvToTicks(csvPath: string, symbol: string): Promise<number> {
  const stream = fs.createReadStream(csvPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let inserted = 0;
  let batch: TickRow[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    await upsertTicks(batch);
    inserted += batch.length;
    batch = [];
  };

  for await (const line of rl) {
    if (!line) continue;

    const p = line.split(",");
    if (p.length < 7) continue;

    // aggTrades columns: aggTradeId,price,qty,firstTradeId,lastTradeId,transactTime,isBuyerMaker,isBestMatch
    const tradeId = String(p[0]);
    const price = Number(p[1]);
    const qty = Number(p[2]);
    const tsMs = Number(p[5]);
    const isBuyerMaker = p[6] === "true";

    if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(tsMs)) continue;

    batch.push({
      exchange: EXCHANGE,
      symbol,
      ts: new Date(tsMs).toISOString(),
      exchange_trade_id: tradeId,
      price,
      qty,
      side: isBuyerMaker ? "sell" : "buy",
    });

    if (batch.length >= BATCH_SIZE) {
      await flush();
    }
  }

  await flush();
  return inserted;
}

async function upsertTicks(rows: TickRow[]) {
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("trade_ticks")
      .upsert(batch, { onConflict: "exchange,symbol,exchange_trade_id" });
    if (error) throw error;
  }
}

async function backfillSymbol(symbol: string) {
  const marketId = toMarketId(symbol);
  const bucket = GRANULARITY === "daily" ? "daily" : "monthly";
  const keys = GRANULARITY === "daily" ? dayRange(START, END) : monthRange(START, END);

  ensureDir(path.join(CACHE_DIR, bucket, marketId));

  let total = 0;
  for (const key of keys) {
    const url = dumpUrl({ marketId, bucket, key });
    const zipPath = path.join(CACHE_DIR, bucket, marketId, `${marketId}-aggTrades-${key}.zip`);

    const ok = await downloadIfMissing(url, zipPath);
    if (!ok) {
      console.log(`[aggdump] ${symbol} ${key} not found (skip)`);
      continue;
    }

    const csvPath = extractCsv(zipPath);
    if (!csvPath) {
      console.log(`[aggdump] ${symbol} ${key} csv not found (skip)`);
      continue;
    }

    const inserted = await ingestCsvToTicks(csvPath, symbol);
    total += inserted;

    console.log(`[aggdump] ${symbol} ${key} rows=${inserted} total=${total}`);
  }

  console.log(`[aggdump] ${symbol} done totalRows=${total}`);
}

async function main() {
  console.log("[aggdump] start", {
    futures: BINANCE_FUTURES,
    symbols: SYMBOLS,
    granularity: GRANULARITY,
    start: START,
    end: END,
    batchSize: BATCH_SIZE,
    cacheDir: CACHE_DIR,
  });

  for (const symbol of SYMBOLS) {
    await backfillSymbol(symbol);
  }

  console.log("[aggdump] done");
}

main().catch((e) => {
  console.error("[aggdump] fatal:", e?.message ?? e);
  process.exit(1);
});
