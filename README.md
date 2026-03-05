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
