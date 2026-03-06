import "dotenv/config";
import fs from "fs";
import path from "path";
import { once } from "events";
import WebSocket from "ws";

const EXCHANGE = (process.env.EXCHANGE ?? "binance").toLowerCase();
const BINANCE_FUTURES = (process.env.BINANCE_FUTURES ?? "true") === "true";
const SYMBOLS = (process.env.SYMBOLS ?? "BTC/USDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RAW_ROOT = process.env.TICK_RAW_DIR ?? path.join("data", "raw");
const FLUSH_EVERY_MS = Number(process.env.TICK_FLUSH_MS ?? 1000);
const FLUSH_BATCH_SIZE = Number(process.env.TICK_FLUSH_BATCH ?? 1000);
const rawMaxMb = Number(process.env.TICK_RAW_MAX_FILE_MB ?? 128);
const MAX_FILE_BYTES = Math.max(1, Math.floor(rawMaxMb * 1024 * 1024));

type TickEvent = {
  exchange: string;
  symbol: string;
  market_id: string;
  ts_ms: number;
  ts_iso: string;
  date: string;
  hour: string;
  exchange_trade_id: string;
  price: number;
  qty: number;
  side: "buy" | "sell" | null;
};

function toMarketId(symbol: string) {
  return symbol.replace("/", "").split(":")[0].toUpperCase();
}

function toStreamName(symbol: string) {
  return toMarketId(symbol).toLowerCase();
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function symbolDirName(symbol: string) {
  return symbol.replace(/[/:]/g, "_");
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function getDateHour(tsMs: number) {
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const h = pad2(d.getUTCHours());
  return {
    date: `${y}-${m}-${day}`,
    hour: h,
  };
}

type Writer = {
  partitionKey: string;
  dir: string;
  filePath: string;
  stream: fs.WriteStream;
  bytes: number;
};

const writers = new Map<string, Writer>();

function buildPartitionDir(symbol: string, date: string, hour: string) {
  return path.join(RAW_ROOT, `symbol=${symbolDirName(symbol)}`, `date=${date}`, `hour=${hour}`);
}

function nextPartPath(dir: string) {
  ensureDir(dir);

  const parts = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ndjson") && f.startsWith("part-"))
    .map((f) => {
      const m = /^part-(\d+)\.ndjson$/.exec(f);
      if (!m) return null;
      return { name: f, idx: Number(m[1]) };
    })
    .filter((x): x is { name: string; idx: number } => !!x && Number.isFinite(x.idx))
    .sort((a, b) => a.idx - b.idx);

  if (parts.length === 0) return path.join(dir, "part-000.ndjson");

  const latest = parts[parts.length - 1];
  const latestPath = path.join(dir, latest.name);
  const st = fs.statSync(latestPath);
  if (st.size < MAX_FILE_BYTES) return latestPath;

  const next = latest.idx + 1;
  return path.join(dir, `part-${String(next).padStart(3, "0")}.ndjson`);
}

function getWriter(symbol: string, date: string, hour: string) {
  const partitionKey = `${symbol}|${date}|${hour}`;
  const existing = writers.get(partitionKey);
  if (existing) return existing;

  const dir = buildPartitionDir(symbol, date, hour);
  const filePath = nextPartPath(dir);
  const bytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

  const stream = fs.createWriteStream(filePath, { flags: "a" });
  const writer: Writer = { partitionKey, dir, filePath, stream, bytes };
  writers.set(partitionKey, writer);
  return writer;
}

async function endWriterStream(stream: fs.WriteStream) {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}

async function writeLine(writer: Writer, line: string) {
  const ok = writer.stream.write(line);
  writer.bytes += Buffer.byteLength(line);
  if (!ok) {
    await once(writer.stream, "drain");
  }
}

async function rotateWriterIfNeeded(w: Writer) {
  if (w.bytes < MAX_FILE_BYTES) return w;

  await endWriterStream(w.stream);
  const filePath = nextPartPath(w.dir);
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  const next: Writer = {
    partitionKey: w.partitionKey,
    dir: w.dir,
    filePath,
    stream,
    bytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
  };
  writers.set(w.partitionKey, next);
  return next;
}

async function flushToDisk(rows: TickEvent[]) {
  if (rows.length === 0) return;

  for (const row of rows) {
    const writer0 = getWriter(row.symbol, row.date, row.hour);
    const writer = await rotateWriterIfNeeded(writer0);
    const line = JSON.stringify(row) + "\n";
    await writeLine(writer, line);
  }
}

async function main() {
  ensureDir(RAW_ROOT);

  const marketIdToSymbol = new Map<string, string>();
  for (const s of SYMBOLS) {
    marketIdToSymbol.set(toMarketId(s), s);
  }

  const streams = SYMBOLS.map((s) => `${toStreamName(s)}@aggTrade`).join("/");
  const base = BINANCE_FUTURES
    ? "wss://fstream.binance.com/stream"
    : "wss://stream.binance.com:9443/stream";
  const wsUrl = `${base}?streams=${streams}`;

  let ws: WebSocket | null = null;
  let isClosing = false;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const buf: TickEvent[] = [];
  let flushing = false;
  let flushQueued = false;

  const flush = async () => {
    if (flushing) {
      flushQueued = true;
      return;
    }

    flushing = true;
    try {
      do {
        flushQueued = false;
        if (buf.length === 0) break;

        const rows = buf.splice(0, buf.length);
        await flushToDisk(rows);
        console.log(`[tick] flushed rows=${rows.length}`);
      } while (flushQueued);
    } catch (e: any) {
      console.error("[tick] flush error:", e?.message ?? e);
    } finally {
      flushing = false;
    }
  };

  const flushTimer = setInterval(() => {
    void flush();
  }, FLUSH_EVERY_MS);

  const connect = () => {
    console.log(`[tick] connecting ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      console.log("[tick] connected", { futures: BINANCE_FUTURES, symbols: SYMBOLS });
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const d = msg?.data;
        if (!d || d.e !== "aggTrade") return;

        const marketId = String(d.s ?? "").toUpperCase();
        const symbol = marketIdToSymbol.get(marketId);
        if (!symbol) return;

        const tradeId = String(d.a ?? "");
        const tsMs = Number(d.T ?? 0);
        const price = Number(d.p);
        const qty = Number(d.q);
        const isBuyerMaker = d.m === true;

        if (!tradeId || !Number.isFinite(tsMs) || !Number.isFinite(price) || !Number.isFinite(qty)) {
          return;
        }

        const { date, hour } = getDateHour(tsMs);

        buf.push({
          exchange: EXCHANGE,
          symbol,
          market_id: marketId,
          ts_ms: tsMs,
          ts_iso: new Date(tsMs).toISOString(),
          date,
          hour,
          exchange_trade_id: tradeId,
          price,
          qty,
          side: isBuyerMaker ? "sell" : "buy",
        });

        if (buf.length >= FLUSH_BATCH_SIZE) {
          void flush();
        }
      } catch (e: any) {
        console.error("[tick] message parse error:", e?.message ?? e);
      }
    });

    ws.on("close", () => {
      console.log("[tick] disconnected");
      if (isClosing) return;
      reconnectTimer = setTimeout(connect, 2000);
    });

    ws.on("error", (e: any) => {
      console.error("[tick] ws error:", e?.message ?? e);
    });
  };

  const shutdown = async () => {
    isClosing = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearInterval(flushTimer);

    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    } catch {
      // ignore
    }

    await flush();
    for (const w of writers.values()) {
      await endWriterStream(w.stream);
    }
    console.log("[tick] shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  connect();
}

main().catch((e) => {
  console.error("[tick] fatal:", e?.message ?? e);
  process.exit(1);
});
