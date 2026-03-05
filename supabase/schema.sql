create table if not exists public.candles (
  id bigserial primary key,
  exchange text not null,
  symbol text not null,
  timeframe text not null,
  ts timestamptz not null,
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
  last_ts timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists bot_state_uniq
on public.bot_state(exchange, symbol, timeframe);

create table if not exists public.trades (
  id bigserial primary key,
  exchange text not null,
  symbol text not null,
  timeframe text not null,
  side text not null check (side in ('long', 'short')),
  entry_ts timestamptz not null,
  entry_price numeric not null,
  qty numeric not null,
  tp_price numeric,
  sl_price numeric,
  status text not null default 'open' check (status in ('open', 'closed', 'canceled', 'error')),
  exchange_order_ids jsonb,
  meta jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists trades_lookup
on public.trades(exchange, symbol, timeframe, entry_ts desc);

create table if not exists public.trade_ticks (
  id bigserial primary key,
  exchange text not null,
  symbol text not null,
  ts timestamptz not null,
  exchange_trade_id text not null,
  price numeric not null,
  qty numeric not null,
  side text,
  created_at timestamptz not null default now()
);

create unique index if not exists trade_ticks_uniq
on public.trade_ticks(exchange, symbol, exchange_trade_id);

create index if not exists trade_ticks_lookup
on public.trade_ticks(exchange, symbol, ts desc);
