### 1) Supabase DB 준비
1. SQL Editor에서 `supabase/migrations/001_init.sql` 실행
2. (선택) `002_features.sql` 실행

### 2) Secrets 설정 (Supabase)
- `POLYGON_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- (선택) `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`

### 3) Edge Functions 배포
- `polygon_ingest`: Polygon → bars_1m upsert
- `build_features`: bars_1m → features_1m 갱신
- `generate_signals`: features_1m → signals 기록

### 4) Cron 스케줄
- pg_cron + pg_net으로 1분/5분마다 함수 호출

### 5) 운영 흐름
Cron → polygon_ingest → build_features → generate_signals → (execute_orders or 외부 실행기)
