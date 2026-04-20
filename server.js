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
  // Rarity-Anweisung wird oben in den System-Prompt injiziert
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
    // Rarity + Roll mit in die Response packen
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

// Email subscribe — schreibt direkt in Supabase subscribers table
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email, source } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.error('Subscribe: SUPABASE_URL or SUPABASE_KEY missing in env');
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
      // 23505 = unique_violation (email already exists) — silent success
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

app.listen(PORT, () => console.log(`EndoCraft API running on port ${PORT}`));
