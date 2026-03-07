import { config } from "./config";
import { runOnce } from "./engine/runner";
import { startInternalApiServer } from "./internal/server";

async function main() {
  startInternalApiServer();

  console.log("[bot] start", {
    exchange: config.exchange,
    symbols: config.symbols,
    timeframe: config.timeframe,
    dryRun: config.dryRun,
    runBotLoop: config.runBotLoop,
  });

  if (!config.runBotLoop) {
    console.log("[bot] RUN_BOT_LOOP=false -> internal API only mode");
    return;
  }

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
