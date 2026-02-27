AI-trading/
  README.md
  .gitignore
  LICENSE

  supabase/
    migrations/
      001_init.sql
      002_features.sql
    functions/
      polygon_ingest/
        index.ts
      build_features/
        index.ts
      generate_signals/
        index.ts
      execute_orders/          # (선택) Edge로 주문까지 하고 싶다면
        index.ts

  ingestion/                  # (선택) 로컬/백필용
    polygon_backfill.py
    universe_update.py

  ml/
    training/
      train_ranker.py
      train_classifier.py
    backtest/
      event_backtest.py
    features/
      feature_defs.py

  trading/
    broker/
      alpaca.py               # 또는 ibkr.py
    runner/
      order_executor.py       # signals 읽고 주문 실행

  configs/
    config.yaml
    symbols_top1000.csv       # (초기 시드)
  
  scripts/
    bootstrap_supabase.sql
    run_local.sh

  .github/
    workflows/
      ci.yml
