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
