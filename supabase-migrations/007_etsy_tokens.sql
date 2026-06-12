-- Etsy OAuth-Token-Persistenz (1 Zeile, Server-Cache lädt beim Boot)
-- In Supabase SQL-Editor ausführen.
create table if not exists etsy_tokens (
  id integer primary key default 1,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  shop_id text,
  shop_name text,
  etsy_user_id text,
  updated_at timestamptz default now(),
  constraint single_row check (id = 1)
);
alter table etsy_tokens enable row level security;
-- Kein Public-Access: nur Service-Key (Backend) darf lesen/schreiben.
