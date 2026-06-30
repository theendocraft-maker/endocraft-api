-- 013_studio_asset_slug.sql
-- Kurze Share-IDs: /s/<slug> (7 Zeichen) statt der langen UUID. Rückwärtskompatibel (alte UUID-Links funktionieren weiter).
alter table studio_assets add column if not exists slug text;
create unique index if not exists studio_assets_slug_idx on studio_assets (slug);
