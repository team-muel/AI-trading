# Order Flow CVD Bot (Supabase 기반 자동매매)

TradingView(Pine) 전략 로직을 서버(Typescript)에서 재현하여,  
**Supabase(Postgres)에 저장된 30분봉 데이터**를 기준으로 신호를 계산하고  
**Binance(현물/선물)** 에 주문(진입 + TP/SL)을 실행하는 봇 템플릿입니다.

> ✅ 추천: 처음엔 반드시 `DRY_RUN=true` 로 시뮬레이션부터 돌리세요.  
> ✅ 전제: Supabase에 `candles` 테이블로 30m 캔들이 지속적으로 적재되고 있어야 합니다.

---

## ✨ Features

- Supabase에서 OHLCV(30m) 읽기
- CVD / CVD SMA 계산 후 Cross 신호 발생 시 진입
- 진입과 동시에 TP/SL 주문(조건 주문) 생성
- `bot_state.last_ts` 로 **중복 실행 방지 / 재시작 복구**
- `.env` 기반 설정, 심볼/파라미터 변경 쉬움

---

## 🧱 Architecture (한눈에 보기)

1. **Ingest(별도 서비스/크론)**  
   Binance → 30m 캔들 수집 → Supabase `candles` upsert
2. **Bot (이 레포)**  
   Supabase 최신 캔들 확인 → 전략 계산 → 주문 실행 → 상태 저장

---

## Tick Data Lake Pipeline (권장)

틱 원본은 Supabase에 넣지 않고 파일 레이크로 운영합니다.

1. 실시간 수집 (aggTrade WebSocket)
   `npm run tick:collect`

- 출력: `data/raw/symbol=.../date=YYYY-MM-DD/hour=HH/part-xxx.ndjson`
- 기본 최대 파일 크기: `TICK_RAW_MAX_FILE_MB=128`

2. 주기적 변환 (DuckDB -> Parquet/ZSTD)
   `npm run tick:convert`

- 입력: `data/raw/**/*.ndjson`
- 출력: `data/parquet/symbol=.../date=.../hour=.../*.parquet`
- 변환 후 raw 파일 archive 이동 기본값: `TICK_ARCHIVE_AFTER_CONVERT=true`

3. GCS 업로드
   `npm run tick:upload`

- 필요 env: `TICK_GCS_URI=gs://<bucket>/<prefix>`
- 내부 명령: `gsutil -m rsync -r data/parquet gs://...`

4. Parquet 기반 백테스트
   `npm run backtest:tv:parquet`

- 기본 입력: `BT_PARQUET_GLOB=data/parquet/**/*.parquet`
- GCS 직접 읽기 시 DuckDB 초기화 SQL을 `BT_DUCKDB_INIT_SQL` 로 주입 가능

핵심 원칙:

- `trade_ticks` 같은 대용량 틱 원본은 Supabase에 적재하지 않음
- Supabase는 `trades`, `bot_state` 같은 운영 로그/상태 저장 용도로만 사용

---

## ✅ Requirements

- Node.js 18+ (권장 20+)
- Supabase 프로젝트 (Postgres)
- Binance API Key/Secret
  - 선물 사용 시 **USDT-M Futures 권한 필요**
- (중요) `SUPABASE_SERVICE_ROLE_KEY` 사용
  - **절대 프론트엔드/클라이언트에 노출 금지**

---

## 🚀 Quick Start

### 1) 프로젝트 클론 & 의존성 설치

```bash
git clone <YOUR_REPO_URL>
cd orderflow-cvd-bot
npm install
```

### 2) discord-news-bot 연동용 내부 API

이 서비스는 봇 루프와 함께 내부 API를 동시에 실행합니다.

- `POST /internal/binance/order`
- `GET /internal/binance/position?symbol=BTCUSDT`

기본 실행 주소:

- `http://0.0.0.0:8787`

필수/권장 환경변수:

- `AI_TRADING_INTERNAL_TOKEN` (권장: 필수처럼 운영)
- `AI_TRADING_HTTP_ENABLED` (기본 `true`)
- `AI_TRADING_HOST` (기본 `0.0.0.0`)
- `AI_TRADING_PORT` (기본 `8787`, 미설정 시 `PORT` fallback)
- `AI_TRADING_ORDER_PATH` (기본 `/internal/binance/order`)
- `AI_TRADING_POSITION_PATH` (기본 `/internal/binance/position`)
- `RUN_BOT_LOOP` (기본 `true`, API 전용 서비스면 `false` 권장)

`discord-news-bot` 쪽에는 아래를 동일하게 맞추면 됩니다.

- `AI_TRADING_BASE_URL=http://<this-service-host>:8787`
- `AI_TRADING_INTERNAL_TOKEN=<same-token>`
- `AI_TRADING_ORDER_PATH=/internal/binance/order`
- `AI_TRADING_POSITION_PATH=/internal/binance/position`

### 3) Vercel(프론트) + Render(백엔드/AI-trading) 권장 연결

구성:

- Frontend: Vercel (`muel-front-uiux`)
- Backend API: Render (`discord-news-bot`)
- AI-trading: Render (이 저장소)

AI-trading(Render) 권장 env:

- `AI_TRADING_HTTP_ENABLED=true`
- `RUN_BOT_LOOP=false` (프록시 전용 운영)
- `AI_TRADING_INTERNAL_TOKEN=<random-strong-token>`
- `DRY_RUN=true` (초기 검증), 실운영 시 `false`
- `BINANCE_API_KEY`, `BINANCE_API_SECRET`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

discord-news-bot(Render) env:

- `AI_TRADING_BASE_URL=https://<ai-trading-render-domain>`
- `AI_TRADING_INTERNAL_TOKEN=<same-token>`
- `AI_TRADING_ORDER_PATH=/internal/binance/order`
- `AI_TRADING_POSITION_PATH=/internal/binance/position`

Vercel(프론트) env:

- `VITE_API_BASE=https://<discord-news-bot-render-domain>`

초기 원격 점검:

1. `GET https://<ai-trading-render-domain>/health`
2. `GET https://<discord-news-bot-render-domain>/health`
3. 로그인 세션 후 `GET /api/trading/position?symbol=BTCUSDT`
4. 관리자 권한으로 `POST /api/trades` (`executeOrder=true`)
