// api/instagram.js
// Instagram DM webhook — receives recipe requests, replies with clean mise links
//
// Required env vars:
//   INSTAGRAM_VERIFY_TOKEN   — any string you choose, set in Meta app dashboard
//   META_APP_SECRET          — from Meta app settings
//   META_PAGE_ACCESS_TOKEN   — from Meta app, needs instagram_manage_messages permission
//   INSTAGRAM_ACCOUNT_ID     — your Instagram Business account ID
//   ANTHROPIC_API_KEY        — existing
//   SUPABASE_URL             — existing
//   SUPABASE_SERVICE_KEY     — service role key (needed for server-side inserts)
//   OPENAI_API_KEY           — for Whisper audio transcription fallback

import crypto from 'crypto';

const GRAPH = 'https://graph.instagram.com/v21.0';

export const config = {
  api: { bodyParser: false }, // need raw body for signature verification
  maxDuration: 60,
};

export default async function handler(req, res) {
  // ── Webhook verification (Meta sends GET to confirm endpoint) ──────────────
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  if (req.method !== 'POST') return res.status(405).end();

  // ── Read & verify raw body ─────────────────────────────────────────────────
  const rawBody = await readBody(req);

  if (!verifySignature(rawBody, req.headers['x-hub-signature-256'])) {
    console.error('Invalid webhook signature');
    return res.status(401).end();
  }

  // Respond immediately — Meta requires 200 within 20s
  res.status(200).end();

  // ── Process messages (runs after response is sent) ─────────────────────────
  try {
    const body = JSON.parse(rawBody);
    if (body.object !== 'instagram') return;

    for (const entry of body.entry || []) {
      for (const msg of entry.messaging || []) {
        await processMessage(msg).catch(err =>
          console.error('Error processing message:', err)
        );
      }
    }
  } catch (err) {
    console.error('Webhook parse error:', err);
  }
}

// ── Message router ─────────────────────────────────────────────────────────────
async function processMessage(msg) {
  const senderId = msg.sender?.id;
  if (!senderId || senderId === process.env.INSTAGRAM_ACCOUNT_ID) return;

  const message = msg.message;
  if (!message || message.is_echo) return;

  let recipe = null;

  // Case 1: text message — look for a URL
  if (message.text) {
    const url = extractUrl(message.text);

    if (!url) {
      return sendDM(senderId,
        "Send me a recipe link (like from AllRecipes or NYT Cooking) " +
        "or share an Instagram reel and I'll strip out the ads 👨‍🍳"
      );
    }

    if (isInstagramUrl(url)) {
      await sendDM(senderId, "Got it, checking that reel...");
      recipe = await handleInstagramUrl(url, senderId);
    } else {
      await sendDM(senderId, "On it, pulling that recipe now...");
      recipe = await extractRecipeFromUrl(url);
    }
  }

  // Case 2: shared reel/media attachment
  else if (message.attachments?.length) {
    const att = message.attachments[0];
    const reelId = att.payload?.reel_video_id || att.payload?.id;
    const reelUrl = att.payload?.url;

    if (reelId || reelUrl) {
      await sendDM(senderId, "Got it, checking that reel...");
      recipe = await handleInstagramMedia(reelId, reelUrl, senderId);
    } else {
      return sendDM(senderId,
        "I can handle recipe links and Instagram reels. Send me a link!"
      );
    }
  }

  else {
    return sendDM(senderId,
      "Send me a recipe link or share an Instagram reel and I'll clean it up 👨‍🍳"
    );
  }

  if (!recipe) {
    return sendDM(senderId,
      "Couldn't find a recipe there. Try a direct link to a recipe page!"
    );
  }

  const recipeId = await saveRecipe(recipe);
  if (!recipeId) {
    return sendDM(senderId, "Found the recipe but had trouble saving it — try again in a moment!");
  }

  const link = `https://mise-delta.vercel.app/recipe/${recipeId}`;
  await sendDM(senderId, `Here's ${recipe.title} — no ads, just the recipe:\n\n${link}`);
}

// ── Instagram reel handlers ────────────────────────────────────────────────────

async function handleInstagramUrl(url, senderId) {
  // Extract shortcode from URL: instagram.com/reel/CODE/ or /p/CODE/
  const match = url.match(/instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)/);
  const shortcode = match?.[1];
  return handleInstagramMedia(null, url, senderId, shortcode);
}

async function handleInstagramMedia(mediaId, mediaUrl, senderId, shortcode) {
  // Step 1: try to get caption + video URL from Graph API
  const details = await fetchMediaDetails(mediaId, shortcode);

  // Step 2: try extracting recipe from caption
  if (details?.caption) {
    const recipe = await extractRecipeFromText(details.caption, 'an Instagram reel caption');
    if (recipe) return recipe;
  }

  // Step 3: fallback — transcribe the audio
  const videoUrl = details?.media_url;
  if (!videoUrl) {
    // Can't get the video — might need additional Graph API permissions
    return null;
  }

  await sendDM(senderId, "No recipe in the caption — transcribing the audio...");
  const transcript = await transcribeVideo(videoUrl);
  if (!transcript) return null;

  return extractRecipeFromText(transcript, 'a video transcript');
}

async function fetchMediaDetails(mediaId, shortcode) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) return null;

  try {
    // Prefer media ID (more reliable); fall back to oEmbed for shortcode
    if (mediaId) {
      const r = await fetch(
        `${GRAPH}/${mediaId}?fields=caption,media_url,media_type&access_token=${token}`
      );
      if (r.ok) return r.json();
    }

    if (shortcode) {
      // oEmbed only returns title/thumbnail — useful as a last resort
      const r = await fetch(
        `https://graph.facebook.com/v21.0/instagram_oembed` +
        `?url=https://www.instagram.com/p/${shortcode}/&access_token=${token}`
      );
      if (r.ok) {
        const data = await r.json();
        return { caption: data.title || '' };
      }
    }
  } catch (err) {
    console.error('fetchMediaDetails error:', err);
  }
  return null;
}

// ── Recipe extraction ──────────────────────────────────────────────────────────

async function extractRecipeFromUrl(url) {
  // Fetch the page
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Mise Recipe Importer/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) return null;

  const html = (await res.text()).slice(0, 200000);

  // Prefer JSON-LD recipe schema (faster + more accurate than raw HTML)
  const jsonLdBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  let context = html.slice(0, 60000);

  for (const block of jsonLdBlocks) {
    const content = block.replace(/<[^>]+>/g, '');
    if (content.includes('"Recipe"') || content.includes('"recipeIngredient"')) {
      context = content;
      break;
    }
  }

  return callClaude(recipePrompt(context));
}

async function extractRecipeFromText(text, sourceDesc) {
  return callClaude(
    `The following text is from ${sourceDesc}. ` +
    `If it contains a recipe, extract it. If not, return {"error":"no recipe"}.\n\n` +
    recipePrompt(text.slice(0, 8000))
  );
}

function recipePrompt(content) {
  return (
    `Extract the recipe from this content. Return ONLY valid JSON, no markdown:\n` +
    `{\n` +
    `  "title": "...",\n` +
    `  "description": "...",\n` +
    `  "servings": <number>,\n` +
    `  "total_time": "...",\n` +
    `  "category": "...",\n` +
    `  "ingredients": ["..."],\n` +
    `  "steps": ["..."],\n` +
    `  "image_url": "..." or null\n` +
    `}\n\nContent:\n${content}`
  );
}

async function callClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!r.ok) return null;
  const data = await r.json();
  const text = data.content?.[0]?.text;
  if (!text) return null;

  // Parse JSON — handle both clean responses and ones wrapped in markdown
  const attempt = (str) => {
    try {
      const parsed = JSON.parse(str);
      return parsed.error ? null : parsed;
    } catch { return null; }
  };

  return attempt(text) || attempt((text.match(/\{[\s\S]*\}/) || [])[0]);
}

// ── Audio transcription via OpenAI Whisper ─────────────────────────────────────

async function transcribeVideo(videoUrl) {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY not set — skipping transcription');
    return null;
  }

  try {
    // Fetch the video (Instagram serves reels as MP4)
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) return null;
    const buffer = await videoRes.arrayBuffer();

    // Send to Whisper
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'video/mp4' }), 'reel.mp4');
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    return r.ok ? r.text() : null;
  } catch (err) {
    console.error('Transcription error:', err);
    return null;
  }
}

// ── Supabase ───────────────────────────────────────────────────────────────────

async function saveRecipe(recipe) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/recipes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({
      title: recipe.title,
      description: recipe.description || null,
      servings: recipe.servings || null,
      total_time: recipe.total_time || null,
      category: recipe.category || null,
      ingredients: recipe.ingredients || [],
      steps: recipe.steps || [],
      image_url: recipe.image_url || null,
      source: 'instagram_dm',
    }),
  });

  if (!r.ok) {
    console.error('Supabase save error:', await r.text());
    return null;
  }
  const data = await r.json();
  return data?.[0]?.id || null;
}

// ── Instagram Graph API ────────────────────────────────────────────────────────

async function sendDM(recipientId, text) {
  const r = await fetch(`${GRAPH}/${process.env.INSTAGRAM_ACCOUNT_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.META_PAGE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });
  if (!r.ok) console.error('sendDM error:', await r.text());
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function verifySignature(rawBody, signature) {
  if (!signature || !process.env.META_APP_SECRET) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function extractUrl(text) {
  return (text.match(/https?:\/\/[^\s]+/) || [])[0] || null;
}

function isInstagramUrl(url) {
  return url.includes('instagram.com');
}
