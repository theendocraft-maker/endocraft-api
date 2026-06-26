-- ─── Wishes-Feature · 2026-06-16 ───
-- Adds wish text column to free_pack_leads so users can submit their adventure wishes
-- after grabbing the free pack on /free thank-you screen.
--
-- Run this in Supabase SQL editor:

ALTER TABLE free_pack_leads
  ADD COLUMN IF NOT EXISTS wish TEXT;

-- Optional: index for filtering "leads with wishes" in cockpit
CREATE INDEX IF NOT EXISTS idx_free_pack_leads_has_wish
  ON free_pack_leads (created_at DESC) WHERE wish IS NOT NULL;

-- That's it. Marco runs this once, then deploy the backend.
