import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BATCH_SIZE = Number(Deno.env.get("BATCH_SIZE") ?? "200");
const LOOKBACK_MINUTES = Number(Deno.env.get("FEATURE_LOOKBACK_MINUTES") ?? "200");
const REGIME_Z_LOOKBACK = Number(Deno.env.get("REGIME_Z_LOOKBACK") ?? "120");

const MARKET_SYMBOL = Deno.env.get("MARKET_SYMBOL") ?? "SPY";
const VXX_SYMBOL = Deno.env.get("VXX_SYMBOL") ?? "VXX";

type BarRow = { ts: string; c: number; v: number };

function mean(a: number[]) { return a.reduce((s, x) => s + x, 0) / Math.max(1, a.length); }
function std(a: number[]) {
  const m = mean(a);
  const v = mean(a.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}
function pct(a: number, b: number) { return (a / (b + 1e-12)) - 1; }

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses += -d;
  }
  const rs = gains / (losses + 1e-12);
  return 100 - (100 / (1 + rs));
}

function regimeFromZ(z: number): number {
  // 0: 매우 안정, 1: 안정, 2: 변동, 3: 고변동
  if (z <= -0.5) return 0;
  if (z <= 0.5) return 1;
  if (z <= 1.5) return 2;
  return 3;
}

serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const batchId = Number(body.batch_id ?? 0);

    // 1) 대상 심볼 가져오기 (유니버스 우선)
    let symbols: string[] = [];
    {
      const { data, error } = await supabase.from("universe_current").select("symbol").order("symbol");
      if (!error && data?.length) symbols = data.map((x: any) => x.symbol);
      if (!symbols.length) {
        const r2 = await supabase.from("instruments").select("symbol").eq("is_active", true).order("symbol");
        if (r2.error) throw r2.error;
        symbols = (r2.data ?? []).map((x: any) => x.symbol);
      }
    }

    const start = batchId * BATCH_SIZE;
    const end = Math.min(symbols.length, start + BATCH_SIZE);
    const slice = symbols.slice(start, end);

    // 2) 시장 레짐 계산용 VXX/시장 바 가져오기 (최근 LOOKBACK)
    const { data: vxxBars, error: vErr } = await supabase
      .from("bars_1m")
      .select("ts,c")
      .eq("symbol", VXX_SYMBOL)
      .order("ts", { ascending: true })
      .limit(Math.max(LOOKBACK_MINUTES, REGIME_Z_LOOKBACK) + 10);
    if (vErr) throw vErr;
    if (!vxxBars?.length) throw new Error(`Missing bars for ${VXX_SYMBOL}. Insert VXX into instruments and ingest it.`);

    const vxxC = vxxBars.map((x: any) => Number(x.c));
    const zBase = vxxC.slice(-REGIME_Z_LOOKBACK);
    const z = (zBase[zBase.length - 1] - mean(zBase)) / (std(zBase) + 1e-12);
    const regime = regimeFromZ(z);

    // "최신 기준 ts"를 VXX 최신 ts로 둔다(동기화 목적)
    const latestTs = vxxBars[vxxBars.length - 1].ts;

    // 3) 심볼별 features 계산(최근 LOOKBACK 구간만)
    let upserts = 0;

    for (const sym of slice) {
      if (sym === MARKET_SYMBOL || sym === VXX_SYMBOL) continue;

      const { data: bars, error } = await supabase
        .from("bars_1m")
        .select("ts,c,v")
        .eq("symbol", sym)
        .order("ts", { ascending: true })
        .limit(LOOKBACK_MINUTES + 70);
      if (error) throw error;
      if (!bars?.length) continue;

      const closes = bars.map((b: any) => Number(b.c));
      const vols = bars.map((b: any) => Number(b.v));
      const tss = bars.map((b: any) => String(b.ts));

      // 마지막 ts만 계산해서 저장(가볍게 운영) - 필요시 여러 행으로 확장 가능
      const i = closes.length - 1;
      const c0 = closes[i];
      const c1 = closes[i - 1] ?? c0;
      const c5 = closes[i - 5] ?? c0;
      const c15 = closes[i - 15] ?? c0;

      // realized vol proxy: std(ret1) over last 60
      const rets: number[] = [];
      for (let k = Math.max(1, closes.length - 60); k < closes.length; k++) {
        rets.push(pct(closes[k], closes[k - 1]));
      }
      const rv60 = std(rets);

      // dollar volume 60: mean(close*vol)
      const dv: number[] = [];
      for (let k = Math.max(0, closes.length - 60); k < closes.length; k++) dv.push(closes[k] * vols[k]);
      const dvol60 = mean(dv);

      const rsi14 = rsi(closes, 14);

      const row = {
        symbol: sym,
        ts: tss[i], // symbol 최신 ts
        ret1: pct(c0, c1),
        ret5: pct(c0, c5),
        ret15: pct(c0, c15),
        rv60,
        rsi14,
        dvol60,
        vxx_z120: z,
        regime,
      };

      const { error: upErr } = await supabase.from("features_1m").upsert([row], { onConflict: "symbol,ts" });
      if (upErr) throw upErr;
      upserts += 1;
    }

    return new Response(JSON.stringify({ ok: true, batch_id: batchId, processed: slice.length, upserts, regime, vxx_z: z, anchor_ts: latestTs }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
