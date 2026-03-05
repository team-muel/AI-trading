export function sizeByExposure(params: {
  equity: number;
  riskPct: number;
  leverage: number;
  price: number;
}) {
  const riskFrac = params.riskPct / 100.0;
  const exposure = params.equity * riskFrac * params.leverage;
  const qty = exposure / params.price;
  return { qty, exposure };
}
