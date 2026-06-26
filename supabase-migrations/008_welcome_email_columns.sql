-- Migration 008: Welcome-Email-Sequence columns
-- Created 2026-06-16 · Prepares free_pack_leads for Resend-based 3-email drip
-- Run via Supabase Dashboard SQL Editor when Resend signup is done

-- Add unsubscribe-token (UUID, auto-generated for new rows)
ALTER TABLE free_pack_leads
  ADD COLUMN IF NOT EXISTS unsubscribe_token UUID DEFAULT gen_random_uuid();

-- Add unsubscribe timestamp (null = subscribed)
ALTER TABLE free_pack_leads
  ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;

-- Track which emails have been sent (null = not sent yet)
ALTER TABLE free_pack_leads
  ADD COLUMN IF NOT EXISTS email_1_sent_at TIMESTAMPTZ;

ALTER TABLE free_pack_leads
  ADD COLUMN IF NOT EXISTS email_2_sent_at TIMESTAMPTZ;

ALTER TABLE free_pack_leads
  ADD COLUMN IF NOT EXISTS email_3_sent_at TIMESTAMPTZ;

-- Backfill existing rows with unsubscribe-tokens (for the 2 existing leads)
UPDATE free_pack_leads
SET unsubscribe_token = gen_random_uuid()
WHERE unsubscribe_token IS NULL;

-- Index for efficient cron-job queries
CREATE INDEX IF NOT EXISTS idx_free_pack_leads_email_2_sent
  ON free_pack_leads(email_1_sent_at, email_2_sent_at, unsubscribed_at)
  WHERE email_1_sent_at IS NOT NULL AND email_2_sent_at IS NULL AND unsubscribed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_free_pack_leads_email_3_sent
  ON free_pack_leads(email_2_sent_at, email_3_sent_at, unsubscribed_at)
  WHERE email_2_sent_at IS NOT NULL AND email_3_sent_at IS NULL AND unsubscribed_at IS NULL;

-- Verification queries (run after migration to confirm):
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'free_pack_leads' AND column_name LIKE 'email_%';
-- SELECT COUNT(*), COUNT(unsubscribe_token) FROM free_pack_leads;

COMMENT ON COLUMN free_pack_leads.unsubscribe_token IS 'UUID for unsubscribe-link, auto-generated on insert';
COMMENT ON COLUMN free_pack_leads.unsubscribed_at IS 'Timestamp when user clicked unsubscribe link';
COMMENT ON COLUMN free_pack_leads.email_1_sent_at IS 'Welcome email sent immediately on signup';
COMMENT ON COLUMN free_pack_leads.email_2_sent_at IS 'Pro-Tip email sent T+3 days after email_1';
COMMENT ON COLUMN free_pack_leads.email_3_sent_at IS 'Curse of Strahd hint email sent T+7 days after email_1';
