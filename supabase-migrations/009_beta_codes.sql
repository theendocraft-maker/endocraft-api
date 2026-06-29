-- 009_beta_codes.sql
-- Server-validierte, pro Empfänger einzigartige Studio-Beta-Codes.
-- Codes liegen damit NICHT mehr im Frontend (nicht mehr erratbar) und sind einzeln deaktivierbar.

create table if not exists beta_codes (
  code         text primary key,
  email        text,
  label        text,
  credits      int  not null default 30,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  redeemed_at  timestamptz
);

create index if not exists beta_codes_email_idx on beta_codes (email);

-- Bestehende verteilte Codes übernehmen, damit aktuelle Tester nicht ausgesperrt werden.
insert into beta_codes (code, label, credits) values
  ('EC-RAVEN-7F3','legacy',30),
  ('EC-EMBER-2K9','legacy',30),
  ('EC-VEXX-5M1','legacy',30),
  ('EC-GLOOM-8Q4','legacy',30),
  ('EC-ORACLE-3H6','legacy',30),
  ('EC-FROST-9B2','legacy',30),
  ('EC-WYRM-4T7','legacy',30),
  ('EC-RELIC-6N8','legacy',30),
  ('EC-CRYPT-1J5','gael',30),
  ('EC-OMEN-7D3','larry',30)
on conflict (code) do nothing;

-- RLS: Validierung läuft serverseitig über den service_role-Key (Railway SUPABASE_KEY),
-- daher KEINE public-read-Policy nötig. RLS an lassen = Codes bleiben privat.
alter table beta_codes enable row level security;
