function normalizeCompactUsdtSymbol(input: string): string {
  const s = input.trim().toUpperCase();
  if (!s || s.includes("/") || s.includes(":")) return input.trim();

  // BTCUSDT -> BTC/USDT
  if (s.endsWith("USDT") && s.length > 4) {
    return `${s.slice(0, -4)}/USDT`;
  }

  return input.trim();
}

export function toBinanceSymbol(symbol: string, futures: boolean): string {
  const s = normalizeCompactUsdtSymbol(symbol);
  if (!s) return s;

  if (futures) {
    // Convert BTC/USDT -> BTC/USDT:USDT for Binance USDT-M futures if needed.
    if (s.includes(":")) return s;
    const parts = s.split("/");
    if (parts.length === 2 && parts[1] === "USDT") {
      return `${parts[0]}/${parts[1]}:USDT`;
    }
    return s;
  }

  // Spot symbols should not include settlement suffix.
  if (!s.includes(":")) return s;
  return s.split(":")[0];
}
