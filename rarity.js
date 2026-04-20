// rarity.js
// Session Scroll — Rarity Seed Module
// Rolls happen SERVER-SIDE before Claude is called. Output goes into
// both the Claude system prompt (via buildRarityPromptModifier) and
// the frontend response (for card styling + Seedream prompt suffix).

const RARITY_TABLE = [
  { rarity: 'misprint',  weight: 0.03, rollMin: 1,  rollMax: 1  },
  { rarity: 'common',    weight: 0.17, rollMin: 2,  rollMax: 6  },
  { rarity: 'rare',      weight: 0.35, rollMin: 7,  rollMax: 13 },
  { rarity: 'epic',      weight: 0.37, rollMin: 14, rollMax: 19 },
  { rarity: 'legendary', weight: 0.08, rollMin: 20, rollMax: 20 },
];

/**
 * Roll a rarity using the weighted table, then pick a visible D20 value
 * from that rarity's bucket.
 * @returns {{ rarity: string, visibleRoll: number }}
 */
function rollRarity() {
  const r = Math.random();
  let cumulative = 0;
  for (const entry of RARITY_TABLE) {
    cumulative += entry.weight;
    if (r < cumulative) {
      const visibleRoll = randomInt(entry.rollMin, entry.rollMax);
      return { rarity: entry.rarity, visibleRoll };
    }
  }
  // Safety fallback (shouldn't happen if weights sum to 1.0)
  return { rarity: 'rare', visibleRoll: 10 };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Build rarity-specific instructions to inject into the Claude system prompt.
 * Design philosophy from memory:
 *  - Nat 20 / Legendary  → ultra-epic, god-rays, triumphant
 *  - Nat 1  / Misprint   → INVERTED moment (what went wrong), CSS glitch handles visuals
 *  - Epic / Rare / Common → scaled intensity in the legendary_moment wording
 */
function buildRarityPromptModifier(rarity) {
  switch (rarity) {
    case 'legendary':
      return `RARITY: LEGENDARY (Nat 20). This was an ULTRA-EPIC moment — mythic in scale. The legendary_moment must read as a moment legends are made of. The image_prompt MUST include: "god-rays, volumetric lighting, triumphant pose, heroic composition, mythic atmosphere".`;

    case 'epic':
      return `RARITY: EPIC. A genuinely high-stakes moment. The legendary_moment should feel weighty and cinematic. The image_prompt should lean dramatic: strong lighting, clear emotional stakes.`;

    case 'rare':
      return `RARITY: RARE. A solid, memorable beat. Keep the legendary_moment grounded but characterful. Standard cinematic framing in the image_prompt.`;

    case 'common':
      return `RARITY: COMMON. Everyday session texture — a small victory, a clever line, a quiet choice. Keep the legendary_moment modest and honest. Do not over-dramatize. Image_prompt: natural lighting, intimate framing.`;

    case 'misprint':
      return `RARITY: MISPRINT (Nat 1). CRITICAL: The legendary_moment must describe what WENT WRONG — the disaster, the fumble, the betrayal, the Nat 1 consequence. Phrase it as an inversion of triumph (e.g. "Slipped on own blade mid-charge", "Intimidated a mirror"). The image_prompt itself stays cinematic and normal — the "misprint" effect is applied via CSS on the frontend. Do NOT mention misprint, inversion, or glitches in the image_prompt.`;

    default:
      return '';
  }
}

/**
 * Seedream prompt suffix per rarity. Applied on the frontend (or backend
 * image endpoint) AFTER Claude returns the base image_prompt.
 * Misprint intentionally has NO visual suffix — effect is pure CSS.
 */
const RARITY_IMAGE_SUFFIX = {
  legendary: ', god-rays, volumetric lighting, mythic atmosphere, ultra-epic composition',
  epic:      ', dramatic cinematic lighting, high-contrast composition',
  rare:      '',
  common:    ', natural lighting, intimate framing',
  misprint:  '', // Misprint visual = CSS glitch only, image stays clean
};

module.exports = {
  rollRarity,
  buildRarityPromptModifier,
  RARITY_IMAGE_SUFFIX,
  RARITY_TABLE, // exported for tests / admin debugging
};
