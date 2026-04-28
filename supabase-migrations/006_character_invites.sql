-- ════════════════════════════════════════════════════════════════════
-- EndoCraft · Charakter-Einladungen (ersetzt Party-Codes)
-- ════════════════════════════════════════════════════════════════════
-- Magic-Link-System: DM oder Spieler erstellt eine Einladung pro Charakter,
-- der Empfänger klickt den Link und ist sofort in der Kampagne als dieser
-- Charakter eingeloggt. Live-Dice-Scope wechselt von party_code zu campaign_id.
--
-- Tables:
--   character_invites · ein Eintrag pro Magic-Link-Token
--   campaign_members  · n:m Mapping Email ↔ Campaign (gefüllt nach accept)
-- ════════════════════════════════════════════════════════════════════

-- ───────── character_invites ─────────
CREATE TABLE IF NOT EXISTS character_invites (
  id              BIGSERIAL PRIMARY KEY,
  token           TEXT UNIQUE NOT NULL,             -- z.B. "inv_abc123def456"
  campaign_id     TEXT NOT NULL,                    -- referenziert dm_studio_state.campaign_id
  dm_email        TEXT NOT NULL,                    -- Owner der Kampagne
  character_id    TEXT,                             -- referenziert character.id in campaign-state
  character_name  TEXT,                             -- gecachet für Vorschau ohne Campaign-Lookup
  character_meta  TEXT,                             -- "Human Cleric · Lvl 5" (Vorschau)
  role            TEXT NOT NULL DEFAULT 'player',  -- 'player' | 'dm' (Co-DM-Einladung)
  invited_by      TEXT NOT NULL,                    -- Email des Einladenden (DM oder anderer Spieler)
  used_by         TEXT,                             -- Email des Spielers der Link genutzt hat
  used_at         TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,                      -- optional
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS character_invites_token_idx ON character_invites (token);
CREATE INDEX IF NOT EXISTS character_invites_campaign_idx ON character_invites (campaign_id);
CREATE INDEX IF NOT EXISTS character_invites_dm_idx ON character_invites (dm_email);

-- ───────── campaign_members ─────────
-- Wer ist in welcher Kampagne aktiv (akzeptierte Einladungen).
CREATE TABLE IF NOT EXISTS campaign_members (
  id              BIGSERIAL PRIMARY KEY,
  campaign_id     TEXT NOT NULL,
  dm_email        TEXT NOT NULL,                    -- Owner-Email (DM)
  member_email    TEXT NOT NULL,
  member_role     TEXT NOT NULL DEFAULT 'player',  -- 'player' | 'dm' (Co-DM)
  character_id    TEXT,                             -- der zugeordnete Charakter
  character_name  TEXT,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, dm_email, member_email)
);

CREATE INDEX IF NOT EXISTS campaign_members_member_idx ON campaign_members (member_email);
CREATE INDEX IF NOT EXISTS campaign_members_campaign_idx ON campaign_members (dm_email, campaign_id);

-- ───────── live_rolls + roll_requests scope-flexibel ─────────
-- Wir adden `campaign_room` als alternativen Scope-Schlüssel.
-- party_code bleibt für Legacy + Backward-Compatibility.
ALTER TABLE live_rolls       ADD COLUMN IF NOT EXISTS campaign_room TEXT;
ALTER TABLE roll_requests    ADD COLUMN IF NOT EXISTS campaign_room TEXT;
CREATE INDEX IF NOT EXISTS live_rolls_room_idx       ON live_rolls (campaign_room, created_at DESC) WHERE campaign_room IS NOT NULL;
CREATE INDEX IF NOT EXISTS roll_requests_room_idx    ON roll_requests (campaign_room, created_at DESC) WHERE campaign_room IS NOT NULL;

-- Convention für campaign_room: "${dm_email_lower}::${campaign_id}"
-- Bsp: "cx.ratti@gmx.de::cos"

-- ───────── RLS ─────────
ALTER TABLE character_invites DISABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_members  DISABLE ROW LEVEL SECURITY;

-- ───────── Realtime ─────────
-- Stellt sicher dass live_rolls + roll_requests weiterhin in der
-- supabase_realtime Publication sind (von 005_live_dice.sql).
-- Keine Action nötig falls schon aktiviert.

-- ────────────── DONE ──────────────
