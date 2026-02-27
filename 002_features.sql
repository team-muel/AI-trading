-- 002_features.sql
-- Feature table + helper indexes for fast incremental computation

create table if not exists public.features_1m (
  symbol text not null references public.instruments(symbol) on delete cascade,
  ts timestamptz not null,
  ret1 double precision,
  ret5 double precision,
  ret15 double precision,
  rv60 double precision,
  rsi14 double precision,
  dvol60 double precision,
  vxx_z120 double precision,  -- VXX z-score proxy
  regime integer,
  created_at timestamptz default now(),
  primary key (symbol, ts)
);

create index if not exists idx_features_1m_ts on public.features_1m(ts);
create index if not exists idx_features_1m_symbol_ts on public.features_1m(symbol, ts);

alter table public.features_1m enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='features_1m' and policyname='read_features') then
    create policy read_features on public.features_1m for select to authenticated using (true);
  end if;
end $$;
