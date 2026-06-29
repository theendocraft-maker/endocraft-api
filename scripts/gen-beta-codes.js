#!/usr/bin/env node
/**
 * gen-beta-codes.js — mint per-recipient EndoCraft Studio beta codes.
 *
 * Codes are non-guessable (crypto-random, ambiguous chars removed) and stored
 * server-side in the `beta_codes` table; the frontend never ships them.
 * Validation happens via POST /api/redeem-code.
 *
 * Requires env: SUPABASE_URL, SUPABASE_KEY (service_role).
 * Node 18+ (uses global fetch + crypto).
 *
 * Usage:
 *   node gen-beta-codes.js                 # one code per /free lead, write merge CSV
 *   node gen-beta-codes.js --count 50      # mint 50 unassigned pool codes
 *   node gen-beta-codes.js --credits 30    # starting credits per code (default 30)
 *   node gen-beta-codes.js --dry           # generate + print, do NOT write to Supabase
 *
 * Output: ./beta-merge.csv  (columns: email,beta_code)  — ready for the broadcast merge.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_KEY env vars.');
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const COUNT   = args.includes('--count') ? parseInt(getArg('--count', '0'), 10) : null;
const CREDITS = parseInt(getArg('--credits', '30'), 10) || 30;
const DRY     = args.includes('--dry');

// Unambiguous alphabet (no 0/O/1/I/L) → easy to read/type, hard to guess.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function group(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
function newCode() { return `EC-${group(4)}-${group(4)}`; } // ~30^8 ≈ 6.5e11 space

const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

async function existingCodes() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/beta_codes?select=code,email`, { headers: H });
  if (!r.ok) throw new Error('fetch beta_codes failed: ' + r.status);
  return await r.json();
}
async function fetchLeads() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/free_pack_leads?select=email`, { headers: H });
  if (!r.ok) throw new Error('fetch free_pack_leads failed: ' + r.status);
  const rows = await r.json();
  const seen = new Set(), out = [];
  for (const row of rows) {
    const e = String(row.email || '').toLowerCase().trim();
    if (e && e.includes('@') && !seen.has(e)) { seen.add(e); out.push(e); }
  }
  return out;
}
async function insertCodes(records) {
  if (DRY) return;
  // chunk to stay well under any payload limits
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/beta_codes`, {
      method: 'POST',
      headers: { ...H, Prefer: 'return=minimal,resolution=ignore-duplicates' },
      body: JSON.stringify(chunk)
    });
    if (!r.ok) throw new Error('insert failed: ' + r.status + ' ' + (await r.text()));
  }
}

(async () => {
  const existing = await existingCodes();
  const usedCodes = new Set(existing.map(r => r.code));
  const emailToCode = new Map(existing.filter(r => r.email).map(r => [r.email.toLowerCase(), r.code]));
  const mint = () => { let c; do { c = newCode(); } while (usedCodes.has(c)); usedCodes.add(c); return c; };

  let records = [];   // new rows to insert
  let csvRows = [];    // [email, code] for merge

  if (COUNT != null) {
    for (let i = 0; i < COUNT; i++) {
      const code = mint();
      records.push({ code, label: 'pool', credits: CREDITS });
      csvRows.push(['', code]);
    }
    console.log(`Minted ${COUNT} pool codes (credits=${CREDITS})${DRY ? ' [DRY]' : ''}.`);
  } else {
    const leads = await fetchLeads();
    let reused = 0, fresh = 0;
    for (const email of leads) {
      if (emailToCode.has(email)) { csvRows.push([email, emailToCode.get(email)]); reused++; continue; }
      const code = mint();
      records.push({ code, email, label: 'lead', credits: CREDITS });
      csvRows.push([email, code]);
      fresh++;
    }
    console.log(`Leads: ${leads.length} | new codes: ${fresh} | reused existing: ${reused}${DRY ? ' [DRY]' : ''}.`);
  }

  await insertCodes(records);

  const csv = 'email,beta_code\n' + csvRows.map(([e, c]) => `${e},${c}`).join('\n') + '\n';
  const outPath = path.join(process.cwd(), 'beta-merge.csv');
  fs.writeFileSync(outPath, csv);
  console.log(`Wrote ${csvRows.length} rows → ${outPath}`);
  if (DRY) console.log('DRY run — nothing written to Supabase.');
})().catch(e => { console.error(e.message); process.exit(1); });
