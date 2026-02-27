import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALPACA_KEY = Deno.env.get("ALPACA_API_KEY")!;
const ALPACA_SECRET = Deno.env.get("ALPACA_SECRET_KEY")!;
const ALPACA_BASE = Deno.env.get("ALPACA_BASE_URL") ?? "https://paper-api.alpaca.markets";

const MAX_POS = Number(Deno.env.get("MAX_POS") ?? "20");

// 매우 단순 예시: signals의 target_weight를 “그대로” 주문 수량으로 바꾸려면 계좌 equity 조회가 필요.
// 여기서는 qty를 외부에서 넘기거나, 일단 1주로 실행하는 안전모드.
const SAFE_QTY = Number(Deno.env.get("SAFE_QTY") ?? "1");

async function alpacaOrder(symbol: string, side: "buy" | "sell", qty: number) {
  const url = `${ALPACA_BASE}/v2/orders`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
    },
    body: JSON.stringify({
      symbol,
      side,
      qty,
      type: "market",
      time_in_force: "day",
    }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Alpaca ${r.status}: ${txt}`);
  return JSON.parse(txt);
}

serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1) 최신 signal ts
    const { data: latest, error: lErr } = await supabase
      .from("signals")
      .select("ts")
      .order("ts", { ascending: false })
      .limit(1);
    if (lErr) throw lErr;
    if (!latest?.length) throw new Error("signals empty. Run generate_signals first.");
    const ts = latest[0].ts;

    // 2) 최신 signals 로드
    const { data: sigs, error: sErr } = await supabase
      .from("signals")
      .select("ts,symbol,target_weight")
      .eq("ts", ts)
      .order("target_weight", { ascending: false })
      .limit(MAX_POS);
    if (sErr) throw sErr;

    if (!sigs?.length) return new Response(JSON.stringify({ ok: true, ts, orders: 0 }), { headers: { "Content-Type": "application/json" } });

    const results: any[] = [];

    // ⚠️ 여기서는 “포지션 정리/리밸런싱”까지 구현하지 않고,
    // 단순히 최신 picks를 BUY 1주씩 넣는 안전모드임.
    for (const s of sigs) {
      const symbol = s.symbol as string;
      const qty = SAFE_QTY;

      // orders 테이블에 기록(요청 생성)
      const { data: o1, error: oErr } = await supabase
        .from("orders")
        .insert({
          ts,
          symbol,
          side: "buy",
          qty,
          order_type: "market",
          status: "new",
          broker: "alpaca",
        })
        .select("id")
        .single();
      if (oErr) throw oErr;

      const orderId = o1.id as number;

      try {
        const alp = await alpacaOrder(symbol, "buy", qty);

        await supabase.from("orders").update({
          status: alp.status ?? "submitted",
          broker_order_id: alp.id ?? null,
          error: null,
        }).eq("id", orderId);

        results.push({ symbol, order_id: orderId, alpaca_id: alp.id, status: alp.status });

      } catch (e) {
        await supabase.from("orders").update({
          status: "error",
          error: String(e),
        }).eq("id", orderId);

        results.push({ symbol, order_id: orderId, error: String(e) });
      }
    }

    return new Response(JSON.stringify({ ok: true, ts, placed: results.length, results: results.slice(0, 10) }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
