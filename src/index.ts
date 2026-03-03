import { config } from "./config";
import { runOnce } from "./engine/runner";

async function main() {
  console.log("[bot] start", {
    exchange: config.exchange,
    symbols: config.symbols,
    timeframe: config.timeframe,
    dryRun: config.dryRun,
  });

  while (true) {
    try {
      await runOnce();
    } catch (e: any) {
      console.error("[bot] loop error:", e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
}

main();
