import test from "node:test";
import assert from "node:assert/strict";
import { parseRunnerTickSource } from "../src/engine/tickSource";

test("parseRunnerTickSource accepts valid values", () => {
  assert.equal(parseRunnerTickSource("supabase"), "supabase");
  assert.equal(parseRunnerTickSource("binance"), "binance");
  assert.equal(parseRunnerTickSource(undefined), "supabase");
});

test("parseRunnerTickSource rejects invalid values", () => {
  assert.throws(() => parseRunnerTickSource("binanec"), /Invalid RUNNER_TICK_SOURCE/);
});
