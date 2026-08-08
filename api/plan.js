// api/plan.js
// Vercel serverless function — generates a personalized ONE-WEEK study plan
// from an already-completed report (weaknesses/strengths/level).
// Requires GEMINI_API_KEY env var (Google AI Studio, free tier).

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'GEMINI_API_KEY is not set on the server. Add it in Vercel > Project Settings > Environment Variables, then redeploy.'
    });
    return;
  }

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';


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

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            { role: 'user', parts: [{ text: 'Generate this week\'s plan now.' }] }
          ],
          generationConfig: {
            maxOutputTokens: 700,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingLevel: 'low' }
          }
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      res.status(geminiRes.status).json({ error: (data && data.error && data.error.message) || 'Gemini API error' });
      return;
    }

    const textOut = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || '';
    const clean = textOut.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || 'Unknown server error' });
  }
};
