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

// (추천) '트레이드당 리스크'를 진짜로 맞추는 방식:
// qty = (equity * riskPct) / (price * slPct)
// export function sizeByStopRisk(...) { ... }
