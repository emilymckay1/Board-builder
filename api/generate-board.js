// This function runs on the server, never in the visitor's browser —
// that's what keeps your Gemini API key safe. Deployed on Vercel, this
// file automatically becomes the endpoint POST /api/generate-board.

// Simple in-memory rate limiter: caps requests per IP per hour.
// NOTE: this resets whenever the serverless instance recycles, and Vercel
// may run several instances at once — so it's a soft speed bump, not a
// hard guarantee. Fine for a small/personal-scale launch. If this app
// gets real traffic and you're worried about cost, swap this for
// Upstash Redis (a few lines of code, free tier available) so the limit
// is shared and durable across every instance.
const rateLimitMap = new Map();
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS_PER_WINDOW = 8;

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(ip) || []).filter(t => now - t < WINDOW_MS);
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return timestamps.length > MAX_REQUESTS_PER_WINDOW;
}

const BOARD_SHAPE_TEXT = {
  round: 'round wood grazing board',
  oval: 'oval marble platter',
  rectangle: 'rectangular wood board'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();

  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many requests right now. Please try again in a bit.' });
    return;
  }

  const { imageBase64, imageMediaType, ingredientsText, boardShape } = req.body || {};

  if (!imageBase64 && !ingredientsText) {
    res.status(400).json({ error: 'Provide either a photo or a list of ingredients.' });
    return;
  }

  const shapeDesc = BOARD_SHAPE_TEXT[boardShape] || BOARD_SHAPE_TEXT.round;

  const intro = imageBase64
    ? 'Look at the attached photo and identify every food ingredient in it. Then generate a photorealistic overhead shot of those exact ingredients'
    : `Here are the ingredients available: ${ingredientsText}. Generate a photorealistic overhead shot of these ingredients`;

  const promptText = `${intro} arranged on a ${shapeDesc}, styled like a professional charcuterie board: cheese as anchor points, meats folded into rosettes or ribbons, crackers fanned and overlapping, fruit and berries clustered to fill every gap, fresh herbs tucked in last. Dense arrangement with zero visible gaps, natural overhead lighting, shallow depth of field, high-end food photography style.`;

  const parts = [{ text: promptText }];
  if (imageBase64) {
    parts.push({ inlineData: { mimeType: imageMediaType || 'image/jpeg', data: imageBase64 } });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Set it in your hosting provider\'s environment variables.' });
    return;
  }

  try {
    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({ contents: [{ parts }] })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', errText);
      res.status(502).json({ error: 'Image generation failed. Please try again.' });
      return;
    }

    const data = await geminiRes.json();
    const responseParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = responseParts.find(p => p.inlineData);

    if (!imagePart) {
      res.status(502).json({ error: 'No image came back. Try a clearer photo, spread out more, or a shorter ingredient list.' });
      return;
    }

    res.status(200).json({
      imageBase64: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || 'image/png'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong generating the board. Please try again.' });
  }
}
