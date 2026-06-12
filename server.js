const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
const { rollRarity, buildRarityPromptModifier } = require('./rarity');

// Optional: sharp for image transcoding (WebP → JPEG so WhatsApp / Slack / Messenger render previews).
// If not installed, /img/:id falls back to passthrough and large/WebP images may not preview on WhatsApp.
let sharp;
try { sharp = require('sharp'); }
catch (e) { console.warn('[img proxy] sharp not installed — WhatsApp link previews may fail for WebP images. Run: npm install sharp'); }

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

// ═══════════════════════════════════════════════════════════════════════════
// PARTY ALBUM PHASE 2 — gemeinsames Album per Party-Code
// Tables: parties, party_members (siehe supabase-migrations/002_parties.sql)
// ═══════════════════════════════════════════════════════════════════════════

// Helper: 8-12 chars Party-Code generieren — buchstaben+ziffern, leicht zu tippen, ohne 0/O/1/I.
function generatePartyCode(seedName) {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const tokens = String(seedName || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return (tokens || 'PARTY') + '-' + suffix;
}

// POST /api/parties/create — DM erstellt Party, kriegt Code zurück
app.post('/api/parties/create', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { dmEmail, name, campaignId } = req.body;
  if (!dmEmail || !name) return res.status(400).json({ error: 'dmEmail + name required' });
  try {
    const normalized = String(dmEmail).toLowerCase().trim();
    // Bis zu 5 Versuche falls Code-Kollision
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generatePartyCode(name);
      const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/parties`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ code, name: String(name).slice(0, 80), dm_email: normalized, campaign_id: campaignId ? String(campaignId) : null })
      });
      const partyData = await insertResp.json();
      if (insertResp.ok && partyData?.[0]?.id) {
        const party = partyData[0];
        // DM auch als Member eintragen
        await fetch(`${SUPABASE_URL}/rest/v1/party_members`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify({ party_id: party.id, email: normalized, role: 'dm', display_name: 'DM' })
        });
        return res.json({ ok: true, party });
      }
      lastErr = partyData?.message || 'unknown';
      // 23505 = unique violation → Code-Kollision → nochmal probieren
      if (!/duplicate|unique/i.test(lastErr)) break;
    }
    res.status(500).json({ error: 'Could not create party', detail: lastErr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/parties/join — Spieler tritt via Code bei
app.post('/api/parties/join', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { code, email, displayName } = req.body;
  if (!code || !email) return res.status(400).json({ error: 'code + email required' });
  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    const normalizedCode = String(code).toUpperCase().trim();
    // Find party by code (case-insensitive)
    const findUrl = `${SUPABASE_URL}/rest/v1/parties?code=eq.${encodeURIComponent(normalizedCode)}&select=*&limit=1`;
    const findResp = await fetch(findUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const parties = await findResp.json();
    if (!findResp.ok) return res.status(findResp.status).json({ error: parties?.message || 'Lookup failed' });
    if (!Array.isArray(parties) || !parties.length) return res.status(404).json({ error: 'Code nicht gefunden' });
    const party = parties[0];
    // Add as member (idempotent via UNIQUE constraint)
    const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/party_members?on_conflict=party_id,email`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify({ party_id: party.id, email: normalizedEmail, role: 'player', display_name: (displayName || '').slice(0, 60) || null })
    });
    const memberData = await insertResp.json();
    if (!insertResp.ok) return res.status(insertResp.status).json({ error: memberData?.message || 'Join failed' });
    res.json({ ok: true, party, member: memberData?.[0] || memberData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/parties/list?email= — alle Parties einer Email
app.get('/api/parties/list', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const normalized = String(email).toLowerCase().trim();
    // Get all party_member rows for this email, joined with parties
    const url = `${SUPABASE_URL}/rest/v1/party_members?email=eq.${encodeURIComponent(normalized)}&select=role,display_name,joined_at,parties(id,code,name,dm_email,campaign_id,created_at)`;
    const resp = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data?.message || 'List failed' });
    res.json({ parties: Array.isArray(data) ? data : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/parties/:code/members — alle Members einer Party
app.get('/api/parties/:code/members', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const code = String(req.params.code || '').toUpperCase().trim();
  try {
    const findResp = await fetch(`${SUPABASE_URL}/rest/v1/parties?code=eq.${encodeURIComponent(code)}&select=id,name,dm_email&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const parties = await findResp.json();
    if (!Array.isArray(parties) || !parties.length) return res.status(404).json({ error: 'Code nicht gefunden' });
    const party = parties[0];
    const memResp = await fetch(`${SUPABASE_URL}/rest/v1/party_members?party_id=eq.${party.id}&select=email,role,display_name,joined_at&order=joined_at.asc`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const members = await memResp.json();
    res.json({ party, members: Array.isArray(members) ? members : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ───────── PARTY-MILESTONES ─────────
// Schwellen + Beschreibungen. Backend setzt Achievements automatisch wenn erreicht.
const PARTY_MILESTONES = [
  { key: 'first_card',      threshold: 1,   name: 'Erste Erinnerung',     desc: 'Eure erste Karte' },
  { key: '5_cards',         threshold: 5,   name: 'Geteilte Geschichten', desc: 'Fünf Karten gemeinsam' },
  { key: '10_nights',       threshold: 10,  name: '10 Nights Together',   desc: 'Eine echte Party — exklusive Karte freigeschaltet' },
  { key: '25_legends',      threshold: 25,  name: '25 Legenden',          desc: 'Eure Geschichte hat Tiefe' },
  { key: '50_chronicles',   threshold: 50,  name: '50 Chronicles',        desc: 'Eine Saga' },
  { key: '100_immortal',    threshold: 100, name: 'Immortal Table',       desc: 'Hall-of-Fame-würdig' }
];

function computeUnlocks(cardCount) {
  return PARTY_MILESTONES.filter(m => cardCount >= m.threshold).map(m => m.key);
}

function progressTowardNext(cardCount, currentUnlocks) {
  const next = PARTY_MILESTONES.find(m => !currentUnlocks.includes(m.key));
  if (!next) return null;
  return {
    next: next.key,
    nextName: next.name,
    nextDesc: next.desc,
    threshold: next.threshold,
    have: cardCount,
    remaining: Math.max(0, next.threshold - cardCount)
  };
}

// GET /api/parties/milestones — statische Liste (für Frontend)
app.get('/api/parties/milestones', (req, res) => {
  res.json({ milestones: PARTY_MILESTONES });
});

// GET /api/parties/:code/sessions — alle Karten/Sessions die Party-Members erstellt haben
// Aggregiert über alle Member-Emails → ihre Sessions aus der `sessions` table → ein gemeinsames Album.
// Berechnet zusätzlich Unlocks basierend auf Total-Card-Count und persistiert sie.
app.get('/api/parties/:code/sessions', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const code = String(req.params.code || '').toUpperCase().trim();
  try {
    const findResp = await fetch(`${SUPABASE_URL}/rest/v1/parties?code=eq.${encodeURIComponent(code)}&select=id,name,dm_email,unlocks,card_count&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const parties = await findResp.json();
    if (!Array.isArray(parties) || !parties.length) return res.status(404).json({ error: 'Code nicht gefunden' });
    const party = parties[0];

    // Members holen
    const memResp = await fetch(`${SUPABASE_URL}/rest/v1/party_members?party_id=eq.${party.id}&select=email,display_name,role`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const members = await memResp.json();
    const emails = Array.isArray(members) ? members.map(m => m.email) : [];
    if (!emails.length) return res.json({ party, members: [], sessions: [], cards: [], unlocks: party.unlocks || [], progress: progressTowardNext(0, party.unlocks || []), milestones: PARTY_MILESTONES });

    // Owner-Slugs für jede Email berechnen
    const slugByEmail = Object.fromEntries(emails.map(e => [e, emailToSlug(e)]));
    const slugs = Object.values(slugByEmail);

    // Sessions holen — aktuell hat sessions.owner_slug? Falls nicht, fallback auf cards.
    // Wir versuchen erst sessions, dann cards.
    let allSessions = [];
    try {
      const sessUrl = `${SUPABASE_URL}/rest/v1/sessions?owner_slug=in.(${slugs.map(s => '"' + s + '"').join(',')})&select=*&order=created_at.desc&limit=200`;
      const sessResp = await fetch(sessUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      if (sessResp.ok) {
        const sessData = await sessResp.json();
        if (Array.isArray(sessData)) allSessions = sessData;
      }
    } catch (e) { /* sessions table missing owner_slug → ignore */ }

    // Cards-Tabelle als Fallback / Ergänzung
    let cards = [];
    try {
      const cardsUrl = `${SUPABASE_URL}/rest/v1/cards?owner_slug=in.(${slugs.map(s => '"' + s + '"').join(',')})&select=id,number,session_title,legendary_moment,character_name,character_class,rarity,image_url,owner_slug,created_at&order=created_at.desc&limit=200`;
      const cardsResp = await fetch(cardsUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      if (cardsResp.ok) {
        const cardsData = await cardsResp.json();
        if (Array.isArray(cardsData)) cards = cardsData;
      }
    } catch (e) { /* cards table missing owner_slug → ignore */ }

    // Display-Name reverse-lookup
    const dnBySlug = {};
    members.forEach(m => { dnBySlug[slugByEmail[m.email]] = m.display_name || (m.role === 'dm' ? 'DM' : 'Spieler'); });
    allSessions.forEach(s => { s._memberName = dnBySlug[s.owner_slug] || ''; });
    cards.forEach(c => { c._memberName = dnBySlug[c.owner_slug] || ''; });

    // Unique Card-Count via ID-Set (Sessions+Cards können dieselben IDs haben)
    const uniqueIds = new Set();
    allSessions.forEach(s => s.id && uniqueIds.add(s.id));
    cards.forEach(c => c.id && uniqueIds.add(c.id));
    const cardCount = uniqueIds.size;

    // Unlocks berechnen + persistieren falls neue dazukamen
    const computedUnlocks = computeUnlocks(cardCount);
    const existingUnlocks = Array.isArray(party.unlocks) ? party.unlocks : [];
    const newlyUnlocked = computedUnlocks.filter(k => !existingUnlocks.includes(k));
    const finalUnlocks = [...new Set([...existingUnlocks, ...computedUnlocks])];

    if (newlyUnlocked.length || party.card_count !== cardCount) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/parties?id=eq.${party.id}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ unlocks: finalUnlocks, card_count: cardCount })
        });
      } catch (e) { console.warn('[parties] unlock persist failed:', e.message); }
    }

    const progress = progressTowardNext(cardCount, finalUnlocks);

    res.json({
      party: { ...party, unlocks: finalUnlocks, card_count: cardCount },
      members, sessions: allSessions, cards,
      cardCount,
      unlocks: finalUnlocks,
      newlyUnlocked,
      progress,
      milestones: PARTY_MILESTONES
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/parties/:code/leave — Member verlässt Party (Self-Service)
app.post('/api/parties/:code/leave', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const code = String(req.params.code || '').toUpperCase().trim();
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const normalized = String(email).toLowerCase().trim();
    const findResp = await fetch(`${SUPABASE_URL}/rest/v1/parties?code=eq.${encodeURIComponent(code)}&select=id,dm_email&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const parties = await findResp.json();
    if (!Array.isArray(parties) || !parties.length) return res.status(404).json({ error: 'Code nicht gefunden' });
    const party = parties[0];
    if (party.dm_email === normalized) return res.status(400).json({ error: 'DM kann nicht austreten — Party muss gelöscht werden' });
    const delResp = await fetch(`${SUPABASE_URL}/rest/v1/party_members?party_id=eq.${party.id}&email=eq.${encodeURIComponent(normalized)}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    res.json({ ok: delResp.ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// HALL OF FAME — Voting + Trending-Mechanik (SQL: 004_hall_of_fame.sql)
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/cards/:id/vote', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const cardId = String(req.params.id || '').trim();
  const { email, vote } = req.body;
  if (!cardId || !email) return res.status(400).json({ error: 'cardId + email required' });
  try {
    const normalized = String(email).toLowerCase().trim();
    const v = vote === 0 ? 0 : 1;
    const upsertResp = await fetch(`${SUPABASE_URL}/rest/v1/card_votes?on_conflict=card_id,voter_email`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ card_id: cardId, voter_email: normalized, vote: v })
    });
    if (!upsertResp.ok) {
      const txt = await upsertResp.text();
      return res.status(upsertResp.status).json({ error: txt.slice(0, 300) });
    }
    const statsResp = await fetch(`${SUPABASE_URL}/rest/v1/card_stats?card_id=eq.${encodeURIComponent(cardId)}&select=*&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const stats = await statsResp.json();
    res.json({ ok: true, stats: Array.isArray(stats) ? stats[0] || null : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cards/:id/votes', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const cardId = String(req.params.id || '').trim();
  const { email } = req.query;
  try {
    const statsResp = await fetch(`${SUPABASE_URL}/rest/v1/card_stats?card_id=eq.${encodeURIComponent(cardId)}&select=*&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const statsArr = await statsResp.json();
    const stats = Array.isArray(statsArr) ? statsArr[0] || { vote_count: 0, trending_score: 0 } : { vote_count: 0, trending_score: 0 };
    let myVote = 0;
    if (email) {
      const normalized = String(email).toLowerCase().trim();
      const myResp = await fetch(`${SUPABASE_URL}/rest/v1/card_votes?card_id=eq.${encodeURIComponent(cardId)}&voter_email=eq.${encodeURIComponent(normalized)}&select=vote&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const my = await myResp.json();
      if (Array.isArray(my) && my.length) myVote = my[0].vote || 0;
    }
    res.json({ stats, myVote });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hall-of-fame/trending', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const sort = req.query.sort === 'all-time' ? 'vote_count' : 'trending_score';
  try {
    const statsUrl = `${SUPABASE_URL}/rest/v1/card_stats?select=card_id,vote_count,trending_score&order=${sort}.desc&limit=${limit}`;
    const statsResp = await fetch(statsUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const stats = await statsResp.json();
    if (!Array.isArray(stats) || !stats.length) return res.json({ cards: [] });
    const ids = stats.map(s => s.card_id);
    const fetchByIds = async (table) => {
      try {
        const url = `${SUPABASE_URL}/rest/v1/${table}?id=in.(${ids.map(i => '"' + i + '"').join(',')})&select=*`;
        const r = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
        const d = await r.json();
        return Array.isArray(d) ? d : [];
      } catch (e) { return []; }
    };
    const sess = await fetchByIds('sessions');
    const cards = await fetchByIds('cards');
    const cardById = {};
    sess.forEach(s => { cardById[s.id] = { ...s, _source: 'session' }; });
    cards.forEach(c => { if (!cardById[c.id]) cardById[c.id] = { ...c, _source: 'card' }; });
    const rarityFilter = req.query.rarity ? String(req.query.rarity).toLowerCase().split(',') : null;
    let result = stats.map(s => {
      const c = cardById[s.card_id];
      if (!c) return null;
      if (rarityFilter && rarityFilter.length && !rarityFilter.includes((c.rarity || 'common').toLowerCase())) return null;
      return { ...c, _stats: { vote_count: s.vote_count, trending_score: s.trending_score } };
    }).filter(Boolean);
    res.json({ cards: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENCOUNTER BUILDER — AI-generated balanced encounters mit SRD Statblöcken
// ═══════════════════════════════════════════════════════════════════════════

// XP-Thresholds aus DMG (per character)
const XP_THRESHOLDS = {
  1:  { easy: 25,   medium: 50,    hard: 75,    deadly: 100   },
  2:  { easy: 50,   medium: 100,   hard: 150,   deadly: 200   },
  3:  { easy: 75,   medium: 150,   hard: 225,   deadly: 400   },
  4:  { easy: 125,  medium: 250,   hard: 375,   deadly: 500   },
  5:  { easy: 250,  medium: 500,   hard: 750,   deadly: 1100  },
  6:  { easy: 300,  medium: 600,   hard: 900,   deadly: 1400  },
  7:  { easy: 350,  medium: 750,   hard: 1100,  deadly: 1700  },
  8:  { easy: 450,  medium: 900,   hard: 1400,  deadly: 2100  },
  9:  { easy: 550,  medium: 1100,  hard: 1600,  deadly: 2400  },
  10: { easy: 600,  medium: 1200,  hard: 1900,  deadly: 2800  },
  11: { easy: 800,  medium: 1600,  hard: 2400,  deadly: 3600  },
  12: { easy: 1000, medium: 2000,  hard: 3000,  deadly: 4500  },
  13: { easy: 1100, medium: 2200,  hard: 3400,  deadly: 5100  },
  14: { easy: 1250, medium: 2500,  hard: 3800,  deadly: 5700  },
  15: { easy: 1400, medium: 2800,  hard: 4300,  deadly: 6400  },
  16: { easy: 1600, medium: 3200,  hard: 4800,  deadly: 7200  },
  17: { easy: 2000, medium: 3900,  hard: 5900,  deadly: 8800  },
  18: { easy: 2100, medium: 4200,  hard: 6300,  deadly: 9500  },
  19: { easy: 2400, medium: 4900,  hard: 7300,  deadly: 10900 },
  20: { easy: 2800, medium: 5700,  hard: 8500,  deadly: 12700 }
};

function partyXPBudget(partySize, partyLevel, difficulty) {
  const lvl = Math.max(1, Math.min(20, parseInt(partyLevel) || 1));
  const t = XP_THRESHOLDS[lvl][difficulty] || XP_THRESHOLDS[lvl].medium;
  return t * Math.max(1, parseInt(partySize) || 4);
}

app.post('/api/encounter/build', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });
  const { partySize, partyLevel, difficulty, theme, additionalContext, count, campaignContext } = req.body;
  if (!partyLevel) return res.status(400).json({ error: 'partyLevel required' });
  const size = Math.max(1, Math.min(10, parseInt(partySize) || 4));
  const level = Math.max(1, Math.min(20, parseInt(partyLevel) || 1));
  const diff = ['easy','medium','hard','deadly'].includes(difficulty) ? difficulty : 'medium';
  const numEncounters = Math.max(1, Math.min(4, parseInt(count) || 3));
  const xpBudget = partyXPBudget(size, level, diff);

  // Campaign-Context-Block für System-Prompt
  let contextBlock = '';
  if (campaignContext && typeof campaignContext === 'object') {
    const parts = [];
    if (campaignContext.campaignName) parts.push(`KAMPAGNE: "${campaignContext.campaignName}"`);
    if (campaignContext.currentLocation) {
      const loc = campaignContext.currentLocation;
      parts.push(`AKTUELLE SZENE: ${loc.name}${loc.meta ? ' (' + loc.meta + ')' : ''}`);
      if (loc.readAloud) parts.push(`READ-ALOUD: ${loc.readAloud}`);
      if (loc.dmNote) parts.push(`DM-NOTIZ: ${loc.dmNote}`);
    }
    if (Array.isArray(campaignContext.existingNpcs) && campaignContext.existingNpcs.length) {
      const npcLines = campaignContext.existingNpcs.map(n => `- ${n.name}${n.cr ? ' (CR ' + n.cr + ')' : ''}${n.type ? ' · ' + n.type : ''}${n.role ? ' · ' + n.role : ''}`).join('\n');
      parts.push(`VORHANDENE NPCs (kannst sie als Bösewichte/Verbündete einsetzen — verwende ihre Namen):\n${npcLines}`);
    }
    if (campaignContext.lastRecap) {
      parts.push(`LETZTER RECAP (Session ${campaignContext.lastRecap.sessionNumber} · "${campaignContext.lastRecap.title}"): ${campaignContext.lastRecap.recap}`);
    }
    if (Array.isArray(campaignContext.partyState) && campaignContext.partyState.length) {
      const partyLines = campaignContext.partyState.map(p => `- ${p.name} (${p.class} Lv${p.level}) HP ${p.hp}/${p.maxHp}${p.conditions?.length ? ' · ' + p.conditions.join(', ') : ''}`).join('\n');
      parts.push(`PARTY-STATE:\n${partyLines}`);
    }
    if (parts.length) contextBlock = '\n\n═══ KAMPAGNEN-KONTEXT ═══\n' + parts.join('\n\n') + '\n═══════════════════════';
  }

  const systemPrompt = `Du bist ein erfahrener D&D-5e-Encounter-Designer. Antworte AUSSCHLIESSLICH mit gültigem JSON, keinem Vorwort, keinem Markdown-Codeblock.

Du baust ${numEncounters} balanced Encounters für eine Party von ${size} Charakteren auf Level ${level}, Difficulty: ${diff.toUpperCase()}.

XP-Budget für diese Party (DMG-Threshold × Party-Size): ${xpBudget} XP.
Encounter-Multiplier-Regeln (DMG):
- 1 Monster: ×1
- 2 Monster: ×1.5
- 3-6 Monster: ×2
- 7-10 Monster: ×2.5
- 11-14 Monster: ×3
- 15+ Monster: ×4
Adjusted XP (sum × multiplier) sollte nahe am Budget liegen.

THEMA / KONTEXT: ${theme ? `"${theme}"` : 'flexibel'}
${additionalContext ? 'ZUSATZ: ' + additionalContext : ''}${contextBlock}

REGELN:
- Nutze SRD 5.1 Monster ALS BASIS — wenn der Kampagnen-Context vorhandene NPCs erwähnt, kannst du sie auch direkt einsetzen (Statblock vom passenden SRD-Monster ableiten)
- Encounter-Titel + description müssen zur AKTUELLEN SZENE passen (falls Context gegeben). Generic-Titel wie "Bandit-Hinterhalt" sind NICHT gewünscht wenn die Szene "W14 Wine Cellar mit Rahadin" ist.
- Description ist atmosphärisch und stellt narrative Anbindung an Recap/Szene her wenn möglich
- Variiere zwischen den ${numEncounters} Encountern (z.B. 1 single boss, 1 mob, 1 mixed) UND zwischen Approach-Stilen (Combat-heavy / Stealth-möglich / Social-twist)
- Tactics: kurze Hinweise wie das Monster im Kampf agieren würde (Range, Spells, Movement, Reaktion auf bestimmte PC-Klassen)
- statblock-Felder kompakt: hp, ac, speed, str/dex/con/int/wis/cha als Zahlen, savingThrows + skills als String, multiAttack als Boolean
- actions: Array mit { name, text } — text mit kompletter Mechanik (z.B. "Melee Weapon Attack: +5 to hit, reach 5 ft. Hit: 7 (1d8+3) slashing damage.")

ANTWORT-FORMAT (exakt dieses JSON-Schema):
{
  "encounters": [
    {
      "title": "string — z.B. 'Bandit-Hinterhalt im Wald'",
      "description": "1-2 Sätze atmosphärisch — was sehen die Spieler",
      "totalXP": 1200,
      "adjustedXP": 1800,
      "difficulty": "medium",
      "monsters": [
        {
          "name": "Bandit Captain",
          "count": 1,
          "cr": "2",
          "xp": 450,
          "statblock": {
            "size": "Medium", "creatureType": "humanoid", "alignment": "any non-lawful alignment",
            "ac": 15, "hp": 65, "hitDice": "10d8+20", "speed": "30 ft.",
            "stats": { "str": 15, "dex": 16, "con": 14, "int": 14, "wis": 11, "cha": 14 },
            "savingThrows": "Str +4, Dex +5, Wis +2",
            "skills": "Athletics +4, Deception +4",
            "senses": "passive Perception 10",
            "languages": "any two languages"
          },
          "traits": [
            { "name": "Trait Name", "text": "Detailed description with mechanics." }
          ],
          "actions": [
            { "name": "Multiattack", "text": "The captain makes three attacks: two with its scimitar and one with its dagger." },
            { "name": "Scimitar", "text": "Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: 6 (1d6+3) slashing." }
          ],
          "tactics": "Stays back, directs minions, throws daggers from cover."
        }
      ]
    }
  ]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Generiere die ${numEncounters} Encounter im JSON-Format wie spezifiziert.` }]
      })
    });
    const data = await response.json();
    let text = '';
    if (Array.isArray(data.content)) text = data.content.map(c => c.type === 'text' ? c.text : '').join('').trim();
    // JSON-Markdown-Codeblock entfernen falls AI eine reinsetzt
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      // Fallback: versuche zwischen { und letztem } zu extrahieren
      const m = text.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch(_){}
      if (!parsed) return res.status(502).json({ error: 'AI-Antwort konnte nicht geparst werden', raw: text.slice(0, 500) });
    }
    res.json({
      ok: true,
      encounters: parsed.encounters || [],
      meta: { partySize: size, partyLevel: level, difficulty: diff, xpBudget }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CHARAKTER-EINLADUNGEN — Magic-Links pro Charakter (ersetzt Party-Codes)
// SQL: 006_character_invites.sql
// ═══════════════════════════════════════════════════════════════════════════

function makeInviteToken() {
  // 12-char URL-safe random
  return 'inv_' + crypto.randomBytes(9).toString('base64')
    .replace(/\+/g, '').replace(/\//g, '').replace(/=/g, '').slice(0, 12);
}

function campaignRoom(dmEmail, campaignId) {
  return `${String(dmEmail).toLowerCase().trim()}::${campaignId}`;
}

// POST /api/invites/create — DM oder Spieler erstellt eine Einladung
// Body: { campaignId, dmEmail, characterId, characterName, characterMeta, role, invitedBy, expiresInDays }
app.post('/api/invites/create', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { campaignId, dmEmail, characterId, characterName, characterMeta, role, invitedBy, expiresInDays } = req.body;
  if (!campaignId || !dmEmail || !invitedBy) return res.status(400).json({ error: 'campaignId + dmEmail + invitedBy required' });
  try {
    const token = makeInviteToken();
    const expires = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null;
    const body = {
      token,
      campaign_id: String(campaignId),
      dm_email: String(dmEmail).toLowerCase().trim(),
      character_id: characterId || null,
      character_name: (characterName || '').slice(0, 100) || null,
      character_meta: (characterMeta || '').slice(0, 200) || null,
      role: role === 'dm' ? 'dm' : 'player',
      invited_by: String(invitedBy).toLowerCase().trim(),
      expires_at: expires
    };
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/character_invites`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data?.message || 'Create failed' });
    res.json({ ok: true, invite: Array.isArray(data) ? data[0] : data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/invites/:token — Einladung abrufen (Vorschau für Player-Landing)
app.get('/api/invites/:token', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const token = String(req.params.token || '').trim();
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/character_invites?token=eq.${encodeURIComponent(token)}&select=*&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const data = await resp.json();
    if (!Array.isArray(data) || !data.length) return res.status(404).json({ error: 'Invite nicht gefunden' });
    const inv = data[0];
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invite abgelaufen' });
    }
    res.json({ invite: inv });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/invites/:token/accept — Spieler akzeptiert Einladung
// Body: { email }
app.post('/api/invites/:token/accept', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const token = String(req.params.token || '').trim();
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const normalized = String(email).toLowerCase().trim();
    // Invite holen
    const findResp = await fetch(`${SUPABASE_URL}/rest/v1/character_invites?token=eq.${encodeURIComponent(token)}&select=*&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const invs = await findResp.json();
    if (!Array.isArray(invs) || !invs.length) return res.status(404).json({ error: 'Invite nicht gefunden' });
    const inv = invs[0];
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: 'Invite abgelaufen' });
    // Member upsert
    const memBody = {
      campaign_id: inv.campaign_id,
      dm_email: inv.dm_email,
      member_email: normalized,
      member_role: inv.role,
      character_id: inv.character_id || null,
      character_name: inv.character_name || null
    };
    const memResp = await fetch(`${SUPABASE_URL}/rest/v1/campaign_members?on_conflict=campaign_id,dm_email,member_email`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(memBody)
    });
    const memData = await memResp.json();
    // Invite als used markieren (nicht-blockierend)
    if (!inv.used_by) {
      await fetch(`${SUPABASE_URL}/rest/v1/character_invites?token=eq.${encodeURIComponent(token)}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ used_by: normalized, used_at: new Date().toISOString() })
      });
    }
    res.json({
      ok: true,
      invite: inv,
      member: Array.isArray(memData) ? memData[0] : memData,
      campaignRoom: campaignRoom(inv.dm_email, inv.campaign_id)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/invites/by-campaign/:dmEmailHash/:campaignId — Liste aktiver Invites
// (Nur für DM-Studio-View — pendingPlayerSlots)
app.get('/api/invites/by-campaign', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { dmEmail, campaignId } = req.query;
  if (!dmEmail || !campaignId) return res.status(400).json({ error: 'dmEmail + campaignId required' });
  try {
    const dm = String(dmEmail).toLowerCase().trim();
    const url = `${SUPABASE_URL}/rest/v1/character_invites?dm_email=eq.${encodeURIComponent(dm)}&campaign_id=eq.${encodeURIComponent(campaignId)}&select=*&order=created_at.desc`;
    const resp = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const data = await resp.json();
    res.json({ invites: Array.isArray(data) ? data : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/campaigns/:dmEmail/:campaignId/album — Alle Karten aller Member dieser Kampagne
// Aggregiert via campaign_members → Email → owner_slug → cards/sessions
app.get('/api/campaigns/:dmEmail/:campaignId/album', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const dmEmail = String(req.params.dmEmail || '').toLowerCase().trim();
  const campaignId = String(req.params.campaignId || '').trim();
  if (!dmEmail || !campaignId) return res.status(400).json({ error: 'dmEmail + campaignId required' });
  try {
    // Members holen (inkl. DM)
    const memResp = await fetch(`${SUPABASE_URL}/rest/v1/campaign_members?dm_email=eq.${encodeURIComponent(dmEmail)}&campaign_id=eq.${encodeURIComponent(campaignId)}&select=member_email,member_role,character_name,character_id`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const members = await memResp.json();
    const memberList = Array.isArray(members) ? members : [];
    // DM auch immer dabei (falls nicht in members)
    if (!memberList.find(m => m.member_email === dmEmail)) {
      memberList.unshift({ member_email: dmEmail, member_role: 'dm', character_name: 'DM', character_id: null });
    }
    if (!memberList.length) return res.json({ members: [], cards: [], sessions: [] });

    // Slug pro Member
    const slugByEmail = Object.fromEntries(memberList.map(m => [m.member_email, emailToSlug(m.member_email)]));
    const slugs = Object.values(slugByEmail);
    const dnBySlug = {};
    memberList.forEach(m => { dnBySlug[slugByEmail[m.member_email]] = m.character_name || (m.member_role === 'dm' ? 'DM' : m.member_email.split('@')[0]); });

    // Karten holen (cards + sessions Tabellen, Union)
    const fetchSlugTable = async (table, fields) => {
      try {
        const url = `${SUPABASE_URL}/rest/v1/${table}?owner_slug=in.(${slugs.map(s => '"' + s + '"').join(',')})&select=${fields}&order=created_at.desc&limit=200`;
        const r = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
        if (!r.ok) return [];
        const d = await r.json();
        return Array.isArray(d) ? d : [];
      } catch (e) { return []; }
    };
    const cards = await fetchSlugTable('cards', 'id,number,session_title,legendary_moment,character_name,character_class,rarity,image_url,owner_slug,created_at');
    const sessions = await fetchSlugTable('sessions', '*');

    // Member-Name annotieren
    cards.forEach(c => { c._memberName = dnBySlug[c.owner_slug] || ''; });
    sessions.forEach(s => { s._memberName = dnBySlug[s.owner_slug] || ''; });

    res.json({ members: memberList, cards, sessions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/campaigns/by-member?email= — alle Kampagnen denen User beigetreten ist
app.get('/api/campaigns/by-member', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const normalized = String(email).toLowerCase().trim();
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/campaign_members?member_email=eq.${encodeURIComponent(normalized)}&select=*&order=joined_at.desc`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const data = await resp.json();
    res.json({ memberships: Array.isArray(data) ? data : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/invites/:token/revoke — DM löscht eine offene Einladung
app.post('/api/invites/:token/revoke', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const token = String(req.params.token || '').trim();
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/character_invites?token=eq.${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    res.json({ ok: resp.ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// LIVE MULTIPLAYER DICE — DM Studio + Player View shared roll-stream
// SQL: 005_live_dice.sql · Realtime-Subscriptions via Supabase Realtime
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/live/request — DM erstellt eine Würfel-Anfrage
// Scope: entweder partyCode (Legacy) ODER campaignRoom (neu, "dm_email::campaign_id")
app.post('/api/live/request', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { partyCode, campaignRoom: room, dmEmail, prompt, statType, dc, targetEmails, visibility, expiresInSec } = req.body;
  if (!dmEmail || !prompt || (!partyCode && !room)) return res.status(400).json({ error: '(partyCode|campaignRoom) + dmEmail + prompt required' });
  try {
    const normalized = String(dmEmail).toLowerCase().trim();
    const expiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null;
    const body = {
      party_code: partyCode ? String(partyCode).toUpperCase().trim() : ('CAMPAIGN_' + (room || '').slice(0, 50)),
      campaign_room: room || null,
      dm_email: normalized,
      prompt: String(prompt).slice(0, 200),
      stat_type: statType || null,
      dc: dc != null ? parseInt(dc) : null,
      target_emails: Array.isArray(targetEmails) && targetEmails.length ? targetEmails.map(e => String(e).toLowerCase().trim()) : null,
      visibility: visibility === 'dm_only' ? 'dm_only' : 'public',
      expires_at: expiresAt
    };
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/roll_requests`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data?.message || 'Request failed', detail: data });
    res.json({ ok: true, request: Array.isArray(data) ? data[0] : data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/live/roll — Spieler postet einen Würfelwurf
// Wenn requestId angegeben: Antwort auf einen DM-Request, sonst spontaner Roll.
// Scope: partyCode (Legacy) ODER campaignRoom (neu)
app.post('/api/live/roll', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const { partyCode, campaignRoom: room, playerEmail, playerName, characterName, stat, modifier, d20, dc, requestId, visibility } = req.body;
  if (!playerEmail || d20 == null || (!partyCode && !room)) return res.status(400).json({ error: '(partyCode|campaignRoom) + playerEmail + d20 required' });
  try {
    const normalized = String(playerEmail).toLowerCase().trim();
    const d = Math.max(1, Math.min(20, parseInt(d20) || 0));
    const m = parseInt(modifier) || 0;
    const total = d + m;
    const dcVal = dc != null ? parseInt(dc) : null;
    let resultKind = null;
    if (d === 20) resultKind = 'crit-success';
    else if (d === 1) resultKind = 'crit-fail';
    else if (dcVal != null) resultKind = total >= dcVal ? 'success' : 'fail';

    const body = {
      party_code: partyCode ? String(partyCode).toUpperCase().trim() : ('CAMPAIGN_' + (room || '').slice(0, 50)),
      campaign_room: room || null,
      request_id: requestId ? parseInt(requestId) : null,
      player_email: normalized,
      player_name: (playerName || '').slice(0, 60) || null,
      character_name: (characterName || '').slice(0, 60) || null,
      stat: stat ? String(stat).slice(0, 20) : null,
      modifier: m,
      d20: d,
      total,
      dc: dcVal,
      result_kind: resultKind,
      visibility: visibility === 'dm_only' ? 'dm_only' : 'public'
    };
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/live_rolls`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data?.message || 'Roll failed' });
    res.json({ ok: true, roll: Array.isArray(data) ? data[0] : data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/live/stream/:partyCode — letzte 50 Rolls + offene Requests
// Akzeptiert auch ?room=... als alternativer Scope für campaign_room.
app.get('/api/live/stream/:partyCode', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const code = String(req.params.partyCode || '').toUpperCase().trim();
  const room = req.query.room || null;
  try {
    let rollsUrl, reqsUrl;
    if (room) {
      rollsUrl = `${SUPABASE_URL}/rest/v1/live_rolls?campaign_room=eq.${encodeURIComponent(room)}&select=*&order=created_at.desc&limit=50`;
      reqsUrl  = `${SUPABASE_URL}/rest/v1/roll_requests?campaign_room=eq.${encodeURIComponent(room)}&resolved_at=is.null&select=*&order=created_at.desc&limit=20`;
    } else {
      rollsUrl = `${SUPABASE_URL}/rest/v1/live_rolls?party_code=eq.${encodeURIComponent(code)}&select=*&order=created_at.desc&limit=50`;
      reqsUrl  = `${SUPABASE_URL}/rest/v1/roll_requests?party_code=eq.${encodeURIComponent(code)}&resolved_at=is.null&select=*&order=created_at.desc&limit=20`;
    }
    const rollsResp = await fetch(rollsUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const rolls = await rollsResp.json();
    const reqResp = await fetch(reqsUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const requests = await reqResp.json();
    res.json({
      rolls: Array.isArray(rolls) ? rolls : [],
      openRequests: Array.isArray(requests) ? requests : []
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/live/request/:id/cancel — DM cancelt eine offene Request
app.post('/api/live/request/:id/cancel', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/roll_requests?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ resolved_at: new Date().toISOString() })
    });
    res.json({ ok: resp.ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/hall-of-fame/recompute', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  try {
    const allResp = await fetch(`${SUPABASE_URL}/rest/v1/card_stats?select=card_id,vote_count`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const all = await allResp.json();
    if (!Array.isArray(all)) return res.status(500).json({ error: 'Cannot read card_stats' });
    let updated = 0;
    for (const row of all) {
      let createdAt = null;
      const sessR = await fetch(`${SUPABASE_URL}/rest/v1/sessions?id=eq.${encodeURIComponent(row.card_id)}&select=created_at&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const sess = await sessR.json();
      if (Array.isArray(sess) && sess.length) createdAt = sess[0].created_at;
      if (!createdAt) {
        const cardR = await fetch(`${SUPABASE_URL}/rest/v1/cards?id=eq.${encodeURIComponent(row.card_id)}&select=created_at&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
        const card = await cardR.json();
        if (Array.isArray(card) && card.length) createdAt = card[0].created_at;
      }
      const ageDays = createdAt ? (Date.now() - new Date(createdAt).getTime()) / 86400000 : 0;
      const score = (row.vote_count || 0) * Math.exp(-ageDays / 7);
      await fetch(`${SUPABASE_URL}/rest/v1/card_stats?card_id=eq.${encodeURIComponent(row.card_id)}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trending_score: score, updated_at: new Date().toISOString() })
      });
      updated++;
    }
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/image', async (req, res) => {
  try {
    const { prompt, model = 'flux-pro', width, height, aspect_ratio } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    const body = { model, prompt };
    if (model.includes('grok')) {
      body.aspect_ratio = aspect_ratio || '2:3';
    } else if (model.includes('seedream')) {
      // Seedream-4.5 verlangt mindestens 3.686.400 Pixel — bei kleinerem Input auto-skalieren statt teurer Call der failed
      let w = width || 2048, h = height || 2048;
      const MIN_PX = 3686400;
      if (w * h < MIN_PX) {
        const scale = Math.sqrt(MIN_PX / (w * h));
        const newW = Math.ceil(w * scale);
        const newH = Math.ceil(h * scale);
        console.log(`[seedream] auto-scaling ${w}x${h} (${w*h}px) → ${newW}x${newH} (${newW*newH}px) to meet 3.686.400 minimum`);
        w = newW; h = newH;
      }
      body.image_size = { width: Math.max(w, 1440), height: Math.max(h, 1440) };
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

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE PROXY — for the Bundle Studio tool. Generated images live on third-party
// CDNs (AIML / Replicate) that don't send permissive CORS headers, so the browser
// can't fetch them as blobs to build a ZIP. This streams them back same-origin.
// SAFETY: only https, host must end with an allow-listed CDN suffix (blocks SSRF
// to internal/private hosts), and the upstream content-type must be an image.
// ═══════════════════════════════════════════════════════════════════════════
const IMAGE_PROXY_ALLOWED_HOSTS = [
  'aimlapi.com', 'cdn.aimlapi.com', 'api.aimlapi.com',
  'replicate.delivery', 'replicate.com',
  'fal.media', 'fal.ai',
  'storage.googleapis.com', 'amazonaws.com',
  'blob.core.windows.net', 'bytedance.com', 'volccdn.com', 'volces.com'
];
app.get('/api/image/proxy', async (req, res) => {
  try {
    const raw = req.query.url;
    if (!raw || typeof raw !== 'string') return res.status(400).json({ error: 'url required' });
    let u;
    try { u = new URL(raw); } catch { return res.status(400).json({ error: 'invalid url' }); }
    if (u.protocol !== 'https:') return res.status(400).json({ error: 'https only' });
    const host = u.hostname.toLowerCase();
    // Block obvious internal / private targets (SSRF guard)
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::1|metadata\.)/.test(host) || host.endsWith('.internal')) {
      return res.status(403).json({ error: 'host not allowed' });
    }
    const ok = IMAGE_PROXY_ALLOWED_HOSTS.some(suf => host === suf || host.endsWith('.' + suf) || host.endsWith(suf));
    if (!ok) {
      console.warn('[image proxy] blocked host:', host);
      return res.status(403).json({ error: 'host not allow-listed', host });
    }
    const upstream = await fetch(u.toString(), { redirect: 'follow' });
    if (!upstream.ok) return res.status(502).json({ error: 'upstream ' + upstream.status });
    const ctype = upstream.headers.get('content-type') || '';
    if (!ctype.startsWith('image/')) {
      return res.status(415).json({ error: 'not an image', ctype });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', ctype);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Content-Disposition', 'attachment');
    return res.send(buf);
  } catch (err) {
    console.error('[image proxy] error:', err.message);
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

    // If sharp is available, transcode to JPEG at 1200px max — guarantees WhatsApp/Slack/Messenger compat.
    // WebP is the killer here: AIML/Seedream often returns WebP, which WhatsApp cannot render in previews.
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

// ═══════════════════════════════════════════════════════════════════════════
// LORE CODEX — AI-generated campaign wiki from characters, sessions, locations
// POST /api/lore-codex
// Body: { campaign, characters[], npcs[], locations[], sessions[] }
// Returns: { entries: [{ type, name, summary, connections[], tags[], secrets }] }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/lore-codex', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  const { campaign = {}, characters = [], npcs = [], locations = [], sessions = [] } = req.body;

  const context = [
    `# Campaign: ${campaign.name || 'Unnamed'}`,
    campaign.description ? `Description: ${campaign.description}` : '',
    characters.length ? `## Player Characters\n${characters.map(c =>
      `- ${c.name} (${[c.race, c.class, c.level ? 'Lv' + c.level : ''].filter(Boolean).join(' ')}): ${c.backstory || '—'}`
    ).join('\n')}` : '',
    npcs.length ? `## NPCs\n${npcs.map(n => `- ${n.name}: ${n.description || '—'}`).join('\n')}` : '',
    locations.length ? `## Locations\n${locations.map(l => `- ${l.name}: ${l.description || '—'}`).join('\n')}` : '',
    sessions.length ? `## Sessions\n${sessions.map((s, i) =>
      `### Session ${i + 1}: ${s.title || 'Unnamed'}\n${s.recap || '—'}`
    ).join('\n\n')}` : ''
  ].filter(Boolean).join('\n\n');

  const system = `You are a TTRPG lore scholar. Given campaign data, generate a structured wiki with 4–10 entries covering the most important people, places, factions, events, and mysteries.

Return ONLY valid JSON in this exact shape:
{
  "entries": [
    {
      "type": "character" | "npc" | "location" | "faction" | "event" | "item" | "mystery",
      "name": "string",
      "summary": "2–3 sentence in-world description",
      "connections": ["name of related entry", ...],
      "tags": ["3–5 short keywords"],
      "secrets": "optional DM-only note, omit if none"
    }
  ]
}

Focus on what makes this campaign unique. Cross-link entries via connections. secrets should only appear when genuinely interesting.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        system,
        messages: [{ role: 'user', content: context || '# Campaign: Unnamed' }]
      })
    });

    let data;
    try { data = await r.json(); }
    catch (parseErr) {
      console.error('[lore-codex] Claude response not JSON:', parseErr.message);
      return res.status(502).json({ error: 'Unexpected response from Claude API' });
    }

    if (!r.ok) {
      const msg = data?.error?.message || JSON.stringify(data);
      console.error('[lore-codex] Claude API error', r.status, msg);
      return res.status(502).json({ error: `Claude API: ${msg}` });
    }

    const text = data?.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('[lore-codex] No JSON block in Claude response. Raw text:', text.slice(0, 400));
      return res.status(500).json({ error: 'Claude returned no JSON. Versuche es erneut.' });
    }

    let wiki;
    try { wiki = JSON.parse(match[0]); }
    catch (jsonErr) {
      console.error('[lore-codex] JSON.parse failed:', jsonErr.message, '\nRaw:', match[0].slice(0, 400));
      return res.status(500).json({ error: 'JSON parse error in Claude response' });
    }

    if (!Array.isArray(wiki.entries)) wiki.entries = [];
    res.json(wiki);
  } catch (err) {
    console.error('[lore-codex] Unexpected error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// BUNDLE LISTING GENERATOR
// Erzeugt fertige Marketplace-Listings (Etsy + DMs Guild + Gumroad + itch.io)
// aus Bundle-Theme + Asset-Manifest. Spart pro Bundle ~60 Min Schreibarbeit.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/listing-generator', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });
  const { bundleName, tagline, tier, assetCount, assetTitles, marketplace } = req.body;
  if (!bundleName) return res.status(400).json({ error: 'bundleName required' });

  const tierGuidance = {
    flagship: 'Premium-Pack (20-30€) — Positionierung: das ultimative, all-in-one DM Kit für dieses Setting. Description hebt Vollständigkeit hervor, suggeriert "saves you 20+ hours of prep".',
    evergreen: 'Solides Themed-Pack (10-18€) — bewährte Themen mit klarer Zielgruppe. Description fokussiert auf Use-Cases ("perfekt für Lost Mine of Phandelver session 3").',
    trope: 'Mini-Pack (6-12€) — generische aber dauerverkaufende Kategorien. Description spricht eine breite Zielgruppe an, betont Wiederverwendbarkeit.'
  }[tier] || 'Mittlere Preisklasse, Standard-Positionierung.';

  const targetMarketplace = ['etsy','dmsguild','gumroad','itch'].includes(marketplace) ? marketplace : 'all';

  const systemPrompt = `Du bist ein erfahrener D&D-Marketplace-SEO-Texter. Antworte AUSSCHLIESSLICH mit gültigem JSON ohne Markdown-Codeblock.

Du schreibst hochkonvertierende Listing-Texte für ein digitales D&D-Bundle:

BUNDLE-NAME: "${bundleName}"
${tagline ? 'TAGLINE: ' + tagline : ''}
TIER: ${tier || 'evergreen'} (${tierGuidance})
ASSETS: ${assetCount || 'unbekannt'} Items
${Array.isArray(assetTitles) && assetTitles.length ? 'ASSET-LISTE:\n' + assetTitles.slice(0,30).map(t => '- ' + t).join('\n') : ''}

REGELN:
- Titles: 3 Varianten, max 140 Zeichen, FRONT-LOADED mit den wichtigsten Keywords (Etsy-Algo bevorzugt erste Worte)
- Etsy-Tags: GENAU 13 Tags, je max 20 Zeichen, LONG-TAIL-fokussiert (nicht "d&d", lieber "dnd npc tokens", "dungeon master gift"). Mix aus: 5 Produkt-Keywords + 4 Setting-Keywords + 4 Use-Case-Keywords.
- Etsy-Description: 250-400 Wörter, in EN. Format: kurzer Hook (1 Satz) + Bullet-Point-Liste "What you get" + Use-Cases-Absatz + Compatibility-Hinweise (Roll20, Foundry, Owlbear, Tabletop) + Print-Instructions kurz + Closing-CTA.
- DMs Guild description: anders schreiben — direkter, kämpfer-orientiert, "supplement" statt "pack", 200-300 Wörter, betont GM-Workflow-Vorteil
- Gumroad description: lockerer Ton, betont künstlerische Qualität + Lizenz für Streamer
- itch.io description: indie-friendly, betont Community + Lizenz für Hobby-Projekte
- Pinterest Pin Texts: 5 Varianten je max 70 Zeichen, klickstarke Hooks ("Stop scrambling for NPCs before session.")
- Pricing: konkrete Empfehlung mit Begründung
- Cover-Image-Vorschlag: welcher Asset-Typ aus der Liste eignet sich am besten als Hero

ANTWORT-FORMAT (exakt dieses JSON-Schema, kein Markdown):
{
  "titles": ["Title 1", "Title 2", "Title 3"],
  "etsy_tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10","tag11","tag12","tag13"],
  "etsy_description": "Multi-line description with \\n\\n for paragraphs and • for bullets",
  "dmsguild_description": "...",
  "gumroad_description": "...",
  "itch_description": "...",
  "pinterest_pins": ["Hook 1", "Hook 2", "Hook 3", "Hook 4", "Hook 5"],
  "pricing": { "etsy": 12.99, "dmsguild": 9.95, "gumroad": 12, "itch": 10, "reasoning": "..." },
  "cover_suggestion": "Welcher Asset-Typ als Hero (1 Satz)",
  "seo_short": "65-Zeichen Meta-Description"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Generiere die Listing-Texte als JSON für das Bundle "${bundleName}". Target-Marketplace: ${targetMarketplace}.` }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('[listing-gen] Claude API error', response.status, data?.error?.message);
      return res.status(502).json({ error: data?.error?.message || 'Claude API error' });
    }
    let text = '';
    if (Array.isArray(data.content)) text = data.content.map(c => c.type === 'text' ? c.text : '').join('').trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch(_){}
      if (!parsed) return res.status(502).json({ error: 'AI-Antwort konnte nicht geparst werden', raw: text.slice(0, 500) });
    }
    res.json({ ok: true, listing: parsed, meta: { bundleName, tier, marketplace: targetMarketplace } });
  } catch (e) {
    console.error('[listing-gen]', e);
    res.status(500).json({ error: e.message });
  }
});



// ═══════════════════════════════════════════════════════════════════════════
// PINTEREST PIN TEXTS — Claude generiert virale Hooks + Subtitles für Pin-Overlays
// Frontend nutzt /api/image für Hintergrundbilder + canvas-composing für Overlays
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/pinterest-pin-texts', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });
  const { bundleName, tagline, tier, count } = req.body;
  if (!bundleName) return res.status(400).json({ error: 'bundleName required' });
  const numPins = Math.max(3, Math.min(10, parseInt(count) || 5));

  const systemPrompt = `Du bist Pinterest-Marketing-Profi für D&D-/TTRPG-Content. Antworte AUSSCHLIESSLICH mit gültigem JSON ohne Markdown.

Du schreibst ${numPins} virale Pinterest-Pin-Texte für ein D&D-Bundle:

BUNDLE: "${bundleName}"
${tagline ? 'KONTEXT: ' + tagline : ''}
TIER: ${tier || 'evergreen'}

REGELN für Pin-Hooks (was Pinterest-User klickbar macht):
- Hooks sind KURZ + SPEZIFISCH + EMOTIONAL — "Stop scrambling for NPCs before session" > "Get NPC pack"
- Mix aus 5 Hook-Stilen: Pain-Point ("Tired of bland NPCs?"), Listicle ("17 NPCs every DM needs"), Curiosity-Gap ("The DM trick that saved my campaign"), Authority ("Used by 500+ DMs"), Result-Promise ("Run your next session in 30 minutes")
- Subtitle: 1 ergänzender Satz, was im Pack ist + an wen es geht
- KEINE Generika wie "Awesome NPC Pack". Pinterest-User scrollen drüber weg.
- Pin-Style-Vorschlag pro Pin: welche Visual-Atmosphäre (dark gothic / bright fantasy / minimal text-focus / character-portrait / map-focused / collage)
- CTA: kurze Action-Phrase fürs Pin-Bottom (max 4 Wörter)

ANTWORT-FORMAT (exaktes JSON):
{
  "pins": [
    { "hook": "Hauptzeile, max 65 Zeichen, klickstarker Hook", "subtitle": "Subtitle 1 Satz, max 90 Zeichen", "cta": "Get the pack", "visual_style": "dark gothic candle-lit", "hook_style": "pain-point" },
    ...
  ]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Generiere ${numPins} Pinterest-Pin-Texte als JSON für "${bundleName}".` }]
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(502).json({ error: data?.error?.message || 'Claude API error' });
    let text = '';
    if (Array.isArray(data.content)) text = data.content.map(c => c.type === 'text' ? c.text : '').join('').trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch(_){}
      if (!parsed) return res.status(502).json({ error: 'AI-Antwort konnte nicht geparst werden', raw: text.slice(0, 500) });
    }
    res.json({ ok: true, pins: parsed.pins || [], meta: { bundleName, count: numPins } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`EndoCraft API running on port ${PORT}`));
