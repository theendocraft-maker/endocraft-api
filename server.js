const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
const { rollRarity, buildRarityPromptModifier } = require('./rarity');

// Optional sharp dependency — used in /img/:id to transcode WebP → JPEG so WhatsApp / Slack /
// Messenger can render link previews. If not installed, proxy falls back to passthrough and
// WebP images will text-only preview on WhatsApp. Graceful degradation either way.
let sharp;
try { sharp = require('sharp'); }
catch (e) { console.warn('[img proxy] sharp not available — WhatsApp previews may fail for WebP images. Installing will fix.'); }

// Deterministic slug from email — 16 hex chars of sha256(lowercase trimmed email)
// Same algorithm as the SQL backfill, so existing + new cards match
function emailToSlug(email){
  return crypto.createHash('sha256')
    .update(String(email || '').toLowerCase().trim())
    .digest('hex')
    .slice(0, 16);
}
app.use(cors());
app.use(express.json({ limit: '10mb' }));
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
const AIML_KEY = process.env.AIML_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 8080;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'EndoCraft API' });
});

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }
  // 🎲 Rarity-Roll passiert HIER, bevor Claude aufgerufen wird
  const { rarity, visibleRoll } = rollRarity();
  const rarityModifier = buildRarityPromptModifier(rarity);
  const modifiedBody = {
    ...req.body,
    system: `${rarityModifier}\n\n${req.body.system || ''}`
  };
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(modifiedBody)
    });
    const data = await response.json();
    res.status(response.status).json({
      ...data,
      rarity,
      visible_roll: visibleRoll
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DM STUDIO CHAT — AI co-DM for TTRPG tables with full campaign context.
// Different from /api/chat (Session Scroll Rarity flow) — no rarity roll,
// and accepts a structured `campaign` block that's serialized into the system
// prompt so Claude has full awareness of party, locations, sessions.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/dm-chat', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });
  try {
    const { campaign, messages, model = 'claude-sonnet-4-6', max_tokens = 1500 } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // Build a rich system prompt from the campaign structure. Claude needs:
    // campaign name + session metadata + party + serialized locations + current-location focus.
    const loc = campaign?.locations?.[campaign?.currentLocationId] || null;
    const locationsDump = Object.entries(campaign?.locations || {})
      .map(([id, l]) => {
        const parts = [];
        parts.push(`[${id}] ${l.name}${l.meta ? ' · ' + l.meta : ''}`);
        if (l.readAloud) parts.push(`  READ-ALOUD: ${l.readAloud.replace(/\n/g, ' ')}`);
        if (l.dmNote) parts.push(`  DM-NOTE: ${l.dmNote}`);
        if (l.scenarios?.length) parts.push('  SZENARIEN: ' + l.scenarios.map(s => `"${s.title}" (${s.probability}): ${s.body}`).join(' | '));
        if (l.dialogs?.length) parts.push('  DIALOGE: ' + l.dialogs.map(d => `${d.speaker}: ${d.text}`).join(' | '));
        if (l.statblocks?.length) parts.push('  STATS: ' + l.statblocks.map(s => `${s.name} [${s.rows.map(r => r.join(': ')).join(', ')}]`).join(' | '));
        if (l.history) parts.push(`  HISTORIE: ${l.history}`);
        return parts.join('\n');
      }).join('\n\n');

    // Serialize characters in classic D&D 5e statblock format so Claude can reference exact
    // stats, saves, attacks, resistances — same shape as SRD/Monster Manual entries.
    const mod = s => Math.floor((s - 10) / 2);
    const fmt = n => (n >= 0 ? '+' : '') + n;
    const charsDump = (campaign?.characters || []).map(c => {
      const tag = c.type === 'pc' ? 'PC' : 'NPC';
      const lines = [];
      lines.push(`═══ [${tag}] ${c.name} ═══`);
      lines.push(`${c.size || 'Medium'} ${c.creatureType || c.race || ''}, ${c.alignment || 'unaligned'}`);
      if (c.type === 'pc') lines.push(`${c.race || ''} ${c.class || ''} · Level ${c.level}`);
      lines.push(`AC ${c.ac}${c.acType ? ` (${c.acType})` : ''} · HP ${c.hp}/${c.maxHp}${c.hitDice ? ` (${c.hitDice})` : ''} · Speed ${c.speed || '30 ft.'}`);
      if (c.stats) {
        const s = c.stats;
        lines.push(`STR ${s.str}(${fmt(mod(s.str))}) DEX ${s.dex}(${fmt(mod(s.dex))}) CON ${s.con}(${fmt(mod(s.con))}) INT ${s.int}(${fmt(mod(s.int))}) WIS ${s.wis}(${fmt(mod(s.wis))}) CHA ${s.cha}(${fmt(mod(s.cha))})`);
      }
      if (c.savingThrows) lines.push(`Saving Throws: ${c.savingThrows}`);
      if (c.skills) lines.push(`Skills: ${c.skills}`);
      if (c.damageResistances) lines.push(`Damage Resistances: ${c.damageResistances}`);
      if (c.damageImmunities) lines.push(`Damage Immunities: ${c.damageImmunities}`);
      if (c.conditionImmunities) lines.push(`Condition Immunities: ${c.conditionImmunities}`);
      if (c.senses) lines.push(`Senses: ${c.senses}`);
      if (c.languages) lines.push(`Languages: ${c.languages}`);
      if (c.type === 'npc' && c.cr) lines.push(`Challenge: ${c.cr}${c.xp ? ` (${c.xp} XP)` : ''}`);
      const sec = (title, items) => {
        if (!items?.length) return '';
        return `\n${title}:\n` + items.map(it => `• ${it.name}: ${it.text}`).join('\n');
      };
      lines.push(sec('Traits', c.traits));
      lines.push(sec('Actions', c.actions));
      lines.push(sec('Bonus Actions', c.bonusActions));
      lines.push(sec('Reactions', c.reactions));
      lines.push(sec('Legendary Actions', c.legendaryActions));
      if (c.backstory) lines.push(`\nBACKSTORY: ${c.backstory}`);
      if (c.personality) lines.push(`PERSONALITY: ${c.personality}`);
      if (c.notes) lines.push(`DM-NOTES: ${c.notes}`);
      return lines.filter(l => l).join('\n');
    }).join('\n\n\n');

    // Serialize active combat state (HP + conditions per combatant)
    const combatDump = (campaign?.combatState || []).map(e => {
      const c = (campaign.characters || []).find(x => x.id === e.id); if (!c) return '';
      const conds = e.conditions?.length ? ` · CONDITIONS: ${e.conditions.join(', ')}` : '';
      return `  ${c.name}: HP ${e.hp}/${c.maxHp}${e.down ? ' (DOWN)' : ''}${conds}${e.turn ? ' [AKTIV AM ZUG]' : ''}`;
    }).filter(l => l).join('\n');

    const systemPrompt = `Du bist Co-DM für einen D&D-5e-Tisch. Antworte auf Deutsch, knapp, im Ton eines erfahrenen Storytellers.

REGELN: D&D 5e SRD 5.1 (CC BY 4.0 WotC). Bei Regelfragen DC + Save-Type nennen. Niemals Spieler-Entscheidungen erfinden — du bist Helfer, nicht Spieler.

FORMAT:
• Vorlese-Texte: [READ_ALOUD: 2-4 Sätze atmosphärisch]
• Bild-Vorschlag: [GENERATE_IMAGE: 60-100 Wörter, English, photorealistic fantasy]
• **Fette Begriffe** für Namen/Regeln
• Keine Floskeln, keine Meta-Kommentare

KAMPAGNE: ${campaign?.name || 'Unbekannt'}${campaign?.session ? ` · S${campaign.session.number} ${campaign.session.title || ''} · Lvl ${campaign.session.level || '–'}` : ''}
${campaign?.lastSessionRecap ? `\nLETZTER RECAP:\n${campaign.lastSessionRecap}\n` : ''}
CHARAKTERE:
${charsDump || '(keine)'}

STANDORT: ${loc ? `${loc.name}${loc.meta ? ' · ' + loc.meta : ''}` : '(keiner)'}
${loc?.readAloud ? `READ-ALOUD: ${loc.readAloud}` : ''}
${loc?.dmNote ? `DM-NOTIZ: ${loc.dmNote}` : ''}
${combatDump ? `\nKAMPF LIVE:\n${combatDump}` : ''}

LOCATIONS-DB:
${locationsDump || '(keine)'}
`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens, system: systemPrompt, messages })
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('[dm-chat]', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DM STUDIO CLOUD SYNC — Supabase-backed state persistence for campaigns.
// Email-based identity (Phase 1). Upsert on user_email + campaign_id unique pair.
// Required table:
//   CREATE TABLE dm_studio_state (
//     id bigserial PRIMARY KEY,
//     user_email text NOT NULL,
//     campaign_id text NOT NULL,
//     state_json jsonb NOT NULL,
//     updated_at timestamptz DEFAULT now(),
//     created_at timestamptz DEFAULT now(),
//     UNIQUE(user_email, campaign_id)
//   );
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/dm-studio/save', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { email, campaignId, state } = req.body;
  if (!email || !campaignId) return res.status(400).json({ error: 'email + campaignId required' });
  try {
    const normalized = String(email).toLowerCase().trim();
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/dm_studio_state?on_conflict=user_email,campaign_id`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify({ user_email: normalized, campaign_id: String(campaignId), state_json: state, updated_at: new Date().toISOString() })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data?.message || 'Supabase error', data });
    res.json({ ok: true, updated_at: data?.[0]?.updated_at || new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dm-studio/load', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { email, campaignId } = req.query;
  if (!email || !campaignId) return res.status(400).json({ error: 'email + campaignId required' });
  try {
    const normalized = String(email).toLowerCase().trim();
    const url = `${SUPABASE_URL}/rest/v1/dm_studio_state?user_email=eq.${encodeURIComponent(normalized)}&campaign_id=eq.${encodeURIComponent(campaignId)}&select=*&limit=1`;
    const resp = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data?.message || 'Supabase error' });
    if (!Array.isArray(data) || !data.length) return res.json({ found: false });
    res.json({ found: true, state: data[0].state_json, updated_at: data[0].updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dm-studio/campaigns', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const normalized = String(email).toLowerCase().trim();
    const url = `${SUPABASE_URL}/rest/v1/dm_studio_state?user_email=eq.${encodeURIComponent(normalized)}&select=campaign_id,updated_at`;
    const resp = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const data = await resp.json();
    res.status(resp.status).json({ campaigns: Array.isArray(data) ? data : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/image', async (req, res) => {
  try {
    const { prompt, model = 'flux-pro', width, height, aspect_ratio, image_url } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    const body = { model, prompt };
    if (model.includes('grok')) {
      body.aspect_ratio = aspect_ratio || '2:3';
    } else if (model.includes('seedream')) {
      body.image_size = { width: Math.max(width || 2048, 1440), height: Math.max(height || 2048, 1440) };
      // Image-to-Image / Character Reference: wenn image_url mitgegeben, als Seedream-Reference durchreichen.
      // Seedream 4.5 unterstützt image input via AIML API — base64-Data-URLs oder https-URLs.
      if (image_url) {
        body.image_url = image_url;
        console.log('[/api/image] Seedream mit Reference-Image (' + (image_url.startsWith('data:') ? 'base64' : 'url') + ', length ' + image_url.length + ')');
      }
    } else if (model.includes('imagen')) {
      body.aspect_ratio = aspect_ratio || '3:4';
    } else {
      if (width) body.width = width;
      if (height) body.height = height;
    }
    const response = await fetch('https://api.aimlapi.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AIML_KEY}`
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    console.log('AIML response:', JSON.stringify(data).substring(0, 300));
    if (data.error) return res.status(500).json({ error: data.error });
    if (data.data?.[0]?.url) return res.json({ url: data.data[0].url });
    if (data.images?.[0]?.url) return res.json({ url: data.images[0].url });
    if (data.output) return res.json({ url: Array.isArray(data.output) ? data.output[0] : data.output });
    return res.status(500).json({ error: 'No image in response', raw: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/image/fast', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    const startRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${REPLICATE_KEY}`,
        'Prefer': 'wait'
      },
      body: JSON.stringify({
        input: { prompt, aspect_ratio: '3:4', output_format: 'webp', num_inference_steps: 4 }
      })
    });
    const prediction = await startRes.json();
    if (prediction.status === 'succeeded') return res.json({ url: prediction.output[0] });
    let result = prediction;
    let attempts = 0;
    while (result.status !== 'succeeded' && result.status !== 'failed' && attempts < 30) {
      await new Promise(r => setTimeout(r, 1000));
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${result.id}`, {
        headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` }
      });
      result = await pollRes.json();
      attempts++;
    }
    if (result.status === 'succeeded') return res.json({ url: result.output[0] });
    res.status(500).json({ error: 'Image generation failed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Email subscribe — writes to Supabase subscribers table
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email, source } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ error: 'Supabase not configured' });
    }
    const response = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        source: source || 'landing'
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      if (errText.includes('23505') || errText.includes('duplicate')) {
        return res.json({ ok: true, duplicate: true });
      }
      console.error('Supabase subscribe error:', response.status, errText);
      return res.status(500).json({ error: 'Failed to save subscriber' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Subscribe handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Save card — writes to Supabase cards table, returns assigned global number + misprint_number.
// Email is OPTIONAL now: if the caller omits email, the card is saved with an anonymous placeholder
// so the share link works immediately. The user can later PATCH via /api/claim-card to attach their
// real email (claim = sealing) which moves the card into their collection.
app.post('/api/save-card', async (req, res) => {
  try {
    const { email, card, id: updateId } = req.body;
    if (!card || typeof card !== 'object') {
      return res.status(400).json({ error: 'Card data required' });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ error: 'Supabase not configured' });
    }

    const hasRealEmail = !!(email && typeof email === 'string' && email.includes('@'));
    // If no email: generate an anon placeholder so the NOT NULL constraint on email is satisfied.
    // Placeholder is randomized so anon cards never collide.
    const effectiveEmail = hasRealEmail
      ? email.toLowerCase().trim()
      : `anon-${crypto.randomBytes(8).toString('hex')}@endocraft.anon`;
    const ownerSlug = emailToSlug(effectiveEmail);

    // ─── UPDATE path: caller passed an existing id + an email → attach email to anon card
    if (updateId && hasRealEmail && /^[a-f0-9-]{10,}$/i.test(updateId)) {
      // Upsert subscribers (best-effort)
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ email: email.toLowerCase().trim(), source: card.source || 'card-claim' })
        });
      } catch (e) { console.warn('subscribe-on-claim failed:', e.message); }

      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/cards?id=eq.${encodeURIComponent(updateId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation' },
        body: JSON.stringify({ email: effectiveEmail, owner_slug: ownerSlug })
      });
      if (!patchRes.ok) {
        const errText = await patchRes.text();
        console.error('claim-card PATCH error:', patchRes.status, errText);
        return res.status(500).json({ error: 'Failed to claim card', detail: errText.slice(0, 300) });
      }
      const patched = await patchRes.json();
      const updated = Array.isArray(patched) ? patched[0] : patched;
      return res.json({
        ok: true,
        claimed: true,
        card: {
          id: updated.id,
          number: updated.number,
          misprint_number: updated.misprint_number,
          rarity: updated.rarity,
          email: updated.email,
          owner_slug: ownerSlug,
          created_at: updated.created_at
        }
      });
    }

    // ─── INSERT path (anonymous or first-time email save)
    if (hasRealEmail) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ email: effectiveEmail, source: card.source || 'card' })
        });
      } catch (subErr) {
        console.warn('Subscribe-on-save failed (non-fatal):', subErr.message);
      }
    }

    const body = {
      email: effectiveEmail,
      owner_slug: ownerSlug,
      session_title: card.session_title || null,
      legendary_moment: card.legendary_moment || null,
      character_name: card.character_name || null,
      character_class: card.character_class || null,
      rarity: card.rarity || 'rare',
      visible_roll: typeof card.visible_roll === 'number' ? card.visible_roll : null,
      image_url: card.image_url || null,
      image_url_temp: card.image_url_temp || card.image_url || null,
      seed_hash: card.seed_hash || null
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Save-card error:', response.status, errText);
      return res.status(500).json({ error: 'Failed to save card', detail: errText.slice(0, 300) });
    }

    const rows = await response.json();
    const saved = Array.isArray(rows) ? rows[0] : rows;

    res.json({
      ok: true,
      anon: !hasRealEmail,
      card: {
        id: saved.id,
        number: saved.number,
        misprint_number: saved.misprint_number,
        rarity: saved.rarity,
        email: hasRealEmail ? saved.email : null,
        owner_slug: hasRealEmail ? ownerSlug : null,
        created_at: saved.created_at
      }
    });
  } catch (err) {
    console.error('Save-card handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

// /my-cards — fetch all cards for an owner_slug (semi-private: only those who have the slug can view)
app.get('/api/my-cards', async (req, res) => {
  try {
    const slug = (req.query.slug || '').trim();
    if (!slug || !/^[a-f0-9]{16}$/i.test(slug)) {
      return res.status(400).json({ error: 'Valid slug required' });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ error: 'Supabase not configured' });
    }
    // Query via service_role (bypasses RLS, but filtered by slug)
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/cards?owner_slug=eq.${encodeURIComponent(slug)}&select=id,number,misprint_number,session_title,legendary_moment,character_name,character_class,rarity,visible_roll,image_url,created_at&order=created_at.desc`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );
    if (!response.ok) {
      const errText = await response.text();
      console.error('my-cards fetch error:', response.status, errText);
      return res.status(500).json({ error: 'Failed to load cards' });
    }
    const cards = await response.json();
    // Don't leak emails to the public — only serve the sanitized card records above
    res.setHeader('Cache-Control', 'private, max-age=10');
    res.json({ ok: true, cards: Array.isArray(cards) ? cards : [] });
  } catch (err) {
    console.error('my-cards handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUBLIC SINGLE-CARD ENDPOINTS ─────────────────────────────────────────────
// These serve ONE card by its id (UUID). Used for share links.
// /api/card/:id returns JSON (used by frontend if needed).
// /c/:id returns a full HTML page with OG tags — the actual share target.
// ──────────────────────────────────────────────────────────────────────────────

async function fetchCardById(id) {
  if (!id || !/^[a-f0-9-]{10,}$/i.test(id)) return null;
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/cards?id=eq.${encodeURIComponent(id)}&select=id,number,misprint_number,session_title,legendary_moment,character_name,character_class,rarity,visible_roll,image_url,created_at&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) {
      console.error('fetchCardById supabase error:', r.status, await r.text());
      return null;
    }
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (err) {
    console.error('fetchCardById exception:', err);
    return null;
  }
}

app.get('/api/card/:id', async (req, res) => {
  const card = await fetchCardById(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ ok: true, card });
});

// ─── IMAGE PROXY ────────────────────────────────────────────────────────────
// Serves the card's image through our own URL — critical for:
//  1) Stable OG/Twitter preview URLs (AIML CDN links expire)
//  2) Consistent Cache-Control so WhatsApp/Twitter/Discord don't re-fetch
//  3) Correct Content-Type (some generators return WebP; here we keep upstream type but fall back to image/jpeg)
// Used as og:image on /c/:id so socials always hit an EndoCraft URL.
app.get('/img/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9-]{10,}$/i.test(id)) return res.status(400).send('Invalid id');
  const card = await fetchCardById(id);
  const src = card && (card.image_url || card.image_url_temp);
  if (!src) {
    // Fallback: redirect to the static EndoCraft logo so previews never 404
    return res.redirect(302, 'https://endocraft.app/IMG_8431.PNG');
  }
  try {
    const imgRes = await fetch(src);
    if (!imgRes.ok) {
      console.warn('img proxy upstream status:', imgRes.status, 'for', src);
      return res.redirect(302, 'https://endocraft.app/IMG_8431.PNG');
    }
    const upstreamType = imgRes.headers.get('content-type') || 'image/jpeg';
    let buf = Buffer.from(await imgRes.arrayBuffer());
    let outType = upstreamType;

    // If sharp is available, transcode to JPEG at 1200px max — guarantees WhatsApp/Slack/Messenger
    // preview compatibility. WebP is the killer here: Seedream / AIML often returns WebP, which
    // WhatsApp cannot render in link previews. JPEG + resize also keeps OG images well under size
    // limits (typical 200-400 KB vs multi-MB originals).
    if (sharp) {
      try {
        buf = await sharp(buf)
          .rotate() // respect EXIF orientation
          .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85, progressive: true, mozjpeg: true })
          .toBuffer();
        outType = 'image/jpeg';
      } catch (sharpErr) {
        console.warn('[img proxy] sharp transform failed, passing upstream bytes through:', sharpErr.message);
      }
    }

    res.setHeader('Content-Type', outType);
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); // 30 days
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  } catch (err) {
    console.error('img proxy exception:', err);
    return res.redirect(302, 'https://endocraft.app/IMG_8431.PNG');
  }
});

// Escape helper for safe insertion into HTML
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderCardSharePage(card) {
  // Data-model note: in our schema `session_title` actually holds the character name (what's
  // displayed as the big card name, e.g. "Lyra", "Caspian"). `legendary_moment` holds the moment
  // title (e.g. "The Dragon's Eye"). `character_name` is an optional extracted field that may be
  // null. We prefer session_title for display because it's always populated from #tcName.
  const charName = card.session_title || card.character_name || 'Hero';
  const moment = card.legendary_moment || '';
  const charClass = card.character_class || '';
  const rarity = (card.rarity || 'rare').toLowerCase();
  const rarityUpper = rarity.charAt(0).toUpperCase() + rarity.slice(1);
  const num = card.number ? String(card.number).padStart(4, '0') : '0000';
  const serial = `${charName} #${num} / 9999`;
  const title = moment || 'A legendary moment';
  // Display image — direct from AIML (what the user sees when viewing the page)
  const imgUrl = card.image_url || 'https://endocraft.app/IMG_8431.PNG';
  // OG image — routed through our proxy so link previews have a stable, cacheable, correctly-typed URL
  // (AIML CDN links expire; WhatsApp caches the preview for days — we need a URL we control.)
  const ogImgUrl = `https://endocraft-production.up.railway.app/img/${card.id}`;
  const dateStr = card.created_at ? new Date(card.created_at).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  // OG description — short, punchy, works in Twitter/Discord/WhatsApp previews.
  // Title = "Character · Moment" (e.g. "Lyra · The Dragon's Eye"). Description adds metadata
  // (class, rarity, serial) without repeating the moment — keeps preview info-dense.
  const ogTitle = `${charName} · ${title}`;
  const ogDesc = charClass
    ? `${charClass} · ${rarityUpper} moment · Sealed on EndoCraft`
    : `${rarityUpper} moment · Nº ${num} · Sealed on EndoCraft`;

  const shareUrl = `https://endocraft-production.up.railway.app/c/${card.id}`;

  // Rarity color for visual consistency with brand
  const rarityColors = {
    legendary: '#E8B86D',
    epic:      '#C084FC',
    rare:      '#60A5FA',
    common:    '#94A3B8',
    misprint:  '#E04A3A'
  };
  const accentColor = rarityColors[rarity] || rarityColors.rare;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(ogTitle)} · EndoCraft</title>

<!-- ─── Open Graph / Twitter Cards — viral preview trigger ─── -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="EndoCraft">
<meta property="og:title" content="${escapeHtml(ogTitle)}">
<meta property="og:description" content="${escapeHtml(ogDesc)}">
<meta property="og:image" content="${escapeHtml(ogImgUrl)}">
<meta property="og:image:secure_url" content="${escapeHtml(ogImgUrl)}">
<meta property="og:image:alt" content="${escapeHtml(title)} — sealed EndoCraft trading card">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1440">
<meta property="og:image:height" content="2560">
<meta property="og:url" content="${escapeHtml(shareUrl)}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(ogTitle)}">
<meta name="twitter:description" content="${escapeHtml(ogDesc)}">
<meta name="twitter:image" content="${escapeHtml(ogImgUrl)}">
<meta name="twitter:image:alt" content="${escapeHtml(title)} — sealed EndoCraft trading card">

<meta name="description" content="${escapeHtml(ogDesc)}">
<meta name="theme-color" content="${accentColor}">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Cinzel+Decorative:wght@700;900&family=EB+Garamond:ital@0;1&family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">

<!-- Privacy-friendly analytics by Plausible — tracks viral share-click traffic -->
<script async src="https://plausible.io/js/pa-XyfUV-SPa2VMk20wnbpyy.js"></script>
<script>
  window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
  plausible.init()
</script>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --accent: ${accentColor};
  --gold: #E8B86D;
}
html, body {
  background: #06030a;
  color: #e8e8f0;
  font-family: 'DM Sans', sans-serif;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
body {
  display: flex; flex-direction: column; align-items: center;
  padding: 24px 20px 64px;
}
body::before {
  content: ''; position: fixed; inset: 0;
  background: radial-gradient(ellipse at 50% 0%, ${accentColor}18, transparent 60%);
  pointer-events: none; z-index: 0;
}

/* Top bar */
.topbar {
  width: 100%; max-width: 480px;
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 24px; position: relative; z-index: 2;
}
.topbar-brand { display: flex; align-items: center; gap: 8px; text-decoration: none; color: inherit; }
.topbar-brand img { width: 26px; height: 26px; object-fit: contain; filter: drop-shadow(0 0 6px rgba(232,184,109,.5)); }
.topbar-brand span { font-family: 'Cinzel', serif; font-size: 11px; letter-spacing: 3px; color: rgba(232,184,109,.85); font-weight: 700; }
.try-btn {
  font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 600;
  color: white; background: #7B6CF6; border-radius: 8px;
  padding: 8px 16px; text-decoration: none; transition: opacity .15s;
}
.try-btn:hover { opacity: .9; }

/* Card (simplified — just the shareable face, no flip) */
.card-frame {
  width: min(340px, 90vw); aspect-ratio: 3/4;
  border-radius: 20px; overflow: hidden; position: relative;
  box-shadow:
    0 0 0 1.5px ${accentColor}80,
    0 24px 60px rgba(0,0,0,.95),
    0 0 80px ${accentColor}35;
  background: #0a0610;
  animation: cardFloat 6s ease-in-out infinite, cardGlow 4s ease infinite;
  z-index: 2;
}
@keyframes cardFloat {
  0%, 100% { transform: translateY(0) rotateX(2deg) rotateY(-2deg); }
  50%      { transform: translateY(-8px) rotateX(-1deg) rotateY(2deg); }
}
@keyframes cardGlow {
  0%, 100% { box-shadow: 0 0 0 1.5px ${accentColor}80, 0 24px 60px rgba(0,0,0,.95), 0 0 70px ${accentColor}25; }
  50%      { box-shadow: 0 0 0 2.5px ${accentColor}cc, 0 24px 60px rgba(0,0,0,.95), 0 0 130px ${accentColor}5f; }
}
.card-frame img {
  width: 100%; height: 100%; object-fit: cover; object-position: center 30%;
  display: block;
}
.card-ov {
  position: absolute; inset: 0; z-index: 2;
  background: linear-gradient(to bottom,
    rgba(6,3,0,.5) 0%, transparent 22%, transparent 55%,
    rgba(6,3,0,.75) 78%, rgba(4,2,0,.98) 100%);
}
.card-holo {
  position: absolute; inset: 0; z-index: 3; pointer-events: none;
  mix-blend-mode: color-dodge;
  background: linear-gradient(135deg, rgba(255,0,80,.04) 0%, rgba(255,160,0,.06) 25%, rgba(0,255,120,.06) 50%, rgba(0,200,255,.06) 75%, rgba(255,0,80,.04) 100%);
  background-size: 200% 200%;
  animation: holoShift 6s ease infinite;
  opacity: .6;
}
@keyframes holoShift { 0%,100% { background-position: 0% 0%; } 50% { background-position: 100% 100%; } }
.card-top {
  position: absolute; top: 0; left: 0; right: 0; z-index: 5;
  padding: 14px 16px; display: flex; align-items: center; justify-content: space-between;
}
.card-brand {
  font-family: 'Cinzel', serif; font-size: 8px; font-weight: 700;
  letter-spacing: 3px; color: rgba(232,184,109,.85);
  text-shadow: 0 1px 8px #000;
}
.card-pill {
  background: rgba(10,5,0,.9); border: 1px solid ${accentColor}66;
  color: ${accentColor}; border-radius: 30px;
  padding: 5px 12px; font-family: 'Cinzel', serif;
  font-size: 8px; font-weight: 700; letter-spacing: 2px;
  backdrop-filter: blur(12px);
}
.card-bottom {
  position: absolute; bottom: 0; left: 0; right: 0; z-index: 5; padding: 16px 18px;
}
.card-class {
  font-family: 'Cinzel', serif; font-size: 8px; letter-spacing: 3px;
  color: rgba(232,184,109,.85); margin-bottom: 4px; text-shadow: 0 1px 8px #000;
}
.card-name {
  font-family: 'Cinzel Decorative', serif; font-size: 30px; font-weight: 900;
  color: #fffbf0; line-height: 1; margin-bottom: 6px; text-shadow: 0 2px 20px #000;
}
.card-title {
  font-family: 'EB Garamond', serif; font-size: 13px; font-style: italic;
  color: rgba(255,230,160,.7); margin-bottom: 8px; text-shadow: 0 1px 8px #000;
  line-height: 1.3;
}
.card-serial {
  font-family: 'Cinzel', serif; font-size: 8px; letter-spacing: 3px;
  color: ${accentColor}aa; text-shadow: 0 1px 6px #000;
}

/* Moment prose card below */
.moment-block {
  max-width: 340px; width: 100%; margin-top: 32px;
  text-align: center; position: relative; z-index: 2;
}
.moment-label {
  font-family: 'Cinzel', serif; font-size: 10px; letter-spacing: 4px;
  color: ${accentColor}; margin-bottom: 10px;
}
.moment-text {
  font-family: 'EB Garamond', serif; font-style: italic; font-size: 17px;
  color: rgba(255,255,255,.82); line-height: 1.5;
}
.card-meta {
  margin-top: 14px; font-family: 'Cinzel', serif; font-size: 9px;
  letter-spacing: 2.5px; color: rgba(255,255,255,.35); text-transform: uppercase;
}

/* Share row */
.share-row {
  margin-top: 28px; display: flex; gap: 10px; flex-wrap: wrap; justify-content: center;
  max-width: 340px; width: 100%; position: relative; z-index: 2;
}
.share-btn {
  flex: 1; min-width: 100px;
  background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12);
  color: rgba(255,255,255,.85); padding: 11px 14px;
  border-radius: 10px; font-family: 'DM Sans', sans-serif;
  font-size: 12px; font-weight: 600; cursor: pointer;
  text-align: center; text-decoration: none;
  transition: all .15s;
}
.share-btn:hover { border-color: rgba(255,255,255,.3); background: rgba(255,255,255,.08); }
.share-btn.primary { background: var(--accent); color: #0a0610; border-color: var(--accent); }
.share-btn.primary:hover { opacity: .9; background: var(--accent); }

/* Final CTA */
.cta-box {
  margin-top: 44px; text-align: center; max-width: 420px;
  padding: 28px 24px; background: linear-gradient(135deg, rgba(123,108,246,.08), rgba(232,184,109,.04));
  border: 1px solid rgba(123,108,246,.2); border-radius: 16px;
  position: relative; z-index: 2;
}
.cta-title {
  font-family: 'Syne', sans-serif; font-weight: 800; font-size: 20px;
  color: white; margin-bottom: 8px; line-height: 1.2;
}
.cta-title em { color: ${accentColor}; font-style: normal; }
.cta-sub {
  font-size: 14px; color: rgba(255,255,255,.6); margin-bottom: 18px; line-height: 1.5;
}
.cta-btn {
  display: inline-block; background: ${accentColor}; color: #0a0610;
  padding: 13px 28px; border-radius: 10px; font-family: 'DM Sans', sans-serif;
  font-size: 14px; font-weight: 700; text-decoration: none;
  box-shadow: 0 4px 20px ${accentColor}44;
  transition: transform .15s, box-shadow .15s;
}
.cta-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 30px ${accentColor}66; }

.footer-tag {
  margin-top: 32px; font-family: 'EB Garamond', serif; font-style: italic;
  font-size: 13px; color: rgba(255,255,255,.3); text-align: center;
  position: relative; z-index: 2;
}

@media (max-width: 480px) {
  .card-name { font-size: 24px; }
  .card-title { font-size: 12px; }
  .moment-text { font-size: 15px; }
  .cta-title { font-size: 18px; }
}
</style>
</head>
<body>

<div class="topbar">
  <a href="https://endocraft.app" class="topbar-brand">
    <img src="https://endocraft.app/IMG_8431.PNG" alt="EndoCraft logo">
    <span>ENDOCRAFT</span>
  </a>
  <a href="https://endocraft.app/scroll/" class="try-btn">Try free →</a>
</div>

<div class="card-frame">
  <img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(title)}">
  <div class="card-ov"></div>
  <div class="card-holo"></div>
  <div class="card-top">
    <div class="card-brand">✦ EndoCraft · Session Scroll</div>
    <div class="card-pill">✦ ${escapeHtml(rarityUpper)}</div>
  </div>
  <div class="card-bottom">
    <div class="card-class">${escapeHtml(charClass)}</div>
    <div class="card-name">${escapeHtml(charName)}</div>
    <div class="card-title">${escapeHtml(title)}</div>
    <div class="card-serial">${escapeHtml(serial)}</div>
  </div>
</div>

${moment ? `
<div class="moment-block">
  <div class="moment-label">✦ THE MOMENT</div>
  <div class="moment-text">"${escapeHtml(moment)}"</div>
  <div class="card-meta">${escapeHtml(rarityUpper)} · Sealed ${escapeHtml(dateStr)}</div>
</div>
` : ''}

<div class="share-row">
  <button class="share-btn primary" onclick="copyLink(this)">📋 Copy link</button>
  <a class="share-btn" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(ogTitle + ' — ' + (moment.slice(0, 100) || 'sealed on EndoCraft'))}&url=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">𝕏 Post</a>
  <a class="share-btn" href="https://api.whatsapp.com/send?text=${encodeURIComponent(ogTitle + ' — ' + shareUrl)}" target="_blank" rel="noopener">WhatsApp</a>
</div>

<div class="cta-box">
  <div class="cta-title">Your session deserves <em>a card like this.</em></div>
  <div class="cta-sub">Drop your next legendary moment. We'll seal it with a permanent serial number. Free to start.</div>
  <a href="https://endocraft.app/scroll/" class="cta-btn">✦ Create your own card</a>
</div>

<div class="footer-tag">"Some moments are too legendary to forget."</div>

<script>
function copyLink(btn) {
  const url = ${JSON.stringify(shareUrl)};
  const doneText = '✓ Copied!';
  const origText = btn.textContent;
  try {
    navigator.clipboard.writeText(url).then(() => {
      btn.textContent = doneText;
      setTimeout(() => { btn.textContent = origText; }, 1800);
    });
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = url; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); btn.textContent = doneText; } catch (_) { alert(url); }
    setTimeout(() => { btn.textContent = origText; document.body.removeChild(ta); }, 1800);
  }
}
</script>
</body>
</html>`;
}

app.get('/c/:id', async (req, res) => {
  const id = req.params.id;
  if (!id || !/^[a-f0-9-]{10,}$/i.test(id)) {
    return res.status(400).send('<h1>Invalid card ID</h1>');
  }
  const card = await fetchCardById(id);
  if (!card) {
    res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send('<!DOCTYPE html><html><head><title>Card not found · EndoCraft</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#06030a;color:#fff;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}a{color:#E8B86D;margin-top:20px}</style></head><body><h1 style="font-family:Georgia,serif;font-style:italic;opacity:.7">The scroll has faded.</h1><p>This card couldn\'t be found.</p><a href="https://endocraft.app/scroll/">→ Create your own card</a></body></html>');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.send(renderCardSharePage(card));
});

// Helper endpoint: convert email → slug (for returning users who know their email but not the slug)
app.post('/api/my-cards/lookup', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const slug = emailToSlug(email);
    res.json({ ok: true, slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public subscriber count — backend proxies the count since RLS now locks direct SELECT
app.get('/api/subscriber-count', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) return res.json({ count: 0 });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=email&limit=1`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'count=exact',
        'Range-Unit': 'items',
        'Range': '0-0'
      }
    });
    const cr = r.headers.get('content-range');
    const total = parseInt((cr || '0-0/0').split('/')[1], 10) || 0;
    res.setHeader('Cache-Control', 'public, max-age=60'); // 1-minute CDN cache
    res.json({ count: total });
  } catch (err) {
    console.error('subscriber-count error:', err);
    res.json({ count: 0 });
  }
});

app.listen(PORT, () => console.log(`EndoCraft API running on port ${PORT}`));
