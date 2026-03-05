/**
 * Setup & configuration validator for AI-trading bot.
 *
 * Run with:  npm run setup
 *
 * Checks that all required environment variables are present and
 * (optionally) verifies connectivity to Supabase and Binance.
 */
import "dotenv/config";

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

function check(name: string, value: string | undefined, hint?: string): CheckResult {
  if (value && value.trim().length > 0) {
    return { name, ok: true, message: "✅  set" };
  }
  return {
    name,
    ok: false,
    message: `❌  missing — ${hint ?? `set ${name} in your .env file`}`,
  };
}

function checkNumber(name: string, raw: string | undefined, min?: number, max?: number): CheckResult {
  const num = Number(raw);
  if (!raw || Number.isNaN(num)) {
    return { name, ok: false, message: `❌  invalid number — set ${name} in your .env file` };
  }
  if (min !== undefined && num < min) {
    return { name, ok: false, message: `❌  value ${num} is below minimum ${min}` };
  }
  if (max !== undefined && num > max) {
    return { name, ok: false, message: `❌  value ${num} exceeds maximum ${max}` };
  }
  return { name, ok: true, message: `✅  ${num}` };
}

function printSection(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 50 - title.length))}`);
}

function printResult(r: CheckResult) {
  console.log(`   ${r.name.padEnd(30)} ${r.message}`);
}

async function run() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     AI-Trading Bot — Configuration Setup          ║");
  console.log("╚══════════════════════════════════════════════════╝");

  const results: CheckResult[] = [];

  // ── Supabase ────────────────────────────────────────────────────────────────
  printSection("Supabase");
  const supabaseChecks = [
    check(
      "SUPABASE_URL",
      process.env.SUPABASE_URL,
      "Your Supabase project URL, e.g. https://xxxx.supabase.co"
    ),
    check(
      "SUPABASE_SERVICE_ROLE_KEY",
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      "Service-role key from your Supabase project settings (never expose this to clients)"
    ),
  ];
  supabaseChecks.forEach((r) => {
    printResult(r);
    results.push(r);
  });

  // ── Binance ─────────────────────────────────────────────────────────────────
  printSection("Binance");
  const binanceChecks = [
    check("BINANCE_API_KEY", process.env.BINANCE_API_KEY, "Binance API key with Futures trading permission"),
    check("BINANCE_API_SECRET", process.env.BINANCE_API_SECRET, "Binance API secret"),
  ];
  binanceChecks.forEach((r) => {
    printResult(r);
    results.push(r);
  });

  // ── Strategy parameters ─────────────────────────────────────────────────────
  printSection("Strategy parameters");
  const strategyChecks = [
    checkNumber("CVD_LEN", process.env.CVD_LEN ?? "19", 2, 500),
    checkNumber("DELTA_COEF", process.env.DELTA_COEF ?? "1.0", 0.01, 10),
    checkNumber("RISK_PCT", process.env.RISK_PCT ?? "2.0", 0.1, 100),
    checkNumber("TP_PCT", process.env.TP_PCT ?? "4.0", 0.1, 100),
    checkNumber("SL_PCT", process.env.SL_PCT ?? "2.0", 0.1, 100),
    checkNumber("LEVERAGE", process.env.LEVERAGE ?? "20", 1, 125),
    checkNumber("INITIAL_CAPITAL", process.env.INITIAL_CAPITAL ?? "3000", 1),
  ];
  strategyChecks.forEach((r) => {
    printResult(r);
    results.push(r);
  });

  // ── Safety ──────────────────────────────────────────────────────────────────
  printSection("Safety");
  const dryRun = (process.env.DRY_RUN ?? "true") === "true";
  const dryRunResult: CheckResult = {
    name: "DRY_RUN",
    ok: true,
    message: dryRun ? "✅  true  (simulation mode — no real orders)" : "⚠️   false (LIVE trading enabled!)",
  };
  printResult(dryRunResult);
  results.push(dryRunResult);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "═".repeat(52));
  if (failed.length === 0) {
    console.log("✅  All checks passed — your bot is ready to run.");
    if (!dryRun) {
      console.log("⚠️   LIVE mode is enabled. Proceed with caution.");
    } else {
      console.log("💡  Tip: set DRY_RUN=false in .env to enable live trading.");
    }
  } else {
    console.log(`❌  ${failed.length} check(s) failed:`);
    failed.forEach((r) => console.log(`      • ${r.name}: ${r.message}`));
    console.log("\n   Copy .env.example to .env and fill in the missing values.");
    process.exitCode = 1;
  }
  console.log("═".repeat(52) + "\n");
}

run().catch((err) => {
  console.error("Setup script error:", err);
  process.exit(1);
});
