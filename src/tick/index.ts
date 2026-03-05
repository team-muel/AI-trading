import "dotenv/config";
import WebSocket from "ws";
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

const FLUSH_EVERY_MS = Number(process.env.TICK_FLUSH_MS ?? 1500);
const FLUSH_BATCH_SIZE = Number(process.env.TICK_FLUSH_BATCH ?? 1000);

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

function toStreamName(symbol: string) {
  return toMarketId(symbol).toLowerCase();
}

async function upsertTicks(rows: TickRow[]) {
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += FLUSH_BATCH_SIZE) {
    const batch = rows.slice(i, i + FLUSH_BATCH_SIZE);
    const { error } = await supabase
      .from("trade_ticks")
      .upsert(batch, { onConflict: "exchange,symbol,exchange_trade_id" });
    if (error) throw error;
  }
}

async function main() {
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

  const buf: TickRow[] = [];
  let flushing = false;

  const flush = async () => {
    if (flushing || buf.length === 0) return;
    flushing = true;
    try {
      const rows = buf.splice(0, buf.length);
      await upsertTicks(rows);
      console.log(`[tick] flushed rows=${rows.length}`);
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

        buf.push({
          exchange: EXCHANGE,
          symbol,
          ts: new Date(tsMs).toISOString(),
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
