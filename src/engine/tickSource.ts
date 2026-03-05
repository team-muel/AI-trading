export type RunnerTickSource = "supabase" | "binance";

export function parseRunnerTickSource(raw: string | undefined): RunnerTickSource {
  const v = (raw ?? "supabase").trim().toLowerCase();
  if (v === "supabase" || v === "binance") {
    return v;
  }
  throw new Error(`Invalid RUNNER_TICK_SOURCE: ${raw}. Allowed: supabase, binance`);
}
