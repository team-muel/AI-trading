-- supabase/schema.sql

create table if not exists public.candles (
  id bigserial primary key,
  exchange text not null,
  symbol text not null,
  timeframe text not null, -- '30m'
  ts timestamptz not null, -- candle open time (UTC recommended)
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric not null,
  created_at timestamptz not null default now()
);

create unique index if not exists candles_uniq
on public.candles(exchange, symbol, timeframe, ts);

create index if not exists candles_lookup
on public.candles(exchange, symbol, timeframe, ts desc);


create table if not exists public.bot_state (
  id bigserial primary key,
  exchange text not null,
  symbol text not null,
  timeframe text not null,
  last_ts timestamptz, -- last processed candle open time
  updated_at timestamptz not null default now()
);

create unique index if not exists bot_state_uniq
on public.bot_state(exchange, symbol, timeframe);


create type public.trade_side as enum ('long','short');
create type public.trade_status as enum ('open','closed','canceled','error');

create table if not exists public.trades (
  id bigserial primary key,
  exchange text not null,
  symbol text not null,
  timeframe text not null,
  side public.trade_side not null,
  entry_ts timestamptz not null,
  entry_price numeric not null,
  qty numeric not null,
  tp_price numeric,
  sl_price numeric,
  status public.trade_status not null default 'open',
  exchange_order_ids jsonb,
  meta jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists trades_lookup
on public.trades(exchange, symbol, timeframe, status, entry_ts desc);
