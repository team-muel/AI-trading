export type Candle = {
  ts: string; // ISO
  open: number;
  close: number;
  volume: number;
};

export function computeDelta(c: Candle, deltaCoef: number) {
  return (c.close - c.open) * c.volume * deltaCoef;
}

export function computeCVDSeries(candles: Candle[], deltaCoef: number): number[] {
  const cvd: number[] = [];
  let acc = 0;
  for (const c of candles) {
    acc += computeDelta(c, deltaCoef);
    cvd.push(acc);
  }
  return cvd;
}

export function sma(series: number[], len: number): number[] {
  const out: number[] = new Array(series.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i];
    if (i >= len) sum -= series[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}
