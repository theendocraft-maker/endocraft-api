-- 012_studio_assets.sql
-- Teilbare Studio-Assets: jede generierte Foto-/Video-Kreation kann einen Share-Link bekommen (/s/<id>).
-- Wird serverseitig über den service_role-Key beschrieben/gelesen; RLS bleibt an = privat (kein public read/write).

create table if not exists studio_assets (
  id          uuid primary key default gen_random_uuid(),
  media_type  text not null check (media_type in ('image','video')),
  kind        text,                       -- npc | monster | location | item
  url         text not null,              -- Original-Asset-URL (Seedream-Bild bzw. Kling-Clip)
  subject     text,                       -- Beschreibung, die der Nutzer eingegeben hat
  code        text,                       -- optional: welcher Beta-Code hat es erstellt (für Tracking)
  created_at  timestamptz not null default now()
);

create index if not exists studio_assets_created_idx on studio_assets (created_at desc);
create index if not exists studio_assets_code_idx    on studio_assets (code);

alter table studio_assets enable row level security;
-- Keine public-Policy: Validierung/Render läuft serverseitig über den service_role-Key (Railway SUPABASE_KEY).
