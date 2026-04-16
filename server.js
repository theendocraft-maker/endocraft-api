const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
const AIML_KEY = process.env.AIML_API_KEY;
const PORT = process.env.PORT || 8080;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'EndoCraft API' });
});

app.post('/api/chat', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/image', async (req, res) => {
  try {
    const { prompt, model = 'flux-pro', width = 768, height = 1024 } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });

    const response = await fetch('https://api.aimlapi.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AIML_KEY}`
      },
      body: JSON.stringify({ model, prompt, width, height })
    });

    const data = await response.json();
    console.log('AIML response:', JSON.stringify(data).substring(0, 200));

    if (data.error) return res.status(500).json({ error: data.error });
    if (data.data && data.data[0]) return res.json({ url: data.data[0].url });
    if (data.images && data.images[0]) return res.json({ url: data.images[0].url });
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

app.listen(PORT, () => console.log(`EndoCraft API running on port ${PORT}`));
