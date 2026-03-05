export function toBinanceSymbol(symbol: string, futures: boolean): string {
  const s = symbol.trim();
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
