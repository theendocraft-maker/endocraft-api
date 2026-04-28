-- ════════════════════════════════════════════════════════════════════
-- EndoCraft · Live Multiplayer Dice
-- ════════════════════════════════════════════════════════════════════
-- Realtime-Sync für Würfel-Würfe zwischen DM Studio und Player View.
-- Scope = Party-Code (gleiche Party = gleicher Würfel-"Raum").
--
-- Tables:
--   roll_requests  · DM fragt eine Würfelung an ("Wis Save DC 16 für alle")
--   live_rolls     · Tatsächliche Würfe (entweder Antwort auf Request oder
--                    free-form Roll vom Spieler)
--
-- WICHTIG: Beide Tables müssen für Supabase Realtime aktiviert werden!
-- Im Supabase Dashboard → Database → Replication → enable für beide Tables.
-- ════════════════════════════════════════════════════════════════════

-- ───────── roll_requests ─────────
-- DM erstellt einen Würfel-Request für einen oder alle Spieler einer Party.
CREATE TABLE IF NOT EXISTS roll_requests (
  id              BIGSERIAL PRIMARY KEY,
  party_code      TEXT NOT NULL,                    -- referenziert parties.code
  dm_email        TEXT NOT NULL,                    -- der anfragende DM
  prompt          TEXT NOT NULL,                    -- z.B. "Wisdom Save · Deathly Choir"
  stat_type       TEXT,                             -- 'str','dex','con','int','wis','cha','attack','damage','custom'
  dc              INTEGER,                          -- DC (optional)
  target_emails   TEXT[],                           -- NULL = alle Member · sonst spezifische
  visibility      TEXT NOT NULL DEFAULT 'public',  -- 'public' alle sehen | 'dm_only' nur DM sieht Result
  expires_at      TIMESTAMPTZ,                      -- optional auto-cancel
  resolved_at     TIMESTAMPTZ,                      -- gesetzt wenn alle Targets gewürfelt haben
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS roll_requests_party_idx ON roll_requests (party_code, created_at DESC);
CREATE INDEX IF NOT EXISTS roll_requests_unresolved_idx ON roll_requests (party_code) WHERE resolved_at IS NULL;

-- ───────── live_rolls ─────────
-- Eigentliche Würfelwürfe — entweder als Antwort auf einen Request oder spontan.
CREATE TABLE IF NOT EXISTS live_rolls (
  id              BIGSERIAL PRIMARY KEY,
  party_code      TEXT NOT NULL,                    -- referenziert parties.code
  request_id      BIGINT REFERENCES roll_requests(id) ON DELETE SET NULL,
  player_email    TEXT NOT NULL,                    -- normalisiert lowercase
  player_name     TEXT,                             -- Display-Name (z.B. "Larrymäus")
  character_name  TEXT,                             -- Charakter (falls anders als player_name)
  stat            TEXT,                             -- z.B. 'wis', 'dex', 'attack'
  modifier        INTEGER NOT NULL DEFAULT 0,
  d20             INTEGER NOT NULL,                 -- 1..20
  total           INTEGER NOT NULL,                 -- d20 + modifier
  dc              INTEGER,                          -- der DC gegen den gewürfelt wurde
  is_crit         BOOLEAN GENERATED ALWAYS AS (d20 = 20) STORED,
  is_fumble       BOOLEAN GENERATED ALWAYS AS (d20 = 1) STORED,
  result_kind     TEXT,                             -- 'crit-success','success','fail','crit-fail',NULL
  visibility      TEXT NOT NULL DEFAULT 'public',  -- 'public' | 'dm_only'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_rolls_party_idx ON live_rolls (party_code, created_at DESC);
CREATE INDEX IF NOT EXISTS live_rolls_request_idx ON live_rolls (request_id) WHERE request_id IS NOT NULL;

-- ───────── RLS ─────────
-- Wir lassen RLS deaktiviert weil wir mit service_role aus dem Backend schreiben
-- und mit anon-key + party_code-Filter nur lesen. Sollten wir später direkten
-- anon-Write erlauben, müssen wir Policies hinzufügen.
ALTER TABLE roll_requests DISABLE ROW LEVEL SECURITY;
ALTER TABLE live_rolls DISABLE ROW LEVEL SECURITY;

-- ───────── Realtime Publication ─────────
-- WICHTIG: Im Supabase Dashboard zusätzlich aktivieren:
--   Database → Replication → supabase_realtime → roll_requests + live_rolls
-- Ohne diesen Schritt funktioniert die Realtime-Subscription NICHT.

-- ────────────── DONE ──────────────
-- Test-Queries:
--   INSERT INTO roll_requests (party_code, dm_email, prompt, stat_type, dc) VALUES ('TEST-CODE', 'test@x.de', 'WIS Save', 'wis', 16);
--   SELECT * FROM roll_requests WHERE party_code = 'TEST-CODE';
