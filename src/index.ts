import { config } from "./config";
import { runOnce } from "./engine/runner";

async function main() {
  console.log(`[bot] start`, {
    exchange: config.exchange,
    symbol: config.symbol,
    timeframe: config.timeframe,
    dryRun: config.dryRun,
  });

  // 간단 폴링 루프
  while (true) {
    try {
      await runOnce();
    } catch (e: any) {
      console.error("[bot] error:", e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
}

main();
