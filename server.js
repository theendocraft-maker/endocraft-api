const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
const PORT = process.env.PORT || 8080;

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'EndoCraft API' });
});

// Claude chat
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

// Replicate image generation
app.post('/api/image', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });

    // Start prediction
    const startRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${REPLICATE_KEY}`,
        'Prefer': 'wait'
      },
      body: JSON.stringify({
        input: {
          prompt: prompt,
          aspect_ratio: '3:4',
          output_format: 'webp',
          output_quality: 90,
          num_inference_steps: 4
        }
      })
    });

    const prediction = await startRes.json();

    if (prediction.error) {
      return res.status(500).json({ error: prediction.error });
    }

    // If not done yet, poll
    if (prediction.status !== 'succeeded') {
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
      if (result.status === 'succeeded') {
        return res.json({ url: result.output[0] });
      } else {
        return res.status(500).json({ error: 'Image generation failed' });
      }
    }

    res.json({ url: prediction.output[0] });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`EndoCraft API running on port ${PORT}`));
