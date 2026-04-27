-- ════════════════════════════════════════════════════════════════════
-- EndoCraft · Party Album Phase 2 · SQL Migration
-- ════════════════════════════════════════════════════════════════════
-- Erstellt zwei neue Tables:
--   parties        · ein Eintrag pro DM-Tisch, mit Beitritts-Code
--   party_members  · n:m Mapping User-Email ↔ Party
--
-- Damit kann ein DM eine Party erstellen (Code wird generiert), Spieler
-- treten via Code bei (ihre Email wird gespeichert) und das gemeinsame
-- Album der Party zeigt ALLE Sessions die irgendein Member auf /scroll/
-- erstellt hat.
--
-- Ausführen in Supabase Dashboard → SQL Editor → Run.
-- ════════════════════════════════════════════════════════════════════

-- ───────── parties ─────────
CREATE TABLE IF NOT EXISTS parties (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,            -- z.B. "STRAHD-7K2X" · 8-12 chars · case-insensitive lookup
  name          TEXT NOT NULL,                    -- z.B. "Curse of Strahd Tisch"
  dm_email      TEXT NOT NULL,                    -- Owner-Email (DM)
  campaign_id   TEXT,                             -- optional: link zu DM-Studio Campaign
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS parties_dm_email_idx ON parties (dm_email);
CREATE INDEX IF NOT EXISTS parties_code_lower_idx ON parties (LOWER(code));

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_parties_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS parties_updated_at_trg ON parties;
CREATE TRIGGER parties_updated_at_trg
BEFORE UPDATE ON parties
FOR EACH ROW EXECUTE FUNCTION update_parties_updated_at();

-- ───────── party_members ─────────
CREATE TABLE IF NOT EXISTS party_members (
  id            BIGSERIAL PRIMARY KEY,
  party_id      BIGINT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,                   -- Member-Email (DM oder Spieler)
  role          TEXT NOT NULL DEFAULT 'player', -- 'dm' | 'player'
  display_name  TEXT,                             -- optional · z.B. Charakter-Name
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (party_id, email)
);

CREATE INDEX IF NOT EXISTS party_members_email_idx ON party_members (email);
CREATE INDEX IF NOT EXISTS party_members_party_id_idx ON party_members (party_id);

-- ───────── RLS ─────────
-- Wir nutzen service_role im Backend (per Railway SUPABASE_KEY env), daher
-- bleiben die Tables ohne RLS-Policies — Backend kontrolliert Zugriff.
-- Falls du später direkt vom Frontend aus zugreifen willst (mit anon-key),
-- musst du Policies hinzufügen (z.B. "user can read parties they're member of").
ALTER TABLE parties DISABLE ROW LEVEL SECURITY;
ALTER TABLE party_members DISABLE ROW LEVEL SECURITY;

-- ────────────── DONE ──────────────
-- Test-Query: SELECT * FROM parties; SELECT * FROM party_members;
