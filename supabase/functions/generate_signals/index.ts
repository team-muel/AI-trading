import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TOP_K = Number(Deno.env.get("TOP_K") ?? "20");
const MAX_POS = Number(Deno.env.get("MAX_POS") ?? "20");
const MIN_EDGE_BPS = Number(Deno.env.get("MIN_EDGE_BPS") ?? "6");
const MODEL_VERSION = Deno.env.get("MODEL_VERSION") ?? "v0";

function clamp(x: number, a: number, b: number) { return Math.max(a, Math.min(b, x)); }

serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 최신 feature timestamp 찾기 (유니버스 종목 중)
    const { data: latest, error: lErr } = await supabase
      .from("features_1m")
      .select("ts")
      .order("ts", { ascending: false })
      .limit(1);
    if (lErr) throw lErr;
    if (!latest?.length) throw new Error("features_1m is empty. Run build_features first.");
    const ts = latest[0].ts;

    // 해당 ts의 피처들 가져오기
    const { data: feats, error: fErr } = await supabase
      .from("features_1m")
      .select("symbol,ts,ret15,rv60,rsi14,dvol60,regime,vxx_z120")
      .eq("ts", ts);
    if (fErr) throw fErr;

    if (!feats?.length) throw new Error("No features at latest ts");

    // score baseline:
    // - 모멘텀( ret15 ) 높고
    // - 변동성( rv60 ) 낮을수록 선호
    // - RSI 과열(>80) 페널티
    const scored = feats.map((x: any) => {
      const ret15 = Number(x.ret15 ?? 0);
      const rv60 = Number(x.rv60 ?? 0);
      const rsi = Number(x.rsi14 ?? 50);
      const rsiPenalty = rsi > 80 ? 0.5 : rsi < 20 ? -0.2 : 0.0;
      const score = (ret15 * 1000) - (rv60 * 500) - rsiPenalty; // 임의 스케일
      // edge_bps proxy: ret15(bps) - vol(bps)
      const edge_bps = (ret15 * 1e4) - (rv60 * 1e4);
      return { ...x, score, edge_bps };
    });

    // 비용 필터
    const filtered = scored.filter((x: any) => Number(x.edge_bps) >= MIN_EDGE_BPS);
    filtered.sort((a: any, b: any) => Number(b.score) - Number(a.score));

    const picks = filtered.slice(0, Math.min(TOP_K, MAX_POS));
    if (!picks.length) {
      return new Response(JSON.stringify({ ok: true, ts, picks: 0, note: "No candidates passed min_edge_bps." }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // weight: inverse vol-like using rv60 (낮은 변동성에 더 큰 비중)
    const inv = picks.map((x: any) => 1 / Math.max(1e-6, Number(x.rv60 ?? 1e-3)));
    const s = inv.reduce((a, b) => a + b, 0);

    const rows = picks.map((x: any, i: number) => ({
      ts,
      symbol: x.symbol,
      score: Number(x.score),
      edge_bps: Number(x.edge_bps),
      target_weight: clamp(inv[i] / (s + 1e-12), 0.01, 0.10),
      regime: Number(x.regime ?? 0),
      model_version: MODEL_VERSION,
    }));

    // 정규화(클램프 후 합계 1로)
    const sumW = rows.reduce((a, r) => a + r.target_weight, 0);
    rows.forEach((r) => (r.target_weight = r.target_weight / (sumW + 1e-12)));

    const { error: upErr } = await supabase.from("signals").upsert(rows, { onConflict: "ts,symbol" });
    if (upErr) throw upErr;

    return new Response(JSON.stringify({ ok: true, ts, picks: rows.length, top: rows.slice(0, 5) }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
