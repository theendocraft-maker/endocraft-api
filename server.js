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
app.use(express.json({ limit: '45mb', verify: (req, _res, buf) => { req.rawBody = buf; } })); // 45mb: Etsy-Digital-Files (max 20MB binär ≈ 27MB base64) laufen als JSON durch; rawBody für Stripe-Webhook-Signatur
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
const AIML_KEY = process.env.AIML_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 8080;

// ─── Backend Hardening Helpers (added 2026-06-16) ───
// Why: prevent indefinite hangs when downstream services are slow/dead.
// Wraps fetch with AbortController for timeout support. Default 45s for AI calls.
async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Admin-Auth-Helper: accepts ADMIN_KEY via query (?key=) OR header (x-admin-key).
// Returns 401 if invalid, 500 if ADMIN_KEY not configured server-side. Returns true if ok (no response written).
function checkAdminKey(req, res) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(500).json({ error: 'ADMIN_KEY not configured' });
    return false;
  }
  const provided = req.query.key || req.headers['x-admin-key'];
  if (provided !== adminKey) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// ─── Resend Email-Integration (prepared 2026-06-16, refactored 2026-06-16) ───
// Activates only when RESEND_API_KEY is set. Until then: all email-functions are no-op.
// Uses Resend's REST API directly via fetch — no SDK dependency.
// Setup steps:
// 1. Set RESEND_API_KEY env in Railway
// 2. Optionally set RESEND_FROM (default: marco@endocraft.app)
// 3. Run supabase-migrations/008_welcome_email_columns.sql
// 4. Verify endocraft.app DNS (SPF + DKIM via Resend dashboard)
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Marco @ EndoCraft <marco@endocraft.app>';
const resendActive = !!RESEND_API_KEY;
if (resendActive) console.log('[email] Resend active · sending via REST API');

// Email-Templates · plain-text for high deliverability + Marco's voice
function emailTemplate1Welcome(unsubToken) {
  return `Hey,

Thanks for grabbing the free pack.

Inside the ZIP you'll find:
- 5 high-res NPC portraits (1800x2400 PNG)
- One quick-reference doc with names, traits, and plot hooks
- A README that explains how I'd use each in a session

Two things to know:

1. Every face was reviewed by me before going in. AI does the heavy lifting (Seedream 4.5), but I keep the obvious AI tells out — janky hands, weird eyes, that uncanny stare. If you spot one I missed, hit reply and I'll fix it.

2. No newsletter shotgun. I'll send maybe 2-3 more emails — useful D&D things, not "click here to buy". If even that's too much, the unsubscribe at the bottom kills it forever, no hard feelings.

If you've got a sec — what adventure are you running next? I read every reply and use them to decide which packs to build next. Even one word ("Phandelver", "homebrew", "Frostmaiden") helps.

Roll high,
Marco

---

P.S. — There's a 10% discount code waiting on the thank-you page (WELCOME10) if you want to grab one of the premium packs. No pressure, just FYI.

Download free pack again: https://endocraft.app/free/endocraft-free-pack.zip
Browse premium packs on Etsy: https://www.etsy.com/shop/EndoCraft?utm_source=endocraft&utm_medium=welcome_email&utm_campaign=email_1

Unsubscribe: https://endocraft-production.up.railway.app/unsubscribe?token=${unsubToken}`;
}

function emailTemplate2ProTip(unsubToken) {
  return `Hey,

Quick one.

Something that took me embarrassingly long to figure out as a DM: an NPC doesn't need a voice. They need three sentences you can deliver consistently.

The format I steal from sitcom writers:

1. ONE physical tic the players will see every time
   ("constantly polishes a coin", "never makes eye contact", "rubs the scar on her wrist")

2. ONE verbal habit
   ("calls everyone 'friend' even when threatening", "starts every sentence with 'See, the thing is...'", "ends statements with a question")

3. ONE thing they want from this scene
   ("wants the party to leave so he can drink", "wants to impress them", "wants to find out who sent them")

That's the entire NPC at the table level. The traits doc inside the free pack is built around exactly this — I put the physical tic, the verbal habit, and the want in three short lines.

Try it on the next NPC you run. Even if everything else falls apart, those three things hold the character together.

If you're prepping a specific session this week, hit reply with the adventure or scene — I'll write you three sentences in this format for a key NPC. Free, no catch. I just like writing them.

Roll high,
Marco

---

P.S. — One concrete example using a name from the free pack:

Thalon Greycloak (Old Mercenary)
- Constantly checks his blind side, like he's expecting an ambush
- Calls every younger person "kid", even nobles
- Wants someone — anyone — to admit the war wasn't worth it

You can run him in any tavern scene right now.

Browse premium packs on Etsy: https://www.etsy.com/shop/EndoCraft?utm_source=endocraft&utm_medium=welcome_email&utm_campaign=email_2
Unsubscribe: https://endocraft-production.up.railway.app/unsubscribe?token=${unsubToken}`;
}

function emailTemplate3CoSHint(unsubToken) {
  return `Hey,

Last email from me for a while (I promised — 2-3 mails max).

A few people who grabbed the free pack told me they're running Curse of Strahd. So if that's you, here's what I built for it.

The Curse of Strahd Master Pack has 39 assets:

NPC PORTRAITS (12)
- Strahd von Zarovich, Ireena Kolyana, Ismark, Madam Eva, Father Donavich
- Rictavio, Van Richten, Ezmerelda, Vasili von Holtz
- Three Vistani (Eva's daughters)

LOCATIONS (8)
- Castle Ravenloft (interior + exterior)
- Village of Barovia gates, Burgomaster's house, the Tavern
- Svalich Road in fog, Tser Pool encampment, Yester Hill

BATTLE MAPS (4 grid-aligned)
- Death House cellar, Old Bonegrinder mill, Argynvostholt great hall, Yester Hill druid circle

MAGIC ITEMS (2)
- Tome of Strahd, Holy Symbol of Ravenkind

PLUS 13 atmospheric mood pieces for session-opener slides

All 1800x2400 PNG, Roll20 + Foundry + Owlbear Rodeo ready. €14.99 on Etsy, less than a single VTT subscription month.

I built it because when I ran my first CoS table, I wasted three sessions of prep time hunting for "good enough" NPC art that didn't look like 2015 stock photos. This pack is what I wish I'd had on day one.

If you're prepping CoS — use WELCOME10 for 10% off:
https://www.etsy.com/shop/EndoCraft?utm_source=endocraft&utm_medium=welcome_email&utm_campaign=email_3_cos

If you're NOT prepping CoS, ignore this and good luck with whatever you're running. The Phandelver and Storm King packs are in the shop too.

Either way — thanks for grabbing the free pack. I hope at least one of those five NPCs ends up at your table.

Roll high,
Marco

---

P.S. — If you read this all the way to here and you're NOT a DM but just curious about the art: hit reply. I'm always curious how non-DMs find this stuff.

Unsubscribe: https://endocraft-production.up.railway.app/unsubscribe?token=${unsubToken}`;
}

// Send a welcome-email via Resend REST API · no-op if Resend not configured
async function sendWelcomeEmail(emailNumber, lead) {
  if (!resendActive) {
    console.log(`[email] Skipping email ${emailNumber} to ${lead.email} — RESEND_API_KEY not set`);
    return { ok: true, skipped: true };
  }
  const subjects = {
    1: 'Your D&D NPC pack is ready (and what\'s inside)',
    2: 'A trick I use to make NPC voices stick at the table',
    3: 'If you\'re prepping Curse of Strahd next...'
  };
  const templates = {
    1: emailTemplate1Welcome,
    2: emailTemplate2ProTip,
    3: emailTemplate3CoSHint
  };
  const tmplFn = templates[emailNumber];
  if (!tmplFn) {
    console.warn(`[email] Unknown emailNumber: ${emailNumber}`);
    return { ok: false, error: 'unknown email number' };
  }
  try {
    const text = tmplFn(lead.unsubscribe_token);
    // POST to Resend REST API · https://resend.com/docs/api-reference/emails/send-email
    const sendRes = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [lead.email],
        subject: subjects[emailNumber],
        text
      })
    });
    if (!sendRes.ok) {
      const errBody = await sendRes.text().catch(() => '');
      console.error(`[email] Resend API failed (${sendRes.status}):`, errBody.slice(0, 300));
      return { ok: false, error: `Resend HTTP ${sendRes.status}` };
    }
    // Mark as sent in Supabase
    if (SUPABASE_URL && SUPABASE_KEY) {
      const patchUrl = `${SUPABASE_URL}/rest/v1/free_pack_leads?id=eq.${lead.id}`;
      await fetchWithTimeout(patchUrl, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ [`email_${emailNumber}_sent_at`]: new Date().toISOString() })
      });
    }
    console.log(`[email] Sent email ${emailNumber} to ${lead.email}`);
    return { ok: true };
  } catch (e) {
    console.error(`[email] Send failed: email ${emailNumber} to ${lead.email}`, e.message);
    return { ok: false, error: e.message };
  }
}

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
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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

    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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
    const resp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/dm_studio_state?on_conflict=user_email,campaign_id`, {
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
    const resp = await fetchWithTimeout(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
    const resp = await fetchWithTimeout(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
      const insertResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/parties`, {
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
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/party_members`, {
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
    const findResp = await fetchWithTimeout(findUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const parties = await findResp.json();
    if (!findResp.ok) return res.status(findResp.status).json({ error: parties?.message || 'Lookup failed' });
    if (!Array.isArray(parties) || !parties.length) return res.status(404).json({ error: 'Code nicht gefunden' });
    const party = parties[0];
    // Add as member (idempotent via UNIQUE constraint)
    const insertResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/party_members?on_conflict=party_id,email`, {
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
    const resp = await fetchWithTimeout(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
    const findResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/parties?code=eq.${encodeURIComponent(code)}&select=id,name,dm_email&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const parties = await findResp.json();
    if (!Array.isArray(parties) || !parties.length) return res.status(404).json({ error: 'Code nicht gefunden' });
    const party = parties[0];
    const memResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/party_members?party_id=eq.${party.id}&select=email,role,display_name,joined_at&order=joined_at.asc`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const members = await memResp.json();
    res.json({ party, members: Array.isArray(members) ? members : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ───────── STUDIO BETA CODES (server-validated, per-recipient) ─────────
// Tabelle beta_codes (siehe supabase-migrations/009_beta_codes.sql):
//   code text pk, email text, label text, credits int default 30,
//   active bool default true, created_at timestamptz, redeemed_at timestamptz
// Codes liegen NICHT mehr im Frontend → nicht mehr erratbar; pro Empfänger einzigartig + deaktivierbar.
// In-memory Rate-Limit gegen Brute-Force (max 30 Versuche / IP / 10 Min).
const _redeemHits = new Map();
function _redeemLimited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 30;
  const arr = (_redeemHits.get(ip) || []).filter(t => now - t < win);
  arr.push(now);
  _redeemHits.set(ip, arr);
  if (_redeemHits.size > 5000) { for (const [k, v] of _redeemHits) { if (!v.some(t => now - t < win)) _redeemHits.delete(k); } }
  return arr.length > max;
}
app.post('/api/redeem-code', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (_redeemLimited(ip)) return res.status(429).json({ ok: false, error: 'too many attempts' });
  const code = String(req.body?.code || '').toUpperCase().trim();
  if (!code || code.length < 4 || code.length > 40 || !/^[A-Z0-9-]+$/.test(code)) {
    return res.status(400).json({ ok: false, error: 'code required' });
  }
  try {
    const url = `${SUPABASE_URL}/rest/v1/beta_codes?code=eq.${encodeURIComponent(code)}&select=code,credits,active&limit=1`;
    const resp = await fetchWithTimeout(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const rows = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ ok: false, error: rows?.message || 'lookup failed' });
    if (!Array.isArray(rows) || !rows.length || rows[0].active === false) {
      return res.status(404).json({ ok: false, error: 'invalid code' });
    }
    const row = rows[0];
    // First redemption stamp (best-effort, non-blocking)
    fetchWithTimeout(`${SUPABASE_URL}/rest/v1/beta_codes?code=eq.${encodeURIComponent(code)}&redeemed_at=is.null`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ redeemed_at: new Date().toISOString() })
    }).catch(() => {});
    res.json({ ok: true, code: row.code, credits: row.credits | 0 });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ───────── CREDIT-HELPERS (server-autoritativ, siehe 010_server_credits.sql) ─────────
async function spendCredits(code, cost) {
  const c = String(code || '').toUpperCase().trim();
  if (!c || !SUPABASE_URL || !SUPABASE_KEY) return { status: 'error', balance: 0 };
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/spend_credits`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: c, p_cost: cost })
    });
    const data = await r.json();
    const row = Array.isArray(data) ? data[0] : data;
    if (!r.ok || !row) return { status: 'error', balance: 0 };
    return { status: row.status, balance: row.balance | 0 };
  } catch (e) { return { status: 'error', balance: 0 }; }
}
async function addCredits(code, amount) {
  const c = String(code || '').toUpperCase().trim();
  if (!c || !SUPABASE_URL || !SUPABASE_KEY) return -1;
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/add_credits`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: c, p_amount: amount })
    });
    const data = await r.json();
    return (typeof data === 'number') ? data : -1;
  } catch (e) { return -1; }
}
// GET /api/credits?code= — aktuellen Kontostand lesen (read-only, kein Abbuchen).
app.get('/api/credits', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const code = String(req.query.code || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: 'code required' });
  try {
    const url = `${SUPABASE_URL}/rest/v1/beta_codes?code=eq.${encodeURIComponent(code)}&select=credits,active&limit=1`;
    const r = await fetchWithTimeout(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length || rows[0].active === false) return res.status(404).json({ ok: false, error: 'invalid code' });
    res.json({ ok: true, credits: rows[0].credits | 0 });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ───────── STRIPE — CREDIT-KAUF (Test-Modus bis live geschaltet) ─────────
// Credit-Packs (amount = Cent EUR). Preise/Mengen frei anpassbar.
const CREDIT_PACKS = {
  starter: { credits: 60,  amount: 499,  label: 'Starter — 60 credits' },
  plus:    { credits: 160, amount: 999,  label: 'Plus — 160 credits' },
  pro:     { credits: 400, amount: 1999, label: 'Pro — 400 credits' }
};
// GET /api/credit-packs — Pack-Liste fürs Frontend
app.get('/api/credit-packs', (_req, res) => {
  res.json({ packs: Object.entries(CREDIT_PACKS).map(([id, p]) => ({ id, credits: p.credits, amount: p.amount, label: p.label })) });
});
// POST /api/checkout { code, pack } → Stripe Checkout-Session, gibt { url } zurück
app.post('/api/checkout', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe not configured' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const code = String(req.body?.code || '').toUpperCase().trim();
  const packId = String(req.body?.pack || '').toLowerCase().trim();
  const pack = CREDIT_PACKS[packId];
  if (!code) return res.status(400).json({ error: 'code required' });
  if (!pack) return res.status(400).json({ error: 'invalid pack' });
  try {
    const chk = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/beta_codes?code=eq.${encodeURIComponent(code)}&select=active&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const rows = await chk.json();
    if (!Array.isArray(rows) || !rows.length || rows[0].active === false) return res.status(404).json({ error: 'invalid code' });
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', 'https://endocraft.app/studio/?paid=1');
    params.append('cancel_url', 'https://endocraft.app/studio/?canceled=1');
    params.append('client_reference_id', code);
    params.append('metadata[code]', code);
    params.append('metadata[pack]', packId);
    params.append('metadata[credits]', String(pack.credits));
    params.append('line_items[0][quantity]', '1');
    params.append('line_items[0][price_data][currency]', 'eur');
    params.append('line_items[0][price_data][unit_amount]', String(pack.amount));
    params.append('line_items[0][price_data][product_data][name]', `EndoCraft Studio — ${pack.label}`);
    const r = await fetchWithTimeout('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status >= 400 ? r.status : 500).json({ error: (data.error && data.error.message) || 'checkout failed' });
    res.json({ url: data.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// POST /api/stripe-webhook — signaturgeprüft; schreibt Credits nach erfolgreicher Zahlung gut (idempotent)
app.post('/api/stripe-webhook', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];
  if (!secret || !sig || !req.rawBody) return res.status(400).send('bad request');
  // Stripe-Signatur prüfen: HMAC-SHA256(secret, `${t}.${rawBody}`)
  const parts = String(sig).split(',').reduce((a, p) => { const i = p.indexOf('='); if (i > 0) a[p.slice(0, i)] = p.slice(i + 1); return a; }, {});
  const signedPayload = `${parts.t}.${req.rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  let valid = false;
  try { valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 || '')); } catch (e) { valid = false; }
  if (!valid) return res.status(400).send('invalid signature');
  let event; try { event = JSON.parse(req.rawBody.toString('utf8')); } catch (e) { return res.status(400).send('bad json'); }
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object || {};
      const code = (s.metadata && s.metadata.code) || s.client_reference_id;
      const credits = parseInt((s.metadata && s.metadata.credits) || '0', 10);
      if (s.payment_status === 'paid' && code && credits > 0) {
        // Idempotenz: stripe_event_id ist UNIQUE; ignore-duplicates → nur bei NEUER Zeile gutschreiben
        const ins = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/credit_purchases`, {
          method: 'POST',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation,resolution=ignore-duplicates' },
          body: JSON.stringify({ stripe_event_id: event.id, code, pack: (s.metadata && s.metadata.pack) || null, credits, amount: s.amount_total || null, currency: s.currency || null, status: 'paid' })
        });
        const rows = await ins.json().catch(() => []);
        if (Array.isArray(rows) && rows.length) { await addCredits(code, credits); }
      }
    }
  } catch (e) { /* nicht 500en → Stripe würde sonst endlos retrien; geloggt reicht */ console.error('[stripe-webhook]', e.message); }
  res.json({ received: true });
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
    const findResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/parties?code=eq.${encodeURIComponent(code)}&select=id,name,dm_email,unlocks,card_count&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const parties = await findResp.json();
    if (!Array.isArray(parties) || !parties.length) return res.status(404).json({ error: 'Code nicht gefunden' });
    const party = parties[0];

    // Members holen
    const memResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/party_members?party_id=eq.${party.id}&select=email,display_name,role`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
      const sessResp = await fetchWithTimeout(sessUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      if (sessResp.ok) {
        const sessData = await sessResp.json();
        if (Array.isArray(sessData)) allSessions = sessData;
      }
    } catch (e) { /* sessions table missing owner_slug → ignore */ }

    // Cards-Tabelle als Fallback / Ergänzung
    let cards = [];
    try {
      const cardsUrl = `${SUPABASE_URL}/rest/v1/cards?owner_slug=in.(${slugs.map(s => '"' + s + '"').join(',')})&select=id,number,session_title,legendary_moment,character_name,character_class,rarity,image_url,owner_slug,created_at&order=created_at.desc&limit=200`;
      const cardsResp = await fetchWithTimeout(cardsUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/parties?id=eq.${party.id}`, {
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
    const findResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/parties?code=eq.${encodeURIComponent(code)}&select=id,dm_email&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const parties = await findResp.json();
    if (!Array.isArray(parties) || !parties.length) return res.status(404).json({ error: 'Code nicht gefunden' });
    const party = parties[0];
    if (party.dm_email === normalized) return res.status(400).json({ error: 'DM kann nicht austreten — Party muss gelöscht werden' });
    const delResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/party_members?party_id=eq.${party.id}&email=eq.${encodeURIComponent(normalized)}`, {
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
    const upsertResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/card_votes?on_conflict=card_id,voter_email`, {
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
    const statsResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/card_stats?card_id=eq.${encodeURIComponent(cardId)}&select=*&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const stats = await statsResp.json();
    res.json({ ok: true, stats: Array.isArray(stats) ? stats[0] || null : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cards/:id/votes', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const cardId = String(req.params.id || '').trim();
  const { email } = req.query;
  try {
    const statsResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/card_stats?card_id=eq.${encodeURIComponent(cardId)}&select=*&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const statsArr = await statsResp.json();
    const stats = Array.isArray(statsArr) ? statsArr[0] || { vote_count: 0, trending_score: 0 } : { vote_count: 0, trending_score: 0 };
    let myVote = 0;
    if (email) {
      const normalized = String(email).toLowerCase().trim();
      const myResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/card_votes?card_id=eq.${encodeURIComponent(cardId)}&voter_email=eq.${encodeURIComponent(normalized)}&select=vote&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
    const statsResp = await fetchWithTimeout(statsUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const stats = await statsResp.json();
    if (!Array.isArray(stats) || !stats.length) return res.json({ cards: [] });
    const ids = stats.map(s => s.card_id);
    const fetchByIds = async (table) => {
      try {
        const url = `${SUPABASE_URL}/rest/v1/${table}?id=in.(${ids.map(i => '"' + i + '"').join(',')})&select=*`;
        const r = await fetchWithTimeout(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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
    const resp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/character_invites`, {
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
    const resp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/character_invites?token=eq.${encodeURIComponent(token)}&select=*&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
    const findResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/character_invites?token=eq.${encodeURIComponent(token)}&select=*&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
    const memResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/campaign_members?on_conflict=campaign_id,dm_email,member_email`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(memBody)
    });
    const memData = await memResp.json();
    // Invite als used markieren (nicht-blockierend)
    if (!inv.used_by) {
      await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/character_invites?token=eq.${encodeURIComponent(token)}`, {
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
    const resp = await fetchWithTimeout(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
    const memResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/campaign_members?dm_email=eq.${encodeURIComponent(dmEmail)}&campaign_id=eq.${encodeURIComponent(campaignId)}&select=member_email,member_role,character_name,character_id`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
        const r = await fetchWithTimeout(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
    const resp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/campaign_members?member_email=eq.${encodeURIComponent(normalized)}&select=*&order=joined_at.desc`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const data = await resp.json();
    res.json({ memberships: Array.isArray(data) ? data : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/invites/:token/revoke — DM löscht eine offene Einladung
app.post('/api/invites/:token/revoke', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
  const token = String(req.params.token || '').trim();
  try {
    const resp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/character_invites?token=eq.${encodeURIComponent(token)}`, {
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
    const resp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/roll_requests`, {
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
    const resp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/live_rolls`, {
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
    const rollsResp = await fetchWithTimeout(rollsUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const rolls = await rollsResp.json();
    const reqResp = await fetchWithTimeout(reqsUrl, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
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
    const resp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/roll_requests?id=eq.${id}`, {
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
    const allResp = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/card_stats?select=card_id,vote_count`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const all = await allResp.json();
    if (!Array.isArray(all)) return res.status(500).json({ error: 'Cannot read card_stats' });
    let updated = 0;
    for (const row of all) {
      let createdAt = null;
      const sessR = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/sessions?id=eq.${encodeURIComponent(row.card_id)}&select=created_at&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const sess = await sessR.json();
      if (Array.isArray(sess) && sess.length) createdAt = sess[0].created_at;
      if (!createdAt) {
        const cardR = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/cards?id=eq.${encodeURIComponent(row.card_id)}&select=created_at&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
        const card = await cardR.json();
        if (Array.isArray(card) && card.length) createdAt = card[0].created_at;
      }
      const ageDays = createdAt ? (Date.now() - new Date(createdAt).getTime()) / 86400000 : 0;
      const score = (row.vote_count || 0) * Math.exp(-ageDays / 7);
      await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/card_stats?card_id=eq.${encodeURIComponent(row.card_id)}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trending_score: score, updated_at: new Date().toISOString() })
      });
      updated++;
    }
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// EndoCraft Quality-Lock — wird zu jedem Asset-Prompt prepended (außer quality_lock:false)
// Stellt sicher, dass die Bilder unsere Etsy-Versprechen halten:
// - "No janky hands, no broken faces" → anatomically correct hands, sharp face
// - "Cinematic consistent style" → photorealistic-cinematic, no oil painting
// - "Premium D&D Pack" → fantasy art quality, no anime, no AI-amateur artifacts
const QUALITY_LOCK_PREFIX = 'cinematic fantasy character portrait photography, photorealistic, masterpiece quality, professional studio lighting, sharp focus on face and eyes, anatomically correct hands with exactly 5 fingers each, hyperdetailed face with clear features, painterly D&D 5e cover art aesthetic (Wayne Reynolds / Tyler Jacobson style references), period-accurate medieval fantasy clothing, ';
const QUALITY_LOCK_SUFFIX = ', NO anime style, NO oil painting roughness, NO deformed hands, NO extra fingers, NO modern haircuts or makeup, NO contemporary features, NO AI artifacts, NO blurry textures';

app.post('/api/image', async (req, res) => {
  try {
    const { prompt, model = 'flux-pro', width, height, aspect_ratio, quality_lock } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    // Quality-Lock per default ON für character/NPC-style assets, deaktivierbar via quality_lock:false
    const useLock = quality_lock !== false;
    const lockedPrompt = useLock ? (QUALITY_LOCK_PREFIX + prompt + QUALITY_LOCK_SUFFIX) : prompt;
    const body = { model, prompt: lockedPrompt };
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
    const response = await fetchWithTimeout('https://api.aimlapi.com/v1/images/generations', {
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

// ===== EndoCraft Studio: geführte Premium-Generierung (per-Typ-Rezept + Claude-Veredelung + Varianten) =====
// Canonical EndoCraft style suffix — identical to the hand-crafted prompts (feedback_endocraft_bildstil)
const STUDIO_SUFFIX = 'cinematic fantasy, photorealistic, sharp focus, professional photography, 8K resolution, shallow depth of field, no text, no watermark, no blur, no deformed hands, no extra limbs';
const STUDIO_RECIPES = {
  npc: {
    size: { width: 1800, height: 2400 },
    style: 'dramatic cinematic character portrait of a single figure, chest-up to head-and-shoulders composition, strong directional rim lighting and warm candlelight, deep shadows, drifting dust, authentic imperfect details such as scars and worn gear, period-accurate medieval-fantasy'
  },
  monster: {
    size: { width: 2400, height: 1800 },
    style: 'epic cinematic shot of a single menacing fantasy creature resting in its lair, mouth closed, powerful clear silhouette, volumetric atmosphere, dramatic rim lighting and drifting embers, overwhelming sense of dread and scale'
  },
  location: {
    size: { width: 2880, height: 1620 },
    style: 'cinematic photorealistic establishing landscape shot, wide-angle architectural photography composition of an atmospheric fantasy place, volumetric god rays, rich depth and mood, golden-hour or torchlit ambience, drifting dust and mist'
  },
  item: {
    size: { width: 1800, height: 2400 },
    style: 'cinematic still-life product photography of a single fantasy hero object, dramatic single-source light, dark moody background, hyperdetailed material and wear such as aged metal cracked leather and parchment, museum-quality'
  }
};
const STUDIO_NUANCE = [
  ', three-quarter view, warm key light',
  ', alternative composition, cool rim light',
  ', slightly different angle, dramatic backlight',
  ', subtle variation, soft directional fill'
];
function studioSanitize(s) {
  return String(s || '').slice(0, 400)
    .replace(/\b(no|without|avoid|don'?t|never)\s+[\w-]+/gi, ' ')
    .replace(/\b(text|words|letters|caption|captions|title|logo|watermark|signature)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}
// Child-safety: block prompts describing minors before any generation.
function studioMinorBlock(s) {
  const t = String(s || '').toLowerCase();
  const words = /\b(child|children|toddler|infant|baby|newborn|kid|kids|preteen|pre-teen|teen|teenage|teenager|adolescent|minor|schoolgirl|schoolboy|underage|loli)\b/;
  const qualified = /\b(little|young|small|tiny|baby)\b[\w\s,'-]{0,24}\b(girl|boy|child|girls|boys)\b/;
  const age = /\b([0-9]|1[0-7])\s*-?\s*(year|yr)s?\s*-?\s*old\b/;
  if (words.test(t) || qualified.test(t) || age.test(t)) {
    return 'EndoCraft Studio creates adult characters, monsters and locations only — please describe an adult hero or villain, a creature, or a place.';
  }
  return null;
}
async function studioEnrich(type, subject, feedback) {
  if (!ANTHROPIC_KEY) return null;
  const recipe = STUDIO_RECIPES[type] || STUDIO_RECIPES.npc;
  const fbLine = feedback ? `\nThe user was unhappy with the previous result and asked to change this: "${String(feedback).slice(0, 300)}". Revise the prompt to clearly address that, while keeping the same core subject.` : '';
  const system = `You are EndoCraft's image-prompt engineer. Expand the user's idea into ONE vivid Seedream prompt for a ${type}, in EndoCraft's signature Cinematic Fantasy Photography look. Compose in this order: shot type, then the subject with emotion, then environment, then lighting. Apply this look: ${recipe.style}.
House rules (critical): describe exactly ONE subject; open with a concrete cinematic shot type and strong directional lighting; add atmospheric particles (dust, embers, mist); name a concrete time of day or weather; favour an aftermath or a held still moment over mid-action; never include projectiles in flight, hand-to-hand exchanges, two interlocking hands, readable text, mirrors, exact counts, or string instruments. ${type === 'location' ? 'This is an empty place: describe ONLY architecture, landscape and atmosphere; do not mention any person, creature, figure or silhouette at all, not even to exclude them.' : 'Describe exactly ONE person or creature, clearly.'}${fbLine}
40-70 words. No meta words, no "no"/"without"/negation phrases, no instructions about text. Output ONLY the prompt text.`;
  try {
    const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 320, system, messages: [{ role: 'user', content: String(subject || '').slice(0, 400) }] })
    }, 20000);
    const d = await r.json();
    const txt = d && d.content && d.content[0] && d.content[0].text;
    return txt ? txt.trim() : null;
  } catch (e) { return null; }
}
async function studioGenerateOne(prompt, size) {
  let w = size.width, h = size.height;
  const MIN_PX = 3686400;
  if (w * h < MIN_PX) { const s = Math.sqrt(MIN_PX / (w * h)); w = Math.ceil(w * s); h = Math.ceil(h * s); }
  const body = { model: 'bytedance/seedream-4-5', prompt, image_size: { width: Math.max(w, 1440), height: Math.max(h, 1440) } };
  const r = await fetchWithTimeout('https://api.aimlapi.com/v1/images/generations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AIML_KEY}` }, body: JSON.stringify(body)
  }, 90000);
  const d = await r.json();
  if (d.error) throw new Error(typeof d.error === 'string' ? d.error : JSON.stringify(d.error));
  const url = (d.data && d.data[0] && d.data[0].url) || (d.images && d.images[0] && d.images[0].url) || (Array.isArray(d.output) ? d.output[0] : d.output);
  if (!url) throw new Error('No image in response');
  return url;
}
app.post('/api/studio-image', async (req, res) => {
  try {
    const { type = 'npc', subject, variants = 3, feedback, beforeUrls, code } = req.body || {};
    if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'subject required' });
    const minorBlock = studioMinorBlock(subject);
    if (minorBlock) return res.status(400).json({ error: minorBlock });
    const t = STUDIO_RECIPES[type] ? type : 'npc';
    const recipe = STUDIO_RECIPES[t];
    const clean = studioSanitize(subject);
    if (!clean) return res.status(400).json({ error: 'please describe your idea in a few words' });
    let core = await studioEnrich(t, clean, feedback);
    if (!core) core = `${recipe.style}, ${clean}`;
    const n = Math.max(1, Math.min(4, parseInt(variants, 10) || 3));
    // Server-autoritative Abbuchung: 1 Credit pro Variante, VOR der Generierung.
    const codeC = String(code || '').toUpperCase().trim();
    if (!codeC) return res.status(401).json({ error: 'code required' });
    const spend = await spendCredits(codeC, n);
    if (spend.status !== 'ok') {
      if (spend.status === 'insufficient') return res.status(402).json({ error: 'Not enough credits', status: spend.status, balance: spend.balance });
      if (spend.status === 'inactive') return res.status(403).json({ error: 'This code is no longer active', status: spend.status });
      if (spend.status === 'invalid') return res.status(403).json({ error: 'Invalid code', status: spend.status });
      return res.status(500).json({ error: 'Could not charge credits' });
    }
    let balance = spend.balance;
    const jobs = Array.from({ length: n }, (_, i) =>
      studioGenerateOne(`${core}. ${STUDIO_SUFFIX}${STUDIO_NUANCE[i % STUDIO_NUANCE.length]}`, recipe.size));
    const settled = await Promise.allSettled(jobs);
    const urls = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
    // Fehlgeschlagene Varianten zurückbuchen (nur gelieferte zählen).
    if (urls.length < n) { const nb = await addCredits(codeC, n - urls.length); if (nb >= 0) balance = nb; }
    if (urls.length === 0) {
      const reason = (settled.find(s => s.status === 'rejected') || {}).reason;
      const msg = (reason && reason.message) || 'generation failed';
      return res.status(502).json({ error: msg, balance });
    }
    let genId = null;
    if (SUPABASE_URL && SUPABASE_KEY) {
      const ipg = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
      try {
        const ins = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/studio_generations`, {
          method: 'POST',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify({ code: String((req.body && req.body.code) || '').slice(0, 40) || null, type: t, subject: clean.slice(0, 400), prompt: `${core}. ${STUDIO_SUFFIX}`.slice(0, 1500), feedback: feedback ? String(feedback).slice(0, 400) : null, before_urls: Array.isArray(beforeUrls) && beforeUrls.length ? beforeUrls.slice(0, 4) : null, urls, ip: ipg || null })
        });
        const row = await ins.json();
        genId = Array.isArray(row) && row[0] ? row[0].id : ((row && row.id) || null);
      } catch (e) {}
    }
    res.json({ urls, type: t, id: genId, balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/studio-pick', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.json({ ok: false });
  const id = parseInt((req.body && req.body.id), 10);
  const chosen = parseInt((req.body && req.body.chosen), 10);
  if (!id || isNaN(chosen) || chosen < 0 || chosen > 3) return res.status(400).json({ error: 'bad params' });
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/studio_generations?id=eq.${id}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ chosen_index: chosen })
    });
    res.json({ ok: r.ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/studio-gallery', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase missing' });
  try {
    const url = `${SUPABASE_URL}/rest/v1/studio_generations?select=id,code,type,subject,prompt,feedback,before_urls,chosen_index,rating,urls,created_at&order=created_at.desc&limit=300`;
    const r = await fetchWithTimeout(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const data = await r.json();
    res.json({ items: Array.isArray(data) ? data : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Code-Tracking: pro Beta-Code Aktivierung/Generierungen/Rest-Credits + Kanal-Aggregation (Label).
app.get('/api/admin/code-stats', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase missing' });
  try {
    const H = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };
    const [codesR, gensR] = await Promise.all([
      fetchWithTimeout(`${SUPABASE_URL}/rest/v1/beta_codes?select=code,email,label,credits,active,created_at,redeemed_at&order=created_at.desc`, { headers: H }),
      fetchWithTimeout(`${SUPABASE_URL}/rest/v1/studio_generations?select=code,type,created_at&limit=5000`, { headers: H })
    ]);
    const codes = await codesR.json();
    const gens = await gensR.json();
    const genBy = {};
    (Array.isArray(gens) ? gens : []).forEach(g => {
      const c = String(g.code || '').toUpperCase();
      if (!c) return;
      if (!genBy[c]) genBy[c] = { count: 0, last: null };
      genBy[c].count++;
      if (!genBy[c].last || g.created_at > genBy[c].last) genBy[c].last = g.created_at;
    });
    const rows = (Array.isArray(codes) ? codes : []).map(c => {
      const g = genBy[String(c.code || '').toUpperCase()] || { count: 0, last: null };
      return {
        code: c.code,
        label: c.label || '—',
        credits_remaining: c.credits,
        active: c.active,
        created_at: c.created_at,
        redeemed_at: c.redeemed_at,
        generations: g.count,
        last_generation_at: g.last,
        activated: g.count > 0
      };
    });
    const byLabel = {};
    rows.forEach(r => {
      const L = r.label || '—';
      if (!byLabel[L]) byLabel[L] = { label: L, codes: 0, activated: 0, generations: 0, credits_remaining: 0 };
      byLabel[L].codes++;
      if (r.activated) byLabel[L].activated++;
      byLabel[L].generations += r.generations;
      byLabel[L].credits_remaining += (r.credits_remaining || 0);
    });
    res.json({
      ok: true,
      totals: {
        codes: rows.length,
        activated: rows.filter(r => r.activated).length,
        generations: rows.reduce((s, r) => s + r.generations, 0)
      },
      by_channel: Object.values(byLabel).sort((a, b) => b.generations - a.generations),
      codes: rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/studio-rate', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase missing' });
  const id = parseInt((req.body && req.body.id), 10);
  const rating = parseInt((req.body && req.body.rating), 10);
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/studio_generations?id=eq.${id}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ rating: (rating === 1 || rating === -1) ? rating : null })
    });
    res.json({ ok: r.ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/image/fast', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    const startRes = await fetchWithTimeout('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
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
      const pollRes = await fetchWithTimeout(`https://api.replicate.com/v1/predictions/${result.id}`, {
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
    const upstream = await fetchWithTimeout(u.toString(), { redirect: 'follow' });
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

// ═══════════════════════════════════════════════════════════════════════════
// VIDEO GENERATION — AIMLAPI (Kling image-to-video). Async: create task → poll.
// Key stays server-side (AIML_API_KEY in Railway). Mirrors the /api/image flow.
//   POST /api/video         { prompt, image_url, model?, duration?, negative_prompt?, cfg_scale? } -> { id, status }
//   GET  /api/video/status?id=... -> { id, status, url, error, credits_used }
//   GET  /api/video/proxy?url=...  -> streams the finished mp4 same-origin
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/video', async (req, res) => {
  try {
    const { prompt, image_url, model = 'kling-video/v2.1/standard/image-to-video', duration = 5, negative_prompt, cfg_scale, code } = req.body || {};
    if (!image_url && !prompt) return res.status(400).json({ error: 'image_url or prompt required' });
    // Server-autoritative Abbuchung: 1 Clip = 4 Credits, vor Job-Start.
    const VIDEO_COST = 8;
    const codeC = String(code || '').toUpperCase().trim();
    if (!codeC) return res.status(401).json({ error: 'code required' });
    const spend = await spendCredits(codeC, VIDEO_COST);
    if (spend.status !== 'ok') {
      if (spend.status === 'insufficient') return res.status(402).json({ error: 'Not enough credits', status: spend.status, balance: spend.balance });
      if (spend.status === 'inactive') return res.status(403).json({ error: 'This code is no longer active', status: spend.status });
      if (spend.status === 'invalid') return res.status(403).json({ error: 'Invalid code', status: spend.status });
      return res.status(500).json({ error: 'Could not charge credits' });
    }
    const body = { model };
    if (prompt) body.prompt = prompt;
    if (image_url) body.image_url = image_url;
    if (duration) body.duration = String(duration);
    if (negative_prompt) body.negative_prompt = negative_prompt;
    if (cfg_scale != null) body.cfg_scale = cfg_scale;
    const r = await fetchWithTimeout('https://api.aimlapi.com/v2/video/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AIML_KEY}` },
      body: JSON.stringify(body)
    }, 60000);
    const data = await r.json().catch(() => ({}));
    console.log('[video] create:', JSON.stringify(data).substring(0, 300));
    if (!r.ok || data.error) {
      await addCredits(codeC, VIDEO_COST); // Job nicht gestartet → zurückbuchen
      return res.status(r.status >= 400 ? r.status : 500).json({ error: data.error || ('HTTP ' + r.status), raw: data });
    }
    return res.json({ id: data.id, status: data.status, balance: spend.balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/video/status', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const r = await fetchWithTimeout('https://api.aimlapi.com/v2/video/generations?generation_id=' + encodeURIComponent(String(id)), {
      headers: { 'Authorization': `Bearer ${AIML_KEY}` }
    }, 60000);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: data.error || ('HTTP ' + r.status), raw: data });
    return res.json({
      id: data.id,
      status: data.status,
      url: (data.video && data.video.url) || null,
      error: data.error || null,
      credits_used: (data.meta && data.meta.usage && data.meta.usage.credits_used) ?? null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const VIDEO_PROXY_ALLOWED_HOSTS = [
  'aimlapi.com', 'cdn.aimlapi.com', 'api.aimlapi.com',
  'klingai.com', 'kling.com',
  'replicate.delivery', 'fal.media', 'fal.ai',
  'storage.googleapis.com', 'amazonaws.com', 'blob.core.windows.net',
  'bytedance.com', 'volccdn.com', 'volces.com'
];
app.get('/api/video/proxy', async (req, res) => {
  try {
    const raw = req.query.url;
    if (!raw || typeof raw !== 'string') return res.status(400).json({ error: 'url required' });
    let u;
    try { u = new URL(raw); } catch { return res.status(400).json({ error: 'invalid url' }); }
    if (u.protocol !== 'https:') return res.status(400).json({ error: 'https only' });
    const host = u.hostname.toLowerCase();
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::1|metadata\.)/.test(host) || host.endsWith('.internal')) return res.status(403).json({ error: 'host not allowed' });
    const ok = VIDEO_PROXY_ALLOWED_HOSTS.some(suf => host === suf || host.endsWith('.' + suf));
    if (!ok) { console.warn('[video proxy] blocked host:', host); return res.status(403).json({ error: 'host not allow-listed', host }); }
    const upstream = await fetchWithTimeout(u.toString(), { redirect: 'follow' }, 120000);
    if (!upstream.ok) return res.status(502).json({ error: 'upstream ' + upstream.status });
    const ctype = upstream.headers.get('content-type') || 'video/mp4';
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', ctype);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Content-Disposition', 'attachment');
    return res.send(buf);
  } catch (err) {
    console.error('[video proxy] error:', err.message);
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
    const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/subscribers`, {
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
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/subscribers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ email: email.toLowerCase().trim(), source: card.source || 'card-claim' })
        });
      } catch (e) { console.warn('subscribe-on-claim failed:', e.message); }

      const patchRes = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/cards?id=eq.${encodeURIComponent(updateId)}`, {
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
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/subscribers`, {
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

    const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/cards`, {
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
    const response = await fetchWithTimeout(
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
    const r = await fetchWithTimeout(
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
    const imgRes = await fetchWithTimeout(src);
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

// ─── Studio share assets: save a generated image/video, serve a public share page at /s/:id ───
app.post('/api/save-asset', async (req, res) => {
  try {
    const { media_type, kind, url, subject, code } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });
    if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
    const slug = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 7) || crypto.randomBytes(4).toString('hex');
    const body = {
      slug,
      media_type: (media_type === 'video') ? 'video' : 'image',
      kind: kind ? String(kind).slice(0, 24) : null,
      url: String(url).slice(0, 2000),
      subject: subject ? String(subject).slice(0, 300) : null,
      code: code ? String(code).slice(0, 40) : null
    };
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/studio_assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation' },
      body: JSON.stringify(body)
    });
    if (!r.ok) { const t = await r.text(); console.error('save-asset error', r.status, t); return res.status(500).json({ error: 'save failed', detail: t.slice(0, 200) }); }
    const rows = await r.json();
    const saved = Array.isArray(rows) ? rows[0] : rows;
    res.json({ ok: true, id: saved.slug || saved.id });
  } catch (err) { console.error('save-asset handler', err); res.status(500).json({ error: err.message }); }
});

async function fetchAssetById(id) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const filter = isUuid ? `id=eq.${encodeURIComponent(id)}` : `slug=eq.${encodeURIComponent(id)}`;
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/studio_assets?${filter}&select=*`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) { return null; }
}

function renderAssetSharePage(a) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isVideo = a.media_type === 'video';
  const proxied = (isVideo ? '/api/video/proxy?url=' : '/api/image/proxy?url=') + encodeURIComponent(a.url);
  const base = 'https://endocraft-production.up.railway.app';
  const subject = esc(a.subject || 'A cinematic D&D creation');
  const ogImage = isVideo ? 'https://endocraft.app/studio/og-image.jpg' : (base + proxied);
  const media = isVideo
    ? `<video src="${proxied}" autoplay loop muted playsinline controls style="width:100%;height:100%;object-fit:contain;background:#06030a"></video>`
    : `<img src="${proxied}" alt="${subject}" style="width:100%;height:100%;object-fit:contain;background:#06030a">`;
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject} · EndoCraft</title>
<meta name="description" content="A cinematic, hand-crafted D&D ${isVideo ? 'cutscene' : 'scene'} made in the EndoCraft Studio.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="EndoCraft">
<meta property="og:title" content="${subject} · EndoCraft">
<meta property="og:description" content="Cinematic D&D art & cutscenes — make your own free.">
<meta property="og:image" content="${ogImage}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${ogImage}">
<style>
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=EB+Garamond&display=swap');
*{box-sizing:border-box}body{margin:0;background:#0c0e16;color:#f3ecda;font-family:'EB Garamond',Georgia,serif;display:flex;flex-direction:column;align-items:center;min-height:100vh}
.wrap{max-width:680px;width:100%;padding:24px 18px 70px;text-align:center}
.brand{font-family:'Cinzel';font-weight:700;letter-spacing:1px;color:#d8b46a;font-size:18px;text-decoration:none;display:inline-block;margin-bottom:18px}
.brand span{color:#9aa0ae;font-size:11px;letter-spacing:2px}
.media{width:100%;aspect-ratio:1/1;max-height:72vh;border-radius:14px;overflow:hidden;border:1px solid #2a2f42;background:#06030a;display:flex;align-items:center;justify-content:center}
h1{font-family:'Cinzel';font-size:21px;color:#f3ecda;margin:20px 0 4px;line-height:1.3}
.sub{color:#9aa0ae;font-size:14px;margin-bottom:24px}
.cta{display:block;background:#171a26;border:1px solid #9c8244;border-radius:14px;padding:22px;margin-top:10px}
.cta .k{font-family:'Cinzel';font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#d8b46a}
.cta .h{font-family:'Cinzel';font-size:19px;color:#f3ecda;margin:8px 0 6px}
.btn{display:inline-block;margin-top:12px;background:#d8b46a;color:#1a1408;font-family:'Cinzel';font-weight:700;font-size:14px;letter-spacing:1px;text-transform:uppercase;padding:13px 26px;border-radius:8px;text-decoration:none}
footer{margin-top:30px;color:#6b7180;font-size:12px}
</style></head><body><div class="wrap">
<a class="brand" href="https://endocraft.app/">EndoCraft <span>STUDIO</span></a>
<div class="media">${media}</div>
<h1>${subject}</h1>
<div class="sub">Made in the EndoCraft Studio — cinematic, hand-curated D&amp;D art.</div>
<div class="cta">
  <div class="k">Free · no catch</div>
  <div class="h">Make your own cinematic D&amp;D art</div>
  <div style="color:#9aa0ae;font-size:14px">Describe a hero, monster or place — we craft it and send it to your inbox.</div>
  <a class="btn" href="https://endocraft.app/free/?utm_source=share&utm_medium=studio&utm_campaign=asset">Get yours free &rarr;</a>
</div>
<footer>endocraft.app</footer>
</div></body></html>`;
}

app.get('/s/:id', async (req, res) => {
  const id = req.params.id;
  if (!id || !/^[A-Za-z0-9_-]{5,40}$/.test(id)) return res.status(400).send('<h1>Invalid asset ID</h1>');
  const asset = await fetchAssetById(id);
  if (!asset) {
    res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send('<!DOCTYPE html><html><head><title>Not found · EndoCraft</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#0c0e16;color:#f3ecda;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}a{color:#d8b46a;margin-top:20px}</style></head><body><h1 style="font-family:Georgia,serif;font-style:italic;opacity:.7">This creation has faded.</h1><p>The link may have expired.</p><a href="https://endocraft.app/free/">→ Make your own free</a></body></html>');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(renderAssetSharePage(asset));
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
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/subscribers?select=email&limit=1`, {
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
    const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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

  const systemPrompt = `Du bist ein erfahrener D&D-Marketplace-SEO-Texter für EndoCraft. Antworte AUSSCHLIESSLICH mit gültigem JSON ohne Markdown-Codeblock.

Du schreibst hochkonvertierende Listing-Texte für ein digitales D&D-Bundle:

BUNDLE-NAME: "${bundleName}"
${tagline ? 'TAGLINE: ' + tagline : ''}
TIER: ${tier || 'evergreen'} (${tierGuidance})
ASSETS: ${assetCount || 'unbekannt'} Items
${Array.isArray(assetTitles) && assetTitles.length ? 'ASSET-LISTE:\n' + assetTitles.slice(0,30).map(t => '- ' + t).join('\n') : ''}

BRAND-POSITIONIERUNG (WICHTIG · IMMER EINHALTEN):
EndoCraft ist eine Ein-Personen-Studio, die AI-art-Asset-Packs für D&D-DMs kuratiert. NICHT generic AI-Spam — Premium-Curation ist das USP. Differentiatoren:
- Jeder Asset PERSONALLY REVIEWED bevor er ins Bundle kommt (no janky hands, no broken faces)
- Cinematic Style CONSISTENT über alle Bundle-Assets (nicht random AI-Batches)
- Curated für spezifische D&D-Themes (canonical NPCs, on-theme Locations)
- Affordable through AI (€10-20 Bundles statt €200+ Single-Artist-Portrait), Premium through Curation (one-person review)

EHRLICHKEIT BEI AI-DISCLOSURE (ETSY-COMPLIANCE):
- NIEMALS "hand-crafted", "handmade", "hand-painted", "hand-drawn" schreiben — das täuscht
- IMMER nutzen: "AI-crafted, hand-curated" / "personally reviewed" / "cinematic" / "premium curation"
- In jeder Description einen ehrlichen "Honest Disclosure"-Absatz (siehe Beispiel unten) integrieren der AI-Generation zugibt, aber als Feature framt (consistent style, affordable) — mit Human-Curation als Quality-Guarantee
- Disclaimer-Sprache: "Portraits are AI-crafted with Seedream 4.5, then hand-curated and quality-reviewed before shipping. No spam autopilot — every asset eyeballed by a human."

ETSY-DESCRIPTION-STRUKTUR (mandatory layout):
1. Premium-Hook (1 Satz, packend, story-driven)
2. "WHY THIS ISN'T GENERIC AI" — 4 bullet checkmarks die die Differentiatoren listen
3. "WHAT'S INCLUDED" — Asset-Listen-Bullets
4. "HONEST DISCLOSURE" — kurzer Absatz wie oben definiert
5. "INSTANT DOWNLOAD" — File-Format-Info + Use-Case-Note + Lizenz-Info

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
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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


// ═══════════════════════════════════════════════════════════════════════════
// QUALITY CHECK — Claude Vision bewertet ein Asset (Score 1-10 + Issues)
// Input: { imageUrl, assetType, bundleName }
// Output: { score, issues[], reroll_recommended, reasoning }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/quality-check', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });
  const { imageUrl, assetType, bundleName } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

  const typeContext = {
    cover: 'a marketing hero/cover image for a D&D bundle on Etsy. Must look polished, marketable, atmospheric. Composition matters.',
    npc: 'a D&D NPC portrait. Anatomy correct (esp. hands, eyes), character distinct, expression clear, no melting features.',
    location: 'a D&D establishing location shot. Atmospheric, depth, no architectural impossibilities.',
    map: 'a top-down tabletop battle map. Bird-eye view, clear features, grid-friendly composition.',
    item: 'an illustrated magic item card. Detailed, ornate, parchment-style if relevant.'
  }[assetType] || 'a D&D bundle asset.';

  const systemPrompt = `Du bist ein strenger Quality-Reviewer für AI-generierte D&D-Marketplace-Assets. Antworte AUSSCHLIESSLICH mit gültigem JSON ohne Markdown.

Du bewertest ${typeContext}

REGELN:
- Score 1-10 (10 = perfekt verkaufsfertig, 7-9 = gut/marketable, 4-6 = mittelmäßig (Reroll empfohlen), 1-3 = unbrauchbar)
- Issues: array of short flags wie "hand_deformity", "off_theme", "low_contrast", "broken_composition", "blurry", "generic", "duplicate_features", "off_anatomy", "watermark_visible", "text_artifact"
- reroll_recommended: true wenn score < 7
- reasoning: 1-2 Sätze in Deutsch, kurz und konkret. Nur Hauptproblem nennen wenn welches da ist.
- Bundle-Context: "${bundleName||'unbekannt'}" — falls Asset thematisch nicht passt, das ist ein Issue.

ANTWORT-FORMAT:
{
  "score": 7,
  "issues": ["off_theme"],
  "reroll_recommended": false,
  "reasoning": "Solide Atmosphäre aber nicht ganz on-theme."
}`;

  try {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            { type: 'text', text: `Bewerte dieses ${assetType||'asset'} für das Bundle "${bundleName||''}". JSON only.` }
          ]
        }]
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
      if (!parsed) return res.status(502).json({ error: 'AI parse failed', raw: text.slice(0,300) });
    }
    res.json({ ok: true, ...parsed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// ═══════════════════════════════════════════════════════════════════════════
// ASSET CONCEPTS — Claude generiert pro Bundle unique Variation pro Asset-Slot
// Verhindert dass alle NPCs/Locations gleich aussehen
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/asset-concepts', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });
  const { bundleName, tagline, tier, slots } = req.body;
  if (!bundleName || !Array.isArray(slots)) return res.status(400).json({ error: 'bundleName + slots[] required' });

  const slotsDesc = slots.map(s => `- ${s.count}× ${s.type} (each needs unique concept)`).join('\n');

  const systemPrompt = `Du bist ein Senior Concept-Designer für D&D-Marketplace-Asset-Packs. Antworte AUSSCHLIESSLICH mit gültigem JSON ohne Markdown.

Du designst Asset-Concepts die KÄUFER FINDEN UND KAUFEN. Käufer suchen entweder:
(a) bekannte Adventure-NPCs (Strahd, Sildar Hallwinter, Glasstaff) wenn das Bundle ein WotC/Pyram-King-Modul ist
(b) wiedererkennbare D&D-Archetypen (der bärtige Wirt, der edle Paladin, die kecke Halbling-Schurkin) wenn das Bundle generic ist

BUNDLE: "${bundleName}"
${tagline ? 'TAGLINE: ' + tagline : ''}
TIER: ${tier || 'evergreen'}

SLOTS NEEDED:
${slotsDesc}

═══ KRITISCHE REGELN ═══

1. CANONICAL FIRST (für Adventure-Module): Wenn Bundle-Name ein WotC-Adventure ist (Curse of Strahd / Lost Mine of Phandelver / Storm King\'s Thunder / Tomb of Annihilation / etc.) oder ein Pyram-King-Modul, generiere PRIORITÄR die KANONISCHEN NPCs des Moduls. Beispiele:
   - Curse of Strahd → Strahd von Zarovich (vampire lord pale skin, dark cape), Ireena Kolyana (red-haired noblewoman), Ismark the Lesser, Madam Eva (Vistani fortune teller), Rictavio, Rudolph van Richten, Ezmerelda d\'Avenir
   - Lost Mine of Phandelver → Sildar Hallwinter (older male human knight), Glasstaff/Iarno Albrek (male human wizard purple robes), Klauth (red dragon), King Grol (bugbear chief), Sister Garaele, Halia Thornton
   - Storm King\'s Thunder → King Hekaton (storm giant), Iymrith (blue dragon), Harshnag, Cog (kobold)
   - Tomb of Annihilation → Acererak, Ras Nsi, Xandala
   Nutze 60-80% der NPC-Slots für canonical, 20-40% für unique unbenannte Side-Characters die im Adventure auftauchen könnten.

2. ARCHETYPES FIRST (für generic/trope Bundles): Wenn KEIN Adventure-Name, dann CLASSIC RECOGNIZABLE Archetypes:
   - Tavern Pack: bearded innkeeper polishing mug, buxom barmaid carrying ale, cloaked mysterious stranger in corner, lute-playing bard, grizzled veteran at fire, dwarven blacksmith eating stew, halfling gambler with cards, hooded ranger with bow
   - Forest Encounter: druid wildshape, hunter ranger with longbow, bandit with crossbow, dryad guardian, awakened tree spirit, kobold scout, witch in shack
   - Gothic Horror: vampire lord brooding, banshee in white, mad scientist, headless horseman, possessed nun, witch with familiar
   Klassische Bilder die jeder sofort als "DAS ist ein X" erkennt.

3. KEINE "Diversity overload" — KEINE Tiefling-purple-Haare-Bardin oder Aasimar-Healer wenn nicht spezifisch gewollt. Verwende KLASSISCHE FANTASY-ARCHETYPEN. Tieflings/Dragonborn/Aasimar nur 1× pro 10 NPCs maximal, und nur bei Bundles die das Thema explizit haben (Avernus etc.).

4. ICONIC VISUALS — jeder Concept muss in 1 Satz so beschrieben sein dass ein Marktplatz-Käufer SOFORT denkt "Ah, das ist der edle Paladin / das ist Strahd / das ist Sildar". Specific details die character-defining sind.

═══ KATEGORIE-REGELN ═══

- Locations: variiere Time-of-Day, Weather, Sub-Type. Bei Adventure-Bundles: kanonische Locations (Castle Ravenloft / Phandalin Village / Tridrone Outpost)
- Maps: kanonische Locations vom Adventure ODER klassische D&D-Setups (cave entrance, dungeon room, forest clearing)
- Items: klassische magic items vom Adventure (Sun Sword / Spellbook of Glasstaff / Tome of the Stilled Tongue) ODER classic D&D items (vorpal sword, cloak of elvenkind)
- Cover: Hero-Composition mit ICONIC theme element (Castle Ravenloft silhouette / Cragmaw Cave entrance / classic tavern facade)

ANTWORT-FORMAT (exakt dieses JSON):
{
  "concepts": {
    "cover": [{"modifier": "epic landscape with [bundle theme] focal point, golden hour, panoramic composition"}],
    "npc": [
      {"modifier": "elderly female human cleric with silver hair in bun, simple robes, kind weathered face holding wooden holy symbol"},
      {"modifier": "middle-aged male half-orc bandit with mohawk, scarred face, leather armor, mean expression with broken nose"},
      ...12 if 12 needed, ALL distinct
    ],
    "location": [
      {"modifier": "stone tavern interior at evening, fireplace warm light, wooden tables, atmospheric"},
      {"modifier": "muddy village square in heavy rain, dusk lighting, market stalls covered"},
      ...
    ],
    "map": [
      {"modifier": "stone watchtower ruin top-down, partial walls, fire pit center, scattered debris, gridded"},
      ...
    ],
    "item": [...]
  }
}

Generiere die EXAKTE Anzahl pro Slot wie angefordert. Jeder Concept-Modifier ist 1-2 spezifische Sätze die in einen Image-Prompt eingefügt werden.`;

  try {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Generiere unique Concepts für alle Slots des Bundles "${bundleName}". JSON only.` }]
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
      if (!parsed) return res.status(502).json({ error: 'AI parse failed', raw: text.slice(0,400) });
    }
    res.json({ ok: true, concepts: parsed.concepts || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// COVER-HOOK — Claude (Haiku) generiert 3 scharfe 4-6-Wort Story-Hooks pro Bundle
// Genutzt von thumbnail.html (Etsy-Cover-Subtitle) UND pinterest.html (Pin-Hook)
// → identische Hooks auf beiden Kanälen = Brand-Konsistenz
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/cover-hook', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });
  const { bundleName, bundleTag, count } = req.body;
  if (!bundleName) return res.status(400).json({ error: 'bundleName required' });
  const prompt = `Generate 3 short emotional story hooks (4-6 words each) for an Etsy D&D asset pack listing called "${bundleName}".${bundleTag ? ' Theme: ' + bundleTag + '.' : ''}${count ? ' Asset count: ' + count + '.' : ''}
Examples of good hooks: "27 souls. one curse.", "Where ancient evil sleeps.", "Steel and fire await."
Rules: lowercase except proper nouns is fine, punchy, evocative, no hashtags, no emoji, no quotes around the hooks.
Return ONLY JSON, no markdown: {"hooks":["...","...","..."]}`;
  try {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
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
      if (!parsed) return res.status(502).json({ error: 'AI parse failed', raw: text.slice(0, 300) });
    }
    const hooks = Array.isArray(parsed.hooks) ? parsed.hooks.filter(h => typeof h === 'string' && h.trim()).slice(0, 3) : [];
    if (!hooks.length) return res.status(502).json({ error: 'No hooks generated' });
    res.json({ ok: true, hooks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// TIKTOK CONTENT POSTING API — Reels automatisch in die TikTok-Entwürfe ("Inbox")
//
// Flow: /api/tiktok/connect (OAuth v2) → /api/tiktok/callback speichert Tokens (Supabase tiktok_tokens)
//       → /api/tiktok/post-draft {video:"reel1-curse-of-strahd"} → Inbox-Upload (FILE_UPLOAD)
//       → Video erscheint als Entwurf in Marcos TikTok-App (Push), er ergänzt Caption + postet.
//
// Railway-ENV: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET (TIKTOK_REDIRECT_URI optional)
// Scope: user.info.basic,video.upload  → Inbox/Draft braucht KEIN App-Audit (Direct-Post später).
// Reels öffentlich gehostet unter https://endocraft.app/reels/<name>.mp4 (GitHub Pages).
// SQL: supabase-migrations/009_tiktok_tokens.sql
// ═══════════════════════════════════════════════════════════════════════════
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI || 'https://endocraft-production.up.railway.app/api/tiktok/callback';
const TIKTOK_SCOPES = 'user.info.basic,video.upload';
const TIKTOK_API = 'https://open.tiktokapis.com';
const REELS_BASE = process.env.REELS_BASE || 'https://endocraft.app/reels';
const tiktokOAuthStates = new Map();
let tiktokTokens = null;

async function tiktokSupaLoad() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/tiktok_tokens?id=eq.1&select=*&limit=1`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await r.json();
    if (r.ok && Array.isArray(data) && data.length) return data[0];
  } catch (e) { console.warn('[tiktok] supa load failed', e.message); }
  return null;
}
async function tiktokSupaSave(t) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/tiktok_tokens?on_conflict=id`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ id: 1, ...t, updated_at: new Date().toISOString() })
    });
  } catch (e) { console.warn('[tiktok] supa save failed', e.message); }
}
async function tiktokGetToken() {
  if (!tiktokTokens) tiktokTokens = await tiktokSupaLoad();
  if (!tiktokTokens || !tiktokTokens.refresh_token) throw new Error('TikTok nicht verbunden — erst /api/tiktok/connect durchlaufen');
  const expiresAt = new Date(tiktokTokens.expires_at || 0).getTime();
  if (Date.now() < expiresAt - 120000) return tiktokTokens.access_token;
  const body = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY, client_secret: TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token', refresh_token: tiktokTokens.refresh_token
  });
  const r = await fetchWithTimeout(`${TIKTOK_API}/v2/oauth/token/`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error('TikTok token refresh failed: ' + (data.error_description || data.error || r.status));
  tiktokTokens = {
    ...tiktokTokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token || tiktokTokens.refresh_token,
    expires_at: new Date(Date.now() + (data.expires_in || 86400) * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + (data.refresh_expires_in || 31536000) * 1000).toISOString(),
    open_id: data.open_id || tiktokTokens.open_id, scope: data.scope || tiktokTokens.scope
  };
  await tiktokSupaSave(tiktokTokens);
  return tiktokTokens.access_token;
}

app.get('/api/tiktok/connect', (req, res) => {
  if (!TIKTOK_CLIENT_KEY) return res.status(500).send('TIKTOK_CLIENT_KEY fehlt in den Railway-Variablen. Erst App auf developers.tiktok.com registrieren.');
  const state = crypto.randomBytes(16).toString('hex');
  tiktokOAuthStates.set(state, { created: Date.now() });
  for (const [k, v] of tiktokOAuthStates) if (Date.now() - v.created > 600000) tiktokOAuthStates.delete(k);
  const url = 'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY, scope: TIKTOK_SCOPES, response_type: 'code',
    redirect_uri: TIKTOK_REDIRECT_URI, state
  });
  res.redirect(url);
});

app.get('/api/tiktok/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const page = (title, body, ok) => res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>body{background:#10131c;color:#e9e4d6;font-family:Georgia,serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{text-align:center;max-width:480px;padding:40px;border:1px solid ${ok ? '#7bbd8f' : '#d98a8a'};border-radius:14px}h1{color:${ok ? '#d8b46a' : '#d98a8a'};font-size:22px}p{color:#9aa0b3;line-height:1.6}</style></head><body><div><h1>${title}</h1><p>${body}</p></div></body></html>`);
  if (error) return page('TikTok-Verbindung abgelehnt', String(error_description || error), false);
  if (!tiktokOAuthStates.get(state)) return page('Ungültiger State', 'OAuth-State unbekannt oder abgelaufen. Connect-Flow neu starten.', false);
  tiktokOAuthStates.delete(state);
  try {
    const body = new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY, client_secret: TIKTOK_CLIENT_SECRET,
      code, grant_type: 'authorization_code', redirect_uri: TIKTOK_REDIRECT_URI
    });
    const r = await fetchWithTimeout(`${TIKTOK_API}/v2/oauth/token/`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const data = await r.json();
    if (!r.ok || data.error) return page('Token-Tausch fehlgeschlagen', data.error_description || data.error || ('HTTP ' + r.status), false);
    tiktokTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + (data.expires_in || 86400) * 1000).toISOString(),
      refresh_expires_at: new Date(Date.now() + (data.refresh_expires_in || 31536000) * 1000).toISOString(),
      open_id: data.open_id, scope: data.scope
    };
    await tiktokSupaSave(tiktokTokens);
    return page('TikTok verbunden', `Scopes: <b style="color:#d8b46a">${tiktokTokens.scope || TIKTOK_SCOPES}</b><br><br>Fenster schliessen. Reels koennen jetzt als Entwurf in die TikTok-App geschoben werden.`, true);
  } catch (e) {
    return page('Fehler', e.message, false);
  }
});

app.get('/api/tiktok/status', async (req, res) => {
  if (!TIKTOK_CLIENT_KEY) return res.json({ connected: false, keyConfigured: false });
  try {
    if (!tiktokTokens) tiktokTokens = await tiktokSupaLoad();
    if (!tiktokTokens || !tiktokTokens.refresh_token) return res.json({ connected: false, keyConfigured: true });
    res.json({ connected: true, keyConfigured: true, open_id: tiktokTokens.open_id || null, scope: tiktokTokens.scope || null, expires_at: tiktokTokens.expires_at });
  } catch (e) { res.json({ connected: false, keyConfigured: true, error: e.message }); }
});

app.post('/api/tiktok/post-draft', async (req, res) => {
  if (!TIKTOK_CLIENT_KEY) return res.status(500).json({ error: 'TIKTOK_CLIENT_KEY fehlt' });
  const name = String((req.body && req.body.video) || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) return res.status(400).json({ error: 'video name required' });
  try {
    const token = await tiktokGetToken();
    const vidUrl = `${REELS_BASE}/${name}.mp4`;
    const vr = await fetchWithTimeout(vidUrl);
    if (!vr.ok) return res.status(404).json({ error: `Reel nicht erreichbar: ${vidUrl} (HTTP ${vr.status})` });
    const buf = Buffer.from(await vr.arrayBuffer());
    const size = buf.length;
    const initR = await fetchWithTimeout(`${TIKTOK_API}/v2/post/publish/inbox/video/init/`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 } })
    });
    const init = await initR.json();
    if (!initR.ok || (init.error && init.error.code !== 'ok')) {
      return res.status(502).json({ error: 'init failed', detail: init.error || init });
    }
    const { publish_id, upload_url } = init.data || {};
    if (!upload_url) return res.status(502).json({ error: 'no upload_url', detail: init });
    const putR = await fetchWithTimeout(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${size - 1}/${size}`, 'Content-Length': String(size) },
      body: buf
    });
    if (!putR.ok) {
      const t = await putR.text().catch(() => '');
      return res.status(502).json({ error: 'upload PUT failed', status: putR.status, detail: t.slice(0, 300) });
    }
    return res.json({ ok: true, publish_id, video: name, note: 'Liegt jetzt als Entwurf in der TikTok-App (Push) - dort Caption ergaenzen + posten.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});


// ETSY OPEN API v3 — Vollautomatische Draft-Listing-Erstellung
//
// Flow: /api/etsy/connect (OAuth2+PKCE) → Callback speichert Tokens (Supabase)
//       → /api/etsy/draft-listing → /api/etsy/listing/:id/image (Cover/Galerie)
//       → /api/etsy/listing/:id/file (Digital-ZIP, max 5 × 20MB)
//
// Benötigte Railway-ENV-Variable: ETSY_KEYSTRING (API Key von etsy.com/developers)
// Registrierte Callback-URL der Etsy-App MUSS exakt sein:
//   https://endocraft-production.up.railway.app/api/etsy/callback
// ═══════════════════════════════════════════════════════════════════════════
const ETSY_KEYSTRING = process.env.ETSY_KEYSTRING;
// Personal-Access-Apps: Etsy verlangt fuer data calls (shops/users) den Shared Secret im x-api-key Header.
// Keystring (client_id) wird nur fuer OAuth (connect/refresh) genutzt. Fallback auf Keystring fuer Backwards-Compat.
const ETSY_API_KEY = process.env.ETSY_API_KEY || process.env.ETSY_SHARED_SECRET || process.env.ETSY_KEYSTRING;
const ETSY_REDIRECT_URI = process.env.ETSY_REDIRECT_URI || 'https://endocraft-production.up.railway.app/api/etsy/callback';
const ETSY_SCOPES = 'listings_r listings_w shops_r transactions_r';
const ETSY_API = 'https://openapi.etsy.com';
const etsyOAuthStates = new Map(); // state → { verifier, created } (10 Min TTL)
let etsyTokens = null;             // In-Memory-Cache { access_token, refresh_token, expires_at, shop_id, shop_name, etsy_user_id }
let etsyTaxonomyCache = null;      // Seller-Taxonomy (24h Cache)

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function etsySupaLoad() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/etsy_tokens?id=eq.1&select=*&limit=1`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await r.json();
    if (r.ok && Array.isArray(data) && data.length) return data[0];
  } catch (e) { console.warn('[etsy] supa load failed', e.message); }
  return null;
}
async function etsySupaSave(t) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/etsy_tokens?on_conflict=id`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ id: 1, ...t, updated_at: new Date().toISOString() })
    });
  } catch (e) { console.warn('[etsy] supa save failed', e.message); }
}

async function etsyGetToken() {
  if (!etsyTokens) etsyTokens = await etsySupaLoad();
  if (!etsyTokens || !etsyTokens.refresh_token) throw new Error('Etsy nicht verbunden — erst /api/etsy/connect durchlaufen');
  const expiresAt = new Date(etsyTokens.expires_at || 0).getTime();
  if (Date.now() < expiresAt - 90000) return etsyTokens.access_token;
  // Refresh
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: ETSY_KEYSTRING, refresh_token: etsyTokens.refresh_token });
  const r = await fetchWithTimeout('https://api.etsy.com/v3/public/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Etsy token refresh failed: ' + (data?.error_description || data?.error || r.status));
  etsyTokens = {
    ...etsyTokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token || etsyTokens.refresh_token,
    expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString()
  };
  await etsySupaSave(etsyTokens);
  return etsyTokens.access_token;
}

async function etsyFetch(path, opts = {}) {
  const token = await etsyGetToken();
  const headers = { 'x-api-key': ETSY_API_KEY, 'Authorization': `Bearer ${token}`, ...(opts.headers || {}) };
  return fetch(ETSY_API + path, { ...opts, headers });
}

// ─── OAuth Start ───
app.get('/api/etsy/connect', (req, res) => {
  if (!ETSY_KEYSTRING) return res.status(500).send('ETSY_KEYSTRING fehlt in den Railway-Variablen. Erst App auf etsy.com/developers registrieren.');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = crypto.randomBytes(16).toString('hex');
  etsyOAuthStates.set(state, { verifier, created: Date.now() });
  for (const [k, v] of etsyOAuthStates) if (Date.now() - v.created > 600000) etsyOAuthStates.delete(k);
  const url = 'https://www.etsy.com/oauth/connect?' + new URLSearchParams({
    response_type: 'code', client_id: ETSY_KEYSTRING, redirect_uri: ETSY_REDIRECT_URI,
    scope: ETSY_SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256'
  });
  res.redirect(url);
});

// ─── OAuth Callback ───
app.get('/api/etsy/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const page = (title, body, ok) => res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>body{background:#10131c;color:#e9e4d6;font-family:Georgia,serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{text-align:center;max-width:480px;padding:40px;border:1px solid ${ok ? '#7bbd8f' : '#d98a8a'};border-radius:14px}h1{color:${ok ? '#d8b46a' : '#d98a8a'};font-size:22px}p{color:#9aa0b3;line-height:1.6}</style></head><body><div><h1>${title}</h1><p>${body}</p></div></body></html>`);
  if (error) return page('Etsy-Verbindung abgelehnt', String(error_description || error), false);
  const st = etsyOAuthStates.get(state);
  if (!st) return page('Ungültiger State', 'OAuth-State unbekannt oder abgelaufen. Bitte den Connect-Flow neu starten.', false);
  etsyOAuthStates.delete(state);
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', client_id: ETSY_KEYSTRING,
      redirect_uri: ETSY_REDIRECT_URI, code, code_verifier: st.verifier
    });
    const r = await fetchWithTimeout('https://api.etsy.com/v3/public/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const data = await r.json();
    if (!r.ok) return page('Token-Tausch fehlgeschlagen', data?.error_description || data?.error || ('HTTP ' + r.status), false);
    etsyTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
      etsy_user_id: String(data.access_token).split('.')[0]
    };
    // Shop-Daten holen
    const meR = await fetchWithTimeout(ETSY_API + '/v3/application/users/me', {
      headers: { 'x-api-key': ETSY_API_KEY, 'Authorization': `Bearer ${etsyTokens.access_token}` }
    });
    const me = await meR.json();
    if (meR.ok && me.shop_id) {
      etsyTokens.shop_id = String(me.shop_id);
      try {
        const shopR = await fetchWithTimeout(`${ETSY_API}/v3/application/shops/${me.shop_id}`, { headers: { 'x-api-key': ETSY_API_KEY } });
        const shop = await shopR.json();
        if (shopR.ok) etsyTokens.shop_name = shop.shop_name;
      } catch (_) {}
    }
    await etsySupaSave(etsyTokens);
    return page('✓ Etsy verbunden', `Shop: <b style="color:#d8b46a">${etsyTokens.shop_name || etsyTokens.shop_id || 'gefunden'}</b><br><br>Du kannst dieses Fenster schließen und zurück zum Bundle Studio wechseln.`, true);
  } catch (e) {
    return page('Fehler', e.message, false);
  }
});

// ─── Status ───
app.get('/api/etsy/status', async (req, res) => {
  if (!ETSY_KEYSTRING) return res.json({ connected: false, keystringConfigured: false });
  try {
    if (!etsyTokens) etsyTokens = await etsySupaLoad();
    if (!etsyTokens || !etsyTokens.refresh_token) return res.json({ connected: false, keystringConfigured: true });
    res.json({
      connected: true, keystringConfigured: true,
      shop_id: etsyTokens.shop_id || null, shop_name: etsyTokens.shop_name || null,
      expires_at: etsyTokens.expires_at
    });
  } catch (e) { res.json({ connected: false, keystringConfigured: true, error: e.message }); }
});

// ─── Taxonomy-Suche (für taxonomy_id-Auswahl, 1× nötig, dann localStorage) ───
app.get('/api/etsy/taxonomy', async (req, res) => {
  if (!ETSY_KEYSTRING) return res.status(500).json({ error: 'ETSY_KEYSTRING fehlt' });
  try {
    if (!etsyTaxonomyCache || Date.now() - etsyTaxonomyCache.ts > 86400000) {
      const r = await fetchWithTimeout(ETSY_API + '/v3/application/seller-taxonomy/nodes', { headers: { 'x-api-key': ETSY_API_KEY } });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: data?.error || 'Taxonomy fetch failed' });
      const flat = [];
      (function walk(nodes, path) {
        for (const n of nodes || []) {
          const p = path ? path + ' › ' + n.name : n.name;
          flat.push({ id: n.id, name: n.name, path: p });
          walk(n.children, p);
        }
      })(data.results, '');
      etsyTaxonomyCache = { ts: Date.now(), flat };
    }
    const q = String(req.query.q || '').toLowerCase().trim();
    let out = etsyTaxonomyCache.flat;
    if (q) out = out.filter(n => n.path.toLowerCase().includes(q));
    res.json({ ok: true, nodes: out.slice(0, 30) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Draft-Listing erstellen (type=download → Digital-Listing, KEIN Auto-Publish) ───
app.post('/api/etsy/draft-listing', async (req, res) => {
  if (!ETSY_KEYSTRING) return res.status(500).json({ error: 'ETSY_KEYSTRING fehlt' });
  const { title, description, price, tags, taxonomy_id, quantity, materials } = req.body;
  if (!title || !description || !price || !taxonomy_id) {
    return res.status(400).json({ error: 'title, description, price, taxonomy_id required' });
  }
  try {
    await etsyGetToken();
    if (!etsyTokens.shop_id) return res.status(400).json({ error: 'Keine shop_id — Etsy neu verbinden' });
    const body = new URLSearchParams({
      quantity: String(quantity || 999),
      title: String(title).slice(0, 140),
      description: String(description),
      price: String(price),
      who_made: 'i_did',
      when_made: 'made_to_order',
      taxonomy_id: String(taxonomy_id),
      type: 'download',
      is_supply: 'false',
      should_auto_renew: 'true'
    });
    if (Array.isArray(tags) && tags.length) {
      body.set('tags', tags.slice(0, 13).map(t => String(t).slice(0, 20)).join(','));
    }
    if (Array.isArray(materials) && materials.length) body.set('materials', materials.slice(0, 13).join(','));
    const r = await etsyFetch(`/v3/application/shops/${etsyTokens.shop_id}/listings`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error || JSON.stringify(data).slice(0, 400) });
    res.json({
      ok: true, listing_id: data.listing_id, state: data.state,
      edit_url: `https://www.etsy.com/your/shops/me/listing-editor/edit/${data.listing_id}`,
      drafts_url: 'https://www.etsy.com/your/shops/me/listings?state=draft'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Bild hochladen (Cover + Galerie; rank 1 = Hauptbild) ───
app.post('/api/etsy/listing/:listingId/image', async (req, res) => {
  if (!ETSY_KEYSTRING) return res.status(500).json({ error: 'ETSY_KEYSTRING fehlt' });
  const { imageBase64, filename, rank } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  try {
    await etsyGetToken();
    const buf = Buffer.from(String(imageBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    const fd = new FormData();
    fd.append('image', new Blob([buf], { type: 'image/png' }), filename || 'cover.png');
    if (rank) fd.append('rank', String(rank));
    const r = await etsyFetch(`/v3/application/shops/${etsyTokens.shop_id}/listings/${req.params.listingId}/images`, {
      method: 'POST', body: fd
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error || JSON.stringify(data).slice(0, 400) });
    res.json({ ok: true, listing_image_id: data.listing_image_id, rank: data.rank });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Digital-File hochladen (max 5 Files à 20MB pro Listing — Etsy-Limit) ───
app.post('/api/etsy/listing/:listingId/file', async (req, res) => {
  if (!ETSY_KEYSTRING) return res.status(500).json({ error: 'ETSY_KEYSTRING fehlt' });
  const { fileBase64, filename, rank } = req.body;
  if (!fileBase64) return res.status(400).json({ error: 'fileBase64 required' });
  try {
    await etsyGetToken();
    const buf = Buffer.from(String(fileBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buf.length > 20 * 1024 * 1024) return res.status(400).json({ error: `File ${filename} ist ${(buf.length / 1048576).toFixed(1)}MB — Etsy-Limit ist 20MB pro File` });
    const safeName = String(filename || 'bundle.zip').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 70);
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/zip' }), safeName);
    fd.append('name', safeName);
    if (rank) fd.append('rank', String(rank));
    const r = await etsyFetch(`/v3/application/shops/${etsyTokens.shop_id}/listings/${req.params.listingId}/files`, {
      method: 'POST', body: fd
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error || JSON.stringify(data).slice(0, 400) });
    res.json({ ok: true, listing_file_id: data.listing_file_id, filename: data.filename, size: data.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// FREE-PACK LEAD-MAGNET — Pinterest/Etsy Funnel
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/free-pack/subscribe', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase nicht konfiguriert' });
  const { email, source, utm } = req.body || {};
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  const ua = String(req.headers['user-agent'] || '').slice(0, 240);
  const sourceClean = String(source || 'direct').slice(0, 40);
  const utmClean = utm ? String(utm).slice(0, 400) : null;
  try {
    // Insert + return-representation so we get back id + unsubscribe_token (needed for email 1)
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/free_pack_leads`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,resolution=ignore-duplicates'
      },
      body: JSON.stringify({ email: emailNorm, source: sourceClean, utm: utmClean, ip: ip || null, user_agent: ua })
    });
    if (!r.ok && r.status !== 409) {
      const txt = await r.text().catch(() => ('http ' + r.status));
      console.warn('[free-pack] supabase insert failed', r.status, txt.slice(0, 200));
    } else if (r.ok) {
      // Trigger Email 1 (no-op if Resend not configured)
      try {
        const rows = await r.json();
        const lead = Array.isArray(rows) ? rows[0] : rows;
        if (lead && lead.id && lead.email) {
          sendWelcomeEmail(1, lead).catch(err => console.warn('[email] email_1 trigger failed:', err.message));
        }
      } catch (parseErr) {
        // Parse failure — Resend skip silently, signup still successful
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.warn('[free-pack] subscribe error', e.message);
    res.json({ ok: true });
  }
});

// ─── Admin: send a custom transactional email (lead replies etc.) via Resend ───
app.post('/api/admin/send-email', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  if (!resendActive) return res.status(500).json({ error: 'RESEND_API_KEY not set' });
  const { to, subject, text, html, replyTo } = req.body || {};
  const toNorm = String(to || '').trim().toLowerCase();
  if (!toNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toNorm)) return res.status(400).json({ error: 'valid "to" email required' });
  if (!subject || (!text && !html)) return res.status(400).json({ error: 'subject and (text or html) required' });
  try {
    const payload = { from: RESEND_FROM, to: [toNorm], subject: String(subject) };
    if (text) payload.text = String(text);
    if (html) payload.html = String(html);
    if (replyTo) payload.reply_to = String(replyTo);
    const r = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: `Resend HTTP ${r.status}`, detail: JSON.stringify(data).slice(0, 300) });
    res.json({ ok: true, id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Wishes-Feature · Adventure-Wünsche von /free thank-you Screen ───
// Linked-mode: PATCHes free_pack_leads.wish by email
// Anon-mode: separate row mit email=null (für Etsy Shop Announcement traffic)
app.post('/api/wishes/submit', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase nicht konfiguriert' });
  const { email, wish, source } = req.body || {};
  const wishClean = String(wish || '').trim().slice(0, 1000);
  if (!wishClean) return res.status(400).json({ error: 'wish required' });
  const emailNorm = email ? String(email).trim().toLowerCase() : null;
  const sourceClean = String(source || 'direct').slice(0, 40);
  try {
    if (emailNorm && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      // Linked mode — PATCH existing lead. If no lead exists yet, insert anon row.
      const patchUrl = `${SUPABASE_URL}/rest/v1/free_pack_leads?email=eq.${encodeURIComponent(emailNorm)}`;
      const r = await fetchWithTimeout(patchUrl, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ wish: wishClean })
      });
      const data = await r.json().catch(() => []);
      // If patch found no rows (Array.isArray && length 0), insert new row
      if (Array.isArray(data) && data.length === 0) {
        const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/free_pack_leads`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ email: emailNorm, source: sourceClean, wish: wishClean, ip: ip || null })
        });
      }
      return res.json({ ok: true, mode: 'linked' });
    }
    // Anon mode — wish ohne email (für Etsy Shop Announcement)
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
    await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/free_pack_leads`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ email: null, source: sourceClean, wish: wishClean, ip: ip || null })
    });
    res.json({ ok: true, mode: 'anon' });
  } catch (e) {
    console.warn('[wishes] submit error', e.message);
    res.json({ ok: true });
  }
});

// ─── Admin-only: Wishes-Liste für Cockpit ───
app.get('/api/wishes', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase missing' });
  if (!checkAdminKey(req, res)) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/free_pack_leads?select=id,email,wish,source,created_at&wish=not.is.null&order=created_at.desc&limit=500`;
    const r = await fetchWithTimeout(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await r.json();
    const items = Array.isArray(data) ? data : [];
    res.json({ total: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/free-pack/stats', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase missing' });
  if (!checkAdminKey(req, res)) return;
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/free_pack_leads?select=source,created_at&order=created_at.desc&limit=500`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await r.json();
    const total = Array.isArray(data) ? data.length : 0;
    const bySource = {};
    if (Array.isArray(data)) data.forEach(d => { bySource[d.source || 'direct'] = (bySource[d.source || 'direct'] || 0) + 1; });
    res.json({ ok: true, total, bySource, latest: Array.isArray(data) ? data.slice(0, 10) : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin-only: full leads list with emails (for endocraft.app/admin/leads page)
app.get('/api/free-pack/leads', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase missing' });
  if (!checkAdminKey(req, res)) return;
  // IP is PII — only include when explicitly requested via ?with_ip=1 (for anti-spam investigation)
  const selectCols = req.query.with_ip === '1'
    ? 'id,email,source,utm,created_at,ip'
    : 'id,email,source,utm,created_at';
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/free_pack_leads?select=${selectCols}&order=created_at.desc&limit=2000`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await r.json();
    if (!Array.isArray(data)) return res.status(502).json({ error: 'Supabase invalid response', raw: data });
    const bySource = {};
    data.forEach(d => { bySource[d.source || 'direct'] = (bySource[d.source || 'direct'] || 0) + 1; });
    res.json({ ok: true, total: data.length, bySource, leads: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ETSY LISTINGS · LIST + UPDATE (für Bulk-Update-Tool)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/etsy/my-listings', async (req, res) => {
  if (!ETSY_KEYSTRING) return res.status(500).json({ error: 'ETSY_KEYSTRING fehlt' });
  try {
    await etsyGetToken();
    if (!etsyTokens.shop_id) return res.status(400).json({ error: 'Keine shop_id' });
    const state = String(req.query.state || 'active');
    const r = await etsyFetch(`/v3/application/shops/${etsyTokens.shop_id}/listings?state=${state}&limit=100&includes=Images`, {
      method: 'GET'
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error || JSON.stringify(data).slice(0, 400) });
    const listings = (data.results || []).map(l => ({
      listing_id: l.listing_id,
      title: l.title,
      description: l.description,
      price: l.price?.amount ? (l.price.amount / l.price.divisor) : null,
      currency: l.price?.currency_code,
      state: l.state,
      url: l.url,
      tags: l.tags || [],
      taxonomy_id: l.taxonomy_id,
      created: l.created_timestamp,
      updated: l.last_modified_timestamp,
      views: l.views || 0,
      num_favorers: l.num_favorers || 0,
      quantity: l.quantity || 0,
      thumb: l.images?.[0]?.url_170x135 || null
    }));
    res.json({ ok: true, count: listings.length, listings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Etsy receipts (sales) for cockpit
app.get('/api/etsy/receipts', async (req, res) => {
  if (!ETSY_KEYSTRING) return res.status(500).json({ error: 'ETSY_KEYSTRING fehlt' });
  if (!checkAdminKey(req, res)) return;
  try {
    await etsyGetToken();
    if (!etsyTokens.shop_id) return res.status(400).json({ error: 'Keine shop_id' });
    const r = await etsyFetch(`/v3/application/shops/${etsyTokens.shop_id}/receipts?limit=100`, { method: 'GET' });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error || JSON.stringify(data).slice(0, 400) });
    const receipts = (data.results || []).map(r => ({
      receipt_id: r.receipt_id,
      created: r.create_timestamp,
      buyer_name: r.name || null,
      total: r.grandtotal?.amount ? (r.grandtotal.amount / r.grandtotal.divisor) : null,
      currency: r.grandtotal?.currency_code || 'EUR',
      status: r.status,
      is_paid: !!r.is_paid,
      is_shipped: !!r.is_shipped,
      transactions: (r.transactions || []).map(t => ({
        listing_id: t.listing_id,
        title: t.title,
        quantity: t.quantity,
        price: t.price?.amount ? (t.price.amount / t.price.divisor) : null
      }))
    }));
    const totalRevenue = receipts.reduce((s, r) => s + (r.total || 0), 0);
    res.json({ ok: true, count: receipts.length, totalRevenue, receipts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cockpit: aggregated business overview
app.get('/api/cockpit/overview', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const result = { ok: true, ts: new Date().toISOString() };

  // Leads
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/free_pack_leads?select=email,source,utm,created_at&order=created_at.desc&limit=2000`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const leads = await r.json();
    if (Array.isArray(leads)) {
      const bySource = {};
      leads.forEach(l => { bySource[l.source || 'direct'] = (bySource[l.source || 'direct'] || 0) + 1; });
      // last 7 days
      const cutoff7d = Date.now() - 7 * 86400 * 1000;
      const last7d = leads.filter(l => new Date(l.created_at).getTime() > cutoff7d).length;
      result.leads = { total: leads.length, bySource, last7d, recent: leads.slice(0, 5) };
    }
  } catch (e) { result.leads = { error: e.message }; }

  // Etsy listings
  try {
    await etsyGetToken();
    if (etsyTokens.shop_id) {
      const r = await etsyFetch(`/v3/application/shops/${etsyTokens.shop_id}/listings?state=active&limit=100&includes=Images`, { method: 'GET' });
      const data = await r.json();
      const listings = (data.results || []).map(l => ({
        listing_id: l.listing_id,
        title: l.title,
        price: l.price?.amount ? (l.price.amount / l.price.divisor) : null,
        currency: l.price?.currency_code,
        url: l.url,
        views: l.views || 0,
        num_favorers: l.num_favorers || 0,
        quantity: l.quantity || 0,
        thumb: l.images?.[0]?.url_170x135 || null
      }));
      const totalViews = listings.reduce((s, l) => s + l.views, 0);
      const totalFavorites = listings.reduce((s, l) => s + l.num_favorers, 0);
      result.etsy = {
        listingCount: listings.length,
        totalViews,
        totalFavorites,
        listings: listings.sort((a, b) => b.views - a.views)
      };
    } else {
      result.etsy = { error: 'shop_id missing — visit /api/etsy/fix-shop-info' };
    }
  } catch (e) { result.etsy = { error: e.message }; }

  // Etsy receipts
  try {
    if (etsyTokens.shop_id) {
      const r = await etsyFetch(`/v3/application/shops/${etsyTokens.shop_id}/receipts?limit=100`, { method: 'GET' });
      const data = await r.json();
      const receipts = (data.results || []).map(r => ({
        receipt_id: r.receipt_id,
        created: r.create_timestamp,
        buyer_name: r.name || null,
        total: r.grandtotal?.amount ? (r.grandtotal.amount / r.grandtotal.divisor) : null,
        currency: r.grandtotal?.currency_code || 'EUR',
        status: r.status,
        transactions: (r.transactions || []).map(t => ({ listing_id: t.listing_id, title: t.title }))
      }));
      const totalRevenue = receipts.reduce((s, r) => s + (r.total || 0), 0);
      result.sales = { count: receipts.length, totalRevenue, recent: receipts.slice(0, 10) };
    }
  } catch (e) { result.sales = { error: e.message }; }

  res.json(result);
});

app.patch('/api/etsy/listing/:listingId', async (req, res) => {
  if (!ETSY_KEYSTRING) return res.status(500).json({ error: 'ETSY_KEYSTRING fehlt' });
  const { title, description, tags } = req.body || {};
  if (!title && !description && !tags) return res.status(400).json({ error: 'title|description|tags required' });
  try {
    await etsyGetToken();
    const body = new URLSearchParams();
    if (title) body.set('title', String(title).slice(0, 140));
    if (description) body.set('description', String(description));
    if (Array.isArray(tags) && tags.length) body.set('tags', tags.slice(0, 13).map(t => String(t).slice(0, 20)).join(','));
    const r = await etsyFetch(`/v3/application/shops/${etsyTokens.shop_id}/listings/${req.params.listingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error || JSON.stringify(data).slice(0, 400) });
    res.json({ ok: true, listing_id: data.listing_id, state: data.state });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ETSY · Manual Shop-Info-Fix (fuer Faelle wo /users/me kein shop_id liefert)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/etsy/fix-shop-info', async (req, res) => {
  if (!ETSY_KEYSTRING) return res.status(500).json({ error: 'ETSY_KEYSTRING fehlt' });
  try {
    const token = await etsyGetToken();
    if (!etsyTokens) return res.status(400).json({ error: 'Etsy nicht verbunden' });
    // Manual-Override: shop_id direkt im Body — fuer Faelle wo lookup blockiert ist
    const manualShopId = req.body?.shop_id || req.query?.shop_id;
    const manualShopName = req.body?.shop_name || req.query?.shop_name;
    if (manualShopId) {
      etsyTokens.shop_id = String(manualShopId);
      etsyTokens.shop_name = manualShopName || etsyTokens.shop_name || null;
      await etsySupaSave(etsyTokens);
      return res.json({ ok: true, shop_id: etsyTokens.shop_id, shop_name: etsyTokens.shop_name, method: 'manual' });
    }
    // user_id aus access_token (Format: USER_ID.JWT_SUFFIX)
    const userId = etsyTokens.etsy_user_id || String(etsyTokens.access_token).split('.')[0];
    if (!userId || !/^\d+$/.test(userId)) return res.status(400).json({ error: 'user_id konnte nicht extrahiert werden', userId });
    // /v3/application/users/{user_id}/shops liefert Shop-Info
    const shopR = await fetchWithTimeout(`${ETSY_API}/v3/application/users/${userId}/shops`, {
      headers: { 'x-api-key': ETSY_API_KEY, 'Authorization': `Bearer ${token}` }
    });
    const shopData = await shopR.json();
    if (!shopR.ok) return res.status(502).json({ error: 'shop-fetch failed', status: shopR.status, raw: JSON.stringify(shopData).slice(0, 400) });
    const shopId = shopData.shop_id || shopData.results?.[0]?.shop_id;
    const shopName = shopData.shop_name || shopData.results?.[0]?.shop_name;
    if (!shopId) return res.status(404).json({ error: 'Kein Shop gefunden fuer user_id', userId, raw: JSON.stringify(shopData).slice(0, 400) });
    etsyTokens.shop_id = String(shopId);
    etsyTokens.shop_name = shopName || null;
    etsyTokens.etsy_user_id = userId;
    await etsySupaSave(etsyTokens);
    res.json({ ok: true, shop_id: etsyTokens.shop_id, shop_name: etsyTokens.shop_name, user_id: userId, method: 'auto' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── Welcome-Email Cron Endpoint (prepared 2026-06-16) ───
// Called by scheduled-task endocraft-welcome-email-cron (to be created) daily at 09:00 Berlin.
// Finds leads needing email 2 (T+3d) or email 3 (T+7d), sends them, marks as sent.
// No-op if Resend not configured.
app.get('/api/welcome-emails/cron-tick', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase missing' });
  if (!resendActive) return res.json({ ok: true, skipped: true, reason: 'RESEND_API_KEY not set' });
  const results = { email_2_sent: 0, email_3_sent: 0, errors: [] };
  try {
    // Email 2: T+3d, sent_at_1 set, sent_at_2 null, not unsubscribed
    const url2 = `${SUPABASE_URL}/rest/v1/free_pack_leads?select=id,email,unsubscribe_token,email_1_sent_at&email_1_sent_at=not.is.null&email_2_sent_at=is.null&unsubscribed_at=is.null&email_1_sent_at=lt.${encodeURIComponent(new Date(Date.now() - 3*24*60*60*1000).toISOString())}&limit=50`;
    const r2 = await fetchWithTimeout(url2, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    if (r2.ok) {
      const leads2 = await r2.json();
      for (const lead of leads2) {
        const result = await sendWelcomeEmail(2, lead);
        if (result.ok) results.email_2_sent++;
        else results.errors.push({ leadId: lead.id, emailNum: 2, error: result.error });
      }
    }
    // Email 3: T+7d, sent_at_2 set, sent_at_3 null
    const url3 = `${SUPABASE_URL}/rest/v1/free_pack_leads?select=id,email,unsubscribe_token,email_2_sent_at&email_2_sent_at=not.is.null&email_3_sent_at=is.null&unsubscribed_at=is.null&email_2_sent_at=lt.${encodeURIComponent(new Date(Date.now() - 4*24*60*60*1000).toISOString())}&limit=50`;
    const r3 = await fetchWithTimeout(url3, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    if (r3.ok) {
      const leads3 = await r3.json();
      for (const lead of leads3) {
        const result = await sendWelcomeEmail(3, lead);
        if (result.ok) results.email_3_sent++;
        else results.errors.push({ leadId: lead.id, emailNum: 3, error: result.error });
      }
    }
    res.json({ ok: true, ts: new Date().toISOString(), ...results });
  } catch (e) {
    console.error('[welcome-email cron-tick] failed:', e.message);
    res.status(500).json({ ok: false, error: e.message, ...results });
  }
});

// ─── Unsubscribe Endpoint (prepared 2026-06-16, brand-styled 2026-06-16) ───
function unsubPage({ title, body, showRetry }) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · EndoCraft</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    background: radial-gradient(ellipse at center top, #1a1410 0%, #0a0d14 70%, #050709 100%);
    color: #e8d990;
    font-family: 'Inter', -apple-system, sans-serif;
    font-weight: 300;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    line-height: 1.6;
    overflow-x: hidden;
  }
  body::before {
    content: ""; position: fixed; inset: 0;
    background: radial-gradient(circle at 30% 20%, rgba(212,175,55,0.04) 0%, transparent 50%),
                radial-gradient(circle at 70% 80%, rgba(212,175,55,0.03) 0%, transparent 50%);
    pointer-events: none;
  }
  .card {
    max-width: 520px; width: 100%;
    background: linear-gradient(180deg, rgba(20,16,12,0.85) 0%, rgba(10,10,14,0.95) 100%);
    border: 1px solid rgba(212,175,55,0.18);
    border-radius: 8px;
    padding: 48px 40px 40px;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(212,175,55,0.06) inset;
    position: relative;
    z-index: 1;
  }
  .brand {
    font-family: 'Cormorant Garamond', serif;
    font-size: 13px;
    letter-spacing: 0.32em;
    color: rgba(212,175,55,0.7);
    text-transform: uppercase;
    margin-bottom: 24px;
    font-weight: 500;
  }
  .seal {
    width: 56px; height: 56px;
    margin: 0 auto 28px;
    border: 1px solid rgba(212,175,55,0.4);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    color: #d4af37;
    position: relative;
  }
  .seal::before {
    content: ""; position: absolute; inset: -6px;
    border: 1px solid rgba(212,175,55,0.15);
    border-radius: 50%;
  }
  h1 {
    font-family: 'Cormorant Garamond', serif;
    font-weight: 500;
    font-size: 36px;
    letter-spacing: 0.01em;
    color: #d4af37;
    margin-bottom: 18px;
    line-height: 1.2;
  }
  p {
    color: rgba(232,217,144,0.78);
    font-size: 16px;
    margin-bottom: 14px;
    font-weight: 300;
  }
  .signature {
    margin-top: 28px;
    font-family: 'Cormorant Garamond', serif;
    font-style: italic;
    font-size: 18px;
    color: rgba(212,175,55,0.85);
  }
  .divider {
    width: 56px; height: 1px;
    background: linear-gradient(90deg, transparent, rgba(212,175,55,0.35), transparent);
    margin: 28px auto 24px;
  }
  .back-link {
    display: inline-block;
    margin-top: 8px;
    color: rgba(212,175,55,0.75);
    text-decoration: none;
    font-size: 13px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    padding: 12px 28px;
    border: 1px solid rgba(212,175,55,0.3);
    border-radius: 2px;
    transition: all 0.3s ease;
  }
  .back-link:hover {
    background: rgba(212,175,55,0.08);
    border-color: rgba(212,175,55,0.6);
    color: #d4af37;
  }
  .roll-high {
    margin-top: 36px;
    font-family: 'Cormorant Garamond', serif;
    font-size: 14px;
    color: rgba(212,175,55,0.35);
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">EndoCraft</div>
    ${body}
    <div class="roll-high">⚔ Roll High ⚔</div>
  </div>
</body></html>`;
}

app.get('/unsubscribe', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
    return res.status(400).send(unsubPage({
      title: 'Invalid Link',
      body: `
        <div class="seal">⚠</div>
        <h1>Invalid Link</h1>
        <p>This unsubscribe link is missing or malformed.</p>
        <p style="font-size:14px;opacity:0.7">If you want to stop receiving emails, reply to any of mine and I'll remove you manually.</p>
        <div class="divider"></div>
        <a class="back-link" href="https://endocraft.app/">Return to EndoCraft</a>
      `
    }));
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).send(unsubPage({
    title: 'Server Error',
    body: `
      <div class="seal">⚙</div>
      <h1>Something Went Wrong</h1>
      <p>Reply to any of my emails and I'll manually remove you. Won't take long.</p>
      <div class="signature">— Marco</div>
      <div class="divider"></div>
      <a class="back-link" href="https://endocraft.app/">Return to EndoCraft</a>
    `
  }));
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/free_pack_leads?unsubscribe_token=eq.${token}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ unsubscribed_at: new Date().toISOString() })
    });
    if (!r.ok) {
      return res.status(500).send(unsubPage({
        title: 'Something Went Wrong',
        body: `
          <div class="seal">⚙</div>
          <h1>Something Went Wrong</h1>
          <p>Reply to any of my emails and I'll manually remove you. Won't take long.</p>
          <div class="signature">— Marco</div>
          <div class="divider"></div>
          <a class="back-link" href="https://endocraft.app/">Return to EndoCraft</a>
        `
      }));
    }
    res.send(unsubPage({
      title: "You're unsubscribed",
      body: `
        <div class="seal">✓</div>
        <h1>You're unsubscribed.</h1>
        <p>No more emails from EndoCraft.</p>
        <p>No hard feelings — sometimes the inbox just gets full.</p>
        <p style="font-size:14px;opacity:0.65;margin-top:18px">If you ever change your mind, the free pack is always at endocraft.app/free.</p>
        <div class="signature">— Marco</div>
        <div class="divider"></div>
        <a class="back-link" href="https://endocraft.app/">Return to EndoCraft</a>
      `
    }));
  } catch (e) {
    res.status(500).send(unsubPage({
      title: 'Unable to Process',
      body: `
        <div class="seal">⚙</div>
        <h1>Unable to Process</h1>
        <p>Reply to any of my emails and I'll remove you manually. Won't take long.</p>
        <div class="signature">— Marco</div>
        <div class="divider"></div>
        <a class="back-link" href="https://endocraft.app/">Return to EndoCraft</a>
      `
    }));
  }
});

app.listen(PORT, () => console.log(`EndoCraft API running on port ${PORT}`));
