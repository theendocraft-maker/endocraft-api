const express = require('express');
const cors = require('cors');
const app = express();
const { rollRarity, buildRarityPromptModifier } = require('./rarity');
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

app.post('/api/image', async (req, res) => {
  try {
    const { prompt, model = 'flux-pro', width, height, aspect_ratio } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    const body = { model, prompt };
    if (model.includes('grok')) {
      body.aspect_ratio = aspect_ratio || '2:3';
    } else if (model.includes('seedream')) {
      body.image_size = { width: Math.max(width || 2048, 1440), height: Math.max(height || 2048, 1440) };
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

// Save card — writes to Supabase cards table, returns assigned global number + misprint_number
app.post('/api/save-card', async (req, res) => {
  try {
    const { email, card } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (!card || typeof card !== 'object') {
      return res.status(400).json({ error: 'Card data required' });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ error: 'Supabase not configured' });
    }

    // 1) Make sure the email is in subscribers (upsert-style: ignore duplicate)
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          email: email.toLowerCase().trim(),
          source: card.source || 'card'
        })
      });
    } catch (subErr) {
      console.warn('Subscribe-on-save failed (non-fatal):', subErr.message);
    }

    // 2) Insert the card — Postgres assigns `number` via BIGSERIAL, trigger sets `misprint_number` if rarity='misprint'
    const body = {
      email: email.toLowerCase().trim(),
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
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      },
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
      card: {
        id: saved.id,
        number: saved.number,                     // global sequential: "the 834th card ever"
        misprint_number: saved.misprint_number,   // null for non-misprint, sequential for misprints
        rarity: saved.rarity,
        email: saved.email,
        created_at: saved.created_at
      }
    });
  } catch (err) {
    console.error('Save-card handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`EndoCraft API running on port ${PORT}`));
