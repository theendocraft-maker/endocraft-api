#!/usr/bin/env node
/**
 * send-campaign.js — sendet die EndoCraft Beta-Einladung personalisiert an jeden Lead.
 *
 * Liest:  ../beta-merge.csv   (email,beta_code)
 *         ../campaign-email.html  (Template mit {{first_name}} {{beta_code}} {{unsubscribe}})
 * Sendet je eine Einzelmail via Resend-API (damit jeder seinen eigenen Code bekommt).
 *
 * Env: RESEND_API_KEY
 * Node 18+ (global fetch).
 *
 * Flags:
 *   --dry   Vorschau, sendet NICHTS (zeigt Empfänger + Betreff)
 */
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const TEST = process.argv.includes('--test'); // sendet NUR an theendocraft@gmail.com
const TEST_ADDR = 'theendocraft@gmail.com';
const SUBJECT = 'A thank-you — and your free beta invite';
const FROM = 'Marco at EndoCraft <marco@endocraft.app>';
const REPLY_TO = 'theendocraft@gmail.com';
const UNSUB = 'mailto:theendocraft@gmail.com?subject=unsubscribe';

const KEY = process.env.RESEND_API_KEY;
if (!DRY && !KEY) { console.error('Missing RESEND_API_KEY env var.'); process.exit(1); }

const root = path.join(__dirname, '..');
const csvPath = path.join(root, 'beta-merge.csv');
const htmlPath = path.join(root, 'campaign-email.html');
if (!fs.existsSync(csvPath))  { console.error('beta-merge.csv nicht gefunden — erst mint-beta-codes.bat ausführen.'); process.exit(1); }
if (!fs.existsSync(htmlPath)) { console.error('campaign-email.html nicht gefunden.'); process.exit(1); }

const template = fs.readFileSync(htmlPath, 'utf8');
const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);

const recipients = [];
for (const line of lines) {
  const [email, code] = line.split(',');
  const e = (email || '').trim().toLowerCase();
  const c = (code || '').trim();
  if (e && e.includes('@') && c) recipients.push({ email: e, code: c });
}

function render(code) {
  return template
    .replaceAll('{{first_name}}', 'there')
    .replaceAll('{{beta_code}}', code)
    .replaceAll('{{unsubscribe}}', UNSUB);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Im Test-Modus nur an die eigene Adresse senden (mit ihrem echten Code, sonst dem ersten).
let sendList = recipients;
if (TEST) {
  const own = recipients.find(r => r.email === TEST_ADDR) || recipients[0];
  sendList = own ? [{ email: TEST_ADDR, code: own.code }] : [];
}

(async () => {
  console.log(`\nKampagne: "${SUBJECT}"${TEST ? '   [TEST-MODUS]' : ''}`);
  console.log(`From: ${FROM}  |  Reply-To: ${REPLY_TO}`);
  console.log(`Empfänger: ${sendList.length}${TEST ? ' (nur Testadresse)' : ''}\n`);
  sendList.forEach((r, i) => console.log(`  ${i + 1}. ${r.email}   [${r.code.slice(0, 3)}****]`));

  if (DRY) { console.log('\n[VORSCHAU] Es wurde NICHTS gesendet.\n'); return; }

  console.log('\nSende...\n');
  let ok = 0, fail = 0;
  for (const r of sendList) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM,
          to: r.email,
          reply_to: REPLY_TO,
          subject: SUBJECT,
          html: render(r.code),
          headers: { 'List-Unsubscribe': `<${UNSUB}>` }
        })
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) { ok++; console.log(`  ✓ ${r.email}  (id ${data.id || '?'})`); }
      else { fail++; console.log(`  ✗ ${r.email}  → ${resp.status} ${data.message || ''}`); }
    } catch (e) { fail++; console.log(`  ✗ ${r.email}  → ${e.message}`); }
    await sleep(600); // gentle pacing
  }
  console.log(`\nFertig. Gesendet: ${ok} | Fehler: ${fail}\n`);
})();
