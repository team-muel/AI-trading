import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../config";
import { placeEntryWithTpSl } from "../exchange/orders";
import { getPositionSnapshot } from "../exchange/position";

type TradeSide = "long" | "short";

function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getBearerToken(req: IncomingMessage): string {
  const auth = String(req.headers.authorization ?? "").trim();
  if (!auth.toLowerCase().startsWith("bearer ")) return "";
  return auth.slice(7).trim();
}

function isAuthorized(req: IncomingMessage): { ok: boolean; code?: number; message?: string } {
  if (!config.aiTradingInternalToken) {
    return { ok: false, code: 503, message: "AI_TRADING_INTERNAL_TOKEN is not configured" };
  }

  const token = getBearerToken(req);
  if (!token) return { ok: false, code: 401, message: "Missing bearer token" };
  if (token !== config.aiTradingInternalToken) return { ok: false, code: 403, message: "Invalid token" };
  return { ok: true };
}

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toTradeSide(value: unknown): TradeSide | null {
  const s = String(value ?? "").toLowerCase();
  if (s === "long" || s === "short") return s;
  return null;
}

async function handleOrder(req: IncomingMessage, res: ServerResponse) {
  const auth = isAuthorized(req);
  if (!auth.ok) {
    sendJson(res, auth.code ?? 401, { error: "UNAUTHORIZED", message: auth.message ?? "Unauthorized" });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }

  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 422, { error: "INVALID_PAYLOAD", message: "JSON body must be an object" });
    return;
  }

  const symbol = String(body.symbol ?? "").trim();
  const side = toTradeSide(body.side);
  const qty = toFiniteNumber(body.qty);
  const entryPrice = toFiniteNumber(body.entryPrice);

  if (!symbol || !side || qty === null || qty <= 0 || entryPrice === null || entryPrice <= 0) {
    sendJson(res, 422, {
      error: "INVALID_PAYLOAD",
      message: "symbol, side(long|short), qty(>0), entryPrice(>0) are required",
    });
    return;
  }

  const requestedTp = toFiniteNumber(body.tpPrice);
  const requestedSl = toFiniteNumber(body.slPrice);

  const tpPrice =
    requestedTp !== null
      ? requestedTp
      : side === "long"
      ? entryPrice * (1 + config.tpPct / 100)
      : entryPrice * (1 - config.tpPct / 100);

  const slPrice =
    requestedSl !== null
      ? requestedSl
      : side === "long"
      ? entryPrice * (1 - config.slPct / 100)
      : entryPrice * (1 + config.slPct / 100);

  try {
    const result = await placeEntryWithTpSl({
      symbol,
      side,
      qty,
      entryPrice,
      tpPrice,
      slPrice,
    });

    const orderIds: Record<string, unknown> = {
      entryId: (result as any)?.entry?.id ?? null,
      tpId: (result as any)?.tp?.id ?? null,
      slId: (result as any)?.sl?.id ?? null,
      ocoId: (result as any)?.oco?.orderListId ?? null,
    };

    sendJson(res, 200, {
      ok: true,
      dryRun: Boolean((result as any)?.dryRun),
      symbol,
      side,
      qty,
      entryPrice,
      tpPrice,
      slPrice,
      orderIds,
      raw: result,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: "ORDER_FAILED", message });
  }
}

async function handlePosition(req: IncomingMessage, res: ServerResponse, url: URL) {
  const auth = isAuthorized(req);
  if (!auth.ok) {
    sendJson(res, auth.code ?? 401, { error: "UNAUTHORIZED", message: auth.message ?? "Unauthorized" });
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }

  const symbol = String(url.searchParams.get("symbol") ?? "").trim();
  if (!symbol) {
    sendJson(res, 422, { error: "INVALID_PAYLOAD", message: "symbol query is required" });
    return;
  }

  try {
    const position = await getPositionSnapshot(symbol);
    sendJson(res, 200, { source: "ai-trading", position });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: "POSITION_FAILED", message });
  }
}

export function startInternalApiServer() {
  if (!config.aiTradingHttpEnabled) {
    console.log("[internal-api] disabled (AI_TRADING_HTTP_ENABLED=false)");
    return;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        service: "ai-trading",
        now: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname === config.aiTradingOrderPath) {
      await handleOrder(req, res);
      return;
    }

    if (url.pathname === config.aiTradingPositionPath) {
      await handlePosition(req, res, url);
      return;
    }

    sendJson(res, 404, { error: "NOT_FOUND" });
  });

  server.listen(config.aiTradingPort, config.aiTradingHost, () => {
    console.log(
      `[internal-api] listening on http://${config.aiTradingHost}:${config.aiTradingPort} ` +
        `(order=${config.aiTradingOrderPath}, position=${config.aiTradingPositionPath})`
    );
  });
}
