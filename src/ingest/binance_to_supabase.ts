async function ingestSymbol(ex: any, symbol: string) {
  const tfMs = timeframeToMs(TIMEFRAME);
  const limit = 1000;

  // DB 최신 ts
  const latestMs = await getLatestTsFromDB(symbol);

  // 백필 시작점: DB가 비어있으면 BACKFILL_DAYS 기준으로 과거부터
  const backfillDays = Number(process.env.BACKFILL_DAYS ?? 21); // 기본 21일 (1000개 30m 근처)
  const earliestTarget = Date.now() - backfillDays * 24 * 60 * 60 * 1000;

  let since = latestMs ? latestMs + 1 : earliestTarget;

  let totalInserted = 0;
  let loops = 0;

  while (true) {
    loops += 1;

    const ohlcvRaw: ccxt.OHLCV[] = await ex.fetchOHLCV(symbol, TIMEFRAME, since, limit);

    // 데이터가 없으면 종료
    if (!ohlcvRaw || ohlcvRaw.length === 0) break;

    // 안전: 마지막 1개(미완성) 제거
    const ohlcv = ohlcvRaw.slice(0, -1);
    if (ohlcv.length === 0) break;

    const rows: CandleRow[] = ohlcv.map((c) => {
      const [t, o, h, l, cl, v] = c;
      return {
        exchange: EXCHANGE,
        symbol,
        timeframe: TIMEFRAME,
        ts: new Date(t).toISOString(),
        open: Number(o),
        high: Number(h),
        low: Number(l),
        close: Number(cl),
        volume: Number(v),
      };
    });

    await upsertCandles(rows);
    totalInserted += rows.length;

    const first = rows[0]?.ts;
    const last = rows[rows.length - 1]?.ts;

    console.log(
      `[ingest] ${symbol} page=${loops} fetched=${ohlcvRaw.length} inserted=${rows.length}` +
        (first && last ? ` range=${first} → ${last}` : "")
    );

    // 다음 페이지 since: 마지막 캔들 다음부터
    const lastMs = new Date(rows[rows.length - 1].ts).getTime();
    since = lastMs + 1;

    // 최신에 거의 도달했으면 종료 (현재 시간 기준 2개 봉 정도 여유)
    if (since >= Date.now() - tfMs * 2) break;

    // 너무 많이 돌지 않게 안전장치(원하면 조정)
    if (loops >= 50) break;

    // 레이트리밋 완화
    await new Promise((r) => setTimeout(r, 250));
  }

  if (totalInserted === 0) {
    console.log(`[ingest] ${symbol} up-to-date (no new closed candles)`);
  }
}
