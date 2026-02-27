-- 001_init.sql
-- Core tables for Polygon -> Supabase ingestion + signal/order pipeline

-- Extensions (Supabase에서 허용되는 경우)
create extension if not exists pgcrypto;
create extension if not exists pg_stat_statements;
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- 1) Instruments (tickers)
create table if not exists public.instruments (
  symbol text primary key,
  name text,
  exchange text,
  asset_type text default 'stock',     -- stock/etf/index/etc
  currency text default 'USD',
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2) Universe snapshots (Top1000 스냅샷용)
create table if not exists public.universe_membership (
  as_of_date date not null,
  symbol text not null references public.instruments(symbol) on delete cascade,
  rank integer,
  market_cap numeric,
  avg_dollar_vol numeric,
  primary key (as_of_date, symbol)
);

create index if not exists idx_universe_membership_symbol on public.universe_membership(symbol);
create index if not exists idx_universe_membership_asof on public.universe_membership(as_of_date);

-- "오늘 기준" 유니버스 (가장 최신 as_of_date)
create or replace view public.universe_current as
select um.symbol, um.rank, um.market_cap, um.avg_dollar_vol, um.as_of_date
from public.universe_membership um
join (
  select max(as_of_date) as as_of_date
  from public.universe_membership
) t using (as_of_date);

-- 3) Ingestion state (per symbol cursor)
create table if not exists public.ingest_state (
  symbol text primary key references public.instruments(symbol) on delete cascade,
  last_ts timestamptz,
  last_status text,
  last_error text,
  updated_at timestamptz default now()
);

-- 4) Minute bars (1m OHLCV)
create table if not exists public.bars_1m (
  symbol text not null references public.instruments(symbol) on delete cascade,
  ts timestamptz not null,
  o double precision not null,
  h double precision not null,
  l double precision not null,
  c double precision not null,
  v double precision not null,
  vw double precision,
  n integer,
  src text default 'polygon',
  primary key (symbol, ts)
);

create index if not exists idx_bars_1m_ts on public.bars_1m (ts);
create index if not exists idx_bars_1m_symbol_ts on public.bars_1m (symbol, ts);

-- 5) Signals (model output)
create table if not exists public.signals (
  ts timestamptz not null,
  symbol text not null references public.instruments(symbol) on delete cascade,
  score double precision not null,
  edge_bps double precision,
  target_weight double precision not null,
  regime integer,
  model_version text default 'v0',
  created_at timestamptz default now(),
  primary key (ts, symbol)
);

create index if not exists idx_signals_ts on public.signals (ts);

-- 6) Orders & fills (broker execution 기록)
create table if not exists public.orders (
  id bigserial primary key,
  created_at timestamptz default now(),
  ts timestamptz, -- signal timestamp
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  qty double precision not null,
  order_type text default 'market',
  status text default 'new',
  broker text default 'alpaca',
  broker_order_id text,
  error text
);

create table if not exists public.fills (
  id bigserial primary key,
  created_at timestamptz default now(),
  order_id bigint references public.orders(id) on delete set null,
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  qty double precision not null,
  price double precision not null,
  fee double precision default 0
);

-- Optional: Row Level Security (권장)
-- Edge Functions는 SERVICE_ROLE_KEY를 쓰면 RLS를 우회할 수 있음.
alter table public.instruments enable row level security;
alter table public.universe_membership enable row level security;
alter table public.ingest_state enable row level security;
alter table public.bars_1m enable row level security;
alter table public.signals enable row level security;
alter table public.orders enable row level security;
alter table public.fills enable row level security;

-- 최소 정책: authenticated는 읽기 가능 (원하면 더 강화 가능)
do $$
begin
  -- instruments read
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='instruments' and policyname='read_instruments') then
    create policy read_instruments on public.instruments for select to authenticated using (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='bars_1m' and policyname='read_bars') then
    create policy read_bars on public.bars_1m for select to authenticated using (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='signals' and policyname='read_signals') then
    create policy read_signals on public.signals for select to authenticated using (true);
  end if;
end $$;
