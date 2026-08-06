// api/plan.js
// Vercel serverless function — generates a personalized ONE-WEEK study plan
// from an already-completed report (weaknesses/strengths/level).
// Requires OPENROUTER_API_KEY env var (same as turn.js / analyze.js).

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
    const { report } = req.body || {};
    if (!report || !report.level) {
      res.status(400).json({ error: 'Missing "report" object (needs at least a "level" field) in request body.' });
      return;
    }

    const weaknesses = (report.weaknesses_ar || []).join('؛ ') || 'غير محدد';
    const strengths = (report.strengths_ar || []).join('؛ ') || 'غير محدد';

    const systemPrompt = `You are an English learning coach. Based on a student's CEFR speaking assessment report, write a practical ONE-WEEK study plan to help them move toward the next CEFR level.

Student's current level: ${report.level}
Weaknesses identified: ${weaknesses}
Strengths identified: ${strengths}

Respond with ONLY valid JSON (no markdown fences, no preamble, no explanation outside the JSON). Exact schema:
{
  "weeklyGoals": ["up to 4 short, specific, achievable goals in Arabic for this week — each tied to one of the weaknesses above"],
  "suggestedExercises": [
    {"title_ar": "short exercise name in Arabic", "description_ar": "1-2 sentence practical description in Arabic of exactly what to do", "focus": "grammar|vocabulary|fluency|listening_comprehension"}
  ]
}
Limit "suggestedExercises" to at most 5 items. Be concrete and specific to this student's actual weaknesses — never generic "practice more" advice.`;

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.SITE_URL || 'https://volish.vercel.app',
        'X-Title': 'Volish'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 700,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Generate this week\'s plan now.' }
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
