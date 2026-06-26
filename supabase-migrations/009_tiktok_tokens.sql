-- Migration 009: TikTok Content Posting API token storage
-- Run via Supabase Dashboard SQL Editor (einmalig, nach TikTok-App-Registrierung).
CREATE TABLE IF NOT EXISTS tiktok_tokens (
  id INT PRIMARY KEY DEFAULT 1,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  refresh_expires_at TIMESTAMPTZ,
  open_id TEXT,
  scope TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT tiktok_tokens_singleton CHECK (id = 1)
);
