import test from "node:test";
import assert from "node:assert/strict";
import { toBinanceSymbol } from "../src/exchange/symbol";

test("toBinanceSymbol futures conversion", () => {
  assert.equal(toBinanceSymbol("BTC/USDT", true), "BTC/USDT:USDT");
  assert.equal(toBinanceSymbol("BTC/USDT:USDT", true), "BTC/USDT:USDT");
});

test("toBinanceSymbol spot conversion", () => {
  assert.equal(toBinanceSymbol("BTC/USDT:USDT", false), "BTC/USDT");
  assert.equal(toBinanceSymbol("ETH/USDT", false), "ETH/USDT");
});
