// api/analyze.js
// Vercel serverless function — final holistic report: CEFR level + IELTS estimate
// + 4 grouped category scores, computed from the full adaptive interview.
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

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const IELTS_BY_CEFR = {
    A1: '2.0–3.0', A2: '3.5–4.0', B1: '4.5–5.5',
    B2: '6.0–6.5', C1: '7.0–8.0', C2: '8.5–9.0'
  };
  const LEVEL_AR = { A1: 'مبتدئ', A2: 'مبتدئ متقدم', B1: 'متوسط', B2: 'متوسط متقدم', C1: 'متقدم', C2: 'محترف' };
  const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

  try {
    const { history, turnLevels } = req.body || {};
    if (!Array.isArray(history) || history.length === 0) {
      res.status(400).json({ error: 'Missing "history" array in request body.' });
      return;
    }

    // ---- Deterministic CEFR calculation: median of the last up-to-5 per-turn
    // levels (never an average), so a single stray answer can't skew the result.
    const validLevels = (turnLevels || []).filter(l => LEVELS.includes(l));
    const usedLevels = validLevels.slice(-5);
    const indices = usedLevels.map(l => LEVELS.indexOf(l)).sort((a, b) => a - b);

    let medianIndex = 2;
    if (indices.length > 0) {
      const mid = Math.floor(indices.length / 2);
      medianIndex = indices.length % 2 !== 0
        ? indices[mid]
        : Math.round((indices[mid - 1] + indices[mid]) / 2);
    }
    const spread = indices.length ? (indices[indices.length - 1] - indices[0]) : 0;
    const finalLevel = LEVELS[medianIndex];
    const lowConfidence = usedLevels.length < 5 || spread >= 2;
    const rangeLevel = (lowConfidence && indices.length)
      ? `${LEVELS[indices[0]]}–${LEVELS[indices[indices.length - 1]]}`
      : null;

    const transcript = history.map((h, i) =>
      `Turn ${i + 1} [${h.type}]: ${h.question}\nStudent: ${h.answer}`
    ).join('\n\n');

    const systemPrompt = `You are an expert English examiner writing the FINAL report for a spoken interview that has already been scored. The determined CEFR level is ${finalLevel}${rangeLevel ? ` (uncertain, range ${rangeLevel})` : ''} — do NOT change or re-decide this level, just build the qualitative report around it.

Judge across exactly 4 grouped categories only (never give more granular sub-scores):
- grammar: sentence accuracy, structure variety, connectors
- vocabulary: word range, accuracy in context, appropriateness
- fluency: length/coherence of answers, flow, connecting ideas
- listening_comprehension: how relevant/on-topic each answer actually was to what was asked

You only have a text transcript (from speech-to-text) — never comment on pronunciation or accent, since no real audio was analyzed.

Respond with ONLY valid JSON (no markdown fences, no preamble, no explanation outside the JSON). Exact schema:
{
  "summary_ar": "2-3 sentence overall summary in Arabic of the student's English level",
  "categoryScores": [
    {"name_ar": "القواعد", "score": 0-100, "note_ar": "short Arabic note"},
    {"name_ar": "المفردات", "score": 0-100, "note_ar": "short Arabic note"},
    {"name_ar": "الطلاقة والتواصل", "score": 0-100, "note_ar": "short Arabic note"},
    {"name_ar": "الاستماع والفهم", "score": 0-100, "note_ar": "short Arabic note"}
  ],
  "strengths_ar": ["up to 3 short strengths, in Arabic"],
  "weaknesses_ar": ["up to 3 short areas to improve, in Arabic"],
  "corrections": [{"original": "a short phrase from the student's actual answers with a grammar/vocabulary issue", "corrected": "the corrected version"}],
  "recommendation_ar": "1-2 sentence practical study recommendation in Arabic for reaching the next level"
}
Limit "corrections" to at most 3 items. Keep every string concise.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            { role: 'user', parts: [{ text: 'Full interview transcript:\n\n' + transcript }] }
          ],
          generationConfig: {
            maxOutputTokens: 1000,
            responseMimeType: 'application/json'
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

    parsed.level = finalLevel;
    parsed.levelName_ar = LEVEL_AR[finalLevel];
    parsed.ieltsEstimate = IELTS_BY_CEFR[finalLevel];
    parsed.rangeLevel = rangeLevel;
    parsed.lowConfidence = lowConfidence;

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || 'Unknown server error' });
  }
};
