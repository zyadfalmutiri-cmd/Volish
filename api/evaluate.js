// Vercel serverless function
// Keeps the OpenRouter API key on the server — never exposed to the browser.
// Configure it in your Vercel project: Settings -> Environment Variables -> OPENROUTER_API_KEY
// Optional: OPENROUTER_MODEL to pick a different model (defaults to Claude Sonnet via OpenRouter).

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'OPENROUTER_API_KEY is not set on the server. Add it in Vercel > Project Settings > Environment Variables, then redeploy.'
    });
    return;
  }

  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';

  try {
    const { conversation } = req.body || {};
    if (!conversation || typeof conversation !== 'string') {
      res.status(400).json({ error: 'Missing "conversation" string in request body.' });
      return;
    }

    const systemPrompt = `You are an expert English language examiner who assesses spoken English proficiency using the CEFR scale (A1, A2, B1, B2, C1, C2), based on a short 8-question spoken interview (the answers were transcribed from speech, so ignore minor transcription artifacts and judge grammar, vocabulary range, coherence, and fluency of expression).

Respond with ONLY valid JSON (no markdown fences, no preamble, no explanation outside the JSON). Use this exact schema:
{
  "level": "one of A1|A2|B1|B2|C1|C2",
  "levelName_ar": "short Arabic name for the level, e.g. متوسط",
  "summary_ar": "2-3 sentence overall summary in Arabic of the student's English level",
  "strengths_ar": ["up to 3 short strengths, in Arabic"],
  "weaknesses_ar": ["up to 3 short areas to improve, in Arabic"],
  "corrections": [{"original": "a short phrase from the student's actual answers with a grammar/vocabulary issue", "corrected": "the corrected version"}],
  "recommendation_ar": "1-2 sentence practical study recommendation in Arabic for reaching the next level"
}
Limit "corrections" to at most 3 items. Keep every string concise.`;

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        // Optional but recommended by OpenRouter for attribution/analytics:
        'HTTP-Referer': process.env.SITE_URL || 'https://volish.vercel.app',
        'X-Title': 'Volish'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Student interview transcript:\n\n' + conversation }
        ]
      })
    });

    const data = await orRes.json();

    if (!orRes.ok) {
      res.status(orRes.status).json({ error: (data && data.error && data.error.message) || 'OpenRouter API error' });
      return;
    }

    const textOut = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const clean = textOut.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || 'Unknown server error' });
  }
};

