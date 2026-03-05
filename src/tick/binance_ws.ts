import WebSocket from "ws";
import { config } from "../config";

type AggTradeMsg = {
  e: "aggTrade";
  E: number;
  s: string; // BTCUSDT
  p: string; // price
  q: string; // qty
  T: number; // trade time
  m: boolean; // buyer is maker
};

function toStreamSymbol(symbol: string) {
  return symbol.replace("/", "").toLowerCase(); // BTC/USDT -> btcusdt
}

export function startAggTradeStream(onTrade: (symbol: string, t: AggTradeMsg) => void) {
  const streams = config.symbols.map((s) => `${toStreamSymbol(s)}@aggTrade`).join("/");

  // Futures(USDT-M): fstream, Spot: stream
  const base = config.binanceFutures
    ? "wss://fstream.binance.com/stream?streams="
    : "wss://stream.binance.com:9443/stream?streams=";

  const url = base + streams;

  let ws: WebSocket | null = null;
  let stopped = false;

  const symMap = new Map<string, string>();
  for (const s of config.symbols) symMap.set(toStreamSymbol(s).toUpperCase(), s);

  function connect() {
    if (stopped) return;

    ws = new WebSocket(url);

    ws.on("open", () => console.log("[tick] ws connected"));

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const d = msg?.data as AggTradeMsg | undefined;
        if (!d || d.e !== "aggTrade") return;

        const key = d.s.toUpperCase(); // BTCUSDT
        const sym = symMap.get(key.toLowerCase().toUpperCase()); // normalize
        if (!sym) return;

        onTrade(sym, d);
      } catch {}
    });

    ws.on("close", () => {
      console.log("[tick] ws closed, reconnecting...");
      setTimeout(connect, 1000);
    });

    ws.on("error", (err) => {
      console.log("[tick] ws error:", (err as any)?.message ?? err);
      try {
        ws?.close();
      } catch {}
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      try {
        ws?.close();
      } catch {}
    },
  };
}
